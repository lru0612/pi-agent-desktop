import type { SessionInfo } from "./types";
import { hostedProjectKey, type HostedProject } from "./remote/project-identity.ts";

/**
 * A project group is the unit rendered as one row in the sidebar's Projects
 * panel: one project (= one repo + all its worktrees, or one non-git dir) plus
 * the sessions that belong to it, plus the derived signal rows need.
 */
export interface ProjectGroup {
  /** Physical project root; never host-qualified. */
  projectRoot: string;
  /** Client key for row identity and persisted folding/archive state. */
  clientKey: string;
  /** Display name: basename of projectRoot, or the full path for orphans. */
  displayName: string;
  /** Sessions that resolve to this project, in input order. */
  sessions: SessionInfo[];
  /** Most recent `modified` timestamp across the group's sessions, ISO. */
  latestModified: string;
  /** Unread session ids within this group. */
  unreadIds: Set<string>;
  /** Session ids currently running within this group. */
  runningIds: Set<string>;
  /** Branches observed in this group (cwd's `worktreeBranch`), deduped, sorted. */
  branches: string[];
  /** Fork: remote host owning the project (absent for local projects). */
  host?: string;
}

function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const trimmed = normalized.replace(/\/+$/, "");
  if (!trimmed) return path;
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Group sessions by project root. Sessions without `projectRoot` (older records
 * built before the server started filling it) fall back to their cwd and are
 * still grouped, so a single missing field never fragments the list.
 *
 * Groups are sorted by `latestModified` desc so the most recent activity floats
 * to the top, matching the existing `getRecentProjects()` ordering.
 *
 * `runningIds` and `unreadIds` are passed in as Sets so the caller can keep
 * the canonical state (live SSE for running, localStorage for unread) and we
 * just project them per-group. Identity is preserved by reference for O(1)
 * `has()` checks downstream.
 */
export function groupByProject(
  sessions: SessionInfo[],
  options: { runningIds?: Set<string>; unreadIds?: Set<string>; projects?: readonly HostedProject[] } = {},
): ProjectGroup[] {
  const { runningIds, unreadIds } = options;
  const groups = new Map<string, ProjectGroup>();

  for (const session of sessions) {
    const root = session.projectRoot || session.cwd;
    // Fork: the same path on two machines is two projects.
    const host = (session as SessionInfo & { host?: string }).host;
    const key = hostedProjectKey(root, host);
    let group = groups.get(key);
    if (!group) {
      group = {
        projectRoot: root,
        clientKey: key,
        displayName: basenameOf(root),
        sessions: [],
        latestModified: session.modified,
        unreadIds: new Set<string>(),
        runningIds: new Set<string>(),
        branches: [],
        ...(host ? { host } : {}),
      };
      groups.set(key, group);
    }
    group.sessions.push(session);
    if (session.modified > group.latestModified) {
      group.latestModified = session.modified;
    }
    if (runningIds?.has(session.id)) group.runningIds.add(session.id);
    if (unreadIds?.has(session.id)) group.unreadIds.add(session.id);
  }

  // Explicit picks only, never access-grant roots or fabricated sessions.
  // A picked linked worktree belongs under its main project root.
  for (const project of options.projects ?? []) {
    const key = hostedProjectKey(project.projectRoot, project.host);
    if (groups.has(key)) continue;
    groups.set(key, {
      projectRoot: project.projectRoot,
      clientKey: key,
      displayName: basenameOf(project.projectRoot),
      sessions: [],
      latestModified: "",
      unreadIds: new Set(),
      runningIds: new Set(),
      branches: [],
      ...(project.host ? { host: project.host } : {}),
    });
  }

  for (const group of groups.values()) {
    const branchSet = new Set<string>();
    for (const s of group.sessions) {
      if (s.worktreeBranch) branchSet.add(s.worktreeBranch);
    }
    group.branches = [...branchSet].sort();
  }

  return [...groups.values()].sort((a, b) => b.latestModified.localeCompare(a.latestModified));
}

/**
 * Convenience: which project group owns `sessionId`? Returns null if the
 * id is not in the groups (e.g. live run that has not been flushed yet).
 */
export function findProjectForSession(
  groups: ProjectGroup[],
  sessionId: string,
): ProjectGroup | null {
  for (const group of groups) {
    if (group.sessions.some((s) => s.id === sessionId)) return group;
  }
  return null;
}
