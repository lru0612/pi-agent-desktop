/**
 * Client-side remote state (fork-owned): known hosts and their status, which
 * backend owns each session / terminal / project path, and the current
 * workspace, settings scope and picker host. Feeds lib/remote/router.ts.
 *
 * Plain module singleton with a subscribe/getSnapshot pair for
 * useSyncExternalStore. Browser-only state is persisted in localStorage so a
 * cold start can route `?session=<remote id>` before the session list loads.
 */
import type { HostedSessionInfo, RemoteHostSnapshot } from "./types";
import type { RouterStateView } from "./router";
import { APP_PREF_KEYS, getPrefJson, setPrefJson } from "../app-prefs.ts";
import { resolveInitialNavigation, type PersistedWorkspace } from "../workspace-state.ts";
import { withTabOpen } from "../initial-navigation.ts";
import { getTabOpen } from "../tab-session.ts";

const MAX_SESSION_HOSTS = 3000;
const MAX_TERMINAL_HOSTS = 200;
const validHost = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value) && value !== "local";

/** Explicitly opened remote project, separate from its allowed file roots. */
export interface RemoteProjectLocation {
  host: string;
  cwd: string;
  projectRoot: string;
  projectKey?: string;
}

export interface RemoteClientSnapshot {
  hosts: RemoteHostSnapshot[];
  projects: RemoteProjectLocation[];
  hostsLoaded: boolean;
  currentHost: string | null;
  /** Bumped when routing knowledge (roots/sessions) changes. */
  routingVersion: number;
}

type Listener = () => void;

function trimPath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** Roots so broad they would claim every path of the other machine. */
function isTooBroadRoot(root: string): boolean {
  return root === "/" || root === "" || /^[a-zA-Z]:\/?$/.test(root);
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

export class RemoteClientStore implements RouterStateView {
  private listeners = new Set<Listener>();
  private snapshot: RemoteClientSnapshot = {
    hosts: [],
    projects: [],
    hostsLoaded: false,
    currentHost: null,
    routingVersion: 0,
  };
  private sessionHosts = new Map<string, string>();
  private localSessionIds = new Set<string>();
  private terminalHosts = new Map<string, string | null>();
  private remoteRoots = new Map<string, Set<string>>();
  /** Roots chosen in the remote folder picker; re-granted after every (re)connect. */
  private pickedRoots = new Map<string, Set<string>>();
  private localRoots = new Set<string>();
  private loaded = false;
  private workspace: { sessionId: string | null; cwd: string | null; host?: string | null } = { sessionId: null, cwd: null };
  /** Host the user last picked for a project root that exists on several backends. */
  private pinnedHosts = new Map<string, string | null>();

  // ------------------------------------------------------------ store plumbing

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): RemoteClientSnapshot => this.snapshot;

  private update(patch: Partial<RemoteClientSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  get currentHost(): string | null {
    return this.snapshot.currentHost;
  }

  load(): void {
    if (this.loaded || typeof window === "undefined") return;
    this.loaded = true;
    const sessions = getPrefJson<unknown>(APP_PREF_KEYS.remoteSessionHosts);
    if (Array.isArray(sessions)) for (const pair of sessions.slice(-MAX_SESSION_HOSTS)) {
      if (Array.isArray(pair) && typeof pair[0] === "string" && validHost(pair[1])) this.sessionHosts.set(pair[0], pair[1]);
    }
    for (const [key, target] of [
      [APP_PREF_KEYS.remoteRoots, this.remoteRoots],
      [APP_PREF_KEYS.remotePickedRoots, this.pickedRoots],
    ] as const) {
      const roots = getPrefJson<unknown>(key);
      if (roots && typeof roots === "object" && !Array.isArray(roots)) {
        for (const [host, paths] of Object.entries(roots)) {
          if (validHost(host) && Array.isArray(paths)) target.set(host, new Set(paths.filter((path): path is string => typeof path === "string")));
        }
      }
    }
    const terminals = getPrefJson<unknown>(APP_PREF_KEYS.remoteTerminalHosts);
    if (Array.isArray(terminals)) for (const pair of terminals.slice(-MAX_TERMINAL_HOSTS)) {
      if (Array.isArray(pair) && typeof pair[0] === "string" && (pair[1] === null || validHost(pair[1]))) this.terminalHosts.set(pair[0], pair[1]);
    }
    const projects = getPrefJson<unknown>(APP_PREF_KEYS.remoteProjects);
    if (Array.isArray(projects)) this.snapshot = { ...this.snapshot, projects: projects.filter((p) =>
      p && validHost(p.host) && typeof p.cwd === "string" && typeof p.projectRoot === "string") };

    // Match AppShell's URL > desktop workspace > per-tab restore ordering,
    // before any child can issue its first API request.
    const desktop = "__TAURI_INTERNALS__" in window;
    const navigation = withTabOpen(resolveInitialNavigation(
      new URL(window.location.href).searchParams,
      desktop ? getPrefJson<PersistedWorkspace>(APP_PREF_KEYS.workspace) : null,
    ), getTabOpen());
    if (navigation.host !== undefined) this.selectWorkspace(navigation.sessionId, navigation.requestedCwd, navigation.host);
    else this.setWorkspace(navigation.sessionId, navigation.requestedCwd);
  }

  private persist(): void {
    setPrefJson(APP_PREF_KEYS.remoteSessionHosts, [...this.sessionHosts.entries()].slice(-MAX_SESSION_HOSTS));
    setPrefJson(APP_PREF_KEYS.remoteRoots, Object.fromEntries([...this.remoteRoots].map(([host, roots]) => [host, [...roots]])));
    setPrefJson(APP_PREF_KEYS.remotePickedRoots, Object.fromEntries([...this.pickedRoots].map(([host, roots]) => [host, [...roots]])));
    setPrefJson(APP_PREF_KEYS.remoteTerminalHosts, [...this.terminalHosts.entries()].slice(-MAX_TERMINAL_HOSTS));
    setPrefJson(APP_PREF_KEYS.remoteProjects, this.snapshot.projects);
  }

  // ------------------------------------------------------------ hosts

  setHosts(hosts: RemoteHostSnapshot[]): void {
    const previous = this.snapshot.hosts;
    const same = previous.length === hosts.length && previous.every((host, index) => {
      const next = hosts[index]!;
      return host.id === next.id && host.status === next.status && host.phase === next.phase
        && host.label === next.label && host.error?.code === next.error?.code && host.error?.detail === next.error?.detail
        && host.home === next.home && host.connectedAt === next.connectedAt && host.version === next.version
        && host.busySessionIds?.length === next.busySessionIds?.length;
    });
    if (same && this.snapshot.hostsLoaded) return;
    // Keep ownership tombstones for open tabs after a host is removed: a
    // missing host must produce 404, never fall back to a same-named local file.
    this.update({ hosts, hostsLoaded: true });
    this.recomputeCurrentHost();
  }

  host(id: string | null | undefined): RemoteHostSnapshot | undefined {
    return id ? this.snapshot.hosts.find((host) => host.id === id) : undefined;
  }

  // ------------------------------------------------------------ routing knowledge

  hostOfSession(id: string): string | null | undefined {
    const host = this.sessionHosts.get(id);
    if (host) return host;
    if (this.localSessionIds.has(id)) return null;
    return undefined;
  }

  hostOfTerminal(id: string): string | null | undefined {
    return this.terminalHosts.get(id);
  }

  ownerOfPath(rawPath: string): string | null | undefined {
    const path = trimPath(rawPath);
    if (this.workspace.host !== undefined && this.workspace.cwd && isWithin(path, trimPath(this.workspace.cwd))) {
      // Explicit workspace selection beats a longer root learned on another
      // machine. Paths alone never identify a backend.
      return this.workspace.host;
    }
    let bestLength = -1;
    let owners: Array<string | null> = [];
    const consider = (root: string, owner: string | null) => {
      if (isTooBroadRoot(root) || !isWithin(path, root)) return;
      if (root.length > bestLength) {
        bestLength = root.length;
        owners = [owner];
      } else if (root.length === bestLength && !owners.includes(owner)) {
        owners.push(owner);
      }
    };
    for (const root of this.localRoots) consider(root, null);
    for (const [host, roots] of this.remoteRoots) for (const root of roots) consider(root, host);
    if (owners.length === 0) return undefined;
    if (owners.length === 1) return owners[0];
    // The same path exists on several backends: an explicit pick wins, then
    // the current workspace's backend.
    for (const [root, pinned] of this.pinnedHosts) {
      if (root.length === bestLength && isWithin(path, root) && owners.includes(pinned)) return pinned;
    }
    return owners.includes(this.snapshot.currentHost) ? this.snapshot.currentHost : owners[0];
  }

  /** Remember which backend a project row belongs to when the user selects it. */
  pinProjectHost(root: string, host: string | null): void {
    const key = trimPath(root);
    if (this.pinnedHosts.get(key) === host && this.pinnedHosts.has(key)) return;
    this.pinnedHosts.set(key, host);
    this.recomputeCurrentHost();
  }

  /** Learn session/project ownership from the merged session list. */
  recordSessions(sessions: HostedSessionInfo[]): void {
    let changed = false;
    const nextLocalRoots = new Set<string>();
    for (const session of sessions) {
      const roots = [session.projectRoot, session.cwd].filter((value): value is string => Boolean(value)).map(trimPath);
      if (session.host) {
        if (this.sessionHosts.get(session.id) !== session.host) {
          this.sessionHosts.delete(session.id);
          this.sessionHosts.set(session.id, session.host);
          changed = true;
        }
        let set = this.remoteRoots.get(session.host);
        if (!set) {
          set = new Set();
          this.remoteRoots.set(session.host, set);
        }
        for (const root of roots) {
          if (!set.has(root)) {
            set.add(root);
            changed = true;
          }
        }
      } else {
        if (this.sessionHosts.delete(session.id)) changed = true;
        this.localSessionIds.add(session.id);
        for (const root of roots) nextLocalRoots.add(root);
      }
    }
    if ([...nextLocalRoots].some((root) => !this.localRoots.has(root))) changed = true;
    for (const root of nextLocalRoots) this.localRoots.add(root);
    if (changed) {
      this.persist();
      this.update({ routingVersion: this.snapshot.routingVersion + 1 });
      this.recomputeCurrentHost();
    }
  }

  recordSession(id: string, host: string | null): void {
    if (host) {
      this.sessionHosts.set(id, host);
      this.persist();
    } else {
      this.sessionHosts.delete(id);
      this.localSessionIds.add(id);
    }
    this.recomputeCurrentHost();
  }

  recordTerminal(id: string, host: string | null): void {
    // Persisted so restored terminal tabs reach their host after a reload.
    this.terminalHosts.set(id, host);
    this.persist();
  }

  /** Register a project root picked on a remote host (before it has sessions). */
  addRemoteRoot(host: string, root: string): void {
    let set = this.remoteRoots.get(host);
    if (!set) {
      set = new Set();
      this.remoteRoots.set(host, set);
    }
    set.add(trimPath(root));
    let picked = this.pickedRoots.get(host);
    if (!picked) {
      picked = new Set();
      this.pickedRoots.set(host, picked);
    }
    picked.add(trimPath(root));
    this.persist();
    this.update({ routingVersion: this.snapshot.routingVersion + 1 });
    this.recomputeCurrentHost();
  }

  /** A picked worktree is still one project row under its repository root. */
  rememberProject(project: RemoteProjectLocation): void {
    const projects = this.snapshot.projects.filter((item) => item.host !== project.host || item.projectRoot !== project.projectRoot);
    projects.push(project);
    this.update({ projects, routingVersion: this.snapshot.routingVersion + 1 });
    this.persist();
  }

  /** Folders picked on `host`: the remote only remembers its grants in memory. */
  pickedRootsOf(host: string): string[] {
    return [...(this.pickedRoots.get(host) ?? [])];
  }

  /** Remote host of a project root, or null for local. */
  hostOfProject(root: string, sessions?: HostedSessionInfo[]): string | null {
    const fromSession = sessions?.find((session) => session.host)?.host;
    if (fromSession) return fromSession;
    if (sessions && sessions.length > 0) return null;
    return this.ownerOfPath(root) ?? null;
  }

  // ------------------------------------------------------------ workspace / scope

  /** Called synchronously by selection handlers, before descendant effects run. */
  selectWorkspace(sessionId: string | null, cwd: string | null, host: string | null): void {
    if (sessionId) this.recordSession(sessionId, host);
    if (cwd) this.pinnedHosts.set(trimPath(cwd), host);
    this.workspace = { sessionId, cwd, host };
    if (this.snapshot.currentHost !== host) this.update({ currentHost: host });
  }

  setWorkspace(sessionId: string | null, cwd: string | null): void {
    if (this.workspace.sessionId !== sessionId || this.workspace.cwd !== cwd) {
      this.workspace = { sessionId, cwd };
    }
    this.recomputeCurrentHost();
  }

  private recomputeCurrentHost(): void {
    const { sessionId, cwd } = this.workspace;
    let host: string | null | undefined = this.workspace.host;
    if (host === undefined && sessionId) host = this.hostOfSession(sessionId);
    if (host === undefined && cwd) host = this.ownerOfPath(cwd);
    const next = host ?? null;
    if (next !== this.snapshot.currentHost) this.update({ currentHost: next });
  }
}

export const remoteClientStore = new RemoteClientStore();

/** Finder / "open with" style actions only make sense for local paths. */
export function canUseNativeFileActions(path: string | null | undefined): boolean {
  if (!path) return true;
  const owner = remoteClientStore.ownerOfPath(path);
  if (owner !== undefined) return owner === null;
  return remoteClientStore.getSnapshot().currentHost === null;
}
