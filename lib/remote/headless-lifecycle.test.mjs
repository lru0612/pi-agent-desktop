import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../../desktop/headless-launcher.cjs", import.meta.url), "utf8");

async function launchHarness(t) {
  const home = await mkdtemp(path.join(tmpdir(), "pi-headless-lifecycle-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = path.join(home, "versions", "1.0");
  await mkdir(dir, { recursive: true });
  const secret = path.join(home, "secret");
  const state = path.join(home, "state.json");
  await writeFile(secret, "a-test-password-not-a-real-secret", { mode: 0o644 });
  const process = new EventEmitter();
  const server = { started: false, activeAgent: true };
  Object.assign(process, {
    env: { PORT: "12345", PI_WEB_PASSWORD_FILE: secret, PI_REMOTE_STATE_FILE: state, PI_WEB_PARENT_PID: "1" },
    pid: 4567, version: "v22.23.3",
    stdout: { write() {} }, stderr: { write() {} },
    exit(code) { throw new Error(`exit ${code}`); },
  });
  const run = () => vm.runInNewContext(source, {
    __dirname: dir, process, Buffer,
    require(name) {
      if (name === "node:fs") return fs;
      if (name === "node:path") return path;
      if (name === "./server.js") { server.started = true; return server; }
      throw new Error(`Unexpected module: ${name}`);
    },
  });
  return { home, dir, secret, state, process, server, run };
}

test("headless startup keeps bundles immutable, secures state/secrets and ignores SSH hangup", async (t) => {
  const h = await launchHarness(t);
  const dependency = path.join(h.dir, "node_modules", "@earendil-works", "pkg", "node_modules", "@earendil-works", "keep.js");
  await mkdir(path.dirname(dependency), { recursive: true });
  await writeFile(dependency, "active bundle dependency");
  await writeFile(h.state, "old state", { mode: 0o644 });
  h.run();
  assert.equal(h.server.started, true);
  assert.equal(fs.statSync(h.secret).mode & 0o777, 0o600);
  assert.equal(fs.statSync(h.state).mode & 0o777, 0o600);
  assert.equal(fs.statSync(h.home).mode & 0o777, 0o700);
  assert.equal(h.process.env.PI_WEB_PASSWORD_FILE, undefined);
  assert.equal(h.process.env.HOSTNAME, "127.0.0.1");
  assert.equal(h.process.env.PI_REMOTE_HEADLESS, "1");
  assert.equal(h.process.listenerCount("SIGHUP"), 1);
  h.process.emit("SIGHUP");
  assert.equal(h.server.activeAgent, true);
  assert.equal(fs.existsSync(h.state), true);
  assert.equal(fs.readFileSync(dependency, "utf8"), "active bundle dependency");
  // The bootstrap's reaper finds servers through this registry entry.
  const registry = path.join(h.home, "servers", "4567.json");
  assert.equal(JSON.parse(fs.readFileSync(registry, "utf8")).port, 12345);
  assert.equal(fs.statSync(registry).mode & 0o777, 0o600);
  h.process.emit("exit");
  assert.equal(fs.existsSync(h.state), false);
  assert.equal(fs.existsSync(registry), false);
});

test("an old daemon exit never removes its replacement's state", async (t) => {
  const h = await launchHarness(t);
  h.run();
  await writeFile(h.state, JSON.stringify({ pid: 9999 }));
  h.process.emit("exit");
  assert.equal(JSON.parse(fs.readFileSync(h.state, "utf8")).pid, 9999);
  assert.equal(fs.existsSync(path.join(h.home, "servers", "4567.json")), false, "its own registry entry goes");
});

test("a state-write failure must not leave an untracked daemon running", async (t) => {
  const h = await launchHarness(t);
  h.process.env.PI_REMOTE_STATE_FILE = path.join(h.secret, "state.json");
  assert.throws(h.run, /exit 1/);
  assert.equal(h.server.started, false);
});

test("headless launcher refuses symlinked secrets without reading or chmodding their targets", async (t) => {
  const h = await launchHarness(t);
  const linked = path.join(h.home, "linked-secret");
  fs.symlinkSync(h.secret, linked);
  h.process.env.PI_WEB_PASSWORD_FILE = linked;
  assert.throws(h.run, /exit 1/);
  assert.equal(h.server.started, false);
  assert.equal(fs.statSync(h.secret).mode & 0o777, 0o644);
});
