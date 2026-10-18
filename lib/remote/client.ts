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
import { resolveApiRequest, stripCwdFromJsonBody, type RouteDecision } from "./router";
import type { HostedSessionInfo, RemoteHostSnapshot, RemoteHostsFrameExtra } from "./types";

const HOST_POLL_MS = 15_000;

let installed = false;
let originalFetch: typeof fetch | null = null;

function decide(url: string, body?: unknown): RouteDecision {
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

function inputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function pathnameOf(url: string): string {
  try {
    return new URL(url, window.location.origin).pathname;
  } catch {
    return "";
  }
}

function tapResponse(decision: RouteDecision, originalPath: string, method: string, response: Promise<Response>): void {
  if (decision.kind === "aggregate" && pathnameOf(decision.url) === "/api/remote-hosts/aggregate/sessions") {
    void response.then((res) => (res.ok ? res.clone().json() : null)).then((data: { sessions?: HostedSessionInfo[] } | null) => {
      if (data?.sessions) remoteClientStore.recordSessions(data.sessions);
    }).catch(() => {});
    return;
  }
  if (method === "POST" && originalPath === "/api/agent/new") {
    void response.then((res) => (res.ok ? res.clone().json() : null)).then((data: { sessionId?: unknown } | null) => {
      if (typeof data?.sessionId === "string") remoteClientStore.recordSession(data.sessionId, decision.host);
    }).catch(() => {});
  }
}

function recordRequest(decision: RouteDecision, originalPath: string, method: string, body: unknown): void {
  if (method === "POST" && originalPath === "/api/terminal" && typeof body === "string") {
    try {
      const id = (JSON.parse(body) as { id?: unknown }).id;
      if (typeof id === "string") remoteClientStore.recordTerminal(id, decision.host);
    } catch {
      // not JSON
    }
  }
}

let hostsTimer: ReturnType<typeof setInterval> | null = null;

/** Refresh the host list from the local server (also used after host actions). */
export async function refreshRemoteHosts(): Promise<RemoteHostSnapshot[]> {
  try {
    const response = await localFetch("/api/remote-hosts", { cache: "no-store" });
    if (!response.ok) return remoteClientStore.getSnapshot().hosts;
    const data = await response.json() as { hosts?: RemoteHostSnapshot[] };
    remoteClientStore.setHosts(data.hosts ?? []);
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
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = inputUrl(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = init?.body;
    const decision = decide(url, body);
    if (!decision.changed) return realFetch(input, init);
    const originalPath = pathnameOf(url);
    recordRequest(decision, originalPath, method, body);
    let nextInit = init;
    if (decision.stripBodyCwd && typeof body === "string") {
      nextInit = { ...init, body: stripCwdFromJsonBody(body) };
    }
    const response = input instanceof Request
      ? realFetch(new Request(decision.url, input), nextInit)
      : realFetch(decision.url, nextInit);
    tapResponse(decision, originalPath, method, response);
    return response;
  };

  const OriginalEventSource = window.EventSource;
  if (OriginalEventSource) {
    class RoutedEventSource extends OriginalEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        const decision = decide(String(url));
        super(decision.url, init);
        if (pathnameOf(decision.url) === "/api/remote-hosts/aggregate/running-events") {
          this.addEventListener("message", (event: MessageEvent<string>) => {
            try {
              const data = JSON.parse(event.data) as RemoteHostsFrameExtra;
              if (Array.isArray(data.remoteHosts)) remoteClientStore.setHosts(data.remoteHosts);
            } catch {
              // not ours
            }
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

