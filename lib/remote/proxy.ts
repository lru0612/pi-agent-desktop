/**
 * Forward /api/r/<host>/<rest> to the remote pi-web through its SSH tunnel
 * (fork-owned, server-only). See docs/remote-hosts-design.zh-CN.md §5.3.
 */
import { Readable } from "node:stream";

import * as undici from "undici";

import { getRemoteHostManager } from "./host-manager";
import { isValidHostId } from "./hosts-store";

/** First path segments that must never reach a remote server. */
const BLOCKED = new Set([
  "desktop",          // native dialogs; token-gated local paths
  "open-in-explorer", // would open a file manager on the remote machine
  "custom-css",
  "updates",
  "web-auth",         // the proxy owns the remote session cookie
  "push",
  "r",
  "remote-hosts",
]);

/** Request headers worth forwarding; everything else is dropped. */
const FORWARD_REQUEST_HEADERS = [
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "content-type",
  "content-length",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "last-event-id",
  "range",
  "user-agent",
  "x-pi-dest-path",
  "x-requested-with",
];

/** Response headers that must not be copied from the remote. */
const DROP_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "proxy-connection",
  "upgrade",
]);

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Remote path (with query) for a proxied request URL. */
export function remotePathFor(requestUrl: string, hostId: string): string | null {
  const url = new URL(requestUrl);
  const prefix = `/api/r/${hostId}/`;
  if (!url.pathname.startsWith(prefix)) return null;
  const rest = url.pathname.slice(prefix.length);
  if (!rest) return null;
  return `/api/${rest}${url.search}`;
}

export async function proxyToHost(request: Request, hostId: string): Promise<Response> {
  if (!isValidHostId(hostId)) return json(404, { error: "unknown_host" });
  const remotePath = remotePathFor(request.url, hostId);
  if (!remotePath) return json(404, { error: "not_found" });
  const firstSegment = decodeURIComponent(remotePath.slice("/api/".length).split(/[/?]/)[0] ?? "");
  if (BLOCKED.has(firstSegment)) return json(404, { error: "not_available_remotely" });

  const manager = getRemoteHostManager();
  const snapshot = manager.get(hostId);
  if (!snapshot) return json(404, { error: "unknown_host" });
  const connection = manager.connection(hostId);
  if (!connection) {
    return json(503, { error: "remote_offline", host: hostId, status: snapshot.status });
  }

  const headers: Record<string, string> = {};
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  // Remote SSE routes rely on req.signal; tell intermediaries not to buffer.
  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && request.body !== null;
  // The local proxy.ts already buffered the body (proxyClientMaxBodySize), so
  // reading it whole keeps a 401 retry possible and gives undici a length.
  const body = hasBody ? Buffer.from(await request.arrayBuffer()) : undefined;
  if (body) headers["content-length"] = String(body.length);

  const send = (cookie: string | null) => undici.request(`${connection.baseUrl}${remotePath}`, {
    method: method as undici.Dispatcher.HttpMethod,
    headers: { ...headers, ...(cookie ? { cookie } : {}) },
    body,
    signal: request.signal,
    dispatcher: manager.dispatcher,
  });

  let response: undici.Dispatcher.ResponseData;
  try {
    response = await send(connection.cookie);
    if (response.statusCode === 401) {
      await response.body.dump();
      const runtimeConnection = await reauthenticate(hostId);
      response = await send(runtimeConnection?.cookie ?? null);
    }
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    manager.reportTransportFailure(hostId);
    return json(502, { error: "remote_unreachable", host: hostId, message: (error as Error).message });
  }

  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined || DROP_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
    else responseHeaders.set(name, String(value));
  }
  responseHeaders.set("x-pi-remote-host", hostId);

  const status = response.statusCode;
  if (status === 204 || status === 304 || method === "HEAD") {
    await response.body.dump();
    return new Response(null, { status, headers: responseHeaders });
  }
  const stream = Readable.toWeb(response.body) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, { status, headers: responseHeaders });
}

async function reauthenticate(hostId: string): Promise<{ cookie: string | null } | null> {
  const manager = getRemoteHostManager();
  try {
    // request() re-logs in on 401; a cheap call refreshes the cookie.
    const response = await manager.request(hostId, "/api/remote-info", { headers: { accept: "application/json" } });
    await response.body.dump();
  } catch {
    return null;
  }
  return manager.connection(hostId);
}
