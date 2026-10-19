/**
 * Explicit backend clients for settings, directory pickers and other views
 * whose lifetime differs from the active chat. No mutable global scope is
 * consulted after a client is created, including after an awaited request.
 */
export type BackendId = string | null; // null is the local installation
export const LOCAL_BACKEND_QUERY = "__pi_backend";

/** These are app/client operations, even inside a remote settings panel. */
const CLIENT_ONLY = new Set(["desktop", "open-in-explorer", "custom-css", "updates", "web-auth", "push", "remote-hosts"]);
const VALID_HOST = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function backendApiUrl(raw: string, host: BackendId, origin: string): string {
  const url = new URL(raw, origin);
  if (url.origin !== origin || !url.pathname.startsWith("/api/")) return raw;
  if (host !== null && (!VALID_HOST.test(host) || host === "local")) throw new Error("Invalid backend id");

  const segments = url.pathname.split("/");
  if (segments[2] === "r") {
    if (segments[3] !== host) throw new Error("Request belongs to another backend");
    return `${url.pathname}${url.search}${url.hash}`;
  }
  if (host === null || CLIENT_ONLY.has(segments[2]!)) {
    // EventSource has no custom headers. The global router strips this marker
    // and must not route it through the active (possibly remote) workspace.
    url.searchParams.set(LOCAL_BACKEND_QUERY, "local");
  } else {
    url.searchParams.delete(LOCAL_BACKEND_QUERY);
    url.pathname = `/api/r/${host}${url.pathname.slice(4)}`;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export interface BackendApi {
  fetch: typeof globalThis.fetch;
  url: (url: string) => string;
  host: BackendId | undefined;
}

/** Injectable transport/origin makes scoping testable without a browser. */
export function createBackendApi(
  host: BackendId,
  transport: typeof globalThis.fetch,
  origin: () => string,
): BackendApi {
  const url = (value: string) => backendApiUrl(value, host, origin());
  const scopedFetch: typeof globalThis.fetch = (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const routed = url(raw);
    // Local fetch bypasses the global router. Strip its EventSource marker.
    const target = new URL(routed, origin());
    if (target.origin === origin()) target.searchParams.delete(LOCAL_BACKEND_QUERY);
    if (input instanceof Request) {
      return transport(new Request(target, input), init);
    }
    return transport(target.href, init);
  };
  return { host, url, fetch: scopedFetch };
}
