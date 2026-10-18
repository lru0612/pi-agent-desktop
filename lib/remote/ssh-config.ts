/**
 * ~/.ssh/config host discovery and connection diagnostics (fork-owned,
 * server-only).
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { userHome } from "../user-home.ts";
import { basename, dirname, isAbsolute, join } from "node:path";

import { BOOTSTRAP_SCRIPT } from "./bootstrap-script.ts";
import { findServerBundleDir, readServerBundle } from "./bundle.ts";
import { runSsh } from "./ssh.ts";

export interface SshConfigHost {
  alias: string;
  hostName?: string;
  user?: string;
  port?: string;
}

function expandIncludes(pattern: string, sshDir: string): string[] {
  const expanded = pattern.startsWith("~/") ? join(userHome(), pattern.slice(2)) : pattern;
  const full = isAbsolute(expanded) ? expanded : join(sshDir, expanded);
  const name = basename(full);
  if (!/[*?]/.test(name)) return [full];
  const regex = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  try {
    return readdirSync(dirname(full)).filter((entry) => regex.test(entry)).sort().map((entry) => join(dirname(full), entry));
  } catch {
    return [];
  }
}

/** Parse Host blocks (concrete aliases only) from ssh config text. Exported for tests. */
export function parseSshConfig(text: string, include?: (pattern: string) => string[]): SshConfigHost[] {
  const hosts: SshConfigHost[] = [];
  let current: SshConfigHost[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const match = /^([^\s=]+)\s*(?:=\s*|\s+)(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (key === "include" && include) {
      for (const file of value.split(/\s+/).flatMap(include)) {
        try {
          hosts.push(...parseSshConfig(readFileSync(file, "utf8")));
        } catch {
          // unreadable include
        }
      }
      continue;
    }
    if (key === "host") {
      current = value.split(/\s+/)
        .filter((alias) => alias && !/[*?!]/.test(alias))
        .map((alias) => ({ alias }));
      hosts.push(...current);
      continue;
    }
    if (key === "match") {
      current = [];
      continue;
    }
    for (const host of current) {
      if (key === "hostname") host.hostName ??= value;
      else if (key === "user") host.user ??= value;
      else if (key === "port") host.port ??= value;
    }
  }
  const seen = new Set<string>();
  return hosts.filter((host) => (seen.has(host.alias) ? false : (seen.add(host.alias), true)));
}

export function listSshConfigHosts(): SshConfigHost[] {
  const sshDir = join(userHome(), ".ssh");
  try {
    return parseSshConfig(readFileSync(join(sshDir, "config"), "utf8"), (pattern) => expandIncludes(pattern, sshDir));
  } catch {
    return [];
  }
}

export interface DoctorStep {
  name: string;
  ok: boolean;
  detail?: string;
}

/** Run every connection step once and report what works (for the "Diagnose" button). */
export async function diagnoseHost(ssh: string): Promise<DoctorStep[]> {
  const steps: DoctorStep[] = [];
  const version = spawnSync("ssh", ["-V"], { encoding: "utf8" });
  steps.push({
    name: "local_ssh",
    ok: version.status === 0,
    detail: (version.stderr || version.stdout || version.error?.message || "").trim(),
  });
  const bundleDir = findServerBundleDir();
  let bundleVersion: string | null = null;
  try {
    bundleVersion = bundleDir ? readServerBundle(bundleDir).version : null;
  } catch {
    bundleVersion = null;
  }
  steps.push({ name: "local_bundle", ok: Boolean(bundleVersion), detail: bundleVersion ?? "not found (run npm run desktop:prepare)" });

  const probe = await runSsh(ssh, "sh -s -- probe", { stdin: BOOTSTRAP_SCRIPT, timeoutMs: 60_000 })
    .catch((error: Error) => ({ code: null, stdout: "", stderr: error.message, timedOut: false }));
  const probeJson = probe.stdout.trim().split("\n").pop() ?? "";
  steps.push({
    name: "ssh_probe",
    ok: probe.code === 0 && probeJson.startsWith("{") && probeJson.includes("\"ok\":true"),
    detail: [probeJson, probe.stderr].filter(Boolean).join("\n").slice(-4000),
  });
  if (probe.code === 0) {
    const logs = await runSsh(ssh, "sh -s -- logs 80", { stdin: BOOTSTRAP_SCRIPT, timeoutMs: 30_000 })
      .catch(() => null);
    if (logs) {
      try {
        const parsed = JSON.parse(logs.stdout.trim().split("\n").pop() ?? "{}") as { file?: string; text?: string };
        steps.push({ name: "remote_log", ok: true, detail: `${parsed.file ?? ""}\n${parsed.text ?? ""}`.trim().slice(-8000) });
      } catch {
        // ignore
      }
    }
  }
  return steps;
}
