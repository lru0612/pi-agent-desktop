import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  isValidHostId,
  loadRemoteHosts,
  makeHostId,
  normalizeSshTarget,
  parseSshTarget,
  saveRemoteHosts,
  splitSshTarget,
} from "./hosts-store.ts";

test("ssh targets split like a shell without expansion", () => {
  assert.deepEqual(splitSshTarget("devbox"), ["devbox"]);
  assert.deepEqual(splitSshTarget("  -p 2222   u@h "), ["-p", "2222", "u@h"]);
  assert.deepEqual(splitSshTarget("-i '/a b/key' u@h"), ["-i", "/a b/key", "u@h"]);
  assert.deepEqual(splitSshTarget('-o "ProxyJump=j1" u@h'), ["-o", "ProxyJump=j1", "u@h"]);
  assert.deepEqual(splitSshTarget("a\\ b"), ["a b"]);
  assert.throws(() => splitSshTarget("'unterminated"), /unterminated/);
});

test("ssh targets must end with the host", () => {
  assert.deepEqual(parseSshTarget("-p 2222 user@host"), ["-p", "2222", "user@host"]);
  assert.deepEqual(
    parseSshTarget("lhy-workspace.i-luhongyu.shai-core.ws@platform.shaipower.com"),
    ["lhy-workspace.i-luhongyu.shai-core.ws@platform.shaipower.com"],
  );
  assert.throws(() => parseSshTarget(""), /empty/);
  assert.throws(() => parseSshTarget("-p 22"), /no host/);
  assert.throws(() => parseSshTarget("user@host rm -rf ~"), /before the host/);
});

test("options typed after the host are moved in front of it", () => {
  assert.equal(normalizeSshTarget("user@host -p 2222"), "-p 2222 user@host");
  assert.equal(normalizeSshTarget("-J jump user@host"), "-J jump user@host");
  assert.equal(normalizeSshTarget("devbox"), "devbox");
  assert.equal(normalizeSshTarget("u@h -i '/a b/k'"), "-i '/a b/k' u@h");
});

test("host ids are short, url-safe and unique", () => {
  assert.equal(makeHostId("devbox", []), "devbox");
  assert.equal(makeHostId("devbox", ["devbox"]), "devbox-2");
  assert.equal(makeHostId("me@gpu01.example.com -p 22", []), "gpu01");
  assert.equal(makeHostId("lhy-workspace.i-luhongyu.shai-core.ws@platform.shaipower.com", []), "platform");
  assert.equal(makeHostId("lhy-workspace", []), "lhy-workspace");
  assert.equal(makeHostId("开发机", []), "host-1");
  assert.equal(makeHostId("local", []), "host-local");
  assert.equal(isValidHostId("devbox"), true);
  assert.equal(isValidHostId("aggregate"), false);
  assert.equal(isValidHostId("../x"), false);
  assert.equal(isValidHostId("Upper"), false);
});

test("host list round-trips and ignores invalid entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-remote-hosts-"));
  try {
    const file = join(dir, "pi-desktop", "remote-hosts.json");
    assert.deepEqual(loadRemoteHosts(file), []);
    const hosts = [{ id: "devbox", label: "Dev box", ssh: "devbox", addedAt: "2026-01-01T00:00:00.000Z" }];
    saveRemoteHosts(hosts, file);
    assert.deepEqual(loadRemoteHosts(file), hosts);
    saveRemoteHosts([...hosts, { id: "Bad Id", label: "x", ssh: "x", addedAt: "" }], file);
    assert.deepEqual(loadRemoteHosts(file), hosts);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
