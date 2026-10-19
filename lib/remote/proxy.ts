/**
 * Forward /api/r/<host>/<rest> to the remote pi-web through its SSH tunnel
 * (fork-owned, server-only). See docs/remote-hosts-design.zh-CN.md §5.3.
 */
import { Readable } from "node:stream";

import * as undici from "undici";

import { getRemoteHostManager } from "./host-manager";
import { isValidHostId } from "./hosts-store";
import { proxyLocation, proxyRequestHeaders, proxyResponseHeaders, remotePathFor } from "./proxy-policy";

export { remotePathFor } from "./proxy-policy";

// Match Next's proxyClientMaxBodySize, leaving room for the 100 MiB upload API.
// Replay once after a 401, but never buffer an unbounded/chunked upload.
const MAX_REQUEST_BYTES = 128 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 15_000;

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

class RequestTooLarge extends Error {}

async function replayableBody(request: Request): Promise<Buffer | undefined> {
  request.signal.throwIfAborted();
  if (request.method === "GET" || request.method === "HEAD" || !request.body) return undefined;
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  request.signal.addEventListener("abort", cancel, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES) throw new RequestTooLarge();
    while (true) {
      request.signal.throwIfAborted();
      const { done, value } = await reader.read();
      request.signal.throwIfAborted();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) throw new RequestTooLarge();
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    request.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** Do not wait for an error/redirect body that can be infinite or stay silent. */
function discard(response: undici.Dispatcher.ResponseData): void {
  response.body.on("error", () => {});
  response.body.destroy();
}

export async function proxyToHost(request: Request, hostId: string): Promise<Response> {
  if (!isValidHostId(hostId)) return json(404, { error: "unknown_host" });
  const remotePath = remotePathFor(request.url, hostId);
  if (!remotePath) return json(404, { error: "not_available_remotely" });

  // Host/Origin and local password checks are performed by the outer proxy.ts.
  // Only after those checks may we strip browser credentials and supply the
  // remote cookie; nothing supplied by the browser selects the tunnel origin.
  const manager = getRemoteHostManager();
  const snapshot = manager.get(hostId);
  if (!snapshot) return json(404, { error: "unknown_host" });
  let connection = manager.connection(hostId);
  if (!connection) {
    return json(503, { error: "remote_offline", host: hostId, status: snapshot.status });
  }

  const method = request.method.toUpperCase();
  const headers = proxyRequestHeaders(request.headers);
  let body: Buffer | undefined;
  try {
    body = await replayableBody(request);
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return json(error instanceof RequestTooLarge ? 413 : 400, { error: "invalid_request_body" });
  }
  if (body !== undefined) headers["content-length"] = String(body.length);

  // undici.request with the manager's plain Agent does not follow redirects or
  // decompress bytes (unlike fetch). Keep that true for Range, gzip and SSE.
  const send = (target: { baseUrl: string; cookie: string | null }) => undici.request(`${target.baseUrl}${remotePath}`, {
    method: method as undici.Dispatcher.HttpMethod,
    headers: { ...headers, ...(target.cookie ? { cookie: target.cookie } : {}) },
    body,
    signal: request.signal,
    dispatcher: manager.dispatcher,
  });

  let response: undici.Dispatcher.ResponseData;
  try {
    response = await send(connection);
    if (response.statusCode === 401) {
      discard(response);
      const refreshed = await reauthenticate(hostId, request.signal);
      request.signal.throwIfAborted();
      if (!refreshed) return json(502, { error: "remote_auth_failed", host: hostId });
      // A reconnect may have changed the tunnel port. Never send a new cookie
      // to the stale connection captured before authentication.
      connection = refreshed;
      response = await send(connection);
    }
  } catch {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    manager.reportTransportFailure(hostId);
    // Transport error strings can contain URLs/headers; do not expose them.
    return json(502, { error: "remote_unreachable", host: hostId });
  }

  try {
    const upstreamHeaders = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) upstreamHeaders.append(name, item);
      else upstreamHeaders.set(name, String(value));
    }
    const responseHeaders = proxyResponseHeaders(upstreamHeaders);
    const location = responseHeaders.get("location");
    if (location !== null) {
      const scoped = proxyLocation(location, connection.baseUrl, remotePath, hostId);
      if (!scoped) {
        discard(response);
        return json(502, { error: "remote_redirect_blocked", host: hostId });
      }
      responseHeaders.set("location", scoped);
    }
    responseHeaders.set("x-pi-remote-host", hostId);

    const status = response.statusCode;
    if (status === 204 || status === 205 || status === 304 || method === "HEAD") {
      discard(response);
      return new Response(null, { status, headers: responseHeaders });
    }
    // The default Node adapter measures chunks, not bytes. Explicitly bound its
    // queue so a slow client cannot prefetch 64K *chunks* of a download/error.
    const stream = Readable.toWeb(response.body, {
      strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
    }) as ReadableStream<Uint8Array>;
    // Readable.toWeb propagates cancellation to the upstream body/socket;
    // request.signal additionally covers disconnects before response headers.
    return new Response(stream, { status, headers: responseHeaders });
  } catch {
    discard(response);
    return json(502, { error: "invalid_remote_response", host: hostId });
  }
}

async function reauthenticate(hostId: string, callerSignal: AbortSignal): Promise<{ baseUrl: string; cookie: string | null } | null> {
  const manager = getRemoteHostManager();
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(AUTH_TIMEOUT_MS)]);
  // request() owns the shared login. Its existing signal cancels probe HTTP;
  // racing it also lets this caller leave while another caller's login runs.
  const refresh = manager.request(hostId, "/api/remote-info", {
    headers: { accept: "application/json", "accept-encoding": "identity" }, signal,
  }).then((response) => {
    discard(response); // Also dispose late responses after timeout/cancellation.
    return response.statusCode === 200 ? manager.connection(hostId) : null;
  });
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([
      refresh,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
