import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { groupByProject } from "../lib/project-group.ts";
import { hostedProjectKey, resolveHostedProject } from "../lib/remote/project-identity.ts";
import { createBackendApi } from "../lib/remote/scoped-api.ts";

const require = createRequire(import.meta.url);
const ROOT = "/work/app";
const session = (host, n = 0) => ({
  id: `${host ?? "local"}-${n}`, host, cwd: ROOT, projectRoot: ROOT,
  projectKey: "server-key", modified: `2026-01-0${n + 1}`, created: "2026-01-01",
  firstMessage: "hello", messageCount: 1,
});

/** Hook-slot unit renderer: executes the real sidebar and action hook, then
 * invokes their emitted JSX callbacks. No app build, DOM, network or git. */
function harness({ native = false, delayBranches = false } = {}) {
  const slots = [];
  let cursor = 0;
  let pending = [];
  let dirty = true;
  let tree;
  const calls = { cwd: [], select: [], new: [], terminal: [], requests: [], nativeMenus: [] };
  const catalog = [session(undefined), ...Array.from({ length: 6 }, (_, n) => session("a", n))];
  const state = {
    currentHost: null,
    projects: [{ host: "b", cwd: ROOT, projectRoot: ROOT, projectKey: "server-key" }],
    hosts: [{ id: "a", label: "A", status: "offline" }, { id: "b", label: "B", status: "online" }],
  };
  const store = {
    get currentHost() { return state.currentHost; },
    selectWorkspace(id, cwd, host) { state.currentHost = host; calls.select.push([id, cwd, host]); dirty = true; },
  };
  const useState = (initial) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
    return [slots[i], (update) => {
      const next = typeof update === "function" ? update(slots[i]) : update;
      if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; }
    }];
  };
  const changed = (old, next) => !old || !next || old.length !== next.length || old.some((v, i) => !Object.is(v, next[i]));
  const effect = (callback, deps) => {
    const i = cursor++;
    if (!slots[i] || changed(slots[i].deps, deps)) {
      const previous = slots[i];
      const current = { deps };
      slots[i] = current;
      pending.push(() => { previous?.cleanup?.(); current.cleanup = callback(); });
    }
  };
  const hooks = {
    useState,
    useRef: (value) => useState(() => ({ current: value }))[0],
    useCallback: (fn, deps) => {
      const i = cursor++;
      if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { deps, value: fn };
      return slots[i].value;
    },
    useMemo: (fn, deps) => {
      const i = cursor++;
      if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { deps, value: fn() };
      return slots[i].value;
    },
    useEffect: effect, useLayoutEffect: effect,
  };
  const prefs = new Map();
  const transport = async (raw, init = {}) => {
    const url = new URL(String(raw), "http://sidebar.test");
    calls.requests.push({ path: url.pathname, method: init.method ?? "GET", body: init.body && JSON.parse(init.body) });
    if (url.pathname === "/api/sessions") return Response.json({ sessions: catalog, sessionListVersion: 1 });
    if (url.pathname === "/api/home") return Response.json({ home: "/home/local" });
    if (url.pathname.includes("worktrees")) {
      if (delayBranches && url.pathname === "/api/r/b/worktrees" && url.searchParams.has("branches")) {
        delayBranches = false;
        await new Promise((resolve) => { calls.releaseBranches = resolve; });
      }
      if (url.pathname.startsWith("/api/r/a/")) return Response.json({ error: "remote_offline" }, { status: 503 });
      return Response.json({ projectRoot: ROOT, projectKey: "server-key", isGit: true, isTopLevel: true,
        branches: ["main", "topic"], remoteBranches: [], branch: "topic", path: `${ROOT}-worktrees/topic`,
        worktrees: [{ path: ROOT, isMain: true, branch: "main" }], currentWorktreePath: ROOT });
    }
    return Response.json({ supported: true, platform: "darwin" });
  };
  // Emulate the global router: an unscoped worktree call would follow A.
  // The captured local client must bypass this even when A is active.
  const routedFetch = (raw, init) => {
    const url = new URL(String(raw), "http://sidebar.test");
    if (state.currentHost && url.pathname.startsWith("/api/worktrees")) url.pathname = `/api/r/${state.currentHost}${url.pathname.slice(4)}`;
    return transport(url, init);
  };
  const noop = () => {};
  const t = (key) => key;
  const modules = {
    react: hooks,
    "react/jsx-runtime": require("react/jsx-runtime"),
    "react-dom": { createPortal: (element) => element },
    "@/lib/remote/project-identity": { hostedProjectKey, resolveHostedProject },
    "@/lib/remote/scoped-api": { createBackendApi },
    "@/lib/remote/client": { localFetch: transport },
    "@/lib/remote/client-store": { remoteClientStore: store },
    "@/components/remote/useRemote": { useRemoteClientState: () => state },
    "./useRemote": { useRemoteClientState: () => state, GlobeIcon: () => null, hostStatusTone: (status) => status },
    "@/lib/project-group": { groupByProject },
    "@/lib/project-display": { getProjectDisplayNames: () => new Map(), getProjectDisplayName: () => "app" },
    "@/lib/session-family": { listSessionFamilies: () => [] },
    "@/lib/recent-sessions": { getRecallSessions: () => [], hasRecallSessionsToday: () => false },
    "./path-ui": { getRecentProjects: (sessions) => [...new Set(sessions.map((s) => s.projectRoot))] },
    "@/hooks/useI18n": { useI18n: () => ({ t }) },
    "@/lib/app-prefs": { APP_PREF_KEYS: { collapsedProjects: "collapsed", archivedProjects: "archived", expandedProjects: "expanded" },
      getPrefJson: (key) => prefs.get(key), setPrefJson: (key, value) => prefs.set(key, value), removePref: (key) => prefs.delete(key) },
    "@/lib/desktop-updater": { isTauriDesktop: () => native },
    "@/lib/desktop-window": { getDesktopPlatform: () => "macos" },
    "@/lib/desktop-menu": { canUseNativeMenu: () => native, menuPointBelow: () => ({ x: 10, y: 10 }),
      showNativeMenu: async (entries) => { calls.nativeMenus.push(entries); return true; } },
    "./desktop": { useWindowDrag: () => ({}) },
    "@/hooks/useScheduledTasks": { isScheduledRunSession: () => false },
    "@/components/remote/BackendScope": { BackendScopeProvider: "BackendScopeProvider" },
  };
  function load(path) {
    const output = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports = {};
    vm.runInNewContext(output, { exports, require: (name) => modules[name] ?? {}, fetch: routedFetch,
      window: { location: { origin: "http://sidebar.test" }, innerWidth: 1000, innerHeight: 800, addEventListener: noop, removeEventListener: noop },
      document: { visibilityState: "visible", addEventListener: noop, removeEventListener: noop },
      EventSource: class { close() {} }, setInterval: noop, clearInterval: noop, setTimeout: noop, clearTimeout: noop,
      crypto, console, URL, Response, Request,
    }, { filename: path });
    return exports;
  }
  modules["./ProjectContextMenu"] = modules["@/components/ProjectContextMenu"] = load("./ProjectContextMenu.tsx");
  modules["@/hooks/useProjectWorktreeActions"] = load("../hooks/useProjectWorktreeActions.ts");
  modules["@/components/remote/RemoteProjectBadge"] = load("./remote/RemoteProjectBadge.tsx");
  const { SessionSidebar } = load("./SessionSidebar.tsx");
  const props = { selectedSessionId: null, skipInitialProjectSelection: true,
    onCwdChange: (...args) => calls.cwd.push(args), onSelectSession: (s) => { assert.equal(store.currentHost, s.host ?? null); },
    onNewSession: (...args) => { assert.equal(store.currentHost, args[2]); calls.new.push(args); },
    onOpenTerminal: (...args) => calls.terminal.push(args),
  };
  async function render() {
    for (let pass = 0; pass < 30; pass++) {
      if (dirty) {
        dirty = false; cursor = 0; pending = []; tree = SessionSidebar(props);
        for (const run of pending) run();
      }
      for (let i = 0; i < 20; i++) await Promise.resolve();
      if (!dirty) return tree;
    }
    throw new Error("Unstable sidebar render");
  }
  const nodes = (node = tree) => !node || typeof node !== "object" ? []
    : Array.isArray(node) ? node.flatMap((item) => nodes(item ?? null)) : [node, ...nodes(node.props?.children ?? null)];
  const group = (host) => nodes().find((n) => n.props?.["data-project-key"] === hostedProjectKey(ROOT, host));
  const byClass = (node, name) => nodes(node).find((n) => n.props?.className?.split(" ").includes(name));
  const menu = () => nodes().find((n) => n.type === modules["./ProjectContextMenu"].ProjectContextMenu)?.props;
  const event = { stopPropagation: noop, currentTarget: { getBoundingClientRect: () => ({ right: 100, bottom: 100, top: 80 }) } };
  const more = async (host) => { byClass(group(host), "sidebar-project-tree-more").props.onClick(event); await render(); };
  return { render, calls, state, prefs, nodes, group, byClass, menu, more, store,
    badge: (host) => modules["@/components/remote/RemoteProjectBadge"].RemoteProjectBadge({ host }),
  };
}

test("local/A-offline/B-empty keep independent rows, selection, New, folding and archive", async () => {
  const h = harness();
  await h.render();
  for (const host of [null, "a", "b"]) assert.ok(h.group(host), String(host));
  assert.equal(h.badge(null), null);
  assert.match(h.badge("a").props.className, /is-offline/);
  assert.equal(h.badge("b").props["data-remote-host"], "b");
  assert.equal(h.nodes(h.group("a")).filter((n) => n.props?.node?.session).length, 5);
  assert.equal(h.nodes(h.group("b")).filter((n) => n.props?.node?.session).length, 0);
  for (const host of ["a", "b", null]) {
    h.byClass(h.group(host), "sidebar-project-tree-action").props.onClick();
    await h.render();
    assert.deepEqual(h.calls.new.at(-1).slice(1), [ROOT, host]);
    assert.deepEqual(h.calls.cwd.at(-1), [ROOT, ROOT, "server-key", host]);
  }
  // Project header selection must notify even when cwd and server key have
  // not changed between machines. Restore folding after each selection.
  for (const host of ["b", "a", null]) {
    h.byClass(h.group(host), "sidebar-project-tree-row-main").props.onClick();
    await h.render();
    assert.equal(h.state.currentHost, host);
    assert.equal(h.calls.cwd.at(-1)[3], host);
    h.byClass(h.group(host), "sidebar-project-tree-row-main").props.onClick();
    await h.render();
  }
  // A's cached session remains selectable even while A cannot serve worktrees.
  const row = h.nodes(h.group("a")).find((n) => n.props?.node?.session);
  row.props.onSelectSession(row.props.node.session);
  await h.render();
  assert.equal(h.state.currentHost, "a");
  h.byClass(h.group("a"), "sidebar-project-tree-show-more").props.onClick();
  await h.render();
  assert.deepEqual([...h.prefs.get("expanded")], [hostedProjectKey(ROOT, "a")]);
  h.byClass(h.group("a"), "sidebar-project-tree-row-main").props.onClick();
  await h.render();
  assert.match(h.group("a").props.className, /is-collapsed/);
  for (const host of [null, "b"]) assert.doesNotMatch(h.group(host).props.className, /is-collapsed/);
  await h.more("a");
  h.menu().onArchive();
  await h.render();
  assert.equal(h.group("a"), undefined);
  for (const host of [null, "b"]) assert.ok(h.group(host));
});

test("background More/branch/fetch/terminal captures B or local without selecting it", async () => {
  const h = harness();
  await h.render();
  h.store.selectWorkspace("a-0", ROOT, "a");
  await h.render();
  for (const host of ["b", null]) {
    await h.more(host);
    assert.equal(h.state.currentHost, "a");
    assert.equal(h.menu().canReveal, host === null);
    assert.equal(h.menu().selectedCwd, null);
    h.menu().onShowBranches();
    await h.render();
    assert.equal(h.menu().branchMenu.host, host);
    h.menu().onFetch();
    await h.render();
    h.menu().onSwitchBranch("topic");
    await h.render();
    assert.equal(h.state.currentHost, "a");
    const prefix = host ? `/api/r/${host}` : "/api";
    assert.ok(h.calls.requests.some((r) => r.path === `${prefix}/worktrees` && r.method === "PUT" && r.body.cwd === ROOT));
    assert.ok(h.calls.requests.some((r) => r.path === `${prefix}/worktrees/fetch` && r.method === "POST"));
    await h.more(host);
    h.menu().onOpenTerminal();
    await h.render();
    assert.deepEqual(h.calls.terminal.at(-1), [ROOT, host]);
    assert.equal(h.state.currentHost, "a");
  }
});

test("late B branch data cannot overwrite a same-path local menu", async () => {
  const h = harness({ delayBranches: true });
  await h.render();
  await h.more("b");
  h.menu().onShowBranches();
  await h.render();
  assert.equal(h.menu().branchLoading, true);
  await h.more(null);
  h.menu().onShowBranches();
  await h.render();
  assert.equal(h.menu().branchMenu.host, null);
  h.calls.releaseBranches();
  await h.render();
  assert.equal(h.menu().branchMenu.host, null);
  assert.equal(h.menu().branchLoading, false);
});

test("native project menus retain the group backend and suppress remote reveal", async () => {
  const h = harness({ native: true });
  await h.render();
  h.store.selectWorkspace(null, ROOT, "a");
  await h.render();
  await h.more("b");
  const entries = h.calls.nativeMenus.at(-1);
  assert.ok(!entries.some((entry) => entry.label === "sidebar.openInFinder"));
  entries.find((entry) => entry.label === "sidebar.openTerminalHere").onSelect();
  assert.deepEqual(h.calls.terminal.at(-1), [ROOT, "b"]);
  entries.find((entry) => entry.label === "sidebar.worktrees").onSelect();
  await h.render();
  assert.ok(h.calls.requests.some((r) => r.path === "/api/r/b/worktrees"));
  assert.equal(h.state.currentHost, "a");
  // Native → DOM continuation must survive the parent native popup closing.
  h.calls.nativeMenus.at(-1).find((entry) => entry.label === "sidebar.newWorktree").onSelect();
  await h.render();
  assert.equal(h.menu().projectRoot, ROOT);
  assert.equal(h.menu().branchMenu.host, "b");
});
