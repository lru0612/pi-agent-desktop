/**
 * Pure merge of local and remote session lists (fork-owned).
 */
import type { HostedSessionInfo, RemoteSessionsPayload } from "./types";

export function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

export function mergeSessionPayloads(
  local: RemoteSessionsPayload,
  remotes: Array<{ host: string; payload: RemoteSessionsPayload | null; live: boolean }>,
  aggregateVersion: number,
): RemoteSessionsPayload {
  const sessions: HostedSessionInfo[] = [...local.sessions];
  const running = [...(local.runningSessionIds ?? [])];
  const suppressed = [...(local.completionNotificationSuppressedSessionIds ?? [])];
  const seen = new Set(sessions.map((session) => session.id));
  for (const { host, payload, live } of remotes) {
    if (!payload) continue;
    for (const session of payload.sessions) {
      // A session id seen locally wins: never let a remote row shadow it.
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      sessions.push({ ...session, host });
    }
    if (live) {
      running.push(...(payload.runningSessionIds ?? []));
      suppressed.push(...(payload.completionNotificationSuppressedSessionIds ?? []));
    }
  }
  return {
    sessions,
    sessionListVersion: aggregateVersion,
    runningSessionIds: unique(running),
    completionNotificationSuppressedSessionIds: unique(suppressed),
  };
}

/** One hit of GET /api/sessions/search (lib/session-search.ts). */
export interface SearchHit {
  session: HostedSessionInfo;
  entryId?: string;
  blockIndex?: number;
  before?: string;
  match?: string;
  after?: string;
}

export interface SearchPayload {
  results: SearchHit[];
  truncated?: boolean;
}

/**
 * Merge full-text search results of the local server and remote hosts: remote
 * hits are tagged with their host, everything is ordered newest first and
 * capped. Hosts that failed or timed out mark the result as truncated.
 */
export function mergeSearchPayloads(
  local: SearchPayload,
  remotes: Array<{ host: string; payload: SearchPayload | null }>,
  limit = 60,
): SearchPayload {
  const hits: SearchHit[] = [...local.results];
  const seen = new Set(hits.map((hit) => hit.session.id));
  let truncated = Boolean(local.truncated);
  for (const { host, payload } of remotes) {
    if (!payload) {
      truncated = true;
      continue;
    }
    truncated ||= Boolean(payload.truncated);
    for (const hit of payload.results) {
      if (seen.has(hit.session.id)) continue;
      seen.add(hit.session.id);
      hits.push({ ...hit, session: { ...hit.session, host } });
    }
  }
  hits.sort((a, b) => (b.session.modified ?? "").localeCompare(a.session.modified ?? ""));
  if (hits.length > limit) truncated = true;
  return { results: hits.slice(0, limit), truncated };
}
