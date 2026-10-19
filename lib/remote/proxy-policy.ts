/** Pure routing/header policy for the SSH HTTP proxy. No host or credential IO. */

const BLOCKED = new Set([
  "desktop", "open-in-explorer", "custom-css", "updates", "web-auth", "push", "r", "remote-hosts",
]);

const FORWARD_REQUEST_HEADERS = [
  "accept", "accept-encoding", "accept-language", "cache-control", "content-type", "content-encoding",
  "if-match", "if-modified-since", "if-none-match", "if-unmodified-since", "if-range",
  "last-event-id", "range", "user-agent", "x-pi-dest-path", "x-requested-with",
];

const HOP_BY_HOP = [
  "connection", "keep-alive", "transfer-encoding", "proxy-connection", "upgrade",
  "te", "trailer", "proxy-authorization", "proxy-authenticate",
];

const DROP_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP,
  "set-cookie", "set-cookie2", "www-authenticate", "authentication-info",
  "proxy-authentication-info", "clear-site-data", "refresh", "alt-svc",
]);

function connectionHeaders(value: string | null): Set<string> {
  return new Set([...HOP_BY_HOP, ...(value ?? "").toLowerCase().split(",").map((name) => name.trim())]);
}

/**
 * Validate routing without decoding/re-encoding the URL we send. In particular,
 * /files/%2F%2Fserver/share, /files/C%3A/..., literal percent filenames and an
 * absolute POSIX file path must retain their original wire representation.
 */
export function isSafeRemotePath(pathname: string): boolean {
  if (!pathname.startsWith("/api/")) return false;
  const rest = pathname.slice(5);
  const first = rest.split("/", 1)[0];
  // All API route families are literal ASCII names. Encoded route names and
  // separators have no legitimate use here and can be interpreted differently
  // by URL parsers, middleware and Next's catch-all router.
  if (!/^[a-z][a-z0-9-]*$/.test(first) || BLOCKED.has(first)) return false;
  try {
    decodeURIComponent(rest); // Malformed percent/UTF-8 input is not a server error.
  } catch {
    return false;
  }

  // Inspect nested structural escapes too, but never use this projection as
  // the outgoing path. Decoding only ASCII escapes preserves literal '%' names
  // such as 100%25done without trying to URI-decode them again as UTF-8.
  let projection = rest;
  for (let depth = 0; depth < 16; depth += 1) {
    if (/[\u0000-\u0020\u007f?#]/.test(projection)) return false;
    if (projection.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) return false;
    if (first !== "files" && /\\|%(?:2f|5c)/i.test(projection)) return false;
    const decoded = projection.replace(/%(25|2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/gi,
      (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (decoded === projection) return true;
    projection = decoded;
  }
  return false; // Unreasonably nested escaping: fail closed with bounded work.
}

/** Validated remote path with the query left byte-for-byte intact. */
export function remotePathFor(requestUrl: string, hostId: string): string | null {
  try {
    const url = new URL(requestUrl);
    const prefix = `/api/r/${hostId}/`;
    if (!url.pathname.startsWith(prefix)) return null;
    const path = `/api/${url.pathname.slice(prefix.length)}`;
    return isSafeRemotePath(path) ? `${path}${url.search}` : null;
  } catch {
    return null;
  }
}

/** Never copy local credentials, Origin, desktop tokens or forwarding metadata. */
export function proxyRequestHeaders(source: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  const hop = connectionHeaders(source.get("connection"));
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = source.get(name);
    if (value !== null && !hop.has(name)) headers[name] = value;
  }
  // Content-Length is computed from the actual replayable bytes, not the caller.
  return headers;
}

export function proxyResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  const hop = connectionHeaders(source.get("connection"));
  for (const [name, value] of source) {
    if (hop.has(name) || DROP_RESPONSE_HEADERS.has(name) || name.startsWith("access-control-")) continue;
    headers.set(name, value);
  }
  return headers;
}

/**
 * Browser-followed redirects must stay on this host's API namespace. Never
 * expose the tunnel URL, redirect to the local API, or send a replayed POST to
 * another origin. The HTTP client itself must not follow redirects.
 */
export function proxyLocation(location: string, baseUrl: string, remotePath: string, hostId: string): string | null {
  try {
    const base = new URL(baseUrl);
    const target = new URL(location, `${baseUrl}${remotePath}`);
    if (target.origin !== base.origin || target.username || target.password || !isSafeRemotePath(target.pathname)) return null;
    return `/api/r/${hostId}/${target.pathname.slice(5)}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}
