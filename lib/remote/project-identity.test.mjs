import assert from "node:assert/strict";
import test from "node:test";
import { hostedProjectKey, resolveHostedProject } from "./project-identity.ts";

const cwd = "/work/app";
const sessions = [null, "a", "b"].map((host) => ({ host, cwd, projectRoot: cwd, projectKey: `server-${host ?? "local"}` }));

test("client keys distinguish local/A/B without changing local keys or physical paths", () => {
  assert.equal(hostedProjectKey(cwd), cwd);
  assert.equal(hostedProjectKey(cwd, null), cwd);
  assert.equal(hostedProjectKey(cwd, "a"), "r:a:/work/app");
  assert.equal(new Set([null, "a", "b"].map((host) => hostedProjectKey(cwd, host))).size, 3);
  for (const path of ["C:\\work\\App", "\\\\server\\share\\App", "/work/app/"]) {
    assert.equal(hostedProjectKey(path), path);
    assert.equal(hostedProjectKey(path, "b"), `r:b:${path}`);
  }
  assert.notEqual(hostedProjectKey("c:d", "a:b"), hostedProjectKey("b:c:d", "a"));
});

test("resolver keeps the server key raw and restricts same-path lookup to its host", () => {
  for (const host of [null, "a", "b"]) {
    assert.deepEqual(resolveHostedProject(cwd, host, sessions), { root: cwd, key: `server-${host ?? "local"}`, host });
  }
});

test("empty B is resolved from explicit projects, not A's worktrees/session cache", () => {
  const aWorktrees = { host: "a", forCwd: cwd, projectRoot: "/a-main", projectKey: "a-key", worktrees: [{ path: cwd }] };
  const projects = [{ host: "b", cwd, projectRoot: "/b-main", projectKey: "b-key" }];
  assert.deepEqual(resolveHostedProject(cwd, "b", sessions.filter((s) => s.host !== "b"), aWorktrees, projects), {
    root: "/b-main", key: "b-key", host: "b",
  });
  assert.deepEqual(resolveHostedProject(cwd, null, sessions, aWorktrees, projects), { root: cwd, key: "server-local", host: null });
});

test("only same-host worktree identity resolves new checkouts into the main project", () => {
  const path = "/work/app-worktrees/topic";
  const worktrees = { host: "a", forCwd: cwd, projectRoot: cwd, projectKey: "raw-server-key", worktrees: [{ path }] };
  assert.deepEqual(resolveHostedProject(path, "a", [], worktrees), { root: cwd, key: "raw-server-key", host: "a" });
  assert.deepEqual(resolveHostedProject(path, "b", [], worktrees), { root: path, key: path, host: "b" });
  assert.equal(resolveHostedProject(null, "a", [], worktrees), null);
});
