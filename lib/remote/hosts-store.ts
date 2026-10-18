/**
 * Persisted list of remote hosts (fork-owned, server-only).
 *
 * Stored at <agentDir>/pi-desktop/remote-hosts.json. Only connection targets
 * live here: no passwords (they are read from the remote over SSH on every
 * connect and kept in memory) and no project lists (those come from each
 * remote's own session list).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface RemoteHostConfig {
  /** URL-safe id used in /api/r/<id>/… and in client-side keys. */
  id: string;
  /** Display name shown in the UI. */
  label: string;
  /** SSH target: a ~/.ssh/config alias, `user@host`, or `user@host -p 2222`. */
  ssh: string;
  addedAt: string;
}

interface HostsFile {
  version: 1;
  hosts: RemoteHostConfig[];
}

const HOST_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RESERVED_IDS = new Set(["local", "aggregate", "events", "ssh-config"]);

export function remoteHostsFile(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-desktop", "remote-hosts.json");
}

export function isValidHostId(id: string): boolean {
  return HOST_ID_PATTERN.test(id) && !RESERVED_IDS.has(id);
}

export function loadRemoteHosts(file = remoteHostsFile()): RemoteHostConfig[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HostsFile>;
    if (!Array.isArray(parsed.hosts)) return [];
    return parsed.hosts.filter((host): host is RemoteHostConfig => (
      typeof host?.id === "string"
      && isValidHostId(host.id)
      && typeof host.ssh === "string"
      && host.ssh.trim().length > 0
      && typeof host.label === "string"
    ));
  } catch {
    return [];
  }
}

export function saveRemoteHosts(hosts: RemoteHostConfig[], file = remoteHostsFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const data: HostsFile = { version: 1, hosts };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Derive a stable, unique id from a label or SSH target. */
export function makeHostId(source: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  // "user@host.example.com -p 22" -> "host"; "devbox" -> "devbox".
  const target = splitSshTarget(source).find((part) => !part.startsWith("-")) ?? source;
  const hostPart = target.includes("@") ? target.slice(target.lastIndexOf("@") + 1) : target;
  let base = hostPart.split(".")[0]!
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  if (!base || !/^[a-z0-9]/.test(base) || RESERVED_IDS.has(base)) base = `host-${base || "1"}`.slice(0, 24);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("could not allocate a host id");
}

/**
 * Split an SSH target string into argv parts. Supports single/double quotes
 * and backslash escapes; no shell expansion (the result goes to spawn()).
 */
export function splitSshTarget(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let hasToken = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < input.length) current += input[++i];
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
    } else if (ch === "\\" && i + 1 < input.length) {
      current += input[++i];
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) parts.push(current);
      current = "";
      hasToken = false;
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (quote) throw new Error("unterminated quote in SSH target");
  if (hasToken) parts.push(current);
  return parts;
}

/** Validate a user-entered SSH target; returns argv parts or throws. */
export function parseSshTarget(input: string): string[] {
  const parts = splitSshTarget(input.trim());
  if (parts.length === 0) throw new Error("SSH target is empty");
  if (!parts.some((part) => !part.startsWith("-"))) throw new Error("SSH target has no host");
  // Remote commands are added by us; a target that already carries one would
  // run before the bootstrap script. Disallow anything after the host.
  const hostIndex = hostArgIndex(parts);
  if (hostIndex !== parts.length - 1) {
    throw new Error("put SSH options before the host (e.g. \"-p 2222 user@host\")");
  }
  return parts;
}

/** SSH options that take a value (so the next argv part is not the host). */
const OPTIONS_WITH_VALUE = new Set([
  "-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m",
  "-O", "-o", "-P", "-p", "-Q", "-R", "-S", "-W", "-w",
]);

function hostArgIndex(parts: string[]): number {
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (!part.startsWith("-")) return i;
    if (OPTIONS_WITH_VALUE.has(part)) i += 1;
  }
  return -1;
}

/**
 * Normalise "user@host -p 2222" (options after the host, as people often type
 * them) into "-p 2222 user@host".
 */
export function normalizeSshTarget(input: string): string {
  const parts = splitSshTarget(input.trim());
  const hostIndex = hostArgIndex(parts);
  if (hostIndex < 0 || hostIndex === parts.length - 1) return parts.map(quoteIfNeeded).join(" ");
  const reordered = [...parts.slice(0, hostIndex), ...parts.slice(hostIndex + 1), parts[hostIndex]!];
  return reordered.map(quoteIfNeeded).join(" ");
}

function quoteIfNeeded(part: string): string {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`;
}
