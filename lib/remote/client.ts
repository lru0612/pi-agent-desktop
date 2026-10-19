/**
 * Installs the remote request router into the page (fork-owned, client-only).
 *
 * Patches window.fetch, EventSource and XMLHttpRequest.open so every
 * same-origin /api request of the unmodified upstream UI is sent to the
 * backend that owns it (lib/remote/router.ts). `<img>/<a>/<iframe>` URLs cannot
 * be intercepted; their few call sites use routeApiUrl() explicitly.
 *
 * Precedent for this approach: demo/mock/install.ts.
 */
import { remoteClientStore } from "./client-store";
import { resolveApiRequest } from "./router";
import { createRoutedFetch, type RoutedRequest } from "./fetch-router";
import type { HostedSessionInfo, RemoteHostSnapshot, RemoteHostsFrameExtra } from "./types";

const HOST_POLL_MS = 15_000;

let installed = false;
let originalFetch: typeof fetch | null = null;

function decide(url: string, body?: unknown) {
  return resolveApiRequest(url, body, remoteClientStore, window.location.origin);
}

/** Route a URL used outside fetch/EventSource/XHR (img src, a href, iframe src). */
export function routeApiUrl(url: string): string {
  if (typeof window === "undefined") return url;
  return decide(url).url;
}

/** fetch() that bypasses the router (for the router's own calls). */
export function localFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return (originalFetch ?? fetch)(input, init);
}

async function learnResponse({ decision, path, method }: RoutedRequest, response: Response): Promise<void> {
  if (!response.ok) return;
  const list = decision.kind === "aggregate" && path === "/api/sessions";
  const search = decision.kind === "aggregate" && path === "/api/sessions/search";
  const creates = method === "POST" && (path.startsWith("/api/agent/") || path === "/api/terminal");
  if (!list && !search && !creates) return;
  try {
    const data = await response.clone().json();
    if (list && Array.isArray(data.sessions)) remoteClientStore.recordSessions(data.sessions);
    if (search && Array.isArray(data.results)) {
      for (const hit of data.results) {
        const session = hit.session as HostedSessionInfo | undefined;
        if (session) remoteClientStore.recordSession(session.id, session.host ?? null);
      }
    }
    if (creates) {
      if (path === "/api/terminal" && typeof data.id === "string") remoteClientStore.recordTerminal(data.id, decision.host);
      for (const id of [data.sessionId, data.data?.newSessionId, data.data?.sessionId]) {
        if (typeof id === "string") remoteClientStore.recordSession(id, decision.host);
      }
    }
  } catch {
    // Malformed responses are still delivered to the caller's own error UI.
  }
}

function recordRequest({ decision, path, method, body }: RoutedRequest): void {
  if (method === "POST" && path === "/api/terminal" && typeof body === "string") {
    try {
      const id = (JSON.parse(body) as { id?: unknown }).id;
      if (typeof id === "string") remoteClientStore.recordTerminal(id, decision.host);
    } catch {
      // not JSON
    }
  }
}

let hostsTimer: ReturnType<typeof setInterval> | null = null;
/** connectedAt of the connection whose folder grants were last restored, per host. */
const restoredConnections = new Map<string, number>();
const restoringConnections = new Map<string, number>();

/**
 * Apply a host list from the server. A remote server keeps its folder grants
 * (allowFileRoot) in memory only, so after every new connection — which may be
 * a restarted server — folders picked there without any session yet are
 * granted again; otherwise their files and terminals would be refused.
 */
function applyHosts(hosts: RemoteHostSnapshot[]): void {
  remoteClientStore.setHosts(hosts);
  for (const host of hosts) {
    if (host.status !== "online" || !host.connectedAt) continue;
    if (restoredConnections.get(host.id) === host.connectedAt || restoringConnections.get(host.id) === host.connectedAt) continue;
    const connection = host.connectedAt;
    restoringConnections.set(host.id, connection);
    // Mark restored only after every grant succeeded. A temporarily failing
    // request is retried on the next snapshot, not silently forgotten forever.
    void Promise.all(remoteClientStore.pickedRootsOf(host.id).map(async (root) => {
      const response = await localFetch(`/api/r/${encodeURIComponent(host.id)}/cwd/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: root }),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    })).then((results) => {
      if (results.every(Boolean) && remoteClientStore.host(host.id)?.connectedAt === connection) {
        restoredConnections.set(host.id, connection);
      }
    }).catch(() => {}).finally(() => {
      if (restoringConnections.get(host.id) === connection) restoringConnections.delete(host.id);
    });
  }
}

/** Refresh the host list from the local server (also used after host actions). */
export async function refreshRemoteHosts(): Promise<RemoteHostSnapshot[]> {
  try {
    const response = await localFetch("/api/remote-hosts", { cache: "no-store" });
    if (!response.ok) return remoteClientStore.getSnapshot().hosts;
    const data = await response.json() as { hosts?: RemoteHostSnapshot[] };
    applyHosts(data.hosts ?? []);
    return data.hosts ?? [];
  } catch {
    return remoteClientStore.getSnapshot().hosts;
  }
}

export function installRemoteRouter(): void {
  if (installed || typeof window === "undefined") return;
  // The demo build answers /api itself.
  if ((window as unknown as { __piWebDemoInstalled?: boolean }).__piWebDemoInstalled) return;
  installed = true;
  remoteClientStore.load();

  originalFetch = window.fetch.bind(window);
  const realFetch = originalFetch;
  window.fetch = createRoutedFetch({
    origin: () => window.location.origin,
    scope: () => remoteClientStore.currentHost,
    resolve: decide,
    transport: realFetch,
    onRequest: recordRequest,
    onResponse: learnResponse,
  });

  const OriginalEventSource = window.EventSource;
  if (OriginalEventSource) {
    class RoutedEventSource extends OriginalEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        const decision = decide(String(url));
        super(decision.url, init);
        const streamPath = new URL(decision.url, window.location.origin).pathname;
        if (streamPath === "/api/remote-hosts/aggregate/running-events") {
          this.addEventListener("message", (event: MessageEvent<string>) => {
            try {
              const data = JSON.parse(event.data) as RemoteHostsFrameExtra;
              if (Array.isArray(data.remoteHosts)) applyHosts(data.remoteHosts);
            } catch {
              // not ours
            }
          });
        } else if (/\/agent\/[^/]+\/events$/.test(streamPath)) {
          this.addEventListener("message", (event: MessageEvent<string>) => {
            try {
              const data = JSON.parse(event.data) as { type?: string; sessionId?: string };
              if (data.type === "session_replaced" && typeof data.sessionId === "string") {
                remoteClientStore.recordSession(data.sessionId, decision.host);
              }
            } catch { /* a malformed frame is handled by the session consumer */ }
          });
        }
      }
    }
    window.EventSource = RoutedEventSource as typeof EventSource;
  }

  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function routedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    const decision = decide(String(url));
    return xhrOpen.call(this, method, decision.url, async ?? true, username, password);
  } as typeof XMLHttpRequest.prototype.open;

  void refreshRemoteHosts();
  hostsTimer = setInterval(() => {
    if (document.visibilityState === "visible") void refreshRemoteHosts();
  }, HOST_POLL_MS);
}

export function isRemoteRouterInstalled(): boolean {
  return installed && hostsTimer !== null;
}

