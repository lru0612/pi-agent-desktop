import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import vm from "node:vm";
import { BOOTSTRAP_SCRIPT } from "./bootstrap-script.ts";

// Execute the exact embedded remote program against temp files and fake
// processes/HTTP, never SSH, real daemons, or the user's home directory.
export async function bootstrapHarness(t, version = "1.0") {
  const home = await mkdtemp(path.join(tmpdir(), "pi-bootstrap-lifecycle-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, ".pi-remote");
  const stateFile = path.join(root, "state.json");
  for (const name of ["1.0", "2.0"]) {
    await mkdir(path.join(root, "versions", name), { recursive: true });
    await writeFile(path.join(root, "versions", name, "headless-launcher.cjs"), "// fake");
  }
  await writeFile(path.join(root, "secret"), "test-secret-at-least-16-characters");
  const state = { pid: 1234, port: 34567, version };
  await writeFile(stateFile, JSON.stringify(state));
  const h = { home, root, stateFile, state, kills: [], spawns: [], requests: [], living: new Set([state.pid]) };
  const http = {
    get(options, callback) {
      const req = new EventEmitter();
      req.destroy = () => req.emit("error", new Error("timeout"));
      queueMicrotask(() => {
        h.requests.push(options);
        const result = h.onHttp?.(options) ?? {
          status: 200,
          json: options.path.endsWith("/remote-info")
            ? { pid: options.port === state.port ? state.pid : 5678, headless: true }
            : { runningSessionIds: [] },
        };
        if (result.error) return req.emit("error", new Error(result.error));
        const res = new EventEmitter();
        res.statusCode = result.status;
        res.setEncoding = () => {};
        callback(res);
        res.emit("data", JSON.stringify(result.json));
        res.emit("end");
      });
      return req;
    },
  };
  const modules = {
    "node:fs": fs, "node:path": path, "node:os": { homedir: () => home },
    "node:crypto": { randomBytes() { throw new Error("unexpected secret rotation"); } },
    "node:http": http,
    "node:net": {
      createServer() {
        const server = new EventEmitter();
        server.listen = (port, host, callback) => callback();
        server.address = () => ({ port: 45678 });
        server.close = (callback) => callback();
        return server;
      },
    },
    "node:child_process": {
      spawn(executable, args, options) {
        h.spawns.push({ executable, args, options });
        const child = new EventEmitter();
        child.pid = 5678;
        child.unref = () => {};
        h.living.add(child.pid);
        return child;
      },
    },
  };
  h.run = async (args) => {
    let stdout = "";
    const process = new EventEmitter();
    Object.assign(process, {
      argv: ["node", "-", ...args], execPath: "/fake/node", env: { ...(h.env ?? {}) },
      pid: 9999, platform: "linux", arch: "x64", version: "v22.23.3",
      stdout: { write: (text) => { stdout += text; } },
      kill(pid, signal) {
        if (!h.living.has(pid)) throw Object.assign(new Error("dead"), { code: "ESRCH" });
        if (signal !== 0) {
          h.kills.push({ pid, signal });
          h.living.delete(pid);
        }
      },
    });
    const js = BOOTSTRAP_SCRIPT.split("<<'PI_REMOTE_JS'\n")[1].split("\nPI_REMOTE_JS")[0];
    await vm.runInNewContext(js, {
      require(name) {
        if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
        return modules[name];
      },
      process, Buffer, setTimeout: (fn) => queueMicrotask(fn),
    }, { filename: "remote-bootstrap.js" });
    return JSON.parse(stdout.trim());
  };
  return h;
}
