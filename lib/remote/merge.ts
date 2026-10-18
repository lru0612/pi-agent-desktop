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
