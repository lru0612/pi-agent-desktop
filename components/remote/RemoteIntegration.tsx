"use client";

/**
 * Remote pieces mounted into upstream components (fork-owned):
 * - RemoteHostBanner: status strip when the current workspace's host is not online.
 * - openAddProjectMenu: the "+" menu (this computer / SSH hosts / manage hosts).
 * - useRemoteConfigScope: the Settings "Settings for: …" switch.
 * - canUseNativeFileActions: hide Finder/open-with actions for remote paths.
 */
import { useEffect, useRef } from "react";

import { useI18n } from "@/hooks/useI18n";
import { canUseNativeMenu, menuPointBelow, showNativeMenu } from "@/lib/desktop-menu";
import type { NativeMenuEntry } from "@/lib/desktop-menu-model";
import { openDomMenu } from "@/lib/dom-menu-store";
import { remoteClientStore } from "@/lib/remote/client-store";

import { openRemoteDirectoryPicker, openRemoteHostsDialog, reconnectRemoteHost } from "./RemoteUiHost";
import { GlobeIcon, hostProblemText, hostStatusTone, useRemoteClientState } from "./useRemote";

// ------------------------------------------------------------------ banner

export function RemoteHostBanner() {
  const { t } = useI18n();
  const state = useRemoteClientState();
  const host = state.currentHost ? state.hosts.find((item) => item.id === state.currentHost) : undefined;
  if (!state.currentHost || !state.hostsLoaded) return null;
  if (host?.status === "online") return null;
  const label = host?.label ?? state.currentHost;
  const tone = hostStatusTone(host?.status);
  const busy = host?.error?.code === "other_version_busy";
  const text = !host
    ? t("remote.offline.title", { host: label })
    : tone === "connecting"
      ? t("remote.banner.connecting", { host: label, phase: hostProblemText(host, t) })
      : busy
        ? t("remote.banner.busy", { host: label, count: host.busySessionIds?.length ?? 0 })
        : t("remote.banner.offline", { host: label, reason: hostProblemText(host, t) });
  return (
    <div className={`remote-host-banner is-${tone}`} role="status">
      <span className={`sidebar-project-remote-globe is-${tone}`} aria-hidden="true"><GlobeIcon size={13} /></span>
      <span className="remote-host-banner-text">{text}</span>
      {host && tone !== "connecting" && (
        <span className="remote-host-banner-actions">
          {busy && (
            <button type="button" onClick={() => void reconnectRemoteHost(host.id, "force")}>{t("remote.banner.forceUpgrade")}</button>
          )}
          <button type="button" onClick={() => void reconnectRemoteHost(host.id)}>{t("remote.banner.reconnect")}</button>
          <button type="button" onClick={() => openRemoteHostsDialog({ focusHost: host.id, diagnose: true })}>{t("remote.banner.diagnose")}</button>
        </span>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ "+" menu

type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * Show the add-project menu under `anchor`. `onLocal` runs the existing local
 * folder flow; `onPicked` receives a folder chosen on a remote host.
 */
export async function openAddProjectMenu(
  anchor: Element,
  t: Translate,
  handlers: { onLocal: () => void; onPicked: (cwd: string) => void },
): Promise<void> {
  const hosts = remoteClientStore.getSnapshot().hosts;
  const entries: NativeMenuEntry[] = [{ label: t("remote.addProject.local"), onSelect: handlers.onLocal }];
  if (hosts.length > 0) {
    entries.push({ kind: "separator" });
    for (const host of hosts) {
      const suffix = host.status === "online" ? "" : ` · ${t(`remote.status.${host.status}`)}`;
      entries.push({
        label: `🌐 ${host.label}${suffix}`,
        onSelect: () => {
          if (host.status === "online") openRemoteDirectoryPicker(host.id, handlers.onPicked);
          else {
            void reconnectRemoteHost(host.id);
            openRemoteHostsDialog({ focusHost: host.id, onPicked: handlers.onPicked });
          }
        },
      });
    }
  }
  entries.push({ kind: "separator" });
  entries.push({
    label: hosts.length > 0 ? t("remote.addProject.manageHosts") : t("remote.addProject.addHost"),
    onSelect: () => openRemoteHostsDialog({ onPicked: handlers.onPicked }),
  });
  const point = menuPointBelow(anchor);
  if (canUseNativeMenu() && await showNativeMenu(entries, point)) return;
  const rect = anchor.getBoundingClientRect();
  openDomMenu(entries, { x: rect.left, y: rect.bottom + 4 });
}

// ------------------------------------------------------------------ settings scope

/**
 * Settings scope switch. While Settings is open the router sends config
 * requests to the chosen backend; `scopeKey` remounts the sections on change.
 * `cwdApplies` is false when the open project lives on another backend, so
 * project-scoped sections are hidden instead of writing to the wrong place.
 */
export function useRemoteConfigScope(cwd: string | null | undefined): { scopeKey: string; cwdApplies: boolean; element: React.ReactNode } {
  const { t } = useI18n();
  const state = useRemoteClientState();
  const initialRef = useRef<string | null>(state.currentHost);

  useEffect(() => {
    remoteClientStore.setConfigHost(initialRef.current);
    return () => remoteClientStore.setConfigHost(undefined);
  }, []);

  const scope = state.configHost === undefined ? initialRef.current : state.configHost;
  const scopeKey = scope ?? "local";
  const cwdOwner = cwd ? remoteClientStore.ownerOfPath(cwd) : undefined;
  const cwdHost = cwdOwner !== undefined ? cwdOwner : state.currentHost;
  const cwdApplies = !cwd || cwdHost === scope;
  if (state.hosts.length === 0 && scope === null) return { scopeKey, cwdApplies, element: null };
  const element = (
    <label className="settings-remote-scope" title={t("remote.scope.label")}>
      <span className={`sidebar-project-remote-globe is-${scope ? hostStatusTone(state.hosts.find((h) => h.id === scope)?.status) : "online"}`} aria-hidden="true">
        {scope ? <GlobeIcon size={12} /> : null}
      </span>
      <span className="settings-remote-scope-label">{t("remote.scope.label")}</span>
      <select
        value={scopeKey}
        onChange={(event) => remoteClientStore.setConfigHost(event.target.value === "local" ? null : event.target.value)}
      >
        <option value="local">{t("remote.scope.local")}</option>
        {state.hosts.map((host) => (
          <option key={host.id} value={host.id}>
            {host.label}{host.status === "online" ? "" : ` (${t(`remote.status.${host.status}`)})`}
          </option>
        ))}
      </select>
    </label>
  );
  return { scopeKey, cwdApplies, element };
}

export { canUseNativeFileActions } from "@/lib/remote/client-store";
