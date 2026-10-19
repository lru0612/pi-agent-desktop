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
 *   prune [--min-age-hours=N] <keep>...
 *                            -> { ok, removed }   (never removes the running version,
 *                               nor one installed less than N hours ago)
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
// One file per running server, written by headless-launcher.cjs. state.json only
// names the current server; this registry also finds older ones to reap.
const SERVERS = path.join(ROOT, "servers");
// Serializes start/stop/prune between bootstraps of concurrent clients.
const LOCK = path.join(ROOT, "lifecycle.lock");
const LOCK_WAIT_MS = Number(process.env.PI_REMOTE_LOCK_WAIT_MS) || 90000;
const START_TIMEOUT_MS = Number(process.env.PI_REMOTE_START_TIMEOUT_MS) || 120000;

function out(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function ensureRoot() {
  for (const dir of [ROOT, VERSIONS, LOGS]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(dir).isDirectory()) throw new Error("Not a private directory: " + dir);
    fs.chmodSync(dir, 0o700);
  }
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}
function installedVersions() {
  try {
    return fs.readdirSync(VERSIONS).filter((name) =>
      fs.existsSync(path.join(VERSIONS, name, "headless-launcher.cjs")));
  } catch { return []; }
}
function runningState() {
  const state = readJson(STATE);
  if (!state) {
    if (fs.existsSync(STATE)) throw new Error("Invalid remote state; refusing to replace a possibly running server");
    return null;
  }
  if (!Number.isInteger(state.pid) || state.pid <= 1) throw new Error("Invalid remote server pid");
  if (!alive(state.pid)) return null;
  // A live PID is not proof of identity (PID reuse, especially without procfs).
  // Keep it as an obstacle to starting; authenticate remote-info before signalling.
  return state;
}
function secret() {
  ensureRoot();
  try {
    const fd = fs.openSync(SECRET, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error("Secret is not a regular file");
      fs.fchmodSync(fd, 0o600);
      const value = fs.readFileSync(fd, "utf8").trim();
      if (value.length < 16) throw new Error("Invalid remote secret; refusing to rotate a running server's credentials");
      return value;
    } finally { fs.closeSync(fd); }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  // Exclusive create: a concurrent bootstrap must not replace our credentials.
  const value = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(SECRET, value + "\n", { mode: 0o600, flag: "wx" });
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
function matchesServer(probe, state) {
  return probe && probe.status === 200 && probe.info &&
    probe.info.pid === state.pid && probe.info.headless === true;
}
function readText(file) { try { return fs.readFileSync(file, "utf8"); } catch { return null; } }
async function withLifecycleLock(action) {
  ensureRoot();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }) + "\n", { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const raw = readText(LOCK);
    if (raw === null) continue;
    let held = null;
    try { held = JSON.parse(raw); } catch { held = null; }
    let stale;
    if (held && Number.isInteger(held.pid)) {
      // A bootstrap killed together with its ssh session leaves the file; a
      // hung one gets far longer than any start can take.
      stale = !alive(held.pid) || Date.now() - Number(held.at || 0) > 300000;
    } else {
      // Created but not written yet, or garbage: judge by age.
      try { stale = Date.now() - fs.statSync(LOCK).mtimeMs > 10000; } catch { stale = false; }
    }
    // Only remove the exact lock judged stale, not one another waiter just took.
    if (stale && readText(LOCK) === raw) {
      try { fs.unlinkSync(LOCK); } catch { /* another waiter removed it */ }
      continue;
    }
    if (Date.now() >= deadline) return out({ ok: false, error: "lifecycle_busy", holder: held && held.pid });
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    return await action();
  } finally {
    const held = readJson(LOCK);
    if (held && held.pid === process.pid) { try { fs.unlinkSync(LOCK); } catch { /* gone */ } }
  }
}
// Servers left behind by an earlier start (a crash between steps, a client of
// an older version) are stopped once they are provably ours and idle. Busy
// ones keep their agents and are reaped by a later connect.
async function reapIdle(currentPid, password) {
  const reaped = [];
  let names = [];
  try { names = fs.readdirSync(SERVERS); } catch { return reaped; }
  for (const name of names) {
    const file = path.join(SERVERS, name);
    const entry = readJson(file);
    const pid = entry && entry.pid;
    if (!Number.isInteger(pid) || pid <= 1 || name !== pid + ".json" || pid === currentPid) continue;
    if (!alive(pid)) { try { fs.unlinkSync(file); } catch { /* gone */ } continue; }
    if (!Number.isInteger(entry.port)) continue;
    if (!matchesServer(await getInfo(entry.port, password), entry)) continue;
    const busy = await getJson(entry.port, password, "/api/agent/running");
    const ids = busy && busy.status === 200 && busy.json && Array.isArray(busy.json.runningSessionIds)
      ? busy.json.runningSessionIds : null;
    if (ids === null || ids.length > 0) continue;
    try { process.kill(pid, "SIGTERM"); } catch { continue; }
    for (let i = 0; i < 50 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 100));
    if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    try { fs.unlinkSync(file); } catch { /* removed by its exit handler */ }
    reaped.push(pid);
  }
  return reaped;
}
async function stop(state = runningState(), password = secret()) {
  if (!state) return false;
  if (!matchesServer(await getInfo(state.port, password), state)) return false;
  const current = runningState();
  if (!current || current.pid !== state.pid || current.port !== state.port || current.version !== state.version) return false;
  try { process.kill(state.pid, "SIGTERM"); } catch { return false; }
  for (let i = 0; i < 50 && alive(state.pid); i += 1) await new Promise((r) => setTimeout(r, 100));
  if (alive(state.pid)) { try { process.kill(state.pid, "SIGKILL"); } catch { /* gone */ } }
  return true;
}

async function start(version, mode) {
  if (!version || !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(version)) return out({ ok: false, error: "usage", message: "start <version>" });
  const dir = path.join(VERSIONS, version);
  if (!fs.existsSync(path.join(dir, "headless-launcher.cjs"))) {
    return out({ ok: false, error: "not_installed", version, versions: installedVersions() });
  }
  const password = secret();
  const running = runningState();
  if (running) {
    const probe = await getInfo(running.port, password);
    if (!matchesServer(probe, running)) {
      // Broken health/auth never proves idleness, even for the requested version.
      // Force is not permission to signal an unverified/reused PID either.
      return out({ ok: false, error: "server_identity_unknown", running });
    }
    if (running.version === version) {
      const reaped = await reapIdle(running.pid, password);
      return out({ ok: true, reused: true, port: running.port, pid: running.pid, version, password, info: probe.info, reaped });
    }
    if (mode === "never") {
      return out({ ok: false, error: "other_version_running", running });
    } else if (mode === "if-idle") {
      // Replacing the server kills its agent runs; only do it when none is active.
      const busy = await getJson(running.port, password, "/api/agent/running");
      const ids = busy && busy.status === 200 && busy.json && Array.isArray(busy.json.runningSessionIds)
        ? busy.json.runningSessionIds : null;
      if (ids === null || ids.length > 0) {
        return out({ ok: false, error: "other_version_busy", running, busySessionIds: ids || [] });
      }
    }
    if (!await stop(running, password) || alive(running.pid)) {
      return out({ ok: false, error: "server_identity_unknown", running });
    }
  }
  ensureRoot();
  const port = await freePort();
  const logFd = fs.openSync(LOG_FILE, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  fs.fchmodSync(logFd, 0o600);
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
  child.on("error", (error) => { exited = { message: error.message }; });
  child.on("exit", (code, signal) => { exited = { code, signal }; });
  fs.closeSync(logFd);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      return out({ ok: false, error: "server_exited", exit: exited, log: tail(LOG_FILE, 40) });
    }
    const probe = await getInfo(port, password);
    if (matchesServer(probe, { pid: child.pid })) {
      const reaped = await reapIdle(child.pid, password);
      return out({ ok: true, reused: false, port, pid: child.pid, version, password, info: probe.info, reaped });
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Never leave a half-started server behind: the next start would find it in
  // state.json without being able to verify it.
  try { process.kill(child.pid, "SIGTERM"); } catch { /* already gone */ }
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
    return withLifecycleLock(() => start(args[0], mode));
  }
  if (action === "stop") return withLifecycleLock(async () => out({ ok: true, stopped: await stop() }));
  if (action === "logs") {
    const lines = Number.parseInt(args[0] || "200", 10) || 200;
    return out({ ok: true, file: LOG_FILE, text: tail(LOG_FILE, lines) });
  }
  if (action === "prune") return withLifecycleLock(async () => {
    // Another window may be installing or starting a version right now: only
    // versions older than --min-age-hours are candidates (by directory mtime,
    // which is set when the tarball is unpacked).
    let minAgeMs = 0;
    const keep = new Set();
    for (const arg of args) {
      const age = /^--min-age-hours=(\d{1,5})$/.exec(arg);
      if (age) minAgeMs = Number(age[1]) * 3600 * 1000;
      else keep.add(arg);
    }
    const running = runningState();
    if (running) keep.add(running.version);
    const removed = [];
    for (const name of installedVersions()) {
      if (keep.has(name)) continue;
      const dir = path.join(VERSIONS, name);
      if (minAgeMs > 0) {
        let mtimeMs;
        try { mtimeMs = fs.statSync(dir).mtimeMs; } catch { continue; }
        if (Date.now() - mtimeMs < minAgeMs) continue;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    }
    return out({ ok: true, removed });
  });
  return out({ ok: false, error: "usage", message: "unknown action " + action });
}
main().catch((error) => out({ ok: false, error: "exception", message: String(error && error.stack || error) }));
PI_REMOTE_JS
`;

/**
 * Remote command that unpacks a server tarball (gzip, streamed on stdin) into
 * ~/.pi-remote/versions/<version>. Existing bundles are immutable. A per-version
 * lock serializes publishers; incomplete uploads are removed, never published.
 * A lock left by SIGKILL needs manual removal rather than unsafe stale recovery.
 */
export function installCommand(version: string): string {
  if (!isSafeVersion(version)) throw new Error(`unsafe version string: ${version}`);
  return [
    "set -e",
    "umask 077",
    'root="$HOME/.pi-remote"',
    'versions="$root/versions"',
    'for dir in "$root" "$versions"; do test ! -L "$dir" || exit 1; mkdir -p "$dir"; chmod 700 "$dir"; done',
    `target="$versions/${version}"`,
    `lock="$versions/.${version}.install-lock"`,
    'mkdir "$lock"',
    'tmp=""',
    `trap '[ -z "$tmp" ] || rm -rf "$tmp"; rmdir "$lock"' 0`,
    `trap 'exit 1' HUP INT TERM`,
    'test ! -e "$target" && test ! -L "$target"',
    `tmp=$(mktemp -d "$versions/.${version}.tmp.XXXXXX")`,
    'tar -xzf - -C "$tmp"',
    'test -f "$tmp/headless-launcher.cjs" && test -f "$tmp/server.js"',
    'mv "$tmp" "$target"',
    'tmp=""',
    `echo '{"ok":true,"installed":"${version}"}'`,
  ].join(" && ");
}

/** Versions travel inside shell commands; allow only a conservative charset. */
export function isSafeVersion(version: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(version);
}
