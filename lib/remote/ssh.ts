/**
 * Thin wrappers around the system `ssh` client (fork-owned, server-only).
 *
 * We deliberately shell out to OpenSSH instead of embedding an SSH library:
 * the user's ~/.ssh/config, agent, ProxyJump and known_hosts all keep working.
 * Authentication must be non-interactive (keys / agent); BatchMode makes a
 * password prompt fail fast instead of hanging a server request.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

import { parseSshTarget } from "./hosts-store";

/** Options shared by every ssh invocation. */
export function sshCommonOptions(): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=20",
    // The platform gateway closes SSH connections after 20 minutes without
    // traffic; keepalives also detect dead tunnels within ~45 s.
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    // Never let a remote host pull credentials or displays through us.
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
  ];
}

/** Lines OpenSSH prints that are noise, not errors. */
const NOISE = [
  /client_global_hostkeys_prove_confirm/,
  /^Warning: Permanently added /,
  /^\*\* WARNING: connection is not using a post-quantum key exchange/,
  /^\*\* This session may be vulnerable/,
  /^\*\* The server may need to be upgraded/,
];

export function cleanSshStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => line.trim() && !NOISE.some((pattern) => pattern.test(line)))
    .join("\n");
}

export interface SshResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunSshOptions {
  /** Data written to the remote command's stdin. */
  stdin?: string | Buffer | Readable;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Run one remote command and collect its output. */
export function runSsh(target: string, remoteCommand: string, options: RunSshOptions = {}): Promise<SshResult> {
  // ClearAllForwardings: a LocalForward in the user's ssh config must not make
  // every bootstrap command fight over the same port.
  const args = [...sshCommonOptions(), "-o", "ClearAllForwardings=yes", "-T", ...parseSshTarget(target), remoteCommand];
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : null;
    const onAbort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: cleanSshStderr(Buffer.concat(stderr).toString("utf8")),
        timedOut,
      });
    });
    // The remote end may close stdin early (e.g. a failing install); ignore EPIPE.
    child.stdin!.on("error", () => {});
    const input = options.stdin;
    if (input === undefined) child.stdin!.end();
    else if (typeof input === "string" || Buffer.isBuffer(input)) child.stdin!.end(input);
    else input.pipe(child.stdin!);
  });
}

/** Long-lived `ssh -N -L` port forward from 127.0.0.1:localPort to the remote loopback. */
export function spawnTunnel(target: string, localPort: number, remotePort: number): ChildProcess {
  const args = [
    ...sshCommonOptions(),
    "-N",
    "-o", "ExitOnForwardFailure=yes",
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    ...parseSshTarget(target),
  ];
  return spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
}

export type SshFailureKind = "auth" | "host_key" | "unreachable" | "timeout" | "not_found" | "other";

/** Classify an ssh failure for the UI. */
export function classifySshFailure(result: Pick<SshResult, "stderr" | "timedOut">, error?: unknown): SshFailureKind {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return "not_found";
  if (result.timedOut) return "timeout";
  const text = result.stderr;
  if (/Permission denied|Too many authentication failures|no matching host key type|Authentication failed/i.test(text)) return "auth";
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) return "host_key";
  if (/Could not resolve hostname|Connection refused|No route to host|Network is unreachable|Connection timed out|Operation timed out|Connection closed by|kex_exchange_identification/i.test(text)) {
    return /timed out/i.test(text) ? "timeout" : "unreachable";
  }
  return "other";
}
