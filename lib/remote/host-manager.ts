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
import { setTimeout as delay } from "node:timers/promises";

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
  "login_rejected",
  "server_identity_unknown",
]);

const HEALTH_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;
/** Server versions installed more recently than this are never pruned. */
const PRUNE_MIN_AGE_HOURS = 24;

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
  controller: AbortController | null;
  healthCheck: Promise<void> | null;
  authRetryAfter: number;
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

function waitForPort(port: number, timeoutMs: number, isDead: () => boolean, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let socket: ReturnType<typeof netConnect> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(retry);
      signal.removeEventListener("abort", abort);
      socket?.destroy();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new Error("connection cancelled"));
    const deadline = setTimeout(() => finish(new Error("timed out waiting for the tunnel")), timeoutMs);
    const attempt = () => {
      if (signal.aborted) return abort();
      if (isDead()) return finish(new Error("tunnel exited"));
      socket = netConnect({ host: "127.0.0.1", port });
      socket.once("connect", () => finish());
      socket.once("error", () => {
        socket?.destroy();
        if (!settled) retry = setTimeout(attempt, 200);
      });
    };
    signal.addEventListener("abort", abort, { once: true });
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
      for (const runtime of this.hosts.values()) this.teardown(runtime);
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
      controller: null,
      healthCheck: null,
      authRetryAfter: 0,
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
      runningSessionIds: runtime.running.ids,
    };
  }

  /** Base URL + auth cookie for proxying, or null when the host is not online. */
  connection(id: string): { baseUrl: string; cookie: string | null } | null {
    this.ensureStarted();
    const runtime = this.hosts.get(id);
    if (!runtime || runtime.status !== "online" || !runtime.localPort) return null;
    return { baseUrl: `http://127.0.0.1:${runtime.localPort}`, cookie: runtime.cookie };
  }

  /** Last-known running ids, retained offline: losing transport is not completion. */
  remoteRunningIds(): { ids: string[]; suppressed: string[] } {
    const ids: string[] = [];
    const suppressed: string[] = [];
    for (const runtime of this.hosts.values()) {
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
      // Do not race an explicit stop against this manager's cancelled start.
      await runtime.connecting;
      await runSsh(runtime.config.ssh, "sh -s -- stop", { stdin: BOOTSTRAP_SCRIPT, timeoutMs: 30_000 }).catch(() => undefined);
    }
    return true;
  }

  /** (Re)connect now. `replace` controls what happens when another server version runs remotely. */
  connect(id: string, options: { replace?: "if-idle" | "force" }): RemoteHostSnapshot | null {
    this.ensureStarted();
    const runtime = this.hosts.get(id);
    if (!runtime) return null;
    // Repeated clicks coalesce; they must not tear down a live attempt or
    // escalate its replacement policy to force midway through bootstrapping.
    if (runtime.wanted && (runtime.status === "online" || (runtime.connecting && !runtime.controller?.signal.aborted))) {
      return this.snapshot(runtime);
    }
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
    const signal = init.signal
      ? AbortSignal.any([init.signal, runtime.controller!.signal])
      : runtime.controller!.signal;
    const baseUrl = `http://127.0.0.1:${runtime.localPort}`;
    let cookie = runtime.cookie;
    const send = () => {
      signal.throwIfAborted();
      cookie = runtime.cookie;
      return undici.request(`${baseUrl}${path}`, {
        method: (init.method ?? "GET") as undici.Dispatcher.HttpMethod,
        headers: {
          ...(init.headers ?? {}),
          ...(cookie ? { cookie } : {}),
        },
        body: init.body,
        signal,
        dispatcher: this.dispatcher,
      });
    };
    let response = await send();
    if (response.statusCode === 401) {
      await response.body.dump();
      signal.throwIfAborted();
      await this.reauthenticate(runtime, cookie);
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

  private async reauthenticate(runtime: HostRuntime, rejectedCookie: string | null): Promise<void> {
    runtime.controller?.signal.throwIfAborted();
    if (runtime.cookie && runtime.cookie !== rejectedCookie) return;
    if (!runtime.relogin) {
      if (now() < runtime.authRetryAfter) throw new HostConnectError("login_rejected", "Remote login is cooling down; reconnect to retry.");
      // Bound repeated requests even if login succeeds but its cookie is rejected.
      runtime.authRetryAfter = now() + MAX_BACKOFF_MS;
      const login = this.login(runtime).finally(() => {
        if (runtime.relogin === login) runtime.relogin = null;
      });
      runtime.relogin = login;
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
    if (!runtime.wanted || this.hosts.get(runtime.config.id) !== runtime) return;
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = setTimeout(() => {
      runtime.retryTimer = null;
      const generation = runtime.generation;
      const previous = runtime.connecting;
      const connecting = (async () => {
        // Cancelled SSH/tar cleanup must settle before the next attempt starts.
        await previous;
        if (!runtime.wanted || this.hosts.get(runtime.config.id) !== runtime || generation !== runtime.generation) return;
        await this.doConnect(runtime, replace);
      })().finally(() => {
        if (runtime.connecting === connecting) runtime.connecting = null;
      });
      runtime.connecting = connecting;
    }, delayMs);
    runtime.retryTimer.unref?.();
  }

  private teardown(runtime: HostRuntime): void {
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = null;
    if (runtime.healthTimer) clearInterval(runtime.healthTimer);
    runtime.healthTimer = null;
    runtime.controller?.abort();
    runtime.runningStream?.abort();
    runtime.runningStream = null;
    const tunnel = runtime.tunnel;
    runtime.tunnel = null;
    if (tunnel && tunnel.exitCode === null) tunnel.kill("SIGKILL");
    runtime.password = null;
    runtime.cookie = null;
    runtime.relogin = null;
    runtime.healthCheck = null;
    // Keep the last running snapshot until an authoritative remote event replaces
    // it. Offline/removed transport must never masquerade as agent completion.
  }

  private async doConnect(runtime: HostRuntime, replace?: "if-idle" | "force"): Promise<void> {
    runtime.generation += 1;
    const generation = runtime.generation;
    const wasOnline = runtime.connectedAt !== null;
    this.teardown(runtime);
    const controller = new AbortController();
    runtime.controller = controller;
    const stale = () => generation !== runtime.generation || !runtime.wanted || controller.signal.aborted;
    runtime.authRetryAfter = 0;
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
          started.error === "server_identity_unknown" ? "server_identity_unknown" : "start_failed",
          `The remote server did not start (${String(started.error ?? "unknown")}).`,
          typeof started.log === "string" ? started.log : undefined,
        );
      }
      runtime.password = String(started.password ?? "");
      runtime.remotePort = Number(started.port);
      runtime.version = bundle.version;

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
      if (stale()) return; // A change listener may disconnect/remove synchronously.
      this.startRunningStream(runtime, generation);
      runtime.healthTimer = setInterval(() => void this.checkHealth(runtime, generation), HEALTH_INTERVAL_MS);
      runtime.healthTimer.unref?.();
      // Each server version takes ~160 MB on the host. Remove the ones nothing
      // uses: never the running one, and none installed in the last day, since
      // another window may be installing or starting it right now.
      void this.bootstrap(runtime, ["prune", `--min-age-hours=${PRUNE_MIN_AGE_HOURS}`, bundle.version], 60_000)
        .catch(() => undefined);
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
      const signal = runtime.controller?.signal;
      signal?.throwIfAborted();
      result = await runSsh(runtime.config.ssh, `sh -s -- ${args.join(" ")}`, { stdin: BOOTSTRAP_SCRIPT, timeoutMs, signal });
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

  private async install(runtime: HostRuntime, bundle: ServerBundle, platform: string): Promise<void> {
    const signal = runtime.controller!.signal;
    signal.throwIfAborted();
    const tar = spawnBundleTar(bundle, platform);
    const upload = new AbortController();
    const cancel = () => upload.abort();
    const killTar = () => {
      tar.stdout?.destroy();
      if (tar.exitCode === null) tar.kill("SIGKILL");
    };
    signal.addEventListener("abort", cancel, { once: true });
    upload.signal.addEventListener("abort", killTar, { once: true });
    let tarError = "";
    tar.stderr?.on("data", (chunk: Buffer) => { tarError = (tarError + chunk.toString("utf8")).slice(-4000); });
    const tarDone = new Promise<void>((resolve, reject) => {
      tar.once("error", (error) => { upload.abort(); reject(error); });
      tar.once("close", (code) => {
        if (code === 0) resolve();
        else { upload.abort(); reject(new Error(`tar exited with code ${code}: ${tarError}`)); }
      });
    });
    // Handle an early tar failure even if SSH fails to spawn synchronously.
    void tarDone.catch(() => undefined);
    let transfer: Promise<void> | undefined;
    try {
      signal.throwIfAborted();
      upload.signal.throwIfAborted();
      transfer = runSsh(runtime.config.ssh, installCommand(bundle.version), {
        stdin: tar.stdout!, timeoutMs: 15 * 60_000, signal: upload.signal,
      }).then((result) => {
        if (result.code === 0 && lastJsonLine(result.stdout)?.ok === true) return;
        if (result.code === 255) throw sshError(result);
        throw new HostConnectError("install_failed", "Uploading the server failed.", `${result.stderr}\n${tarError}`.trim());
      });
      await Promise.all([transfer, tarDone]);
      signal.throwIfAborted();
    } catch (error) {
      throw error instanceof HostConnectError ? error : new HostConnectError("install_failed", `Uploading the server failed: ${(error as Error).message}`);
    } finally {
      upload.abort();
      await Promise.allSettled([transfer, tarDone]);
      signal.removeEventListener("abort", cancel);
    }
  }

  private async openTunnel(runtime: HostRuntime, generation: number): Promise<void> {
    const signal = runtime.controller!.signal;
    signal.throwIfAborted();
    const localPort = await freePort(runtime.localPort);
    signal.throwIfAborted();
    if (generation !== runtime.generation) return;
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
      if (generation !== runtime.generation || !runtime.wanted || runtime.tunnel !== tunnel || runtime.status !== "online") return;
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
      await waitForPort(localPort, 30_000, () => exited, signal);
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
    const signal = runtime.controller!.signal;
    signal.throwIfAborted();
    const response = await undici.request(`http://127.0.0.1:${runtime.localPort}/api/web-auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: runtime.password ?? "" }),
      dispatcher: this.dispatcher,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    await response.body.dump();
    signal.throwIfAborted();
    const setCookie = response.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const session = cookies.map((value) => value.split(";")[0]!).find((value) => /^pi_web_session=.+/.test(value));
    if (response.statusCode !== 200 || !session) {
      // Missing auth, bad credentials and rate limits need intervention, not
      // another reconnect loop hitting the remote's global login throttle.
      throw new HostConnectError("login_rejected", `The remote server rejected the login (HTTP ${response.statusCode}, session cookie ${session ? "present" : "missing"}).`);
    }
    runtime.cookie = session;
  }

  private async fetchInfo(runtime: HostRuntime, timeoutMs: number): Promise<RemoteServerInfo> {
    const signal = AbortSignal.any([runtime.controller!.signal, AbortSignal.timeout(timeoutMs)]);
    const url = `http://127.0.0.1:${runtime.localPort}/api/remote-info`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal.throwIfAborted();
      const cookie = runtime.cookie;
      const response = await undici.request(url, {
        headers: { ...(cookie ? { cookie } : {}), accept: "application/json" },
        dispatcher: this.dispatcher,
        signal,
      });
      if (response.statusCode === 200) return await response.body.json() as RemoteServerInfo;
      await response.body.dump();
      signal.throwIfAborted();
      if (response.statusCode === 401 && attempt === 0) {
        await this.reauthenticate(runtime, cookie);
        continue;
      }
      throw new HostConnectError(response.statusCode === 401 ? "login_rejected" : "handshake_failed", `remote-info returned HTTP ${response.statusCode}`);
    }
    throw new HostConnectError("handshake_failed", "remote-info failed");
  }

  private async checkHealth(runtime: HostRuntime, generation: number): Promise<void> {
    if (generation !== runtime.generation || runtime.status !== "online") return;
    if (runtime.healthCheck) return runtime.healthCheck;
    const check = (async () => {
      try {
        await this.fetchInfo(runtime, 10_000);
        if (generation !== runtime.generation || runtime.status !== "online") return;
        runtime.healthFailures = 0;
        runtime.lastOnlineAt = now();
      } catch (error) {
        if (generation !== runtime.generation || runtime.status !== "online") return;
        if (error instanceof HostConnectError && error.code === "login_rejected") {
          this.teardown(runtime);
          this.setStatus(runtime, "error", null, { code: error.code, message: error.message });
          return;
        }
        runtime.healthFailures += 1;
        if (runtime.healthFailures >= 2) {
          this.teardown(runtime);
          this.setStatus(runtime, "reconnecting", null, null);
          this.scheduleConnect(runtime, 0);
        }
      }
    })().finally(() => {
      if (runtime.healthCheck === check) runtime.healthCheck = null;
    });
    runtime.healthCheck = check;
    return check;
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
            if (controller.signal.aborted || generation !== runtime.generation || runtime.status !== "online") return;
            const data = JSON.parse(event.data) as { type?: string; runningSessionIds?: string[]; sessionListVersion?: number };
            if (data.type !== "running" || !Array.isArray(data.runningSessionIds) || !data.runningSessionIds.every((id) => typeof id === "string")) continue;
            const ids = data.runningSessionIds;
            const listVersion = typeof data.sessionListVersion === "number" ? data.sessionListVersion : runtime.running.listVersion;
            const changed = ids.join(",") !== runtime.running.ids.join(",") || listVersion !== runtime.running.listVersion;
            runtime.running = { ...runtime.running, ids, listVersion };
            if (changed) this.emitChange();
          }
        } catch {
          if (controller.signal.aborted) return;
        }
        await delay(2_000, undefined, { signal: controller.signal }).catch(() => undefined);
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
