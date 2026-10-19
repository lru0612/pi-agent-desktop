"use client";

/**
 * React glue for the remote-host client state (fork-owned).
 */
import { useEffect, useRef, useSyncExternalStore } from "react";

import { remoteClientStore, type RemoteClientSnapshot } from "@/lib/remote/client-store";
import type { RemoteHostSnapshot, RemoteHostStatus } from "@/lib/remote/types";

const SERVER_SNAPSHOT: RemoteClientSnapshot = {
  hosts: [],
  projects: [],
  hostsLoaded: false,
  currentHost: null,
  routingVersion: 0,
};

export function useRemoteClientState(): RemoteClientSnapshot {
  return useSyncExternalStore(remoteClientStore.subscribe, remoteClientStore.getSnapshot, () => SERVER_SNAPSHOT);
}

/** Tell the router which session / folder the main pane is showing. */
export function useRemoteWorkspace(sessionId: string | null | undefined, cwd: string | null | undefined): void {
  useEffect(() => {
    remoteClientStore.setWorkspace(sessionId ?? null, cwd ?? null);
  }, [sessionId, cwd]);
}

/**
 * Run `onRecovered` when the current workspace's host comes back online after
 * having been unreachable while it was current, so views that failed with
 * 503 reload instead of showing a stale error.
 */
export function useRemoteHostRecovered(onRecovered: () => void): void {
  const state = useRemoteClientState();
  const status = state.currentHost ? state.hosts.find((host) => host.id === state.currentHost)?.status : undefined;
  const previous = useRef<{ host: string | null; status: string | undefined }>({ host: null, status: undefined });
  useEffect(() => {
    const prev = previous.current;
    previous.current = { host: state.currentHost, status };
    if (!state.currentHost || prev.host !== state.currentHost) return;
    if (status === "online" && prev.status !== undefined && prev.status !== "online") onRecovered();
  }, [state.currentHost, status, onRecovered]);
}

export function hostStatusTone(status: RemoteHostStatus | undefined): "online" | "connecting" | "offline" {
  if (status === "online") return "online";
  if (status === "connecting" || status === "reconnecting") return "connecting";
  return "offline";
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Localised one-line reason for a host that is not online. */
export function hostProblemText(host: RemoteHostSnapshot, t: Translate): string {
  if (host.status === "connecting" || host.status === "reconnecting") {
    return host.phase ? t(`remote.phase.${host.phase}`) : t(`remote.status.${host.status}`);
  }
  return host.error?.message ?? t(`remote.status.${host.status}`);
}

export function GlobeIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="currentColor" fillOpacity="0.14" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  );
}
