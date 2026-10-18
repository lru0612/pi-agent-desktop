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

const SESSION_HOSTS_KEY = "pi-remote:session-hosts:v1";
const TERMINAL_HOSTS_KEY = "pi-remote:terminal-hosts:v1";
const REMOTE_ROOTS_KEY = "pi-remote:roots:v1";
const MAX_SESSION_HOSTS = 3000;
const MAX_TERMINAL_HOSTS = 200;

export interface RemoteClientSnapshot {
  hosts: RemoteHostSnapshot[];
  hostsLoaded: boolean;
  currentHost: string | null;
  configHost: string | null | undefined;
  browseHost: string | null;
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

class RemoteClientStore implements RouterStateView {
  private listeners = new Set<Listener>();
  private snapshot: RemoteClientSnapshot = {
    hosts: [],
    hostsLoaded: false,
    currentHost: null,
    configHost: undefined,
    browseHost: null,
    routingVersion: 0,
  };
  private sessionHosts = new Map<string, string>();
  private localSessionIds = new Set<string>();
  private terminalHosts = new Map<string, string>();
  private remoteRoots = new Map<string, Set<string>>();
  private localRoots = new Set<string>();
  private loaded = false;
  private workspace: { sessionId: string | null; cwd: string | null } = { sessionId: null, cwd: null };
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

  get configHost(): string | null | undefined {
    return this.snapshot.configHost;
  }

  get browseHost(): string | null {
    return this.snapshot.browseHost;
  }

  load(): void {
    if (this.loaded || typeof localStorage === "undefined") return;
    this.loaded = true;
    try {
      const sessions = JSON.parse(localStorage.getItem(SESSION_HOSTS_KEY) ?? "[]") as Array<[string, string]>;
      for (const [id, host] of sessions) this.sessionHosts.set(id, host);
    } catch {
      // ignore corrupt cache
    }
    try {
      const roots = JSON.parse(localStorage.getItem(REMOTE_ROOTS_KEY) ?? "{}") as Record<string, string[]>;
      for (const [host, list] of Object.entries(roots)) this.remoteRoots.set(host, new Set(list));
    } catch {
      // ignore corrupt cache
    }
    try {
      const terminals = JSON.parse(localStorage.getItem(TERMINAL_HOSTS_KEY) ?? "[]") as Array<[string, string]>;
      for (const [id, host] of terminals) this.terminalHosts.set(id, host);
    } catch {
      // ignore corrupt cache
    }
  }

  private persist(): void {
    if (typeof localStorage === "undefined") return;
    try {
      const entries = [...this.sessionHosts.entries()].slice(-MAX_SESSION_HOSTS);
      localStorage.setItem(SESSION_HOSTS_KEY, JSON.stringify(entries));
      const roots: Record<string, string[]> = {};
      for (const [host, set] of this.remoteRoots) roots[host] = [...set];
      localStorage.setItem(REMOTE_ROOTS_KEY, JSON.stringify(roots));
      localStorage.setItem(TERMINAL_HOSTS_KEY, JSON.stringify([...this.terminalHosts.entries()].slice(-MAX_TERMINAL_HOSTS)));
    } catch {
      // storage full / private mode
    }
  }

  // ------------------------------------------------------------ hosts

  setHosts(hosts: RemoteHostSnapshot[]): void {
    const previous = this.snapshot.hosts;
    const same = previous.length === hosts.length && previous.every((host, index) => {
      const next = hosts[index]!;
      return host.id === next.id && host.status === next.status && host.phase === next.phase
        && host.label === next.label && host.error?.code === next.error?.code && host.home === next.home
        && host.busySessionIds?.length === next.busySessionIds?.length;
    });
    if (same && this.snapshot.hostsLoaded) return;
    // Forget routing knowledge of hosts that were removed.
    const ids = new Set(hosts.map((host) => host.id));
    let routingChanged = false;
    for (const host of [...this.remoteRoots.keys()]) {
      if (!ids.has(host)) {
        this.remoteRoots.delete(host);
        routingChanged = true;
      }
    }
    if (routingChanged) this.persist();
    this.update({
      hosts,
      hostsLoaded: true,
      routingVersion: this.snapshot.routingVersion + (routingChanged ? 1 : 0),
    });
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
      this.localSessionIds.add(id);
    }
  }

  recordTerminal(id: string, host: string | null): void {
    // Persisted so restored terminal tabs reach their host after a reload.
    if (host) this.terminalHosts.set(id, host);
    else this.terminalHosts.delete(id);
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
    this.persist();
    this.update({ routingVersion: this.snapshot.routingVersion + 1 });
    this.recomputeCurrentHost();
  }

  /** Remote host of a project root, or null for local. */
  hostOfProject(root: string, sessions?: HostedSessionInfo[]): string | null {
    const fromSession = sessions?.find((session) => session.host)?.host;
    if (fromSession) return fromSession;
    if (sessions && sessions.length > 0) return null;
    return this.ownerOfPath(root) ?? null;
  }

  // ------------------------------------------------------------ workspace / scope

  setWorkspace(sessionId: string | null, cwd: string | null): void {
    this.workspace = { sessionId, cwd };
    this.recomputeCurrentHost();
  }

  private recomputeCurrentHost(): void {
    const { sessionId, cwd } = this.workspace;
    let host: string | null | undefined = sessionId ? this.hostOfSession(sessionId) : undefined;
    if (host === undefined && cwd) host = this.ownerOfPath(cwd);
    const next = host ?? null;
    if (next !== this.snapshot.currentHost) this.update({ currentHost: next });
  }

  setConfigHost(host: string | null | undefined): void {
    if (host !== this.snapshot.configHost) this.update({ configHost: host });
  }

  setBrowseHost(host: string | null): void {
    if (host !== this.snapshot.browseHost) this.update({ browseHost: host });
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
