"use client";

// Fork-owned: probes whether the session's workspace folder still exists, so the
// composer can say so instead of reporting a model error. AppShell (upstream-owned)
// only calls this.

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { UnavailableWorkspace, WorkspaceAvailability } from "@/lib/workspace-availability";
import { localFetch, refreshRemoteHosts } from "@/lib/remote/client";
import { remoteClientStore } from "@/lib/remote/client-store";

/** What the probe can say: the folder's state, or that its SSH host is not connected. */
type ProbedAvailability = WorkspaceAvailability | "host-offline" | "unknown";

export function useWorkspaceAvailability(
  cwd: string | null,
  setModelsRefreshKey: Dispatch<SetStateAction<number>>,
  // Fork (SSH hosts): the same path can exist on several machines, so a probe
  // result only applies to the backend it was asked on. null = this computer.
  backend: string | null = null,
) {
  // "unknown": the probe itself failed, so nothing is blocked on its account.
  const statusKey = cwd ? `${backend ?? ""}\u0000${cwd}` : null;
  const [workspaceStatus, setWorkspaceStatus] = useState<{ cwd: string; key: string; availability: ProbedAvailability } | null>(null);
  const workspaceStatusRef = useRef(workspaceStatus);
  const [workspaceStatusCheck, setWorkspaceStatusCheck] = useState(0);

  // A workspace deleted outside the app keeps its history, but every cwd-scoped
  // request then fails and the composer reported it as a model error (#1061).
  // Probe the folder itself so the chat can say what happened and hold new runs.
  useEffect(() => {
    if (!cwd || !statusKey) return;
    const probedCwd = cwd;
    const probedKey = statusKey;
    const controller = new AbortController();
    fetch(`/api/cwd/status?cwd=${encodeURIComponent(probedCwd)}`, { signal: controller.signal })
      .then(async (response): Promise<ProbedAvailability> => {
        const data = await response.json() as { availability?: WorkspaceAvailability; error?: string };
        // The local proxy answers 503 for a host that is not connected. That is
        // not a missing folder: say so, and hold runs until it is back.
        if (backend && response.status === 503 && data.error === "remote_offline") return "host-offline";
        return response.ok && data.availability ? data.availability : "unknown";
      })
      .catch((error) => (error instanceof DOMException && error.name === "AbortError" ? null : "unknown" as const))
      .then((availability) => {
        if (!availability || controller.signal.aborted) return;
        const previous = workspaceStatusRef.current;
        const recovered = availability === "available"
          && previous?.key === probedKey
          && previous.availability !== "available"
          && previous.availability !== "unknown";
        workspaceStatusRef.current = { cwd: probedCwd, key: probedKey, availability };
        setWorkspaceStatus({ cwd: probedCwd, key: probedKey, availability });
        // The model list loaded while the folder was gone only holds its error.
        if (recovered) setModelsRefreshKey((key) => key + 1);
      });
    return () => controller.abort();
  }, [backend, cwd, statusKey, workspaceStatusCheck, setModelsRefreshKey]);

  const workspaceAvailability = cwd && workspaceStatus?.key === statusKey
    ? workspaceStatus.availability
    : null;
  const hostLabel = backend
    ? remoteClientStore.getSnapshot().hosts.find((host) => host.id === backend)?.label ?? backend
    : undefined;
  const unavailableWorkspace = useMemo<UnavailableWorkspace | null>(() => (
    cwd && workspaceAvailability && workspaceAvailability !== "available" && workspaceAvailability !== "unknown"
      ? { cwd, availability: workspaceAvailability, ...(workspaceAvailability === "host-offline" ? { host: hostLabel } : {}) }
      : null
  ), [cwd, workspaceAvailability, hostLabel]);
  const recheckWorkspace = useCallback(() => {
    // "Check again" on a disconnected host means: reconnect it. The probe runs
    // again by itself once the host is back (AppShell's useRemoteHostRecovered),
    // which calls this with the host already online: nothing to reconnect then.
    const hostStatus = backend
      ? remoteClientStore.getSnapshot().hosts.find((host) => host.id === backend)?.status
      : undefined;
    if (backend && hostStatus !== "online" && workspaceStatusRef.current?.availability === "host-offline") {
      void localFetch(`/api/remote-hosts/${encodeURIComponent(backend)}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).catch(() => undefined).then(() => refreshRemoteHosts());
    }
    setWorkspaceStatusCheck((check) => check + 1);
  }, [backend]);

  return { workspaceAvailability, unavailableWorkspace, recheckWorkspace };
}
