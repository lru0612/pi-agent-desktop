/**
 * Merged views over the local server and every remote host (fork-owned,
 * server-only). The client router sends the sidebar's session-list and
 * running-status requests here, so the upstream sidebar code keeps working on
 * a single list. See docs/remote-hosts-design.zh-CN.md §5.4.
 */
import { GET as localSessionsGET } from "@/app/api/sessions/route";
import { GET as localSearchGET } from "@/app/api/sessions/search/route";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
  subscribeRunningSessions,
} from "@/lib/rpc-manager";
import { getSessionListVersion } from "@/lib/session-reader";

import { getRemoteHostManager } from "./host-manager";
import { sseFrame } from "./sse";
import { mergeSearchPayloads, mergeSessionPayloads, unique, type SearchPayload } from "./merge";
import type { RemoteSessionsPayload } from "./types";

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

/**
 * Merged GET /api/sessions/search: the local transcripts plus every online
 * host's. A slow host is cut off after a few seconds (reported as truncated)
 * so one bad tunnel cannot stall the search box.
 */
export async function aggregateSearch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const manager = getRemoteHostManager();
  manager.ensureStarted();
  const localRequest = new Request(new URL(`/api/sessions/search?${new URLSearchParams({ q: query })}`, url), {
    signal: request.signal,
  });
  const online = manager.list().filter((host) => host.status === "online").map((host) => host.id);
  const [localResponse, remotes] = await Promise.all([
    localSearchGET(localRequest),
    Promise.all(online.map(async (host) => {
      try {
        const payload = await manager.requestJson<SearchPayload>(
          host,
          `/api/sessions/search?${new URLSearchParams({ q: query })}`,
          8_000,
        );
        return { host, payload };
      } catch {
        return { host, payload: null };
      }
    })),
  ]);
  if (!localResponse.ok) return localResponse;
  const local = await localResponse.json() as SearchPayload;
  return Response.json(mergeSearchPayloads(local, remotes), { headers: { "Cache-Control": "no-store" } });
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
