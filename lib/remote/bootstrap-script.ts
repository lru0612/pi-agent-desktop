/**
 * Remote bootstrap script, sent over `ssh <host> sh -s -- <action> [args]`.
 *
 * A short POSIX-sh preamble finds a usable Node (>= 22.19) and then runs the
 * embedded Node program, which implements the actions and prints exactly one
 * JSON line on stdout:
 *
 *   probe                    -> { ok, platform, node, home, versions, running }
 *   start <version> [--replace | --replace-if-idle]
 *                            -> { ok, port, pid, version, password, reused, info }
 *                               or { ok:false, error:"other_version_busy", running, busySessionIds }
 *   stop                     -> { ok, stopped }
 *   logs [lines]             -> { ok, file, text }
 *   prune <keep>...          -> { ok, removed }   (never removes the running version)
 *
 * Installing a version is a separate step: the local side streams the server
 * tarball into `ssh <host> sh -s -- ...` with INSTALL_COMMAND (below).
 *
 * Layout on the remote (all under ~/.pi-remote, created 0700):
 *   versions/<version>/   unpacked server tree (headless-launcher.cjs, server.js, ...)
 *   secret                access password, 0600 (generated on first start)
 *   state.json            written by headless-launcher.cjs: { pid, port, version, dir }
 *   logs/server.log       server stdout/stderr
 *
 * Constraint: this file is a String.raw template, so the embedded code must not
 * contain backticks or dollar-brace sequences.
 *
 * Fork-owned. See docs/remote-hosts-design.zh-CN.md §4.4.
 */
export const BOOTSTRAP_SCRIPT = String.raw`
set -u
ROOT="$HOME/.pi-remote"
NODE=""
for c in "$ROOT/node/bin/node" "$(command -v node 2>/dev/null || true)" /usr/local/bin/node /usr/bin/node; do
  [ -n "$c" ] && [ -x "$c" ] || continue
  if "$c" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' 2>/dev/null; then
    NODE="$c"; break
  fi
done
if [ -z "$NODE" ]; then
  printf '{"ok":false,"error":"node_missing","message":"Node.js >= 22.19 not found on the remote host"}\n'
  exit 0
fi
exec "$NODE" - "$@" <<'PI_REMOTE_JS'
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const ROOT = path.join(os.homedir(), ".pi-remote");
const VERSIONS = path.join(ROOT, "versions");
const STATE = path.join(ROOT, "state.json");
const SECRET = path.join(ROOT, "secret");
const LOGS = path.join(ROOT, "logs");
const LOG_FILE = path.join(LOGS, "server.log");

function out(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function ensureRoot() {
  for (const dir of [ROOT, VERSIONS, LOGS]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function installedVersions() {
  try {
    return fs.readdirSync(VERSIONS).filter((name) =>
      fs.existsSync(path.join(VERSIONS, name, "headless-launcher.cjs")));
  } catch { return []; }
}
function runningState() {
  const state = readJson(STATE);
  if (!state || !Number.isInteger(state.pid) || !alive(state.pid)) return null;
  try {
    const cmd = fs.readFileSync("/proc/" + state.pid + "/cmdline", "utf8");
    if (!cmd.includes("headless-launcher.cjs")) return null;
  } catch { /* no procfs (macOS): trust the pid */ }
  return state;
}
function secret() {
  ensureRoot();
  try {
    const value = fs.readFileSync(SECRET, "utf8").trim();
    if (value.length >= 16) return value;
  } catch { /* create below */ }
  const value = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(SECRET, value + "\n", { mode: 0o600 });
  return value;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
function getJson(port, password, urlPath) {
  return new Promise((resolve) => {
    const req = http.get({
      host: "127.0.0.1", port, path: urlPath, timeout: 3000, agent: false,
      headers: { Authorization: "Basic " + Buffer.from("pi:" + password).toString("base64") },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve({ status: res.statusCode });
        try { resolve({ status: 200, json: JSON.parse(body) }); } catch { resolve({ status: -1 }); }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}
async function getInfo(port, password) {
  const result = await getJson(port, password, "/api/remote-info");
  return result && result.status === 200 ? { status: 200, info: result.json } : result;
}
function tail(file, lines) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.split("\n").slice(-lines - 1).join("\n");
  } catch { return ""; }
}
async function stop() {
  const state = runningState();
  if (!state) return false;
  try { process.kill(state.pid, "SIGTERM"); } catch { return false; }
  for (let i = 0; i < 50 && alive(state.pid); i += 1) await new Promise((r) => setTimeout(r, 100));
  if (alive(state.pid)) { try { process.kill(state.pid, "SIGKILL"); } catch { /* gone */ } }
  return true;
}

async function start(version, mode) {
  if (!version) return out({ ok: false, error: "usage", message: "start <version>" });
  const dir = path.join(VERSIONS, version);
  if (!fs.existsSync(path.join(dir, "headless-launcher.cjs"))) {
    return out({ ok: false, error: "not_installed", version, versions: installedVersions() });
  }
  const password = secret();
  const running = runningState();
  if (running) {
    if (running.version === version) {
      const probe = await getInfo(running.port, password);
      if (probe && probe.status === 200) {
        return out({ ok: true, reused: true, port: running.port, pid: running.pid, version, password, info: probe.info });
      }
    } else if (mode === "never") {
      return out({ ok: false, error: "other_version_running", running });
    } else if (mode === "if-idle") {
      // Replacing the server kills its agent runs; only do it when none is active.
      const busy = await getJson(running.port, password, "/api/agent/running");
      const ids = busy && busy.status === 200 && Array.isArray(busy.json.runningSessionIds)
        ? busy.json.runningSessionIds : null;
      if (ids === null || ids.length > 0) {
        return out({ ok: false, error: "other_version_busy", running, busySessionIds: ids || [] });
      }
    }
    await stop();
  }
  ensureRoot();
  const port = await freePort();
  const logFd = fs.openSync(LOG_FILE, "a", 0o600);
  const child = spawn(process.execPath, [path.join(dir, "headless-launcher.cjs")], {
    cwd: dir,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      PI_WEB_PASSWORD_FILE: SECRET,
      PI_REMOTE_STATE_FILE: STATE,
      PI_WEB_SKIP_VERSION_CHECK: "1",
    },
  });
  child.unref();
  let exited = null;
  child.on("exit", (code, signal) => { exited = { code, signal }; });
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (exited) {
      return out({ ok: false, error: "server_exited", exit: exited, log: tail(LOG_FILE, 40) });
    }
    const probe = await getInfo(port, password);
    if (probe && probe.status === 200) {
      return out({ ok: true, reused: false, port, pid: child.pid, version, password, info: probe.info });
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return out({ ok: false, error: "start_timeout", port, pid: child.pid, log: tail(LOG_FILE, 40) });
}

async function main() {
  const [action = "probe", ...args] = process.argv.slice(2);
  if (action === "probe") {
    return out({
      ok: true,
      platform: process.platform + "-" + process.arch,
      node: process.version,
      home: os.homedir(),
      versions: installedVersions(),
      running: runningState(),
    });
  }
  if (action === "start") {
    const mode = args.includes("--replace") ? "force" : args.includes("--replace-if-idle") ? "if-idle" : "never";
    return start(args[0], mode);
  }
  if (action === "stop") return out({ ok: true, stopped: await stop() });
  if (action === "logs") {
    const lines = Number.parseInt(args[0] || "200", 10) || 200;
    return out({ ok: true, file: LOG_FILE, text: tail(LOG_FILE, lines) });
  }
  if (action === "prune") {
    const keep = new Set(args);
    const running = runningState();
    if (running) keep.add(running.version);
    const removed = [];
    for (const name of installedVersions()) {
      if (keep.has(name)) continue;
      fs.rmSync(path.join(VERSIONS, name), { recursive: true, force: true });
      removed.push(name);
    }
    return out({ ok: true, removed });
  }
  return out({ ok: false, error: "usage", message: "unknown action " + action });
}
main().catch((error) => out({ ok: false, error: "exception", message: String(error && error.stack || error) }));
PI_REMOTE_JS
`;

/**
 * Remote command that unpacks a server tarball (gzip, streamed on stdin) into
 * ~/.pi-remote/versions/<version>. Atomic: unpacks into a temp dir and renames.
 * The version string must already be validated by the caller (see isSafeVersion).
 */
export function installCommand(version: string): string {
  if (!isSafeVersion(version)) throw new Error(`unsafe version string: ${version}`);
  const target = `"$HOME/.pi-remote/versions/${version}"`;
  const tmp = `"$HOME/.pi-remote/versions/.${version}.tmp.$$"`;
  return [
    "set -e",
    'mkdir -p "$HOME/.pi-remote/versions"',
    'chmod 700 "$HOME/.pi-remote"',
    `rm -rf ${tmp}`,
    `mkdir -p ${tmp}`,
    `tar -xzf - -C ${tmp}`,
    `rm -rf ${target}`,
    `mv ${tmp} ${target}`,
    `echo '{"ok":true,"installed":"${version}"}'`,
  ].join(" && ");
}

/** Versions travel inside shell commands; allow only a conservative charset. */
export function isSafeVersion(version: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(version);
}
