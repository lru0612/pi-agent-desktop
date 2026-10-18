"use strict";

// Headless entry point for running the packaged pi-web server on a remote
// machine (reached by the desktop app through an SSH tunnel). Unlike
// desktop-server.cjs it has no parent-process watchdog — it is started with
// setsid/nohup and must outlive the SSH session that launched it.
//
// Environment:
//   PORT                    port to listen on (required)
//   HOSTNAME                bind address, default 127.0.0.1
//   PI_WEB_PASSWORD_FILE    file holding the access password (recommended;
//                           keeps the secret out of argv and the env of the
//                           ssh command that starts us)
//   PI_REMOTE_STATE_FILE    where to write {pid, port, version, startedAt}
//
// Fork-owned. See docs/remote-hosts-design.zh-CN.md §4.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");

function log(message) {
  // The stream wrapper below adds the timestamp.
  process.stderr.write(`[pi-remote] ${message}\n`);
}

function fail(message) {
  log(message);
  process.exit(1);
}

// Timestamp every line, as desktop-server.cjs does: the output goes to a log
// file that is otherwise impossible to correlate with user reports.
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  let atLineStart = true;
  stream.write = (chunk, encoding, callback) => {
    if (typeof chunk === "string" || chunk instanceof Uint8Array) {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const stamp = `${new Date().toISOString()} `;
      const stamped = (atLineStart ? stamp : "") + text.replace(/\n(?=[^])/g, `\n${stamp}`);
      atLineStart = text.endsWith("\n");
      return write(stamped, typeof encoding === "string" ? encoding : undefined, typeof encoding === "function" ? encoding : callback);
    }
    return write(chunk, encoding, callback);
  };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

process.env.HOSTNAME = (process.env.HOSTNAME || "127.0.0.1").trim();
process.env.NODE_ENV = "production";
process.env.NEXT_TELEMETRY_DISABLED = "1";
process.env.PI_REMOTE_HEADLESS = "1";

const port = Number.parseInt(process.env.PORT ?? "", 10);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  fail(`PORT must be set to a valid port (got "${process.env.PORT ?? ""}")`);
}

const passwordFile = process.env.PI_WEB_PASSWORD_FILE;
if (passwordFile) {
  let password;
  try {
    password = fs.readFileSync(passwordFile, "utf8").trim();
  } catch (error) {
    fail(`cannot read PI_WEB_PASSWORD_FILE ${passwordFile}: ${error.message}`);
  }
  if (password.length < 16) fail("password in PI_WEB_PASSWORD_FILE is shorter than 16 characters");
  process.env.PI_WEB_PASSWORD = password;
}
delete process.env.PI_WEB_PASSWORD_FILE;

// Same rule as bin/network-exposure-warning.js: never expose an
// unauthenticated agent beyond loopback.
if (!LOOPBACK.has(process.env.HOSTNAME) && !process.env.PI_WEB_PASSWORD) {
  fail(`refusing to listen on ${process.env.HOSTNAME} without a password`);
}
if (!process.env.PI_WEB_PASSWORD) {
  log("warning: no password configured; any local user on this machine can reach the server port");
}

// Overwrite-install leftovers: see desktop-server.cjs (#72).
try {
  const scopeDir = path.join(__dirname, "node_modules", "@earendil-works");
  for (const pkg of fs.readdirSync(scopeDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const nested = path.join(scopeDir, pkg.name, "node_modules", "@earendil-works");
    if (fs.existsSync(nested)) fs.rmSync(nested, { recursive: true, force: true });
  }
} catch (error) {
  log(`stale-dependency cleanup failed: ${error.message}`);
}

const stateFile = process.env.PI_REMOTE_STATE_FILE;
if (stateFile) {
  // The install directory name (~/.pi-remote/versions/<version>) is the
  // identity the bootstrap script compares against; appVersion is informative.
  let appVersion = "unknown";
  try {
    appVersion = JSON.parse(fs.readFileSync(path.join(__dirname, "pi-remote-version.json"), "utf8")).appVersion;
  } catch {
    // Older bundles have no version stamp.
  }
  const state = {
    pid: process.pid,
    port,
    version: path.basename(__dirname),
    appVersion,
    dir: __dirname,
    startedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  } catch (error) {
    log(`cannot write state file ${stateFile}: ${error.message}`);
  }
  const clear = () => {
    try {
      const current = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (current.pid === process.pid) fs.rmSync(stateFile, { force: true });
    } catch {
      // Already replaced or removed.
    }
  };
  process.on("exit", clear);
}

// SIGINT/SIGTERM are left to Next's standalone server and
// instrumentation-node.ts (graceful SSE shutdown). nohup already ignores SIGHUP.

log(`starting pi-web on ${process.env.HOSTNAME}:${port} (node ${process.version}, pid ${process.pid})`);

// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./server.js");
