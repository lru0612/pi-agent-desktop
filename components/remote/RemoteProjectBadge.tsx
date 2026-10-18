"use client";

/**
 * Light-blue globe after a remote project's name in the sidebar (fork-owned).
 * Grey when the host is offline, pulsing while it connects.
 */
import { useI18n } from "@/hooks/useI18n";
import { remoteClientStore } from "@/lib/remote/client-store";
import type { HostedSessionInfo } from "@/lib/remote/types";
import type { SessionInfo } from "@/lib/types";

import { GlobeIcon, hostStatusTone, useRemoteClientState } from "./useRemote";

export function RemoteProjectBadge({ projectRoot, sessions }: { projectRoot: string; sessions: SessionInfo[] }) {
  const { t } = useI18n();
  const state = useRemoteClientState();
  void state.routingVersion; // re-render when ownership knowledge changes
  const hostId = remoteClientStore.hostOfProject(projectRoot, sessions as HostedSessionInfo[]);
  if (!hostId) return null;
  const host = state.hosts.find((item) => item.id === hostId);
  const status = host?.status ?? "offline";
  const tone = hostStatusTone(status);
  const title = t("remote.badge.title", {
    host: host?.label ?? hostId,
    target: host?.ssh ?? "",
    status: t(`remote.status.${status}`),
  });
  return (
    <span
      className={`sidebar-project-remote-globe is-${tone}`}
      title={title}
      aria-label={title}
      role="img"
      data-remote-host={hostId}
    >
      <GlobeIcon />
    </span>
  );
}
