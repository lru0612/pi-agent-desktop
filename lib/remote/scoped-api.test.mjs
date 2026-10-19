import assert from "node:assert/strict";
import test from "node:test";
import { RemoteClientStore } from "./client-store.ts";
import { createBackendApi, backendApiUrl } from "./scoped-api.ts";
import { resolveApiRequest } from "./router.ts";
import { createRoutedFetch } from "./fetch-router.ts";

const origin = "http://127.0.0.1:38471";
const pathOf = (input) => new URL(input instanceof Request ? input.url : input, origin).pathname;
const session = (id, host, cwd = "/work/app") => ({ id, host, cwd, projectRoot: cwd });

test("settings writes, retries and OAuth URLs remain bound across focus changes", async () => {
  const store = new RemoteClientStore();
  const sent = [];
  const transport = async (input, init) => {
    sent.push({ path: pathOf(input), method: init?.method, body: init?.body });
    return Response.json({ ok: true });
  };
  const local = createBackendApi(null, transport, () => origin);
  const remote = createBackendApi("devbox", transport, () => origin);
  store.selectWorkspace(null, "/work/app", "other");
  await remote.fetch("/api/mcp", { method: "POST", body: '{"action":"undo","token":"test-token"}' });
  store.selectWorkspace(null, "/work/app", null);
  await remote.fetch("/api/auth/login/test", { method: "POST", body: '{"token":"flow"}' });
  store.selectWorkspace(null, "/work/app", "devbox");
  await local.fetch("/api/models-config", { method: "PUT", body: '{"providers":{}}' });
  assert.deepEqual(sent.map((s) => s.path), ["/api/r/devbox/mcp", "/api/r/devbox/auth/login/test", "/api/models-config"]);
  assert.equal(sent[0].body, '{"action":"undo","token":"test-token"}');
  const localEvents = resolveApiRequest(local.url("/api/auth/login/test"), null, store, origin);
  assert.equal(localEvents.url, "/api/auth/login/test");
  assert.equal(localEvents.host, null);
  assert.equal(remote.url("/api/auth/login/test"), "/api/r/devbox/auth/login/test");
});

test("explicit backend URLs cannot escape scope; local-only actions never reach remote", () => {
  assert.throws(() => backendApiUrl("/api/r/other/mcp", "devbox", origin), /another backend/);
  assert.throws(() => backendApiUrl("/api/models", "../bad", origin), /Invalid backend/);
  assert.equal(backendApiUrl("https://provider.example/authorize", "devbox", origin), "https://provider.example/authorize");
  assert.equal(backendApiUrl("/api/desktop/save", "devbox", origin), "/api/desktop/save?__pi_backend=local");
  assert.equal(backendApiUrl("/api/cwd/browse?path=%2Fwork", "devbox", origin), "/api/r/devbox/cwd/browse?path=%2Fwork");
});

test("Request-object POST preserves body, headers, signal and remote ownership", async () => {
  const store = new RemoteClientStore();
  store.recordSessions([session("remote", "devbox")]);
  let dispatched;
  const controller = new AbortController();
  const original = new Request(`${origin}/api/agent/new`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Test": "yes" },
    body: ' {"cwd":"/work/app","message":"hello"}', signal: controller.signal,
  });
  const routed = createRoutedFetch({
    origin: () => origin, scope: () => store.currentHost,
    resolve: (url, body) => resolveApiRequest(url, body, store, origin),
    transport: async (input) => { dispatched = input; return Response.json({ sessionId: "new-id" }); },
  });
  await routed(original);
  assert.equal(dispatched.url, `${origin}/api/r/devbox/agent/new`);
  assert.equal(dispatched.method, "POST");
  assert.equal(dispatched.headers.get("x-test"), "yes");
  assert.equal(await dispatched.text(), ' {"cwd":"/work/app","message":"hello"}');
  controller.abort();
  assert.equal(dispatched.signal.aborted, true);
});

test("ownership is learned before the consumer issues its dependent request", async () => {
  const store = new RemoteClientStore();
  const sent = [];
  const routed = createRoutedFetch({
    origin: () => origin, scope: () => store.currentHost,
    resolve: (url, body) => resolveApiRequest(url, body, store, origin),
    transport: async (input) => { sent.push(pathOf(input)); return Response.json({ sessionId: "created" }); },
    onResponse: async ({ path }, response) => {
      if (path !== "/api/agent/new") return;
      await new Promise((resolve) => setTimeout(resolve, 10));
      const data = await response.clone().json();
      store.recordSession(data.sessionId, "devbox");
    },
  });
  store.selectWorkspace(null, "/work/app", "devbox");
  const result = await (await routed("/api/agent/new", { method: "POST", body: '{}' })).json();
  store.selectWorkspace(null, "/Users/me", null);
  await routed(`/api/agent/${result.sessionId}/events`);
  assert.deepEqual(sent, ["/api/r/devbox/agent/new", "/api/r/devbox/agent/created/events"]);
});

test("local terminal and local session metadata are recorded even if URL is unchanged", async () => {
  const store = new RemoteClientStore();
  const routed = createRoutedFetch({
    origin: () => origin, scope: () => store.currentHost,
    resolve: (url, body) => resolveApiRequest(url, body, store, origin),
    transport: async () => Response.json({}),
    onRequest: ({ decision }) => store.recordTerminal("local-terminal", decision.host),
  });
  await routed("/api/terminal", { method: "POST", body: '{"id":"local-terminal","cwd":"/local"}' });
  store.selectWorkspace(null, "/remote", "devbox");
  assert.equal(store.hostOfTerminal("local-terminal"), null);
  assert.equal(resolveApiRequest("/api/terminal/local-terminal", null, store, origin).host, null);
});

test("same paths and nested remote roots never override an explicitly selected workspace", () => {
  const store = new RemoteClientStore();
  store.recordSessions([session("local", undefined), session("a", "a"), session("b", "b", "/work/app/sub")]);
  store.selectWorkspace(null, "/work/app", null);
  assert.equal(store.ownerOfPath("/work/app/sub/file"), null);
  store.selectWorkspace(null, "/work/app", "a");
  assert.equal(store.ownerOfPath("/work/app/sub/file"), "a");
  store.setWorkspace(null, "/work/app"); // the parent's later effect must preserve the explicit choice
  assert.equal(store.currentHost, "a");
  store.selectWorkspace("b", "/work/app/sub", "b");
  assert.equal(store.ownerOfPath("/work/app/sub/file"), "b");
  store.recordSession("local", null);
  assert.equal(store.hostOfSession("local"), null);
});
