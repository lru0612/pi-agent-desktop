import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import vm from "node:vm";
import ts from "typescript";

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

export function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.finish = (code = 0) => {
    child.exitCode = code;
    child.emit("exit", code);
    child.emit("close", code);
  };
  child.kill = (signal) => { child.kills.push(signal); child.finish(-1); return true; };
  return child;
}

export function response(statusCode = 200, json = {}, headers = {}) {
  return { statusCode, headers, body: { dump: async () => {}, json: async () => json } };
}

export function hostHarness() {
  const timers = new Map();
  let time = 100_000;
  const timer = (callback, ms = 0, interval = false) => {
    const handle = { unref() {}, callback, due: time + ms, ms, interval };
    timers.set(handle, handle);
    return handle;
  };
  const clear = (handle) => timers.delete(handle);
  const clock = {
    timers,
    async tick(ms = 0) {
      const end = time + ms;
      await flush();
      for (;;) {
        const next = [...timers.values()].filter((t) => t.due <= end).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        time = next.due;
        if (next.interval) next.due += next.ms;
        else timers.delete(next);
        next.callback();
        await flush();
      }
      time = end;
      await flush();
    },
  };
  const h = {
    clock, ssh: [], prunes: [], tunnels: [], tars: [], http: [], streams: [], sockets: [],
    saved: [], freePortGate: null, socketReady: true,
    info: { protocol: 1, appVersion: "1.0", pid: 123, headless: true },
    probe: { ok: true, platform: "linux-x64", versions: ["1.0-build"] },
  };
  const fs = {
    readFileSync() { throw new Error("no cache"); },
    mkdirSync() {}, writeFileSync() {},
  };
  const runSsh = (target, command, options) => {
    const call = { target, command, ...options };
    // Background housekeeping after each connect; kept out of h.ssh so the
    // tests can count the connect/stop protocol exactly.
    if (command.includes(" prune")) {
      h.prunes.push(call);
      return Promise.resolve({ code: 0, stdout: JSON.stringify({ ok: true, removed: [] }), stderr: "", timedOut: false });
    }
    h.ssh.push(call);
    if (h.onSsh) return h.onSsh(call);
    const value = command.includes(" probe") ? h.probe : { ok: true, port: 12345, password: "remote-secret-password" };
    return Promise.resolve({ code: 0, stdout: JSON.stringify(value), stderr: "", timedOut: false });
  };
  const stream = (signal) => {
    let waiting;
    const queue = [];
    let closed = false;
    const body = {
      push(value) { queue.push({ data: JSON.stringify(value) }); waiting?.(); },
      async dump() {},
      async *[Symbol.asyncIterator]() {
        while (!closed) {
          if (!queue.length) await new Promise((resolve) => { waiting = resolve; });
          while (queue.length) yield queue.shift();
        }
      },
    };
    signal.addEventListener("abort", () => { closed = true; waiting?.(); }, { once: true });
    h.streams.push(body);
    return body;
  };
  const undici = {
    Agent: class {},
    async request(url, init) {
      const call = { url, ...init };
      h.http.push(call);
      if (h.onRequest) return h.onRequest(call);
      if (url.endsWith("/api/web-auth")) return response(200, {}, { "set-cookie": "pi_web_session=valid; HttpOnly" });
      if (url.endsWith("/events")) return { statusCode: 200, headers: {}, body: stream(init.signal) };
      return response(200, h.info);
    },
  };
  const modules = {
    "node:events": { EventEmitter }, "node:fs": fs,
    "node:path": { dirname: (p) => p.slice(0, p.lastIndexOf("/")), join: (...p) => p.join("/") },
    "node:timers/promises": {
      setTimeout(ms, value, { signal }) {
        return new Promise((resolve, reject) => {
          if (signal.aborted) return reject(new Error("aborted"));
          const abort = () => { clear(handle); reject(new Error("aborted")); };
          const handle = timer(() => { signal.removeEventListener("abort", abort); resolve(value); }, ms);
          signal.addEventListener("abort", abort, { once: true });
        });
      },
    },
    "node:net": {
      createServer() {
        const server = new EventEmitter();
        server.listen = (port, host, callback) => {
          if (h.freePortGate) h.freePortGate.promise.then(callback);
          else queueMicrotask(callback);
        };
        server.address = () => ({ port: 23456 });
        server.close = (callback) => callback();
        return server;
      },
      connect() {
        const socket = new EventEmitter();
        socket.destroy = () => { socket.destroyed = true; };
        h.sockets.push(socket);
        if (h.socketReady) queueMicrotask(() => socket.emit("connect"));
        return socket;
      },
    },
    "@earendil-works/pi-coding-agent": { getAgentDir: () => "/fake-agent" },
    undici,
    "./bootstrap-script": { BOOTSTRAP_SCRIPT: "fake bootstrap", installCommand: (version) => `install ${version}` },
    "./bundle": {
      findServerBundleDir: () => "/fake-bundle",
      readServerBundle: () => ({ dir: "/fake-bundle", version: "1.0-build", appVersion: "1.0" }),
      isSupportedRemotePlatform: () => true,
      spawnBundleTar() { const child = fakeChild(); h.tars.push(child); return child; },
    },
    "./hosts-store": {
      loadRemoteHosts: () => [{ id: "box", label: "Box", ssh: "fake-box" }],
      saveRemoteHosts: (value) => h.saved.push(value),
      isValidHostId: () => true,
    },
    "./protocol": { REMOTE_PROTOCOL_VERSION: 1 },
    "./sse": { parseSse: (body) => body },
    "./ssh": {
      runSsh,
      classifySshFailure: () => "other",
      spawnTunnel() { const child = fakeChild(); h.tunnels.push(child); return child; },
    },
  };
  const output = ts.transpileModule(readFileSync(new URL("./host-manager.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  const process = new EventEmitter();
  vm.runInNewContext(output, {
    exports, require(name) {
      if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
      return modules[name];
    },
    process, Buffer, AbortController, AbortSignal, URLSearchParams,
    Date: class extends Date { static now() { return time; } },
    setTimeout: timer, clearTimeout: clear,
    setInterval: (fn, ms) => timer(fn, ms, true), clearInterval: clear,
  }, { filename: "host-manager.ts" });
  h.manager = new exports.RemoteHostManager();
  h.runtime = () => h.manager.hosts.get("box");
  h.cleanup = () => { process.emit("exit"); h.manager.removeAllListeners(); };
  return h;
}
