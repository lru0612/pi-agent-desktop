import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createBackendApi } = await jiti.import("../lib/remote/scoped-api.ts");
const { loadMcpOverview } = await jiti.import("./mcp-config-helpers.ts");
const files = new Map();
for (const file of ["SettingsPanel", "ModelsConfig", "EnabledModelsSection", "AgentsConfig", "SkillsConfig", "PluginsConfig", "McpConfig", "ArtifactsSettingRow", "NonChatModelsDetail", "ProviderUsageSummary", "remote/RemoteIntegration"]) {
  const source = await readFile(new URL(`./${file}.tsx`, import.meta.url), "utf8");
  files.set(file, ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
}
function find(root, predicate) {
  if (predicate(root)) return root;
  return ts.forEachChild(root, (node) => find(node, predicate));
}
function component(file, name) {
  const node = find(files.get(file), (node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, name);
  return node;
}
function callback(file, owner, name) {
  const node = find(component(file, owner), (node) => ts.isVariableDeclaration(node) && node.name.getText() === name);
  assert.ok(node?.initializer, name);
  return node.initializer.getText();
}
// Run only the selected component/handler, with mocked hooks and no DOM, server,
// credentials or network. A missed transport binding fails instead of making I/O.
function evaluate(text, bindings) {
  const code = ts.transpileModule(`const tested = (${text.replace(/^export /, "")});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: "jsx", jsxFragmentFactory: "Fragment" },
  }).outputText;
  return new Script(`${code}\ntested;`).runInNewContext({
    jsx: (type, props, ...children) => ({ type, props: { ...props, children } }),
    Fragment: "Fragment",
    fetch() { throw new Error("Unscoped network request"); },
    useCallback: (fn) => fn,
    useEffect() {},
    useLayoutEffect() {},
    useRef: (current) => ({ current }),
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useI18n: () => ({ t: (key) => key, locale: "en", supportedLocales: [], setLocale() {} }),
    ...bindings,
  });
}
function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...elements(tree.props?.children)];
}

const requestOwners = {
  SettingsPanel: ["GeneralSettings"],
  ModelsConfig: ["ModelsConfig", "ProviderDetail", "ModelDetail", "OAuthDetail", "ApiKeyDetail"],
  EnabledModelsSection: ["useEnabledModels", "useCatalogRefresh"],
  AgentsConfig: ["AgentsConfig"],
  SkillsConfig: ["SkillsConfig", "AddSkillPanel"],
  PluginsConfig: ["PluginsConfig"],
  McpConfig: ["McpConfig"],
  ArtifactsSettingRow: ["ArtifactsSettingRow"],
  NonChatModelsDetail: ["NonChatModelsDetail"],
  ProviderUsageSummary: ["ProviderUsageContent"],
};
test("all settings request owners capture the provider's transport, including inner model/auth panes", () => {
  for (const [file, names] of Object.entries(requestOwners)) {
    for (const name of names) {
      assert.match(component(file, name).body.getText(), /const \{ fetch(?:, [^}]+)? \} = useBackendApi\(\);/, `${file}: ${name}`);
    }
    assert.doesNotMatch(files.get(file).text, /(?:window|globalThis)\.fetch\(/, file);
  }
  assert.match(component("ModelsConfig", "OAuthDetail").body.getText(), /new EventSource\(url\(`/);
});

test("every MCP helper receives captured fetch, including polling, paste and cancel", () => {
  const positions = { loadMcpOverview: 1, saveMcpCodemodePreference: 1, saveMcpCodemodeMode: 1, saveMcpCodemodeInlineBudget: 1, postMcpAction: 2, postMcpTest: 2, postMcpSignIn: 2, getMcpSignIn: 1, pasteMcpSignIn: 2, cancelMcpSignInFlow: 1 };
  for (const [name, index] of Object.entries(positions)) {
    const call = find(component("McpConfig", "McpConfig"), (node) => ts.isCallExpression(node) && node.expression.getText() === name);
    assert.equal(call?.arguments[index]?.getText(), "fetch", name);
  }
});

test("settings scope is local state, respects a local cwd owner, and cannot change during an update", () => {
  let state = { currentHost: "host-a", hosts: [{ id: "host-a", status: "online" }] };
  let saved;
  let initialized = false;
  const useScope = evaluate(component("remote/RemoteIntegration", "useRemoteConfigScope").getText(), {
    useState(initial) {
      if (!initialized) { saved = initial(); initialized = true; }
      return [saved, (next) => { saved = next; }];
    },
    useRemoteClientState: () => state,
    remoteClientStore: { ownerOfPath: () => null },
    GlobeIcon: "GlobeIcon",
    hostStatusTone: () => "online",
  });
  const select = (result) => elements(result.element).find((node) => node.type === "select");
  const local = useScope("/local/project");
  assert.equal(local.host, null, "known local ownership must not fall back to the remote workspace");
  assert.equal(local.cwdApplies, true);
  select(local).props.onChange({ target: { value: "host-a" } });
  const remote = useScope("/local/project");
  assert.equal(remote.host, "host-a");
  assert.equal(remote.cwdApplies, false);
  assert.equal(state.currentHost, "host-a", "the hook never writes the workspace store");
  state = { ...state, currentHost: null };
  const busy = useScope("/local/project", true);
  assert.equal(busy.host, "host-a", "a workspace change does not overwrite the user's settings choice");
  assert.equal(select(busy).props.disabled, true);
  select(busy).props.onChange({ target: { value: "local" } });
  assert.equal(useScope("/local/project").host, "host-a");
});

test("Settings remounts a provider per backend and withholds unrelated session/trust props", () => {
  const names = ["BackendScopeProvider", "GeneralSettings", "ModelsConfig", "SkillsConfig", "AgentsConfig", "PluginsConfig", "McpConfig", "SettingsSectionIcon"];
  const panel = evaluate(component("SettingsPanel", "SettingsPanel").getText(), {
    ...Object.fromEntries(names.map((name) => [name, name])),
    useRemoteConfigScope: () => ({ host: "host-b", scopeKey: "host-b", cwdApplies: false, element: null }),
    SETTINGS_SECTION_ITEMS: [],
    settingsSectionRequiresProject: () => false,
  });
  const tree = panel({ cwd: "/host-a/project", sessionId: "session-a", initialSection: "general", projectTrust: { trusted: true }, onOpenTrustDialog() {}, onProjectTrustChanged() {} });
  const nodes = elements(tree);
  const provider = nodes.find((node) => node.type === "BackendScopeProvider");
  assert.equal(provider.props.key, "host-b");
  assert.equal(provider.props.host, "host-b");
  assert.equal(nodes.find((node) => node.type === "GeneralSettings").props.sessionId, null);
  const mcp = elements(panel({ initialSection: "mcp", cwd: "/host-a/project", projectTrust: { trusted: true }, onOpenTrustDialog() {} })).find((node) => node.type === "McpConfig");
  assert.equal(mcp.props.cwd, null);
  assert.equal(mcp.props.trust, undefined);
  assert.equal(mcp.props.onTrustProject, undefined);
});

test("remote General hides local app, appearance and native controls but retains backend artifacts", () => {
  const general = (host) => evaluate(component("SettingsPanel", "GeneralSettings").getText(), {
    useBackendApi: () => ({ host, fetch() { throw new Error("effects must not run"); } }),
    useTheme: () => ({}), useDiffViewMode: () => ({}), useChatAppearance: () => ({}), useEnterSendMode: () => "enter",
    isTauriDesktop: () => true, PRODUCT_NAME: "Test", THEME_OPTIONS: [],
    CHAT_CONTENT_WIDTH_DEFAULT: 800, CHAT_CONTENT_WIDTH_MIN: 400, CHAT_CONTENT_WIDTH_MAX: 1200,
    CHAT_CONTENT_FONT_SIZE_DEFAULT: 14, CHAT_CONTENT_FONT_SIZE_MIN: 10, CHAT_CONTENT_FONT_SIZE_MAX: 24,
    AppUpdatesSection: "AppUpdatesSection", DesktopAppSection: "DesktopAppSection", ArtifactsSettingRow: "ArtifactsSettingRow",
    ConfigButton: "ConfigButton", ConfigSwitch: "ConfigSwitch",
  })({});
  const local = elements(general(null));
  const remote = elements(general("host-a"));
  for (const type of ["AppUpdatesSection", "DesktopAppSection"]) {
    assert.ok(local.some((node) => node.type === type));
    assert.ok(!remote.some((node) => node.type === type));
  }
  for (const className of ["settings-language-options", "settings-theme-options", "settings-option-action"]) {
    assert.ok(local.some((node) => node.props.className === className), className);
    assert.ok(!remote.some((node) => node.props.className === className), className);
  }
  assert.ok(remote.some((node) => node.type === "ArtifactsSettingRow"));
});

test("a PowerShell save finishing after scope unmount never reloads the session", async () => {
  let finish;
  let reloads = 0;
  const mountedRef = { current: true };
  const toggle = evaluate(callback("SettingsPanel", "GeneralSettings", "togglePowerShell"), {
    fetch: () => new Promise((resolve) => { finish = resolve; }),
    setShellSaving() {}, setShellError() {}, setShellSettings() {},
    sessionId: "session-a", mountedRef,
    sendAgentCommand: () => { reloads++; }, onSessionReloaded: () => { reloads++; },
  });
  const request = toggle(true);
  mountedRef.current = false;
  finish(Response.json({ isWindows: true, powerShellEnabled: true }));
  await request;
  assert.equal(reloads, 0);
});

test("models.json save and its post-await enabledModels resync use the same captured backend", async () => {
  const calls = [];
  let finishSave;
  const transport = async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path.endsWith("/models-config")) return new Promise((resolve) => { finishSave = resolve; });
    return Response.json({ providers: [] });
  };
  let api = createBackendApi("host-a", transport, () => "http://settings.test");
  const enabledModels = evaluate(component("EnabledModelsSection", "useEnabledModels").getText(), {
    useBackendApi: () => api,
  })(null);
  const save = evaluate(callback("ModelsConfig", "ModelsConfig", "handleSave"), {
    fetch: api.fetch, enabledModels,
    config: { providers: {} }, loadError: null, providerNameDraft: null,
    setSaving() {}, setSaveError(error) { if (error) assert.fail(error); }, setSavedOk() {}, setSavedConfig() {},
    renamesRef: { current: new Map() }, savedModelIdsRef: { current: new Map() }, savedProvidersRef: { current: new Set() },
    collectModelRenames: () => [], savedModelIds: () => new Map(),
    applyProviderRename() {}, t: (key) => key, setTimeout() {},
  });
  const pending = save();
  api = createBackendApi("host-b", transport, () => "http://settings.test");
  finishSave(Response.json({ success: true }));
  await pending;
  assert.deepEqual(calls, ["/api/r/host-a/models-config", "/api/r/host-a/models/enabled"]);
});

test("a settings retry after awaiting a cwd refusal stays on its original backend", async () => {
  const calls = [];
  let finish;
  const transport = async (input) => {
    calls.push(new URL(String(input)).pathname);
    if (calls.length === 1) return new Promise((resolve) => { finish = resolve; });
    return Response.json({ mcp: { available: true }, codemode: {}, files: [], servers: [] });
  };
  let api = createBackendApi("host-a", transport, () => "http://settings.test");
  const pending = loadMcpOverview("/project", api.fetch);
  api = createBackendApi("host-b", transport, () => "http://settings.test");
  finish(Response.json({ error: "Denied", reason: "cwd-denied" }, { status: 403 }));
  await pending;
  assert.equal(api.host, "host-b");
  assert.deepEqual(calls, ["/api/r/host-a/mcp", "/api/r/host-a/mcp"]);
});
