/** Client-only identity. Never send this key to a filesystem or backend API. */
export function hostedProjectKey(key: string, host?: string | null): string {
  return host ? `r:${encodeURIComponent(host)}:${key}` : key;
}

export interface HostedProject {
  host?: string | null;
  cwd: string;
  projectRoot: string;
  projectKey?: string;
}

export interface HostedProjectSelection {
  root: string;
  /** Raw server identity (not host-qualified). */
  key: string;
  host: string | null;
}

interface ProjectSession {
  host?: string | null;
  cwd: string;
  projectRoot?: string;
  projectKey?: string;
}

interface ProjectWorktrees {
  host: string | null;
  forCwd: string;
  projectRoot: string;
  projectKey: string;
  worktrees: ReadonlyArray<{ path: string }>;
}

/** No owner inference: identical paths on different machines are unrelated. */
export function resolveHostedProject(
  cwd: string | null,
  host: string | null,
  sessions: readonly ProjectSession[],
  worktrees?: ProjectWorktrees | null,
  projects: readonly HostedProject[] = [],
): HostedProjectSelection | null {
  if (!cwd) return null;
  if (worktrees?.host === host && (worktrees.forCwd === cwd || worktrees.worktrees.some((w) => w.path === cwd))) {
    return { root: worktrees.projectRoot, key: worktrees.projectKey, host };
  }
  const match = sessions.find((s) => (s.host ?? null) === host
    && (s.cwd === cwd || (s.projectRoot ?? s.cwd) === cwd))
    ?? projects.find((p) => (p.host ?? null) === host && (p.cwd === cwd || p.projectRoot === cwd));
  return { root: match?.projectRoot ?? cwd, key: match?.projectKey ?? match?.projectRoot ?? cwd, host };
}
