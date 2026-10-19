/**
 * Remote UI regression test with fully mocked HTTP backends. No SSH, model
 * calls, auth files or real project writes. Uses the real compiled frontend.
 *
 * With a dev/test server already running:
 *   E2E_BASE_URL=http://127.0.0.1:30141 PLAYWRIGHT_CHANNEL=chrome node e2e/remote-hosts.mjs
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chromium } from "playwright";

const root = "/work/app";
const version = "2026-01-01T12:00:00Z";
const row = (id, host) => ({
  id, ...(host ? { host } : {}), cwd: root, projectRoot: root, projectKey: root,
  path: `/sessions/${id}.jsonl`, name: `Chat on ${host ?? "local"}`,
  firstMessage: "fixture", created: version, modified: version, messageCount: 0,
});
const host = (id, status) => ({
  id, label: id === "alpha" ? "Alpha" : "Beta", ssh: `${id}.example.invalid`,
  status, phase: null, error: null, version: "fixture", remoteVersion: "fixture",
  platform: "linux-x64", home: "/work", connectedAt: status === "online" ? 1 : null,
  lastOnlineAt: 1, busySessionIds: null, runningSessionIds: [],
});
const models = (backend) => ({
  models: { [`test:model-${backend}`]: `Model on ${backend}` },
  modelList: [{ provider: "test", id: `model-${backend}`, name: `Model on ${backend}`, input: ["text"] }],
  defaultModel: { provider: "test", modelId: `model-${backend}` },
  defaultThinkingLevel: "off", savedDefaultThinkingLevel: "off", thinkingLevelMaps: {}, thinkingLevelPins: {},
  thinkingLevels: { [`test:model-${backend}`]: ["off"] },
});

export async function checkRemoteHosts(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1320, height: 900 }, locale: "en-US" });
  const calls = [];
  const hosts = [host("alpha", "offline"), host("beta", "online")];
  const sessions = [row("local-chat"), row("alpha-chat", "alpha")];
  const errors = [];
  await context.addInitScript(() => {
    localStorage.setItem("pi-locale", "en");
    localStorage.setItem("pi-remote:projects:v1", JSON.stringify([
      { host: "beta", cwd: "/work/app/worktree", projectRoot: "/work/app", projectKey: "/work/app" },
    ]));
    localStorage.setItem("pi-remote:roots:v1", JSON.stringify({ beta: ["/work/app", "/work/app/worktree"] }));
  });
  // Intercept every API call, including unknown ones, so this test cannot touch
  // the live dev server's sessions/settings even on a regression.
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const match = /^\/api\/r\/([^/]+)(\/.*)$/.exec(url.pathname);
    const backend = match?.[1] ?? "local";
    const path = match ? `/api${match[2]}` : url.pathname;
    const body = request.postDataJSON();
    calls.push({ backend, path, method: request.method(), body, query: url.search });
    const json = (data, status = 200) => route.fulfill({ status, json: data });
    if (match && hosts.find((h) => h.id === backend)?.status !== "online") return json({ error: "remote_offline" }, 503);
    if (path === "/api/remote-hosts") return json({ hosts, bundle: { version: "fixture" } });
    if (/\/api\/remote-hosts\/[^/]+\/connect$/.test(path)) {
      const h = hosts.find((h) => path.includes(`/${h.id}/`));
      h.status = "online";
      h.connectedAt = 2;
      return json({ host: h });
    }
    if (path === "/api/remote-hosts/ssh-config") return json({ hosts: [] });
    if (path === "/api/remote-hosts/aggregate/sessions" || path === "/api/sessions") {
      return json({ sessions, sessionListVersion: 1, runningSessionIds: [] });
    }
    if (path.endsWith("/running-events") || path.endsWith("/running/events")) {
      return route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "running", runningSessionIds: [], sessionListVersion: 1, remoteHosts: hosts })}\n\n` });
    }
    if (path.endsWith("/events")) return route.fulfill({ contentType: "text/event-stream", body: ":\n\n" });
    if (path === "/api/models") return json(models(backend));
    if (path === "/api/models-config") return json({ providers: {} });
    if (path === "/api/auth/providers") return json({ oauthProviders: [], apiKeyProviders: [] });
    if (path === "/api/models/enabled") return json({ providers: [], allEnabled: true, stalePatterns: [], availableTotal: 0, enabledTotal: 0, editable: true });
    if (path === "/api/models/nonchat") return json({ models: [], codemode: "automatic" });
    if (path === "/api/cwd/status") return json({ availability: "available" });
    if (path === "/api/cwd/validate") {
      const cwd = body?.cwd ?? root;
      const projectRoot = cwd.startsWith(root) ? root : cwd;
      return json({ success: true, cwd, projectRoot, projectKey: projectRoot });
    }
    if (path === "/api/cwd/browse") {
      const at = url.searchParams.get("path") ?? root;
      const parentPath = at === "/" ? null : at.replace(/\/[^/]+$/, "") || "/";
      const directories = at.endsWith("-folder") ? [] : [{ name: `${backend}-folder`, path: `${at === "/" ? "" : at}/${backend}-folder` }];
      return json({ path: at, parentPath, directories });
    }
    if (path === "/api/worktrees" || path === "/api/worktrees/fetch") return json({ projectRoot: root, projectKey: root, isGit: false, worktrees: [], branches: [] });
    if (path === "/api/project-trust") return json({ cwd: root, trusted: true, requiresTrust: false });
    if (path === "/api/skills") return json({ skills: [], diagnostics: [], loaded: true });
    if (path === "/api/file-index") return json({ files: [] });
    if (path === "/api/git/status") return json({ files: [], changes: [] });
    if (path === "/api/agent/new") return json({ sessionId: `${backend}-new`, success: true });
    if (/\/api\/agent\/[^/]+$/.test(path)) return json({ running: false, success: true, data: {} });
    if (/\/api\/sessions\/[^/]+\/state$/.test(path)) return json({ running: false });
    if (/\/api\/sessions\/[^/]+$/.test(path)) {
      const info = sessions.find((s) => path.endsWith(`/${s.id}`)) ?? row(`${backend}-new`, backend === "local" ? undefined : backend);
      return json({ info, tree: [], context: { messages: [], entryIds: [], hasMore: false, oldestEntryId: null, model: null }, stats: {}, activeLeafId: null });
    }
    if (path === "/api/terminal") return json({ id: body?.id });
    if (/\/api\/terminal\/[^/]+$/.test(path)) return json({ success: true, cwd: root });
    if (path === "/api/home") return json({ home: "/work" });
    if (path === "/api/open-in-explorer") return json({ supported: false });
    if (path === "/api/web-auth") return json({ enabled: false, authenticated: true });
    if (path === "/api/tools/settings") return json({ isWindows: false, powerShellEnabled: false });
    if (path === "/api/artifacts/settings") return json({ enabled: true });
    if (path === "/api/scheduled-tasks") return json({ tasks: [], runs: [], scheduler: {} });
    if (path === "/api/custom-css") return route.fulfill({ contentType: "text/css", body: "" });
    return json({});
  });
  const page = await context.newPage();
  // E2E_SCREENSHOTS=<dir> keeps a picture of each checked state for review.
  const shot = async (name) => {
    if (!process.env.E2E_SCREENSHOTS) return;
    await mkdir(process.env.E2E_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/${name}.png` });
  };
  page.setDefaultTimeout(25_000);
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${base}/?cwd=${encodeURIComponent(root)}&host=local`, { waitUntil: "domcontentloaded" });
    const local = page.locator('[data-project-key="/work/app"]');
    const alpha = page.locator('[data-project-key="r:alpha:/work/app"]');
    const beta = page.locator('[data-project-key="r:beta:/work/app"]');
    // Remembered remote projects render immediately; discovered ones need the
    // merged session list, so wait for every row before counting.
    await Promise.all([local.waitFor(), alpha.waitFor(), beta.waitFor()]);
    assert.equal(await page.locator(".sidebar-project-tree-group").count(), 3, "worktree grants must not create duplicate rows");
    assert.equal(await local.locator(".sidebar-project-remote-globe").count(), 0);
    await alpha.locator(".sidebar-project-remote-globe.is-offline").waitFor();
    await beta.locator(".sidebar-project-remote-globe.is-online").waitFor();
    await shot("1-sidebar");

    const betaModels = page.waitForRequest((req) => new URL(req.url()).pathname === "/api/r/beta/models");
    await beta.locator(".sidebar-project-tree-row-main").click();
    await betaModels;
    await page.waitForURL((url) => url.searchParams.get("host") === "beta");
    await page.getByText("Model on beta", { exact: true }).first().waitFor();

    // Local -> remote -> local with the exact same physical path must reset the
    // composer rather than getting swallowed as project-key hydration.
    const localModels = page.waitForRequest((req) => new URL(req.url()).pathname === "/api/models");
    await local.locator(".sidebar-project-tree-row-main").click();
    await localModels;
    await page.waitForURL((url) => url.searchParams.get("host") !== "beta");

    // Settings may inspect beta while the open composer stays local.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("menuitem", { name: "General", exact: true }).click();
    const scope = page.locator(".settings-remote-scope select");
    await scope.waitFor();
    await scope.selectOption("beta");
    const modelSettings = page.waitForRequest((req) => new URL(req.url()).pathname === "/api/r/beta/models-config");
    await page.locator(".settings-section-tab").filter({ hasText: /^Models$/ }).click();
    await modelSettings;
    await shot("2-settings-scope");
    const background = await page.evaluate(async () => (await fetch("/api/models?cwd=%2Fwork%2Fapp")).json());
    assert.equal(background.defaultModel.modelId, "model-local", "Settings scope must not hijack background requests");
    // The host manager opens above Settings, and Escape closes only it.
    await page.locator(".settings-remote-scope-manage").click();
    const manager = page.locator(".remote-dialog-overlay");
    await manager.waitFor();
    await shot("3-host-manager-over-settings");
    await manager.getByText("beta.example.invalid", { exact: true }).click({ trial: true });
    await page.keyboard.press("Escape");
    await manager.waitFor({ state: "detached" });
    await scope.waitFor();
    await page.locator(".settings-dialog-close").click();

    // The first directory listing (a child effect) is already on beta.
    await page.locator(".sidebar-project-tree-add").click();
    await page.getByRole("menuitem").filter({ hasText: /Beta/ }).click();
    await page.getByText("beta-folder", { exact: true }).waitFor();
    assert.equal(await page.getByText("local-folder", { exact: true }).count(), 0);
    // Pick a brand-new folder on beta while the open workspace is local: the
    // project must be created on beta (globe), not attributed to local.
    await page.getByText("beta-folder", { exact: true }).click();
    await page.locator(".directory-picker-path").first().waitFor();
    await page.waitForFunction(() => document.querySelector(".directory-picker-path")?.value === "/work/beta-folder");
    const validated = page.waitForRequest((req) => new URL(req.url()).pathname === "/api/r/beta/cwd/validate");
    await page.getByRole("button", { name: "Select this folder", exact: true }).click();
    await validated;
    const picked = page.locator('[data-project-key="r:beta:/work/beta-folder"]');
    await picked.locator(".sidebar-project-remote-globe.is-online").waitFor();
    await shot("4-remote-folder-picked");
    assert.equal(await page.locator('[data-project-key="/work/beta-folder"]').count(), 0, "remote pick must not create a local row");
    await page.waitForURL((url) => url.searchParams.get("host") === "beta" && url.searchParams.get("cwd") === "/work/beta-folder");
    await page.getByText("Model on beta", { exact: true }).first().waitFor();

    await alpha.locator(".sidebar-project-tree-row-main").click();
    await page.locator(".remote-host-banner.is-offline").waitFor();
    // The composer says the host is offline (not "Model error: remote_offline",
    // not "folder deleted") and holds sends until it is back.
    const hostOffline = page.locator('[data-workspace-unavailable="host-offline"]');
    await hostOffline.waitFor();
    assert.match(await hostOffline.innerText(), /Alpha is not connected/);
    assert.equal(await page.getByText("remote_offline").count(), 0, "raw proxy error must not be shown");
    await shot("5-offline-banner");
    assert.equal(await page.locator(".sidebar-project-tree-group").count(), 4, "offline projects remain visible");
    // Reconnect from the composer notice itself.
    const connected = page.waitForRequest((req) => new URL(req.url()).pathname === "/api/remote-hosts/alpha/connect");
    await hostOffline.getByRole("button", { name: "Reconnect", exact: true }).click();
    await connected;
    await alpha.locator(".sidebar-project-remote-globe.is-online").waitFor();
    await page.locator(".remote-host-banner").waitFor({ state: "detached" });
    await hostOffline.waitFor({ state: "detached" });
    await page.getByText("Model on alpha", { exact: true }).first().waitFor();

    assert.deepEqual(errors, [], "Unexpected browser errors");
    assert.ok(calls.some((call) => call.backend === "beta" && call.path === "/api/cwd/browse"));
    assert.equal(calls.some((call) => call.body?.type === "prompt"), false, "No model prompts in this suite");
    console.log("PASS: same-path local/remote selection, empty/offline projects, scoped settings, remote folder pick and reconnect");
  } catch (error) {
    await mkdir("test-results/remote", { recursive: true });
    await page.screenshot({ path: "test-results/remote/failure.png", fullPage: true });
    console.error("Remote UI requests (no payloads):", calls.slice(-18).map(({ method, backend, path }) => `${method} ${backend} ${path}`));
    throw error;
  } finally {
    await context.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.env.E2E_BASE_URL;
  assert.ok(base, "Set E2E_BASE_URL to a running test/dev UI");
  const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  try { await checkRemoteHosts(browser, base); } finally { await browser.close(); }
}
