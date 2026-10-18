/**
 * Request routing decision for the client fetch router (fork-owned, pure).
 * Kept free of browser globals so it is unit-testable in Node.
 */
import { classifyApiPath, type RouteClass } from "./route-classes.ts";

export interface RouterStateView {
  /** Host owning a path: string = remote host, null = local, undefined = unknown. */
  ownerOfPath(path: string): string | null | undefined;
  hostOfSession(id: string): string | null | undefined;
  hostOfTerminal(id: string): string | null | undefined;
  /** Backend of the selected workspace (null = local). */
  currentHost: string | null;
  /** Settings scope: undefined = follow the workspace, null = local, string = host. */
  configHost: string | null | undefined;
  /** Host whose directories the "add project" picker is browsing (null = local). */
  browseHost: string | null;
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
  if (typeof body !== "string" || !body.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(body) as { cwd?: unknown };
    return typeof parsed.cwd === "string" && parsed.cwd ? parsed.cwd : undefined;
  } catch {
    return undefined;
  }
}

/** Remove `cwd` from a JSON body string. */
export function stripCwdFromJsonBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    delete parsed.cwd;
    return JSON.stringify(parsed);
  } catch {
    return body;
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
  if (url.origin !== origin) return passthrough(rawUrl);
  if (!url.pathname.startsWith("/api/") || url.pathname.startsWith("/api/r/")) return passthrough(rawUrl);

  const cls = classifyApiPath(url.pathname);
  let host: string | null;
  let stripBodyCwd = false;
  let queryCwdStripped = false;

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
      const owner = state.ownerOfPath(cls.path);
      host = owner !== undefined ? owner : state.currentHost;
      break;
    }
    case "cwd": {
      const cwd = url.searchParams.get("cwd") ?? bodyCwd(body);
      const owner = cwd ? state.ownerOfPath(cwd) : undefined;
      if (owner !== undefined) host = owner;
      else host = cls.fallback === "workspace" ? state.currentHost : state.browseHost;
      break;
    }
    case "config": {
      const cwd = url.searchParams.get("cwd") ?? bodyCwd(body);
      if (state.configHost !== undefined) {
        host = state.configHost;
        if (cwd) {
          const owner = state.ownerOfPath(cwd);
          const cwdHost = owner !== undefined ? owner : state.currentHost;
          if (cwdHost !== host) {
            // The project path means nothing on the chosen host: ask for its
            // global configuration instead.
            queryCwdStripped = url.searchParams.has("cwd");
            url.searchParams.delete("cwd");
            stripBodyCwd = bodyCwd(body) !== undefined;
          }
        }
      } else if (cwd) {
        const owner = state.ownerOfPath(cwd);
        host = owner !== undefined ? owner : state.currentHost;
      } else {
        host = state.currentHost;
      }
      break;
    }
    case "browse":
      host = state.browseHost;
      break;
  }

  const search = url.search;
  if (host === null) {
    if (!queryCwdStripped && !stripBodyCwd) return { ...passthrough(rawUrl), kind: cls.kind };
    return { url: `${url.pathname}${search}`, changed: true, host: null, kind: cls.kind, stripBodyCwd };
  }
  const target = `/api/r/${encodeURIComponent(host)}${url.pathname.slice("/api".length)}${search}`;
  return { url: target, changed: true, host, kind: cls.kind, stripBodyCwd };
}
