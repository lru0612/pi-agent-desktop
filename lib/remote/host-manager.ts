/**
 * Remote host manager (fork-owned, server-only).
 *
 * One state machine per configured host:
 *
 *   connecting ──probe/install/start/tunnel/login──▶ online
 *        ▲                                             │ tunnel exit / health failure
 *        └──────────── reconnecting ◀──────────────────┘
 *   transient failures retry with backoff; auth / config problems stop in `error`.
 *
 * The manager is a process-wide singleton (kept on globalThis so `next dev`
 * module reloads do not orphan ssh children). See
 * docs/remote-hosts-design.zh-CN.md §5.
 */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect as netConnect, createServer } from "node:net";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as undici from "undici";

import { BOOTSTRAP_SCRIPT, installCommand } from "./bootstrap-script";
import { findServerBundleDir, isSupportedRemotePlatform, readServerBundle, spawnBundleTar, type ServerBundle } from "./bundle";
import {
  isValidHostId,
  loadRemoteHosts,
  makeHostId,
  normalizeSshTarget,
  parseSshTarget,
  saveRemoteHosts,
  type RemoteHostConfig,
} from "./hosts-store";
import { REMOTE_PROTOCOL_VERSION, type RemoteServerInfo } from "./protocol";
import { parseSse } from "./sse";
import { classifySshFailure, runSsh, spawnTunnel, type SshResult } from "./ssh";
import type { RemoteHostError, RemoteHostSnapshot, RemoteHostStatus, RemoteSessionsPayload } from "./types";

export type { RemoteHostError, RemoteHostSnapshot, RemoteHostStatus } from "./types";

/** Errors that will not fix themselves; no automatic retry. */
const PERMANENT_ERRORS = new Set([
  "ssh_auth",
  "ssh_host_key",
  "ssh_missing",
  "invalid_target",
  "node_missing",
  "unsupported_platform",
  "no_bundle",
  "protocol_mismatch",
  "other_version_busy",
  "install_failed",
]);

const HEALTH_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

class HostConnectError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: string, readonly extra?: Record<string, unknown>) {
    super(message);
  }
}

interface HostRuntime {
  config: RemoteHostConfig;
  status: RemoteHostStatus;
  phase: string | null;
  error: RemoteHostError | null;
  /** Whether the user wants this host connected. */
  wanted: boolean;
  attempt: number;
  generation: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  healthTimer: ReturnType<typeof setInterval> | null;
  healthFailures: number;
  connecting: Promise<void> | null;
  tunnel: ChildProcess | null;
  tunnelStderr: string;
  localPort: number | null;
  remotePort: number | null;
  password: string | null;
  cookie: string | null;
  relogin: Promise<void> | null;
  info: RemoteServerInfo | null;
  version: string | null;
  connectedAt: number | null;
  lastOnlineAt: number | null;
  running: { ids: string[]; suppressed: string[]; listVersion: number | null };
  runningStream: AbortController | null;
  sessionsCache: { full: RemoteSessionsPayload | null; summary: RemoteSessionsPayload | null; savedAt: number };
  busySessionIds: string[] | null;
}

function now(): number {
  return Date.now();
}

function freePort(preferred?: number | null): Promise<number> {
  const tryListen = (port: number) => new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      server.close(() => resolve(actual));
    });
  });
  if (preferred) return tryListen(preferred).catch(() => tryListen(0));
  return tryListen(0);
}

function waitForPort(port: number, timeoutMs: number, isDead: () => boolean): Promise<void> {
  const deadline = now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (isDead()) return reject(new Error("tunnel exited"));
      const socket = netConnect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (now() > deadline) reject(new Error("timed out waiting for the tunnel"));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

function lastJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // keep looking
    }
  }
  return null;
}

function sshError(result: SshResult, error?: unknown): HostConnectError {
  const kind = classifySshFailure(result, error);
  const detail = result.stderr || (error instanceof Error ? error.message : undefined);
  switch (kind) {
    case "not_found":
      return new HostConnectError("ssh_missing", "The ssh command was not found on this computer.", detail);
    case "auth":
      return new HostConnectError("ssh_auth", "SSH authentication failed. Key or agent authentication is required.", detail);
    case "host_key":
      return new HostConnectError("ssh_host_key", "The host key could not be verified. Connect once with ssh in a terminal to accept it.", detail);
    case "timeout":
      return new HostConnectError("ssh_timeout", "Connecting over SSH timed out.", detail);
    case "unreachable":
      return new HostConnectError("ssh_unreachable", "The host could not be reached.", detail);
    default:
      return new HostConnectError("ssh_failed", `ssh exited with code ${result.code ?? "?"}.`, detail);
  }
}

function cacheFile(id: string): string {
  return join(getAgentDir(), "pi-desktop", "remote-cache", `${id}.sessions.json`);
}

export class RemoteHostManager extends EventEmitter {
  private readonly hosts = new Map<string, HostRuntime>();
  private started = false;
  private aggregateCounter = 1;
  private aggregateKey = "";
  readonly dispatcher = new undici.Agent({
    // SSE and file-watch streams can stay silent for minutes.
    bodyTimeout: 0,
    headersTimeout: 120_000,
    keepAliveTimeout: 15_000,
    connect: { timeout: 10_000 },
  });

  constructor() {
    super();
    this.setMaxListeners(100);
    process.once("exit", () => {
      for (const runtime of this.hosts.values()) runtime.tunnel?.kill("SIGTERM");
    });
  }

  /** Load the host list and start connecting every host (idempotent). */
  ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    for (const config of loadRemoteHosts()) {
      const runtime = this.createRuntime(config);
      this.hosts.set(config.id, runtime);
      this.scheduleConnect(runtime, 0);
    }
  }

  private createRuntime(config: RemoteHostConfig): HostRuntime {
    const runtime: HostRuntime = {
      config,
      status: "connecting",
      phase: null,
      error: null,
      wanted: true,
      attempt: 0,
      generation: 0,
      retryTimer: null,
      healthTimer: null,
      healthFailures: 0,
      connecting: null,
      tunnel: null,
      tunnelStderr: "",
      localPort: null,
      remotePort: null,
      password: null,
      cookie: null,
      relogin: null,
      info: null,
      version: null,
      connectedAt: null,
      lastOnlineAt: null,
      running: { ids: [], suppressed: [], listVersion: null },
      runningStream: null,
      sessionsCache: { full: null, summary: null, savedAt: 0 },
      busySessionIds: null,
    };
    try {
      const cached = JSON.parse(readFileSync(cacheFile(config.id), "utf8")) as RemoteSessionsPayload;
      if (Array.isArray(cached.sessions)) runtime.sessionsCache.full = cached;
    } catch {
      // no cache yet
    }
    return runtime;
  }

  // ---------------------------------------------------------------- queries

  list(): RemoteHostSnapshot[] {
    this.ensureStarted();
    return [...this.hosts.values()].map((runtime) => this.snapshot(runtime));
  }

  get(id: string): RemoteHostSnapshot | null {
    this.ensureStarted();
    const runtime = this.hosts.get(id);
    return runtime ? this.snapshot(runtime) : null;
  }

  ids(): string[] {
    this.ensureStarted();
    return [...this.hosts.keys()];
  }

  private snapshot(runtime: HostRuntime): RemoteHostSnapshot {
    return {
      id: runtime.config.id,
      label: runtime.config.label,
      ssh: runtime.config.ssh,
      status: runtime.status,
      phase: runtime.phase,
      error: runtime.error,
      version: runtime.version,
      remoteVersion: runtime.info?.appVersion ?? null,
      platform: runtime.info?.platform ?? null,
      home: runtime.info?.home ?? null,
      connectedAt: runtime.connectedAt,
      lastOnlineAt: runtime.lastOnlineAt,
      busySessionIds: runtime.busySessionIds,
      runningSessionIds: runtime.status === "online" ? runtime.running.ids : [],
    };
  }

  /** Base URL + auth cookie for proxying, or null when the host is not online. */
  connection(id: string): { baseUrl: string; cookie: string | null } | null {
    this.ensureStarted();
    const runtime = this.hosts.get(id);
    if (!runtime || runtime.status !== "online" || !runtime.localPort) return null;
    return { baseUrl: `http://127.0.0.1:${runtime.localPort}`, cookie: runtime.cookie };
  }

  /** Union of running session ids across online hosts. */
  remoteRunningIds(): { ids: string[]; suppressed: string[] } {
    const ids: string[] = [];
    const suppressed: string[] = [];
    for (const runtime of this.hosts.values()) {
      if (runtime.status !== "online") continue;
      ids.push(...runtime.running.ids);
      suppressed.push(...runtime.running.suppressed);
    }
    return { ids, suppressed };
  }

  /**
   * A single monotonically changing list version for the merged session list.
   * Changes whenever the local version, a host's list version or a host's
   * connection state changes, so connected sidebars refetch.
   */
  aggregateVersion(localVersion: number): number {
    const parts = [`local:${localVersion}`];
    for (const runtime of this.hosts.values()) {
      parts.push(`${runtime.config.id}:${runtime.status}:${runtime.running.listVersion ?? "-"}:${runtime.connectedAt ?? 0}`);
    }
    const key = parts.join("|");
    if (key !== this.aggregateKey) {
      this.aggregateKey = key;
      this.aggregateCounter += 1;
    }
    return this.aggregateCounter;
  }

  // ---------------------------------------------------------------- mutations

  add(input: { ssh: string; label?: string }): RemoteHostSnapshot {
    this.ensureStarted();
    const ssh = normalizeSshTarget(input.ssh);
    parseSshTarget(ssh); // throws on invalid input
    const existing = [...this.hosts.values()].find((runtime) => runtime.config.ssh === ssh);
    if (existing) {
      if (existing.status !== "online") this.connect(existing.config.id, {});
      return this.snapshot(existing);
    }
    const id = makeHostId(input.label?.trim() || ssh, this.hosts.keys());
    const config: RemoteHostConfig = {
      id,
      label: input.label?.trim() || id,
      ssh,
      addedAt: new Date().toISOString(),
    };
    const runtime = this.createRuntime(config);
    this.hosts.set(id, runtime);
    this.persist();
    this.scheduleConnect(runtime, 0);
    this.emitChange();
    return this.snapshot(runtime);
  }

  update(id: string, patch: { label?: string }): RemoteHostSnapshot | null {
    const runtime = this.hosts.get(id);
    if (!runtime) return null;
    if (patch.label?.trim()) runtime.config = { ...runtime.config, label: patch.label.trim() };
    this.persist();
    this.emitChange();
    return this.snapshot(runtime);
  }

  async remove(id: string, options: { stopRemote?: boolean } = {}): Promise<boolean> {
    const runtime = this.hosts.get(id);
    if (!runtime) return false;
    runtime.wanted = false;
    runtime.generation += 1;
    this.teardown(runtime);
    this.hosts.delete(id);
    this.persist();
    this.emitChange();
    if (options.stopRemote) {
      await runSsh(runtime.config.ssh, "sh -s -- stop", { stdin: BOOTSTRAP_SCRIPT, timeoutMs: 30_000 }).catch(() => undefined);
    }
    return true;
  }

  /** (Re)connect now. `replace` controls what happens when another server version runs remotely. */
  connect(id: string, options: { replace?: "if-idle" | "force" }): RemoteHostSnapshot | null {
    this.ensureStarted();
    const runtime = this.hosts.get(id);
    if (!runtime) return null;
    runtime.wanted = true;
    runtime.attempt = 0;
    this.scheduleConnect(runtime, 0, options.replace);
    return this.snapshot(runtime);
  }

  disconnect(id: string): RemoteHostSnapshot | null {
    const runtime = this.hosts.get(id);
    if (!runtime) return null;
    runtime.wanted = false;
    runtime.generation += 1;
    this.teardown(runtime);
    this.setStatus(runtime, "offline", null, null);
    return this.snapshot(runtime);
  }

  /** Called by the proxy when a request through the tunnel failed at the transport level. */
  reportTransportFailure(id: string): void {
    const runtime = this.hosts.get(id);
    if (!runtime || runtime.status !== "online") return;
    void this.checkHealth(runtime, runtime.generation);
  }

  // ---------------------------------------------------------------- remote HTTP

  /** Request a path on an online host, re-authenticating once on 401. */
  async request(
    id: string,
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {},
  ): Promise<undici.Dispatcher.ResponseData> {
    const runtime = this.hosts.get(id);
    if (!runtime || runtime.status !== "online" || !runtime.localPort) {
      throw new HostConnectError("remote_offline", "host is not connected");
    }
    const send = () => undici.request(`http://127.0.0.1:${runtime.localPort}${path}`, {
      method: (init.method ?? "GET") as undici.Dispatcher.HttpMethod,
      headers: {
        ...(init.headers ?? {}),
        ...(runtime.cookie ? { cookie: runtime.cookie } : {}),
      },
      body: init.body,
      signal: init.signal,
      dispatcher: this.dispatcher,
    });
    let response = await send();
    if (response.statusCode === 401) {
      await response.body.dump();
      await this.reauthenticate(runtime);
      response = await send();
    }
    return response;
  }

  async requestJson<T>(id: string, path: string, timeoutMs = 15_000): Promise<T> {
    const response = await this.request(id, path, {
      headers: { accept: "application/json", "accept-encoding": "identity" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.statusCode !== 200) {
      await response.body.dump();
      throw new Error(`HTTP ${response.statusCode} for ${path}`);
    }
    return await response.body.json() as T;
  }

  async reauthenticate(runtime: HostRuntime): Promise<void> {
    if (!runtime.relogin) {
      runtime.relogin = this.login(runtime).finally(() => {
        runtime.relogin = null;
      });
    }
    await runtime.relogin;
  }

  // ---------------------------------------------------------------- sessions cache (used by the aggregator)

  /** Session list of one host: live when online, otherwise the last cached copy. */
  async sessions(id: string, query: string): Promise<{ payload: RemoteSessionsPayload | null; live: boolean }> {
    const runtime = this.hosts.get(id);
    if (!runtime) return { payload: null, live: false };
    const summary = new URLSearchParams(query).get("summary") === "1";
    if (runtime.status === "online") {
      try {
        const payload = await this.requestJson<RemoteSessionsPayload>(id, `/api/sessions${query}`);
        if (summary) runtime.sessionsCache.summary = payload;
        else {
          runtime.sessionsCache.full = payload;
          this.saveCache(runtime, payload);
        }
        if (typeof payload.sessionListVersion === "number") {
          runtime.running.listVersion ??= payload.sessionListVersion;
        }
        return { payload, live: true };
      } catch {
        this.reportTransportFailure(id);
      }
    }
    return { payload: runtime.sessionsCache.full ?? runtime.sessionsCache.summary, live: false };
  }

  private saveCache(runtime: HostRuntime, payload: RemoteSessionsPayload): void {
    if (now() - runtime.sessionsCache.savedAt < 10_000) return;
    runtime.sessionsCache.savedAt = now();
    try {
      const file = cacheFile(runtime.config.id);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ sessions: payload.sessions, sessionListVersion: 0 }), { mode: 0o600 });
    } catch {
      // cache is best-effort
    }
  }

  // ---------------------------------------------------------------- connection lifecycle

  private persist(): void {
    saveRemoteHosts([...this.hosts.values()].map((runtime) => runtime.config));
  }

  private emitChange(): void {
    this.emit("change");
  }

  private setStatus(runtime: HostRuntime, status: RemoteHostStatus, phase: string | null, error: RemoteHostError | null): void {
    const changed = runtime.status !== status || runtime.phase !== phase || runtime.error?.code !== error?.code;
    runtime.status = status;
    runtime.phase = phase;
    runtime.error = error;
    if (changed) this.emitChange();
  }

  private scheduleConnect(runtime: HostRuntime, delayMs: number, replace?: "if-idle" | "force"): void {
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = setTimeout(() => {
      runtime.retryTimer = null;
      if (!runtime.wanted || !this.hosts.has(runtime.config.id)) return;
      runtime.connecting = this.doConnect(runtime, replace).finally(() => {
        runtime.connecting = null;
      });
    }, delayMs);
    runtime.retryTimer.unref?.();
  }

  private teardown(runtime: HostRuntime): void {
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = null;
    if (runtime.healthTimer) clearInterval(runtime.healthTimer);
    runtime.healthTimer = null;
    runtime.runningStream?.abort();
    runtime.runningStream = null;
    if (runtime.tunnel && runtime.tunnel.exitCode === null) runtime.tunnel.kill("SIGTERM");
    runtime.tunnel = null;
    runtime.running = { ids: [], suppressed: [], listVersion: null };
  }

  private async doConnect(runtime: HostRuntime, replace?: "if-idle" | "force"): Promise<void> {
    runtime.generation += 1;
    const generation = runtime.generation;
    const stale = () => generation !== runtime.generation || !runtime.wanted;
    const wasOnline = runtime.connectedAt !== null;
    this.teardown(runtime);
    runtime.busySessionIds = null;
    const progress = (phase: string) => {
      if (!stale()) this.setStatus(runtime, wasOnline ? "reconnecting" : "connecting", phase, null);
    };

    try {
      progress("probe");
      const bundleDir = findServerBundleDir();
      if (!bundleDir) {
        throw new HostConnectError("no_bundle", "No server bundle to install. Run `npm run desktop:prepare` first.");
      }
      const bundle = readServerBundle(bundleDir);

      const probe = await this.bootstrap(runtime, ["probe"], 60_000);
      if (stale()) return;
      if (!probe.ok) {
        if (probe.error === "node_missing") {
          throw new HostConnectError("node_missing", "Node.js 22.19 or newer is required on the remote host.");
        }
        throw new HostConnectError("probe_failed", String(probe.message ?? probe.error ?? "probe failed"));
      }
      const platform = String(probe.platform ?? "");
      if (!isSupportedRemotePlatform(platform)) {
        throw new HostConnectError("unsupported_platform", `Unsupported remote platform: ${platform}`);
      }

      const installed = Array.isArray(probe.versions) ? probe.versions as string[] : [];
      if (!installed.includes(bundle.version)) {
        progress("install");
        await this.install(runtime, bundle, platform);
        if (stale()) return;
      }

      progress("start");
      const mode = replace === "force" ? "--replace" : "--replace-if-idle";
      const started = await this.bootstrap(runtime, ["start", bundle.version, mode], 180_000);
      if (stale()) return;
      if (!started.ok) {
        if (started.error === "other_version_busy") {
          runtime.busySessionIds = Array.isArray(started.busySessionIds) ? started.busySessionIds as string[] : [];
          throw new HostConnectError(
            "other_version_busy",
            "Another server version is running tasks on this host.",
            undefined,
            { running: started.running },
          );
        }
        throw new HostConnectError(
          "start_failed",
          `The remote server did not start (${String(started.error ?? "unknown")}).`,
          typeof started.log === "string" ? started.log : undefined,
        );
      }
      runtime.password = String(started.password ?? "");
      runtime.remotePort = Number(started.port);
      runtime.version = bundle.version;
      void this.bootstrap(runtime, ["prune", bundle.version], 60_000).catch(() => undefined);

      progress("tunnel");
      await this.openTunnel(runtime, generation);
      if (stale()) return;

      progress("login");
      await this.login(runtime);
      if (stale()) return;

      const info = await this.fetchInfo(runtime, 15_000);
      if (stale()) return;
      if (info.protocol !== REMOTE_PROTOCOL_VERSION) {
        throw new HostConnectError("protocol_mismatch", `Remote protocol ${info.protocol}, expected ${REMOTE_PROTOCOL_VERSION}.`);
      }
      runtime.info = info;
      runtime.attempt = 0;
      runtime.healthFailures = 0;
      runtime.connectedAt = now();
      runtime.lastOnlineAt = now();
      this.setStatus(runtime, "online", null, null);
      this.startRunningStream(runtime, generation);
      runtime.healthTimer = setInterval(() => void this.checkHealth(runtime, generation), HEALTH_INTERVAL_MS);
      runtime.healthTimer.unref?.();
    } catch (error) {
      if (stale()) return;
      this.teardown(runtime);
      const failure = error instanceof HostConnectError
        ? error
        : new HostConnectError("connect_failed", error instanceof Error ? error.message : String(error));
      const permanent = PERMANENT_ERRORS.has(failure.code);
      this.setStatus(runtime, permanent ? "error" : "offline", null, {
        code: failure.code,
        message: failure.message,
        detail: failure.detail?.slice(-4000),
      });
      if (!permanent) {
        const delay = Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** runtime.attempt);
        runtime.attempt += 1;
        this.scheduleConnect(runtime, delay);
      }
    }
  }

  private async bootstrap(runtime: HostRuntime, args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
    let result: SshResult;
    try {
      result = await runSsh(runtime.config.ssh, `sh -s -- ${args.join(" ")}`, { stdin: BOOTSTRAP_SCRIPT, timeoutMs });
    } catch (error) {
      if ((error as Error).message?.includes("SSH target")) {
        throw new HostConnectError("invalid_target", (error as Error).message);
      }
      throw sshError({ code: null, stdout: "", stderr: "", timedOut: false }, error);
    }
    const json = lastJsonLine(result.stdout);
    if (!json) throw sshError(result);
    return json;
  }

  private install(runtime: HostRuntime, bundle: ServerBundle, platform: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tar = spawnBundleTar(bundle, platform);
      let tarError = "";
      tar.stderr?.on("data", (chunk: Buffer) => {
        tarError += chunk.toString("utf8");
      });
      tar.on("error", (error) => reject(new HostConnectError("install_failed", `tar failed: ${error.message}`)));
      runSsh(runtime.config.ssh, installCommand(bundle.version), { stdin: tar.stdout!, timeoutMs: 15 * 60_000 })
        .then((result) => {
          const json = lastJsonLine(result.stdout);
          if (json?.ok === true) resolve();
          else if (result.code === 255) reject(sshError(result));
          else reject(new HostConnectError("install_failed", "Uploading the server failed.", `${result.stderr}\n${tarError}`.trim()));
        })
        .catch((error) => reject(new HostConnectError("install_failed", `Uploading the server failed: ${(error as Error).message}`)));
    });
  }

  private async openTunnel(runtime: HostRuntime, generation: number): Promise<void> {
    const localPort = await freePort(runtime.localPort);
    runtime.localPort = localPort;
    runtime.tunnelStderr = "";
    const tunnel = spawnTunnel(runtime.config.ssh, localPort, runtime.remotePort!);
    runtime.tunnel = tunnel;
    let exited = false;
    tunnel.stderr?.on("data", (chunk: Buffer) => {
      runtime.tunnelStderr = (runtime.tunnelStderr + chunk.toString("utf8")).slice(-4000);
    });
    tunnel.on("error", () => {
      exited = true;
    });
    tunnel.on("exit", () => {
      exited = true;
      if (generation !== runtime.generation || !runtime.wanted || runtime.tunnel !== tunnel) return;
      // The tunnel died under a live connection: reconnect quickly.
      runtime.tunnel = null;
      this.teardown(runtime);
      this.setStatus(runtime, "reconnecting", null, {
        code: "tunnel_closed",
        message: "The SSH connection was closed.",
        detail: runtime.tunnelStderr.trim() || undefined,
      });
      const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** runtime.attempt);
      runtime.attempt += 1;
      this.scheduleConnect(runtime, delay);
    });
    try {
      await waitForPort(localPort, 30_000, () => exited);
    } catch (error) {
      throw new HostConnectError(
        "tunnel_failed",
        `Could not open the SSH tunnel: ${(error as Error).message}`,
        runtime.tunnelStderr.trim() || undefined,
      );
    }
  }

  private async login(runtime: HostRuntime): Promise<void> {
    if (!runtime.localPort) throw new HostConnectError("login_failed", "no tunnel");
    let lastStatus = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await undici.request(`http://127.0.0.1:${runtime.localPort}/api/web-auth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: runtime.password ?? "" }),
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(15_000),
      }).catch((error: Error) => {
        throw new HostConnectError("login_failed", `Login request failed: ${error.message}`);
      });
      lastStatus = response.statusCode;
      await response.body.dump();
      if (response.statusCode === 200) {
        const setCookie = response.headers["set-cookie"];
        const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
        const session = cookies.map((value) => value.split(";")[0]!).find((value) => value.startsWith("pi_web_session="));
        runtime.cookie = session ?? null;
        return;
      }
      if (response.statusCode === 404) {
        // Server without a password (should not happen for bootstrapped hosts).
        runtime.cookie = null;
        return;
      }
      if (response.statusCode === 429) {
        await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
        continue;
      }
      break;
    }
    throw new HostConnectError("login_failed", `The remote server rejected the login (HTTP ${lastStatus}).`);
  }

  private async fetchInfo(runtime: HostRuntime, timeoutMs: number): Promise<RemoteServerInfo> {
    const response = await undici.request(`http://127.0.0.1:${runtime.localPort}/api/remote-info`, {
      headers: { ...(runtime.cookie ? { cookie: runtime.cookie } : {}), accept: "application/json" },
      dispatcher: this.dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.statusCode === 401) {
      await response.body.dump();
      await this.login(runtime);
      return this.fetchInfo(runtime, timeoutMs);
    }
    if (response.statusCode !== 200) {
      await response.body.dump();
      throw new HostConnectError("handshake_failed", `remote-info returned HTTP ${response.statusCode}`);
    }
    return await response.body.json() as RemoteServerInfo;
  }

  private async checkHealth(runtime: HostRuntime, generation: number): Promise<void> {
    if (generation !== runtime.generation || runtime.status !== "online") return;
    try {
      await this.fetchInfo(runtime, 10_000);
      runtime.healthFailures = 0;
      runtime.lastOnlineAt = now();
    } catch {
      runtime.healthFailures += 1;
      if (runtime.healthFailures >= 2 && generation === runtime.generation) {
        // Killing the tunnel routes through the exit handler's reconnect path.
        if (runtime.tunnel) runtime.tunnel.kill("SIGTERM");
        else this.scheduleConnect(runtime, 0);
      }
    }
  }

  /** Follow the host's running-session stream so the merged sidebar stays live. */
  private startRunningStream(runtime: HostRuntime, generation: number): void {
    const controller = new AbortController();
    runtime.runningStream = controller;
    const loop = async () => {
      while (!controller.signal.aborted && generation === runtime.generation && runtime.status === "online") {
        try {
          const response = await this.request(runtime.config.id, "/api/agent/running/events", {
            headers: { accept: "text/event-stream", "accept-encoding": "identity" },
            signal: controller.signal,
          });
          if (response.statusCode !== 200) {
            await response.body.dump();
            throw new Error(`HTTP ${response.statusCode}`);
          }
          for await (const event of parseSse(response.body)) {
            const data = JSON.parse(event.data) as { type?: string; runningSessionIds?: string[]; sessionListVersion?: number };
            if (data.type !== "running") continue;
            const ids = Array.isArray(data.runningSessionIds) ? data.runningSessionIds : [];
            const listVersion = typeof data.sessionListVersion === "number" ? data.sessionListVersion : runtime.running.listVersion;
            const changed = ids.join(",") !== runtime.running.ids.join(",") || listVersion !== runtime.running.listVersion;
            runtime.running = { ...runtime.running, ids, listVersion };
            if (changed) this.emitChange();
          }
        } catch {
          if (controller.signal.aborted) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    };
    void loop();
  }
}

const GLOBAL_KEY = "__piRemoteHostManager";

export function getRemoteHostManager(): RemoteHostManager {
  const holder = globalThis as unknown as Record<string, RemoteHostManager | undefined>;
  holder[GLOBAL_KEY] ??= new RemoteHostManager();
  return holder[GLOBAL_KEY]!;
}

export { isValidHostId };
