import assert from "node:assert/strict";
import test from "node:test";
import { deferred, flush, hostHarness, response } from "./host-manager.lifecycle-helpers.mjs";

const sshResult = (json) => ({ code: 0, stdout: JSON.stringify(json), stderr: "", timedOut: false });

function harness(t) {
  const h = hostHarness();
  t.after(() => {
    h.cleanup();
    assert.equal(h.clock.timers.size, 0, "all owned timers must be cancelled");
  });
  return h;
}

async function online(h) {
  h.manager.ensureStarted();
  await h.clock.tick();
  assert.equal(h.manager.get("box").status, "online");
}

test("duplicate connect requests share bootstrap, tunnel and health timer", async (t) => {
  const h = harness(t);
  const probe = deferred();
  h.onSsh = (call) => call.command.includes(" probe")
    ? probe.promise : Promise.resolve(sshResult({ ok: true, port: 12345, password: "remote-secret-password" }));
  h.manager.ensureStarted();
  await h.clock.tick();
  for (let i = 0; i < 10; i++) h.manager.connect("box", {});
  await h.clock.tick();
  assert.equal(h.ssh.length, 1);
  probe.resolve(sshResult(h.probe));
  await flush();
  assert.equal(h.manager.get("box").status, "online");
  h.manager.connect("box", {});
  await h.clock.tick();
  assert.equal(h.tunnels.length, 1);
  assert.equal(h.clock.timers.size, 1);
  // Only the online transition prunes, once, and never a version that another
  // window may be installing right now (age guard) or the running one.
  assert.equal(h.prunes.length, 1);
  assert.match(h.prunes[0].command, /prune --min-age-hours=24 1\.0-build$/);
});

test("disconnect aborts bootstrap; reconnect waits for old subprocess cleanup", async (t) => {
  const h = harness(t);
  const probe = deferred();
  h.onSsh = () => probe.promise;
  h.manager.ensureStarted();
  await h.clock.tick();
  h.manager.disconnect("box");
  assert.equal(h.ssh[0].signal.aborted, true);
  h.manager.connect("box", {});
  await h.clock.tick();
  assert.equal(h.ssh.length, 1, "cancelled child has not closed yet");
  h.onSsh = undefined;
  probe.resolve(sshResult(h.probe));
  await flush();
  assert.equal(h.ssh.length, 3);
  assert.equal(h.tunnels.length, 1);
  assert.equal(h.manager.get("box").status, "online");
});

test("removing a bootstrapping host prevents late start, retry and tunnel creation", async (t) => {
  const h = harness(t);
  const probe = deferred();
  h.onSsh = () => probe.promise;
  h.manager.ensureStarted();
  await h.clock.tick();
  assert.equal(await h.manager.remove("box"), true);
  assert.equal(h.ssh[0].signal.aborted, true);
  probe.resolve(sshResult(h.probe));
  await h.clock.tick(60_000);
  assert.equal(h.manager.get("box"), null);
  assert.equal(h.ssh.length, 1);
  assert.equal(h.tunnels.length, 0);
});

test("disconnect during port allocation cannot spawn a late tunnel", async (t) => {
  const h = harness(t);
  h.freePortGate = deferred();
  h.manager.ensureStarted();
  await h.clock.tick();
  assert.equal(h.manager.get("box").phase, "tunnel");
  h.manager.disconnect("box");
  h.freePortGate.resolve();
  await flush();
  assert.equal(h.tunnels.length, 0);
  assert.equal(h.manager.get("box").status, "offline");
});

test("disconnect destroys the pending tunnel socket and deadline", async (t) => {
  const h = harness(t);
  h.socketReady = false;
  h.manager.ensureStarted();
  await h.clock.tick();
  assert.equal(h.tunnels.length, 1);
  assert.equal(h.clock.timers.size, 1);
  h.manager.disconnect("box");
  await flush();
  assert.deepEqual(h.tunnels[0].kills, ["SIGKILL"]);
  assert.equal(h.sockets[0].destroyed, true);
  assert.equal(h.clock.timers.size, 0);
});

test("upload cancellation terminates tar and SSH before the attempt settles", async (t) => {
  const h = harness(t);
  h.probe.versions = [];
  const upload = deferred();
  h.onSsh = (call) => call.command.startsWith("install ") ? upload.promise : Promise.resolve(sshResult(h.probe));
  h.manager.ensureStarted();
  await h.clock.tick();
  const pending = h.runtime().connecting;
  h.manager.disconnect("box");
  assert.equal(h.ssh[1].signal.aborted, true);
  assert.deepEqual(h.tars[0].kills, ["SIGKILL"]);
  assert.equal(h.tars[0].stdout.destroyed, true);
  upload.resolve(sshResult({ ok: false }));
  await pending;
  assert.equal(h.ssh.length, 2);
  assert.equal(h.tunnels.length, 0);
});

test("an SSH success cannot hide a failed tar producer", async (t) => {
  const h = harness(t);
  h.probe.versions = [];
  h.manager.ensureStarted();
  await h.clock.tick();
  assert.equal(h.manager.get("box").phase, "install");
  h.tars[0].finish(2);
  await flush();
  assert.equal(h.manager.get("box").error.code, "install_failed");
  assert.equal(h.ssh.length, 2, "never starts an incomplete uploaded tree");
});

test("repeated handshake 401s do one re-login then stop without reconnect loops", async (t) => {
  const h = harness(t);
  h.onRequest = async (call) => call.url.endsWith("/web-auth")
    ? response(200, {}, { "set-cookie": "pi_web_session=rejected" }) : response(401);
  h.manager.ensureStarted();
  await h.clock.tick();
  assert.equal(h.manager.get("box").error.code, "login_rejected");
  assert.equal(h.http.filter((call) => call.url.endsWith("/web-auth")).length, 2);
  assert.equal(h.http.filter((call) => call.url.endsWith("/remote-info")).length, 2);
  await h.clock.tick(120_000);
  assert.equal(h.ssh.length, 2);
  assert.deepEqual(h.tunnels[0].kills, ["SIGKILL"]);
});

for (const status of [401, 404, 429, 200]) {
  test(`login HTTP ${status} without a usable cookie fails closed without retry`, async (t) => {
    const h = harness(t);
    h.onRequest = async () => response(status);
    h.manager.ensureStarted();
    await h.clock.tick();
    assert.equal(h.manager.get("box").error.code, "login_rejected");
    assert.equal(h.http.length, 1);
    assert.equal(h.clock.timers.size, 0);
  });
}

test("concurrent 401s share one login, late old-cookie 401s reuse it, new failures cool down", async (t) => {
  const h = harness(t);
  await online(h);
  const login = deferred();
  const late = deferred();
  let loginCalls = 0;
  h.onRequest = async (call) => {
    if (call.url.endsWith("/web-auth")) { loginCalls++; return login.promise; }
    if (call.url.endsWith("/late") && call.headers.cookie === "pi_web_session=valid") return late.promise;
    return response(call.headers.cookie === "pi_web_session=new" ? 200 : 401);
  };
  const requests = [h.manager.request("box", "/one"), h.manager.request("box", "/two"), h.manager.request("box", "/late")];
  await flush();
  assert.equal(loginCalls, 1);
  login.resolve(response(200, {}, { "set-cookie": "pi_web_session=new" }));
  await flush();
  late.resolve(response(401));
  assert.ok((await Promise.all(requests)).every((res) => res.statusCode === 200));
  assert.equal(loginCalls, 1);
  h.onRequest = async () => response(401);
  await assert.rejects(h.manager.request("box", "/again"), /cooling down/);
});

test("late login cannot repopulate credentials after disconnect", async (t) => {
  const h = harness(t);
  const login = deferred();
  h.onRequest = () => login.promise;
  h.manager.ensureStarted();
  await h.clock.tick();
  h.manager.disconnect("box");
  assert.equal(h.http[0].signal.aborted, true);
  login.resolve(response(200, {}, { "set-cookie": "pi_web_session=late" }));
  await flush();
  assert.equal(h.runtime().cookie, null);
  assert.equal(h.manager.get("box").status, "offline");
  assert.equal(h.http.length, 1);
});

test("tunnel loss retains running ids until the next authoritative snapshot", async (t) => {
  const h = harness(t);
  await online(h);
  h.streams[0].push({ type: "running", runningSessionIds: ["active-agent"], sessionListVersion: 7 });
  await flush();
  h.tunnels[0].finish(255);
  assert.equal(h.manager.get("box").status, "reconnecting");
  assert.deepEqual(Array.from(h.manager.get("box").runningSessionIds), ["active-agent"]);
  assert.deepEqual(Array.from(h.manager.remoteRunningIds().ids), ["active-agent"]);
  h.streams[0].push({ type: "running", runningSessionIds: [] });
  await flush();
  assert.deepEqual(Array.from(h.manager.remoteRunningIds().ids), ["active-agent"], "late old-stream frames cannot clear it");
  await h.clock.tick(1000);
  assert.equal(h.manager.get("box").status, "online");
  assert.deepEqual(Array.from(h.manager.remoteRunningIds().ids), ["active-agent"]);
  h.streams[1].push({ type: "running", runningSessionIds: [], sessionListVersion: 8 });
  await flush();
  assert.deepEqual(Array.from(h.manager.remoteRunningIds().ids), []);
  assert.ok(h.ssh.every((call) => !call.command.includes("stop")));
});

test("disconnect from an online change listener cannot leave a stream or timer behind", async (t) => {
  const h = harness(t);
  h.manager.on("change", () => {
    if (h.manager.get("box")?.status === "online") h.manager.disconnect("box");
  });
  h.manager.ensureStarted();
  await h.clock.tick();
  assert.equal(h.manager.get("box").status, "offline");
  assert.equal(h.clock.timers.size, 0);
  assert.equal(h.streams.length, 0);
  assert.deepEqual(h.tunnels[0].kills, ["SIGKILL"]);
});

test("explicit remove-and-stop waits for cancelled bootstrap cleanup", async (t) => {
  const h = harness(t);
  const probe = deferred();
  h.onSsh = () => probe.promise;
  h.manager.ensureStarted();
  await h.clock.tick();
  const removing = h.manager.remove("box", { stopRemote: true });
  await flush();
  assert.equal(h.ssh.length, 1);
  h.onSsh = undefined;
  probe.resolve(sshResult(h.probe));
  await removing;
  assert.equal(h.ssh.length, 2);
  assert.match(h.ssh[1].command, / stop$/);
  assert.equal(h.tunnels.length, 0);
});

test("malformed running events do not imply completion", async (t) => {
  const h = harness(t);
  await online(h);
  h.streams[0].push({ type: "running", runningSessionIds: ["active-agent"] });
  await flush();
  h.streams[0].push({ type: "running" });
  await flush();
  assert.deepEqual(Array.from(h.manager.remoteRunningIds().ids), ["active-agent"]);
});

test("health auth rejection drops only the tunnel and preserves active agents without retry", async (t) => {
  const h = harness(t);
  await online(h);
  h.streams[0].push({ type: "running", runningSessionIds: ["active-agent"] });
  await flush();
  h.onRequest = async () => response(401);
  h.manager.reportTransportFailure("box");
  await flush();
  assert.equal(h.manager.get("box").error.code, "login_rejected");
  assert.deepEqual(Array.from(h.manager.remoteRunningIds().ids), ["active-agent"]);
  await h.clock.tick(120_000);
  assert.equal(h.clock.timers.size, 0);
  assert.equal(h.ssh.length, 2, "no remote stop or reconnect on auth rejection");
});

test("health checks are single-flight and ignore a response after disconnect", async (t) => {
  const h = harness(t);
  await online(h);
  h.streams[0].push({ type: "running", runningSessionIds: ["active-agent"] });
  await flush();
  const health = deferred();
  h.onRequest = () => health.promise;
  const before = h.http.length;
  h.manager.reportTransportFailure("box");
  h.manager.reportTransportFailure("box");
  await h.clock.tick(30_000);
  assert.equal(h.http.length, before + 1);
  h.manager.disconnect("box");
  const lastOnlineAt = h.manager.get("box").lastOnlineAt;
  health.resolve(response(200, h.info));
  await flush();
  assert.equal(h.manager.get("box").lastOnlineAt, lastOnlineAt);
  assert.deepEqual(Array.from(h.manager.remoteRunningIds().ids), ["active-agent"]);
});
