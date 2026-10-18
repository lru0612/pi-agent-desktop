/**
 * Which backend an /api request belongs to (fork-owned, pure, client+test).
 *
 * The fetch router (./router.ts) uses this table to send each request of the
 * unmodified upstream UI either to the local server or, through
 * /api/r/<host>/…, to a remote host. Every route under app/api must be listed
 * here: route-classes.test.mjs fails when a new upstream route is unclassified.
 *
 * See docs/remote-hosts-design.zh-CN.md §6.1 and Appendix A.
 */

export type RouteClass =
  /** Always the local server (desktop, auth, updates, host management…). */
  | { kind: "local" }
  /** Replaced by a merged local+remote endpoint. */
  | { kind: "aggregate"; target: string }
  /** Keyed by a session id in the path (agent, sessions, subagents). */
  | { kind: "session"; id: string }
  /** Keyed by a terminal id in the path. */
  | { kind: "terminal"; id: string }
  /** Keyed by an absolute filesystem path in the URL (/api/files/<path>). */
  | { kind: "path"; path: string }
  /** Keyed by a project directory in ?cwd= or the JSON body's cwd. */
  | { kind: "cwd"; fallback: "workspace" | "local" }
  /** Global pi configuration: follows the settings scope / current workspace. */
  | { kind: "config" }
  /** Directory browsing while adding a project: follows the picker's host. */
  | { kind: "browse" };

/** First path segments that always stay on the local server. */
const LOCAL_ONLY = new Set([
  "desktop",
  "open-in-explorer",
  "custom-css",
  "updates",
  "web-auth",
  "push",
  "home",
  "remote-hosts",
  "remote-info",
  // Scheduled tasks are local-only for now (remote tasks keep running on
  // their host but are not listed here).
  "scheduled-tasks",
]);

/** First segments whose routes read or write a pi installation's global config. */
const CONFIG = new Set([
  "models",
  "models-config",
  "auth",
  "provider-usage",
  "mcp",
  "skills",
  "plugins",
  "tools",
  "artifacts",
]);

/** First segments whose routes are keyed by a project directory. */
const CWD_KEYED = new Set(["file-index", "git", "worktrees", "project-trust"]);

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Absolute path encoded by lib/file-paths.ts encodeFilePathForApi. */
export function decodeFilesApiPath(segments: string[]): string {
  const decoded = segments.map(decodeSegment);
  const first = decoded[0] ?? "";
  // "C:/…" (Windows drive) and "//host/…" (UNC) keep their own root.
  if (/^[a-zA-Z]:$/.test(first) || first.startsWith("//")) return decoded.join("/");
  return `/${decoded.join("/")}`;
}

/**
 * Classify `/api/...` pathnames.
 */
export function classifyApiPath(pathname: string): RouteClass {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "api") return { kind: "local" };
  const [head = "", second, third] = segments.slice(1);

  if (head === "r" || LOCAL_ONLY.has(head)) return { kind: "local" };

  switch (head) {
    case "sessions":
      if (!second) return { kind: "aggregate", target: "/api/remote-hosts/aggregate/sessions" };
      if (second === "search") return { kind: "local" };
      return { kind: "session", id: decodeSegment(second) };
    case "agent":
      if (second === "new") return { kind: "cwd", fallback: "workspace" };
      if (second === "running") {
        return third === "events"
          ? { kind: "aggregate", target: "/api/remote-hosts/aggregate/running-events" }
          : { kind: "aggregate", target: "/api/remote-hosts/aggregate/running" };
      }
      return second ? { kind: "session", id: decodeSegment(second) } : { kind: "local" };
    case "subagents":
      if (second === "profiles" || second === "settings") return { kind: "config" };
      return second ? { kind: "session", id: decodeSegment(second) } : { kind: "local" };
    case "terminal":
      return second ? { kind: "terminal", id: decodeSegment(second) } : { kind: "cwd", fallback: "workspace" };
    case "files":
      return { kind: "path", path: decodeFilesApiPath(segments.slice(2)) };
    case "cwd":
      if (second === "browse") return { kind: "browse" };
      if (second === "validate") return { kind: "cwd", fallback: "local" };
      return { kind: "cwd", fallback: "workspace" }; // status
    case "default-cwd":
      return { kind: "browse" };
    default:
      break;
  }
  if (CWD_KEYED.has(head)) return { kind: "cwd", fallback: "workspace" };
  if (CONFIG.has(head)) return { kind: "config" };
  // Unknown (new upstream) routes follow the current workspace; the test
  // keeps this list exhaustive so this is only a safety net.
  return { kind: "cwd", fallback: "workspace" };
}

/** Route families known to this table (for the exhaustiveness test). */
export const CLASSIFIED_HEADS = new Set([
  ...LOCAL_ONLY,
  ...CONFIG,
  ...CWD_KEYED,
  "r",
  "sessions",
  "agent",
  "subagents",
  "terminal",
  "files",
  "cwd",
  "default-cwd",
]);
