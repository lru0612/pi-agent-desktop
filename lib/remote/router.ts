/**
 * Request routing decision for the client fetch router (fork-owned, pure).
 * Kept free of browser globals so it is unit-testable in Node.
 */
import { classifyApiPath, type RouteClass } from "./route-classes.ts";
import { LOCAL_BACKEND_QUERY } from "./scoped-api.ts";

export interface RouterStateView {
  /** Host owning a path: string = remote host, null = local, undefined = unknown. */
  ownerOfPath(path: string): string | null | undefined;
  hostOfSession(id: string): string | null | undefined;
  hostOfTerminal(id: string): string | null | undefined;
  /** Backend of the selected workspace (null = local). */
  currentHost: string | null;
}

export interface RouteDecision {
  /** Rewritten URL (same as input when unchanged). */
  url: string;
  changed: boolean;
  /** Backend the request goes to: null = local. */
  host: string | null;
  kind: RouteClass["kind"] | "passthrough";
  /** The JSON body's `cwd` must be removed (settings scope differs from it). */
  stripBodyCwd: boolean;
}

function passthrough(url: string): RouteDecision {
  return { url, changed: false, host: null, kind: "passthrough", stripBodyCwd: false };
}

/** `cwd` from a JSON request body, if any. */
export function bodyCwd(body: unknown): string | undefined {
  if (typeof body !== "string" || !body.trimStart().startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(body) as { cwd?: unknown };
    return typeof parsed.cwd === "string" && parsed.cwd ? parsed.cwd : undefined;
  } catch {
    return undefined;
  }
}

export function resolveApiRequest(
  rawUrl: string,
  body: unknown,
  state: RouterStateView,
  origin: string,
): RouteDecision {
  let url: URL;
  try {
    url = new URL(rawUrl, origin);
  } catch {
    return passthrough(rawUrl);
  }
  if (url.origin !== origin || !url.pathname.startsWith("/api/")) return passthrough(rawUrl);
  if (url.pathname.startsWith("/api/r/")) {
    const host = url.pathname.split("/")[3];
    return { ...passthrough(rawUrl), host: host ? decodeURIComponent(host) : null };
  }
  if (url.searchParams.get(LOCAL_BACKEND_QUERY) === "local") {
    url.searchParams.delete(LOCAL_BACKEND_QUERY);
    return { url: `${url.pathname}${url.search}`, changed: true, host: null, kind: "local", stripBodyCwd: false };
  }

  const cls = classifyApiPath(url.pathname);
  let host: string | null;

  switch (cls.kind) {
    case "local":
      return { ...passthrough(rawUrl), kind: "local" };
    case "aggregate": {
      const target = `${cls.target}${url.search}`;
      return { url: target, changed: true, host: null, kind: "aggregate", stripBodyCwd: false };
    }
    case "session": {
      const known = state.hostOfSession(cls.id);
      host = known !== undefined ? known : state.currentHost;
      break;
    }
    case "terminal": {
      const known = state.hostOfTerminal(cls.id);
      host = known !== undefined ? known : state.currentHost;
      break;
    }
    case "path": {
      // A transcript may refer to /tmp/output on either machine; its source
      // session is authoritative, not another project's overlapping root.
      const sourceSession = url.searchParams.get("sessionId");
      const sourceHost = sourceSession ? state.hostOfSession(sourceSession) : undefined;
      const owner = sourceHost !== undefined ? sourceHost : state.ownerOfPath(cls.path);
      host = owner !== undefined ? owner : state.currentHost;
      break;
    }
    case "cwd": {
      const cwd = url.searchParams.get("cwd") ?? bodyCwd(body);
      const owner = cwd ? state.ownerOfPath(cwd) : undefined;
      // An unqualified folder picker is local. Remote pickers have an
      // explicit /api/r/<host>/ prefix, even when both machines share a path.
      if (cls.fallback === "local") host = null;
      else host = owner !== undefined ? owner : state.currentHost;
      break;
    }
    case "config": {
      // Settings use a BackendScopeProvider and explicit URLs. Changing a
      // settings dropdown must never redirect background composer requests.
      const cwd = url.searchParams.get("cwd") ?? bodyCwd(body);
      const owner = cwd ? state.ownerOfPath(cwd) : undefined;
      host = owner !== undefined ? owner : state.currentHost;
      break;
    }
    case "browse":
      host = null;
      break;
  }

  const search = url.search;
  if (host === null) return { ...passthrough(rawUrl), kind: cls.kind };
  const target = `/api/r/${encodeURIComponent(host)}${url.pathname.slice("/api".length)}${search}`;
  return { url: target, changed: true, host, kind: cls.kind, stripBodyCwd: false };
}
