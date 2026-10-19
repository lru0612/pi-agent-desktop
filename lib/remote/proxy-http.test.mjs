import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { Readable } from "node:stream";
import test from "node:test";
import { gzipSync } from "node:zlib";
import * as undici from "undici";

// Load the real proxy with only the stateful manager/SDK boundary mocked. No
// Next server, real SSH manager, auth files or application startup is imported.
const managerKey = Symbol.for("pi-proxy-http-test-manager");
const proxyUrl = new URL("./proxy.ts", import.meta.url).href;
const hostsUrl = new URL("./hosts-store.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === proxyUrl && specifier === "./host-manager") {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
        'export const getRemoteHostManager = () => globalThis[Symbol.for("pi-proxy-http-test-manager")];',
      ) };
    }
    if (context.parentURL === proxyUrl && ["./hosts-store", "./proxy-policy"].includes(specifier)) {
      return nextResolve(new URL(specifier + ".ts", proxyUrl).href, context);
    }
    if (context.parentURL === hostsUrl && specifier === "@earendil-works/pi-coding-agent") {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
        'export const getAgentDir = () => { throw new Error("Tests must never access agent files"); };',
      ) };
    }
    return nextResolve(specifier, context);
  },
});
const { proxyToHost } = await import(proxyUrl);
hooks.deregister();

const local = "http://127.0.0.1:12345/api/r/devbox/";
const request = (path = "sessions", init) => new Request(local + path, init);
const deferred = () => Promise.withResolvers();

async function backend(t, handler) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ url: req.url, headers: req.headers, method: req.method });
    Promise.resolve(handler(req, res, calls)).catch((error) => {
      res.destroy(error);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, calls };
}

function installManager(t, remote) {
  const dispatcher = new undici.Agent({ bodyTimeout: 0, headersTimeout: 2000 });
  const state = { connection: { baseUrl: remote.baseUrl, cookie: "pi_web_session=remote-secret" }, failures: 0, refreshes: 0 };
  const manager = {
    dispatcher,
    get: () => ({ status: "online" }),
    connection: () => state.connection,
    reportTransportFailure: () => { state.failures++; },
    request: async (_host, path, init) => {
      state.refreshes++;
      return undici.request(state.connection.baseUrl + path, {
        ...init, dispatcher, headers: { ...init.headers, cookie: state.connection.cookie },
      });
    },
  };
  globalThis[managerKey] = manager;
  t.after(async () => { delete globalThis[managerKey]; await dispatcher.destroy(); });
  return { manager, state };
}

test("proxy refuses ambiguous/blocked routes before any manager access", async () => {
  delete globalThis[managerKey];
  for (const path of ["desktop/save", "%64esktop/save", "files/%252e%252e%252fweb-auth", "%", "files/%00x"]) {
    assert.equal((await proxyToHost(request(path), "devbox")).status, 404);
  }
  assert.equal((await proxyToHost(request(), "local")).status, 404);
});

test("fake HTTP: upload bytes and allowed headers arrive unchanged; local credentials do not", { timeout: 5000 }, async (t) => {
  const payload = Buffer.from([0, 255, 13, 10, 0, 128, 42]);
  const remote = await backend(t, async (req, res) => {
    const body = Buffer.concat(await Array.fromAsync(req));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ body: [...body], headers: req.headers, url: req.url }));
  });
  installManager(t, remote);
  const path = "files/%2F%2Fserver/share/a%20b?type=upload&x=%2f+%25";
  const response = await proxyToHost(request(path, {
    method: "POST", body: payload,
    headers: {
      host: "local.invalid", cookie: "pi_web_session=local-secret", authorization: "Basic local-secret",
      origin: "http://local.invalid", referer: "http://local.invalid/private", "sec-fetch-site": "same-origin",
      "x-pi-desktop-token": "desktop-secret", "x-forwarded-for": "fake", "x-forwarded-host": "fake",
      "x-middleware-subrequest": "middleware", "proxy-authorization": "secret",
      "content-type": "application/octet-stream", "content-length": "999", "last-event-id": "42",
      range: "bytes=1-3", "if-range": '"v1"', "x-pi-dest-path": "/tmp/output",
    },
  }), "devbox");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.body, [...payload]);
  assert.equal(result.url, `/api/${path}`);
  assert.equal(result.headers.host, new URL(remote.baseUrl).host);
  assert.equal(result.headers.cookie, "pi_web_session=remote-secret");
  assert.equal(result.headers["content-length"], String(payload.length));
  assert.equal(result.headers.range, "bytes=1-3");
  assert.equal(result.headers["last-event-id"], "42");
  assert.equal(result.headers["if-range"], '"v1"');
  for (const name of ["authorization", "origin", "referer", "sec-fetch-site", "x-pi-desktop-token", "x-forwarded-for", "x-forwarded-host", "x-middleware-subrequest", "proxy-authorization"]) {
    assert.equal(result.headers[name], undefined, name);
  }
});

test("fake HTTP: compressed 206 response remains raw with length, range, CSP and validators", { timeout: 5000 }, async (t) => {
  const bytes = gzipSync(Buffer.from([0, 1, 255, 13, 10, 128]));
  const remote = await backend(t, (_req, res) => {
    res.writeHead(206, {
      "content-type": "application/octet-stream", "content-encoding": "gzip", "content-length": bytes.length,
      "content-range": "bytes 1-6/10", "accept-ranges": "bytes", etag: '"v1"',
      "content-security-policy": "sandbox", "content-disposition": 'attachment; filename="a.bin"',
      "set-cookie": ["pi_web_session=secret", "another=secret"], "access-control-allow-origin": "*",
      "clear-site-data": '"*"', refresh: "0; url=/api/desktop/save", "www-authenticate": "Basic realm=remote",
      connection: "keep-alive, x-private", "x-private": "secret",
    });
    res.end(bytes);
  });
  installManager(t, remote);
  const response = await proxyToHost(request("files/tmp/a?type=download", { headers: { range: "bytes=1-6", "accept-encoding": "gzip" } }), "devbox");
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-encoding"), "gzip");
  assert.equal(response.headers.get("content-length"), String(bytes.length));
  assert.equal(response.headers.get("content-range"), "bytes 1-6/10");
  assert.equal(response.headers.get("etag"), '"v1"');
  assert.equal(response.headers.get("content-security-policy"), "sandbox");
  assert.equal(response.headers.get("x-pi-remote-host"), "devbox");
  for (const name of ["set-cookie", "connection", "x-private", "refresh", "clear-site-data", "access-control-allow-origin", "www-authenticate"]) assert.equal(response.headers.get(name), null, name);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test("fake HTTP: redirects are not followed and safe Locations stay host-scoped", { timeout: 5000 }, async (t) => {
  const remote = await backend(t, (_req, res) => {
    res.writeHead(308, { location: "/api/files/%2F%2Fserver/share/a?type=serve" });
    res.end("redirect bytes");
  });
  installManager(t, remote);
  const response = await proxyToHost(request("files//tmp/a"), "devbox");
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "/api/r/devbox/files/%2F%2Fserver/share/a?type=serve");
  assert.equal(await response.text(), "redirect bytes");
  assert.equal(remote.calls.length, 1);
});

test("fake HTTP: unsafe redirect is rejected without draining an endless error body", { timeout: 5000 }, async (t) => {
  const closed = deferred();
  const remote = await backend(t, (_req, res) => {
    res.on("close", closed.resolve);
    res.writeHead(307, { location: "http://must-not-contact.invalid/api/sessions", "set-cookie": "secret=x" });
    res.write("never-ending redirect");
  });
  installManager(t, remote);
  const response = await proxyToHost(request(), "devbox");
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "remote_redirect_blocked", host: "devbox" });
  await closed.promise;
  assert.equal(remote.calls.length, 1);
});

test("fake HTTP: raw SSE is incremental; consumer cancellation closes upstream", { timeout: 5000 }, async (t) => {
  const closed = deferred();
  const bytes = Buffer.from("id: 7\r\ndata: 中文😀\r\n\r\n");
  const remote = await backend(t, (_req, res) => {
    res.on("close", closed.resolve);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
    res.write(bytes); // Deliberately never end: the proxy must not buffer this.
  });
  const { state } = installManager(t, remote);
  const response = await proxyToHost(request("agent/id/events"), "devbox");
  const reader = response.body.getReader();
  assert.deepEqual(Buffer.from((await reader.read()).value), bytes);
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  await reader.cancel();
  await closed.promise;
  assert.equal(state.failures, 0);
});

test("fake HTTP: 401 and refresh bodies are discarded; a binary mutation is replayed once", { timeout: 5000 }, async (t) => {
  const closed = [deferred(), deferred()];
  const payloads = [];
  const payload = Buffer.from([0, 255, 42]);
  let state;
  const remote = await backend(t, async (req, res) => {
    if (req.url === "/api/remote-info") {
      res.on("close", closed[1].resolve);
      state.connection = { ...state.connection, cookie: "pi_web_session=fresh" };
      res.writeHead(200);
      res.write("infinite probe body");
      return;
    }
    payloads.push(Buffer.concat(await Array.fromAsync(req)));
    if (req.headers.cookie !== "pi_web_session=fresh") {
      res.on("close", closed[0].resolve);
      res.writeHead(401);
      res.write("infinite unauthorized body");
    } else res.end(payload);
  });
  ({ state } = installManager(t, remote));
  const response = await proxyToHost(request("agent/id", { method: "POST", body: payload }), "devbox");
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
  assert.deepEqual(payloads, [payload, payload]);
  await Promise.all(closed.map((item) => item.promise));
  assert.equal(state.refreshes, 1);
  assert.equal(remote.calls.length, 3);
});

test("fake HTTP: retry uses the refreshed tunnel, never the old port with the new cookie", { timeout: 5000 }, async (t) => {
  const oldRemote = await backend(t, (_req, res) => { res.writeHead(401); res.end(); });
  const newRemote = await backend(t, (_req, res) => res.end("new tunnel"));
  const { manager, state } = installManager(t, oldRemote);
  manager.request = async () => {
    state.connection = { baseUrl: newRemote.baseUrl, cookie: "pi_web_session=new-host-secret" };
    return { statusCode: 200, body: Readable.from([]) };
  };
  const response = await proxyToHost(request(), "devbox");
  assert.equal(await response.text(), "new tunnel");
  assert.equal(oldRemote.calls.length, 1);
  assert.equal(oldRemote.calls[0].headers.cookie, "pi_web_session=remote-secret");
  assert.equal(newRemote.calls[0].headers.cookie, "pi_web_session=new-host-secret");
});

test("fake HTTP: final error stays streamed, including a second 401 without an auth prompt", { timeout: 5000 }, async (t) => {
  const remote = await backend(t, (_req, res) => {
    res.writeHead(401, { "www-authenticate": "Basic realm=remote", "retry-after": "10" });
    res.write("partial error");
  });
  const { manager } = installManager(t, remote);
  let refreshes = 0;
  manager.request = async () => { refreshes++; return { statusCode: 200, body: Readable.from([]) }; };
  const response = await proxyToHost(request(), "devbox");
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), null);
  assert.equal(response.headers.get("retry-after"), "10");
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), "partial error");
  await reader.cancel();
  assert.equal(refreshes, 1);
  assert.equal(remote.calls.length, 2);
});

test("fake HTTP: abort before headers terminates the request without reporting host failure", { timeout: 5000 }, async (t) => {
  const arrived = deferred();
  const closed = deferred();
  const remote = await backend(t, (_req, res) => { res.on("close", closed.resolve); arrived.resolve(); });
  const { state } = installManager(t, remote);
  const controller = new AbortController();
  const pending = proxyToHost(request("sessions", { signal: controller.signal }), "devbox");
  await arrived.promise;
  controller.abort();
  assert.equal((await pending).status, 499);
  await closed.promise;
  assert.equal(state.failures, 0);
});

test("fake HTTP: abort during SSE propagates to the pending reader and socket", { timeout: 5000 }, async (t) => {
  const closed = deferred();
  const remote = await backend(t, (_req, res) => {
    res.on("close", closed.resolve);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
  });
  installManager(t, remote);
  const controller = new AbortController();
  const response = await proxyToHost(request("agent/id/events", { signal: controller.signal }), "devbox");
  const pending = response.body.getReader().read();
  controller.abort();
  await assert.rejects(pending);
  await closed.promise;
});

test("abort during shared authentication returns promptly and destroys its late response", { timeout: 5000 }, async (t) => {
  const remote = await backend(t, (_req, res) => { res.writeHead(401); res.end(); });
  const { manager, state } = installManager(t, remote);
  const started = deferred();
  const refresh = deferred();
  manager.request = async (_host, _path, init) => { started.resolve(init.signal); return refresh.promise; };
  const controller = new AbortController();
  const pending = proxyToHost(request("sessions", { signal: controller.signal }), "devbox");
  const refreshSignal = await started.promise;
  controller.abort();
  assert.equal((await pending).status, 499);
  assert.equal(refreshSignal.aborted, true);
  const body = new Readable({ read() {} });
  refresh.resolve({ statusCode: 200, body });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(body.destroyed, true);
  assert.equal(state.failures, 0);
});

test("upload cancellation and declared size cap happen before remote HTTP", { timeout: 5000 }, async (t) => {
  const remote = await backend(t, (_req, res) => res.end("must not arrive"));
  const { state } = installManager(t, remote);
  const controller = new AbortController();
  let cancelled = false;
  const upload = new ReadableStream({ cancel() { cancelled = true; } });
  const pending = proxyToHost(request("files/tmp/a", { method: "POST", body: upload, duplex: "half", signal: controller.signal }), "devbox");
  controller.abort();
  assert.equal((await pending).status, 499);
  assert.equal(cancelled, true);
  const oversized = await proxyToHost(request("files/tmp/a", {
    method: "POST", body: "x", headers: { "content-length": String(129 * 1024 * 1024) },
  }), "devbox");
  assert.equal(oversized.status, 413);
  assert.equal(remote.calls.length, 0);
  assert.equal(state.failures, 0);
});

test("fake HTTP: HEAD, 204, 205 and 304 have no response body", { timeout: 5000 }, async (t) => {
  let status = 200;
  const remote = await backend(t, (_req, res) => { res.writeHead(status, { etag: '"v1"' }); res.end(); });
  installManager(t, remote);
  for (const code of [200, 204, 205, 304]) {
    status = code;
    const response = await proxyToHost(request("files/tmp/a", { method: code === 200 ? "HEAD" : "GET" }), "devbox");
    assert.equal(response.status, code);
    assert.equal(response.body, null);
    assert.equal(response.headers.get("etag"), '"v1"');
  }
});
