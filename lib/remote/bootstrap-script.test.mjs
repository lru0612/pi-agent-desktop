import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { BOOTSTRAP_SCRIPT, installCommand, isSafeVersion } from "./bootstrap-script.ts";
import { bootstrapHarness } from "./bootstrap-lifecycle-helpers.mjs";

const execFileAsync = promisify(execFile);

async function runBootstrap(home, args) {
  const child = execFileAsync("sh", ["-s", "--", ...args], {
    env: { ...process.env, HOME: home, PATH: `${join(process.execPath, "..")}:${process.env.PATH}` },
  });
  child.child.stdin.end(BOOTSTRAP_SCRIPT);
  const { stdout } = await child;
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1, `expected exactly one JSON line, got: ${stdout}`);
  return JSON.parse(lines[0]);
}

test("version strings are restricted to a shell-safe charset", () => {
  for (const ok of ["0.7.3", "0.7.3-dev1", "1.0.0+build.5", "v2_rc"]) {
    assert.equal(isSafeVersion(ok), true, ok);
  }
  for (const bad of ["", "../x", "1.0;rm -rf ~", "a b", "$(id)", "`id`", "-rf", ".hidden", "x".repeat(65)]) {
    assert.equal(isSafeVersion(bad), false, bad);
  }
  assert.throws(() => installCommand("1.0;id"), /unsafe version/);
  assert.match(installCommand("0.7.3"), /tar -xzf - -C/);
});

test("probe reports platform and an empty install on a fresh home", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-remote-home-"));
  try {
    const result = await runBootstrap(home, ["probe"]);
    assert.equal(result.ok, true);
    assert.equal(result.platform, `${process.platform}-${process.arch}`);
    assert.deepEqual(result.versions, []);
    assert.equal(result.running, null);
    assert.equal(result.home, home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("start refuses a version that is not installed", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-remote-home-"));
  try {
    const result = await runBootstrap(home, ["start", "9.9.9"]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "not_installed");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("same-version active daemon is reused without signals or replacement", async (t) => {
  const h = await bootstrapHarness(t);
  h.onHttp = (request) => ({ status: 200, json: request.path.endsWith("remote-info")
    ? { pid: h.state.pid, headless: true } : { runningSessionIds: ["active-agent"] } });
  const result = await h.run(["start", "1.0", "--replace-if-idle"]);
  assert.equal(result.reused, true);
  assert.deepEqual(h.kills, []);
  assert.deepEqual(h.spawns, []);
  assert.equal(h.living.has(h.state.pid), true);
});

for (const failure of ["timeout", 401, 429, 500, "wrong-pid", "not-headless"]) {
  test(`same-version ${failure} probe cannot kill or replace a daemon, even with force`, async (t) => {
    const h = await bootstrapHarness(t);
    h.onHttp = () => failure === "timeout" ? { error: "timeout" } : {
      status: typeof failure === "number" ? failure : 200,
      json: { pid: failure === "wrong-pid" ? 1 : h.state.pid, headless: failure !== "not-headless" },
    };
    for (const mode of ["--replace-if-idle", "--replace"]) {
      const result = await h.run(["start", "1.0", mode]);
      assert.equal(result.error, "server_identity_unknown");
      assert.deepEqual(h.kills, []);
      assert.deepEqual(h.spawns, []);
    }
  });
}

for (const activity of [{ runningSessionIds: ["active-agent"] }, null, {}, { runningSessionIds: "bad" }]) {
  test(`replacement requires a verified empty running list (${JSON.stringify(activity)})`, async (t) => {
    const h = await bootstrapHarness(t);
    h.onHttp = (request) => ({ status: 200, json: request.path.endsWith("remote-info")
      ? { pid: h.state.pid, headless: true } : activity });
    const result = await h.run(["start", "2.0", "--replace-if-idle"]);
    assert.equal(result.error, "other_version_busy");
    assert.deepEqual(h.kills, []);
    assert.deepEqual(h.spawns, []);
    assert.equal(h.living.has(h.state.pid), true);
  });
}

test("verified idle version upgrade signals only the verified daemon and detaches the replacement", async (t) => {
  const h = await bootstrapHarness(t);
  const result = await h.run(["start", "2.0", "--replace-if-idle"]);
  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.deepEqual(h.kills, [{ pid: h.state.pid, signal: "SIGTERM" }]);
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].options.detached, true);
  assert.equal(h.spawns[0].options.stdio[0], "ignore");
  assert.equal(h.spawns[0].options.env.HOSTNAME, "127.0.0.1");
});

test("explicit force may replace a busy, authenticated daemon but normal start may not", async (t) => {
  const h = await bootstrapHarness(t);
  h.onHttp = (request) => ({ status: 200, json: request.path.endsWith("remote-info")
    ? { pid: request.port === h.state.port ? h.state.pid : 5678, headless: true }
    : { runningSessionIds: ["active-agent"] } });
  assert.equal((await h.run(["start", "2.0"])).error, "other_version_running");
  assert.deepEqual(h.kills, []);
  assert.equal((await h.run(["start", "2.0", "--replace"])).ok, true);
  assert.deepEqual(h.kills, [{ pid: h.state.pid, signal: "SIGTERM" }]);
});

test("prune keeps the running version and anything installed recently", async (t) => {
  const h = await bootstrapHarness(t); // versions 1.0 (running) and 2.0
  const versions = join(h.root, "versions");
  for (const name of ["0.9", "0.8"]) {
    await mkdir(join(versions, name), { recursive: true });
    await writeFile(join(versions, name, "headless-launcher.cjs"), "// fake");
  }
  const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000);
  for (const name of ["1.0", "0.8"]) await utimes(join(versions, name), twoDaysAgo, twoDaysAgo);
  // 0.9 and 2.0 were "installed" just now: another window may be starting them.
  const result = await h.run(["prune", "--min-age-hours=24", "2.0"]);
  assert.deepEqual(result, { ok: true, removed: ["0.8"] });
  assert.deepEqual((await readdir(versions)).sort(), ["0.9", "1.0", "2.0"]);
  assert.deepEqual(h.kills, []);
  // Without the guard only the kept and running versions survive.
  assert.deepEqual(await h.run(["prune", "2.0"]), { ok: true, removed: ["0.9"] });
});

test("prune fails closed when the running state cannot be read", async (t) => {
  const h = await bootstrapHarness(t);
  await writeFile(h.stateFile, "{ not json");
  const result = await h.run(["prune", "2.0"]);
  assert.equal(result.ok, false);
  assert.deepEqual((await readdir(join(h.root, "versions"))).sort(), ["1.0", "2.0"]);
});

test("start reaps idle servers it can prove are ours and leaves everything else alone", async (t) => {
  const h = await bootstrapHarness(t); // state: pid 1234 on 34567, version 1.0
  const servers = join(h.root, "servers");
  await mkdir(servers, { recursive: true });
  const entry = (pid, port) => writeFile(join(servers, `${pid}.json`), JSON.stringify({ pid, port, version: "0.9" }));
  await entry(1234, 34567); // the current server
  await entry(2001, 40001); // gone
  await entry(2002, 40002); // ours, idle
  await entry(2003, 40003); // ours, running an agent
  await entry(2004, 40004); // port now answered by another process
  for (const pid of [2002, 2003, 2004]) h.living.add(pid);
  const pids = { 34567: 1234, 40002: 2002, 40003: 2003, 40004: 9876 };
  h.onHttp = (request) => request.path.endsWith("remote-info")
    ? { status: 200, json: { pid: pids[request.port], headless: true } }
    : { status: 200, json: { runningSessionIds: request.port === 40003 ? ["busy-agent"] : [] } };
  const result = await h.run(["start", "1.0"]);
  assert.equal(result.reused, true);
  assert.deepEqual(result.reaped, [2002]);
  assert.deepEqual(h.kills, [{ pid: 2002, signal: "SIGTERM" }]);
  assert.deepEqual((await readdir(servers)).sort(), ["1234.json", "2003.json", "2004.json"]);
});

test("lifecycle actions wait for a live lock holder and take over a dead one", async (t) => {
  const h = await bootstrapHarness(t);
  h.env = { PI_REMOTE_LOCK_WAIT_MS: "40" };
  const lock = join(h.root, "lifecycle.lock");
  h.living.add(4242);
  await writeFile(lock, JSON.stringify({ pid: 4242, at: Date.now() }));
  const busy = await h.run(["start", "2.0", "--replace"]);
  assert.deepEqual({ ok: busy.ok, error: busy.error, holder: busy.holder }, { ok: false, error: "lifecycle_busy", holder: 4242 });
  assert.deepEqual(h.kills, [], "nothing is signalled without the lock");
  assert.equal(h.spawns.length, 0);
  h.living.delete(4242); // the holder's ssh session died with the lock held
  assert.equal((await h.run(["start", "1.0"])).reused, true);
  await assert.rejects(stat(lock), { code: "ENOENT" }, "released after use");
});

test("a server that never answers is stopped instead of left half-started", async (t) => {
  const h = await bootstrapHarness(t);
  h.env = { PI_REMOTE_START_TIMEOUT_MS: "30" };
  await writeFile(h.stateFile, JSON.stringify({ ...h.state, pid: 31337 })); // stale: pid gone
  h.onHttp = () => ({ error: "connect ECONNREFUSED" });
  const result = await h.run(["start", "2.0"]);
  assert.equal(result.error, "start_timeout");
  assert.equal(h.spawns.length, 1);
  assert.deepEqual(h.kills, [{ pid: 5678, signal: "SIGTERM" }]);
});

test("stop refuses an unauthenticated or reused PID", async (t) => {
  const h = await bootstrapHarness(t);
  h.onHttp = () => ({ status: 200, json: { pid: 42, headless: true } });
  assert.equal((await h.run(["stop"])).stopped, false);
  assert.deepEqual(h.kills, []);
});

test("installer publishes a complete tree once and never overwrites it", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "pi-install-lifecycle-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = join(home, "source");
  await mkdir(source);
  await writeFile(join(source, "headless-launcher.cjs"), "original launcher");
  await writeFile(join(source, "server.js"), "original server");
  const { stdout: archive } = await execFileAsync("tar", ["-czf", "-", "-C", source, "."], { encoding: "buffer" });
  const install = (data) => {
    const child = execFileAsync("sh", ["-c", installCommand("1.0")], { env: { ...process.env, HOME: home } });
    child.child.stdin.on("error", () => {});
    child.child.stdin.end(data);
    return child;
  };
  await assert.rejects(install(Buffer.from("not a tarball")));
  const versions = join(home, ".pi-remote", "versions");
  assert.deepEqual(await readdir(versions), [], "failed archive and lock must be cleaned up");
  await install(archive);
  await assert.rejects(install(archive), "existing active bundle is immutable");
  assert.equal(await readFile(join(versions, "1.0", "server.js"), "utf8"), "original server");
  assert.deepEqual(await readdir(versions), ["1.0"]);
  assert.equal((await stat(versions)).mode & 0o777, 0o700);
});

test("bootstrap tightens existing secret/log modes without rotating credentials", async (t) => {
  const h = await bootstrapHarness(t);
  const secret = join(h.root, "secret");
  const logDir = join(h.root, "logs");
  await mkdir(logDir);
  await chmod(h.root, 0o755);
  await chmod(secret, 0o644);
  await writeFile(join(logDir, "server.log"), "existing log", { mode: 0o644 });
  const password = await readFile(secret, "utf8");
  assert.equal((await h.run(["start", "2.0", "--replace-if-idle"])).ok, true);
  assert.equal(await readFile(secret, "utf8"), password);
  assert.equal((await stat(secret)).mode & 0o777, 0o600);
  assert.equal((await stat(join(logDir, "server.log"))).mode & 0o777, 0o600);
  assert.equal((await stat(h.root)).mode & 0o777, 0o700);
  assert.equal((await stat(logDir)).mode & 0o777, 0o700);
});

test("invalid or symlinked credentials fail closed without killing the active daemon", async (t) => {
  const h = await bootstrapHarness(t);
  const secret = join(h.root, "secret");
  await writeFile(secret, "short");
  assert.equal((await h.run(["start", "1.0", "--replace-if-idle"])).ok, false);
  assert.equal(await readFile(secret, "utf8"), "short");
  const outside = join(h.home, "outside-secret");
  await writeFile(outside, "a-different-long-password");
  await rm(secret);
  await symlink(outside, secret);
  assert.equal((await h.run(["start", "1.0", "--replace-if-idle"])).ok, false);
  assert.deepEqual(h.kills, []);
  assert.deepEqual(h.spawns, []);
});

test("unknown actions fail with a usage error instead of hanging", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-remote-home-"));
  try {
    const result = await runBootstrap(home, ["frobnicate"]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "usage");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
