import type { TabOpen } from "./tab-session";

export interface InitialNavigation {
  requestedCwd: string | null;
  sessionId: string | null;
  sidebarCollapsed: boolean;
  /** Explicit backend for a bookmark or restored workspace. */
  host?: string | null;
}

export function getInitialNavigation(
  searchParams: Pick<URLSearchParams, "get">,
): InitialNavigation {
  const requestedCwd = searchParams.get("cwd")?.trim() || null;
  const hint = searchParams.get("host");
  const host = hint === "local" ? null : hint && /^[a-z0-9][a-z0-9-]{0,31}$/.test(hint) ? hint : undefined;

  return {
    requestedCwd,
    ...(host !== undefined ? { host } : {}),
    sessionId: requestedCwd ? null : (searchParams.get("session") || null),
    sidebarCollapsed: searchParams.get("sidebar") === "collapsed",
  };
}

/**
 * Apply per-tab memory to a navigation snapshot that was taken from the URL
 * alone. Returns the same object when the URL already chose a cwd or session,
 * or when this tab has nothing stored.
 *
 * A remembered session fills `sessionId`. A remembered new-session composer
 * fills `requestedCwd` so reload shows that UI instead of the previous chat.
 *
 * Call this after mount. Reading sessionStorage during the first client render
 * (including a `useState` initializer) makes SSR HTML diverge from the client
 * tree — sessionStorage is empty on the server — and React reports a
 * hydration text mismatch in the sidebar / placeholder.
 */
export function withTabOpen(
  navigation: InitialNavigation,
  tabOpen: TabOpen | null,
): InitialNavigation {
  if (navigation.requestedCwd || navigation.sessionId || !tabOpen) {
    return navigation;
  }
  const backend = tabOpen.host ? { host: tabOpen.host } : {};
  if (tabOpen.kind === "session") {
    return { ...navigation, ...backend, sessionId: tabOpen.sessionId };
  }
  return { ...navigation, ...backend, requestedCwd: tabOpen.cwd };
}
