import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CLASSIFIED_HEADS, classifyApiPath, decodeFilesApiPath } from "./route-classes.ts";
import { resolveApiRequest, stripCwdFromJsonBody } from "./router.ts";

const apiDir = fileURLToPath(new URL("../../app/api/", import.meta.url));

async function routeFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await routeFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

test("every app/api route family is classified for remote routing", async () => {
  const files = await routeFiles(apiDir);
  assert.ok(files.length > 50, "expected the full route tree");
  const unclassified = new Set();
  for (const file of files) {
    const head = relative(apiDir, file).split(sep)[0];
    if (!CLASSIFIED_HEADS.has(head)) unclassified.add(head);
  }
  assert.deepEqual(
    [...unclassified],
    [],
    "new /api route families must be added to lib/remote/route-classes.ts (local / config / cwd / …)",
  );
});

test("classification of representative routes", () => {
  const cases = [
    ["/api/desktop/save", "local"],
    ["/api/open-in-explorer", "local"],
    ["/api/web-auth", "local"],
    ["/api/home", "local"],
    ["/api/remote-hosts", "local"],
    ["/api/scheduled-tasks/events", "local"],
    ["/api/sessions", "aggregate"],
    ["/api/sessions/search", "local"],
    ["/api/sessions/abc/context", "session"],
    ["/api/agent/abc/events", "session"],
    ["/api/agent/new", "cwd"],
    ["/api/agent/running", "aggregate"],
    ["/api/agent/running/events", "aggregate"],
    ["/api/subagents/xyz", "session"],
    ["/api/subagents/profiles", "config"],
    ["/api/terminal", "cwd"],
    ["/api/terminal/0123/events", "terminal"],
    ["/api/files/home/u/a.txt", "path"],
    ["/api/file-index", "cwd"],
    ["/api/git/status", "cwd"],
    ["/api/worktrees/fetch", "cwd"],
    ["/api/project-trust", "cwd"],
    ["/api/cwd/status", "cwd"],
    ["/api/cwd/validate", "cwd"],
    ["/api/cwd/browse", "browse"],
    ["/api/default-cwd", "browse"],
    ["/api/models", "config"],
    ["/api/models-config/test", "config"],
    ["/api/auth/login/anthropic", "config"],
    ["/api/mcp/sign-in/flow", "config"],
    ["/api/skills/install", "config"],
    ["/api/plugins", "config"],
    ["/api/tools/settings", "config"],
    ["/api/artifacts/settings", "config"],
  ];
  for (const [path, kind] of cases) {
    assert.equal(classifyApiPath(path).kind, kind, path);
  }
  assert.deepEqual(classifyApiPath("/api/agent/running/events"), {
    kind: "aggregate",
    target: "/api/remote-hosts/aggregate/running-events",
  });
  assert.equal(classifyApiPath("/api/cwd/validate").fallback, "local");
  assert.equal(classifyApiPath("/api/git/diff").fallback, "workspace");
});

test("files API paths decode back to absolute paths", () => {
  assert.equal(decodeFilesApiPath(["home", "u", "a%20b.txt"]), "/home/u/a b.txt");
  assert.equal(decodeFilesApiPath(["C%3A", "Users", "x"]), "C:/Users/x");
  assert.equal(decodeFilesApiPath(["%2F%2Fserver", "share"]), "//server/share");
});

function state(overrides = {}) {
  const sessions = new Map([["remote-session", "devbox"], ["local-session", null]]);
  const roots = [
    ["/home/u/proj", "devbox"],
    ["/Users/me/app", null],
    ["/srv/shared", "devbox"],
    ["/srv/shared", null],
  ];
  return {
    currentHost: null,
    configHost: undefined,
    browseHost: null,
    hostOfSession: (id) => sessions.get(id),
    hostOfTerminal: (id) => (id === "t-remote" ? "devbox" : undefined),
    ...overrides,
    // Mirrors RemoteClientStore.ownerOfPath: longest root wins, ties prefer the current host.
    ownerOfPath(path) {
      let owners = [];
      let length = -1;
      for (const [root, owner] of roots) {
        if (!(path === root || path.startsWith(`${root}/`))) continue;
        if (root.length > length) {
          owners = [owner];
          length = root.length;
        } else if (root.length === length) {
          owners.push(owner);
        }
      }
      if (length < 0) return undefined;
      const current = overrides.currentHost ?? null;
      return owners.includes(current) ? current : owners[0];
    },
  };
}

const ORIGIN = "http://127.0.0.1:38471";
const route = (url, body, overrides) => resolveApiRequest(url, body, state(overrides), ORIGIN);

test("session, terminal and file requests go to the backend that owns them", () => {
  assert.equal(route("/api/agent/remote-session/events").url, "/api/r/devbox/agent/remote-session/events");
  assert.equal(route("/api/sessions/local-session").changed, false);
  assert.equal(route("/api/terminal/t-remote/events?after=3").url, "/api/r/devbox/terminal/t-remote/events?after=3");
  assert.equal(route("/api/files/home/u/proj/a.ts?type=read").url, "/api/r/devbox/files/home/u/proj/a.ts?type=read");
  assert.equal(route("/api/files/Users/me/app/a.ts?type=read").changed, false);
  // Unknown ids and paths follow the current workspace.
  assert.equal(route("/api/agent/unknown/events", undefined, { currentHost: "devbox" }).url, "/api/r/devbox/agent/unknown/events");
  assert.equal(route("/api/agent/unknown/events").changed, false);
});

test("cwd-keyed requests use ?cwd= or the JSON body", () => {
  assert.equal(route("/api/git/status?cwd=%2Fhome%2Fu%2Fproj").url, "/api/r/devbox/git/status?cwd=%2Fhome%2Fu%2Fproj");
  const body = JSON.stringify({ cwd: "/home/u/proj/sub", message: "hi" });
  assert.equal(route("/api/agent/new", body).url, "/api/r/devbox/agent/new");
  assert.equal(route("/api/agent/new", JSON.stringify({ cwd: "/Users/me/app" })).changed, false);
  // Same path on two backends: the current workspace wins.
  assert.equal(route("/api/git/status?cwd=%2Fsrv%2Fshared", undefined, { currentHost: "devbox" }).url.startsWith("/api/r/devbox/"), true);
  assert.equal(route("/api/git/status?cwd=%2Fsrv%2Fshared").changed, false);
  // Validating a folder picked locally stays local even when a remote workspace is open.
  assert.equal(route("/api/cwd/validate", JSON.stringify({ cwd: "/Users/me/new" }), { currentHost: "devbox" }).changed, false);
  assert.equal(route("/api/cwd/validate", JSON.stringify({ cwd: "/x" }), { browseHost: "devbox" }).url, "/api/r/devbox/cwd/validate");
});

test("config requests follow the settings scope and drop a foreign cwd", () => {
  assert.equal(route("/api/models?cwd=%2Fhome%2Fu%2Fproj").url, "/api/r/devbox/models?cwd=%2Fhome%2Fu%2Fproj");
  assert.equal(route("/api/models", undefined, { currentHost: "devbox" }).url, "/api/r/devbox/models");
  const scoped = route("/api/skills?cwd=%2FUsers%2Fme%2Fapp", undefined, { configHost: "devbox" });
  assert.equal(scoped.url, "/api/r/devbox/skills");
  const localScope = route("/api/models?cwd=%2Fhome%2Fu%2Fproj", undefined, { configHost: null });
  assert.equal(localScope.url, "/api/models");
  assert.equal(localScope.changed, true);
  const putBody = JSON.stringify({ cwd: "/Users/me/app", provider: "x" });
  const put = route("/api/models/default", putBody, { configHost: "devbox" });
  assert.equal(put.url, "/api/r/devbox/models/default");
  assert.equal(put.stripBodyCwd, true);
  assert.deepEqual(JSON.parse(stripCwdFromJsonBody(putBody)), { provider: "x" });
});

test("aggregate, local-only, explicit and foreign URLs", () => {
  assert.equal(route("/api/sessions?summary=1").url, "/api/remote-hosts/aggregate/sessions?summary=1");
  assert.equal(route("/api/agent/running/events").url, "/api/remote-hosts/aggregate/running-events");
  assert.equal(route("/api/desktop/save", undefined, { currentHost: "devbox" }).changed, false);
  assert.equal(route("/api/r/devbox/models").changed, false);
  assert.equal(route("https://example.com/api/models", undefined, { currentHost: "devbox" }).changed, false);
  assert.equal(route("/_next/static/chunk.js", undefined, { currentHost: "devbox" }).changed, false);
  assert.equal(route(`${ORIGIN}/api/models`, undefined, { currentHost: "devbox" }).url, "/api/r/devbox/models");
  assert.equal(route("/api/cwd/browse?path=%2F", undefined, { browseHost: "devbox", currentHost: null }).url, "/api/r/devbox/cwd/browse?path=%2F");
  assert.equal(route("/api/cwd/browse", undefined, { currentHost: "devbox" }).changed, false);
});
