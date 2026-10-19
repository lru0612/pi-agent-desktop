"use client";

/**
 * Light-blue globe after a remote project's name in the sidebar (fork-owned).
 * Grey when the host is offline, pulsing while it connects.
 */
import { useI18n } from "@/hooks/useI18n";

import { GlobeIcon, hostStatusTone, useRemoteClientState } from "./useRemote";

export function RemoteProjectBadge({ host: hostId }: { host: string | null }) {
  const { t } = useI18n();
  const state = useRemoteClientState();
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
