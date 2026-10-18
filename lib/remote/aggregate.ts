/**
 * Merged views over the local server and every remote host (fork-owned,
 * server-only). The client router sends the sidebar's session-list and
 * running-status requests here, so the upstream sidebar code keeps working on
 * a single list. See docs/remote-hosts-design.zh-CN.md §5.4.
 */
import { GET as localSessionsGET } from "@/app/api/sessions/route";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
  subscribeRunningSessions,
} from "@/lib/rpc-manager";
import { getSessionListVersion } from "@/lib/session-reader";

import { getRemoteHostManager } from "./host-manager";
import { sseFrame } from "./sse";
import type { HostedSessionInfo, RemoteSessionsPayload } from "./types";

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

/** Pure merge step (exported for tests). */
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

export async function aggregateSessions(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = url.search;
  const manager = getRemoteHostManager();
  manager.ensureStarted();

  const localRequest = new Request(new URL(`/api/sessions${query}`, url), {
    headers: { accept: "application/json", "accept-encoding": "identity" },
  });
  const [localResponse, remotes] = await Promise.all([
    localSessionsGET(localRequest),
    Promise.all(manager.ids().map(async (host) => ({ host, ...(await manager.sessions(host, query)) }))),
  ]);
  if (!localResponse.ok) return localResponse;
  const local = await localResponse.json() as RemoteSessionsPayload;
  const merged = mergeSessionPayloads(local, remotes, manager.aggregateVersion(local.sessionListVersion));
  // Remote running ids also arrive through the live streams; include them so a
  // freshly loaded list agrees with the next SSE frame.
  const live = manager.remoteRunningIds();
  merged.runningSessionIds = unique([...(merged.runningSessionIds ?? []), ...live.ids]);
  return Response.json(merged, { headers: { "Cache-Control": "no-store" } });
}

function runningSnapshot() {
  const manager = getRemoteHostManager();
  const remote = manager.remoteRunningIds();
  return {
    type: "running" as const,
    runningSessionIds: unique([...getRunningRpcSessionIds(), ...remote.ids]),
    completionNotificationSuppressedSessionIds: unique([
      ...getCompletionNotificationSuppressedRpcSessionIds(),
      ...remote.suppressed,
    ]),
    sessionListVersion: manager.aggregateVersion(getSessionListVersion()),
    remoteHosts: manager.list(),
  };
}

export function aggregateRunning(): Response {
  getRemoteHostManager().ensureStarted();
  const snapshot: Partial<ReturnType<typeof runningSnapshot>> = runningSnapshot();
  delete snapshot.type;
  return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}

/** Merged replacement for /api/agent/running/events (same frame shape + remoteHosts). */
export function aggregateRunningEvents(request: Request): Response {
  const manager = getRemoteHostManager();
  manager.ensureStarted();
  let dispose = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let lastFrame = "";
      let pending: ReturnType<typeof setTimeout> | null = null;
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const emit = () => {
        // Coalesce bursts (several hosts changing at once) into one frame.
        if (pending || closed) return;
        pending = setTimeout(() => {
          pending = null;
          const frame = sseFrame(runningSnapshot());
          if (frame === lastFrame) return;
          lastFrame = frame;
          send(frame);
        }, 50);
      };
      const unsubscribeLocal = subscribeRunningSessions(() => emit());
      manager.on("change", emit);
      const heartbeat = setInterval(() => send(":\n\n"), 30_000);
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (pending) clearTimeout(pending);
        clearInterval(heartbeat);
        unsubscribeLocal();
        manager.off("change", emit);
        request.signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      dispose = cleanup;
      request.signal.addEventListener("abort", cleanup);
      lastFrame = sseFrame(runningSnapshot());
      send(lastFrame);
    },
    cancel() {
      dispose();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
