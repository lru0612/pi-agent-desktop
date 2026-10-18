"use client";

/**
 * Remote-host dialogs (fork-owned): host management (add / reconnect /
 * diagnose / remove) and the remote folder picker used by "add project".
 * Mounted once by AppShell; opened through the functions below.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { DirectoryPicker } from "@/components/DirectoryPicker";
import { useI18n } from "@/hooks/useI18n";
import { localFetch, refreshRemoteHosts } from "@/lib/remote/client";
import { remoteClientStore } from "@/lib/remote/client-store";
import type { RemoteHostSnapshot } from "@/lib/remote/types";

import { GlobeIcon, hostProblemText, hostStatusTone, useRemoteClientState } from "./useRemote";

type DialogState =
  | { kind: "hosts"; focusHost?: string; diagnose?: boolean; onPicked?: (cwd: string) => void }
  | { kind: "picker"; hostId: string; onPicked: (cwd: string) => void }
  | null;

let dialogState: DialogState = null;
const dialogListeners = new Set<() => void>();

function setDialog(next: DialogState): void {
  dialogState = next;
  // Set the picker's host before DirectoryPicker mounts: its first listing
  // runs in a child effect, before any effect of RemoteDirectoryPicker.
  remoteClientStore.setBrowseHost(next?.kind === "picker" ? next.hostId : null);
  for (const listener of dialogListeners) listener();
}

/** Open the SSH host manager. `onPicked` receives a folder chosen on a newly connected host. */
export function openRemoteHostsDialog(options: { focusHost?: string; diagnose?: boolean; onPicked?: (cwd: string) => void } = {}): void {
  setDialog({ kind: "hosts", ...options });
}

/** Open the folder picker on a remote host. */
export function openRemoteDirectoryPicker(hostId: string, onPicked: (cwd: string) => void): void {
  setDialog({ kind: "picker", hostId, onPicked });
}

export function closeRemoteDialogs(): void {
  setDialog(null);
}

export async function reconnectRemoteHost(hostId: string, replace?: "if-idle" | "force"): Promise<void> {
  await localFetch(`/api/remote-hosts/${encodeURIComponent(hostId)}/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(replace ? { replace } : {}),
  }).catch(() => undefined);
  await refreshRemoteHosts();
}

export function RemoteUiHost() {
  const dialog = useSyncExternalStore(
    (listener) => {
      dialogListeners.add(listener);
      return () => dialogListeners.delete(listener);
    },
    () => dialogState,
    () => null,
  );
  if (!dialog) return null;
  if (dialog.kind === "picker") {
    return <RemoteDirectoryPicker key={dialog.hostId} hostId={dialog.hostId} onPicked={dialog.onPicked} onClose={closeRemoteDialogs} />;
  }
  return (
    <RemoteHostsDialog
      focusHost={dialog.focusHost}
      diagnose={dialog.diagnose}
      onPicked={dialog.onPicked}
      onClose={closeRemoteDialogs}
    />
  );
}

// ------------------------------------------------------------------ folder picker

function RemoteDirectoryPicker({ hostId, onPicked, onClose }: { hostId: string; onPicked: (cwd: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const state = useRemoteClientState();
  const host = state.hosts.find((item) => item.id === hostId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const select = useCallback(async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await localFetch(`/api/r/${encodeURIComponent(hostId)}/cwd/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await response.json().catch(() => ({})) as { cwd?: string; projectRoot?: string; error?: string };
      if (!response.ok || !data.cwd) {
        setError(data.error ?? `HTTP ${response.status}`);
        return;
      }
      remoteClientStore.addRemoteRoot(hostId, data.projectRoot ?? data.cwd);
      if (data.projectRoot && data.projectRoot !== data.cwd) remoteClientStore.addRemoteRoot(hostId, data.cwd);
      onClose();
      onPicked(data.cwd);
    } catch (selectError) {
      setError((selectError as Error).message);
    } finally {
      setBusy(false);
    }
  }, [hostId, onClose, onPicked]);

  if (host && host.status !== "online") {
    return (
      <RemoteModal title={t("remote.picker.title", { host: host.label })} onClose={onClose}>
        <HostRow host={host} t={t} />
        <div className="remote-dialog-actions">
          <button type="button" className="remote-dialog-button" onClick={() => void reconnectRemoteHost(host.id)}>
            {t("remote.dialog.reconnect")}
          </button>
          <button type="button" className="remote-dialog-button" onClick={onClose}>{t("remote.dialog.close")}</button>
        </div>
      </RemoteModal>
    );
  }

  return (
    <>
      <div className="remote-picker-host-label" role="status">
        <GlobeIcon size={13} />
        <span>{t("remote.picker.title", { host: host?.label ?? hostId })}</span>
      </div>
      <DirectoryPicker
        busy={busy}
        error={error}
        initialPath={host?.home ?? undefined}
        onCancel={onClose}
        onSelect={(path) => void select(path)}
      />
    </>
  );
}

// ------------------------------------------------------------------ host manager

interface SshConfigHost {
  alias: string;
  hostName?: string;
  user?: string;
}

interface DoctorStep {
  name: string;
  ok: boolean;
  detail?: string;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

function HostRow({ host, t, children }: { host: RemoteHostSnapshot; t: Translate; children?: React.ReactNode }) {
  const tone = hostStatusTone(host.status);
  return (
    <div className="remote-host-row" data-status={host.status}>
      <span className={`sidebar-project-remote-globe is-${tone}`} aria-hidden="true"><GlobeIcon size={14} /></span>
      <div className="remote-host-row-main">
        <div className="remote-host-row-title">
          <strong>{host.label}</strong>
          <span className={`remote-host-status is-${tone}`}>{t(`remote.status.${host.status}`)}</span>
        </div>
        <div className="remote-host-row-target">{host.ssh}</div>
        {host.status === "online" && host.remoteVersion && (
          <div className="remote-host-row-meta">{t("remote.dialog.version", { version: host.remoteVersion, platform: host.platform ?? "" })}</div>
        )}
        {host.status !== "online" && (
          <div className={`remote-host-row-meta${tone === "offline" ? " is-error" : ""}`}>{hostProblemText(host, t)}</div>
        )}
        {host.error?.detail && host.status !== "online" && (
          <details className="remote-host-row-detail">
            <summary>{host.error.code}</summary>
            <pre>{host.error.detail}</pre>
          </details>
        )}
        {children}
      </div>
    </div>
  );
}

function RemoteModal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => setTarget(document.body), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!target) return null;
  return createPortal(
    <div className="remote-dialog-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`remote-dialog${wide ? " is-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="remote-dialog-header">
          <strong>{title}</strong>
          <button type="button" className="config-close-button" onClick={onClose} aria-label="×">×</button>
        </div>
        <div className="remote-dialog-body">{children}</div>
      </div>
    </div>,
    target,
  );
}

function RemoteHostsDialog({
  focusHost,
  diagnose,
  onPicked,
  onClose,
}: {
  focusHost?: string;
  diagnose?: boolean;
  onPicked?: (cwd: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { hosts } = useRemoteClientState();
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");
  const [suggestions, setSuggestions] = useState<SshConfigHost[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingHost, setPendingHost] = useState<string | null>(null);
  const [doctor, setDoctor] = useState<{ hostId: string; loading: boolean; steps: DoctorStep[] } | null>(null);
  const diagnosedRef = useRef(false);

  useEffect(() => {
    void localFetch("/api/remote-hosts/ssh-config", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { hosts: [] }))
      .then((data: { hosts?: SshConfigHost[] }) => setSuggestions(data.hosts ?? []))
      .catch(() => setSuggestions([]));
    void refreshRemoteHosts();
  }, []);

  const busy = hosts.some((host) => host.status === "connecting" || host.status === "reconnecting") || pendingHost !== null;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void refreshRemoteHosts(), 1_000);
    return () => clearInterval(timer);
  }, [busy]);

  // A host added from "add project" opens its folder picker once it is online.
  useEffect(() => {
    if (!pendingHost) return;
    const host = hosts.find((item) => item.id === pendingHost);
    if (!host) return;
    if (host.status === "online") {
      setPendingHost(null);
      if (onPicked) openRemoteDirectoryPicker(host.id, onPicked);
    } else if (host.status === "error") {
      setPendingHost(null);
    }
  }, [hosts, pendingHost, onPicked]);

  const runDoctor = useCallback(async (hostId: string) => {
    setDoctor({ hostId, loading: true, steps: [] });
    try {
      const response = await localFetch(`/api/remote-hosts/${encodeURIComponent(hostId)}/doctor`, { cache: "no-store" });
      const data = await response.json() as { steps?: DoctorStep[] };
      setDoctor({ hostId, loading: false, steps: data.steps ?? [] });
    } catch (doctorError) {
      setDoctor({ hostId, loading: false, steps: [{ name: "request", ok: false, detail: (doctorError as Error).message }] });
    }
  }, []);

  useEffect(() => {
    if (diagnose && focusHost && !diagnosedRef.current) {
      diagnosedRef.current = true;
      void runDoctor(focusHost);
    }
  }, [diagnose, focusHost, runDoctor]);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const ssh = target.trim();
    if (!ssh) return;
    setAdding(true);
    setError(null);
    try {
      const response = await localFetch("/api/remote-hosts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssh, label: label.trim() || undefined }),
      });
      const data = await response.json() as { host?: RemoteHostSnapshot; error?: string };
      if (!response.ok || !data.host) {
        setError(data.error ?? `HTTP ${response.status}`);
        return;
      }
      setTarget("");
      setLabel("");
      setPendingHost(data.host.id);
      await refreshRemoteHosts();
    } catch (addError) {
      setError((addError as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const remove = async (host: RemoteHostSnapshot) => {
    if (!window.confirm(t("remote.dialog.removeConfirm", { host: host.label }))) return;
    await localFetch(`/api/remote-hosts/${encodeURIComponent(host.id)}`, { method: "DELETE" }).catch(() => undefined);
    await refreshRemoteHosts();
  };

  const disconnect = async (host: RemoteHostSnapshot) => {
    await localFetch(`/api/remote-hosts/${encodeURIComponent(host.id)}/disconnect`, { method: "POST" }).catch(() => undefined);
    await refreshRemoteHosts();
  };

  const ordered = useMemo(() => {
    if (!focusHost) return hosts;
    return [...hosts].sort((a, b) => (a.id === focusHost ? -1 : b.id === focusHost ? 1 : 0));
  }, [hosts, focusHost]);

  return (
    <RemoteModal title={t("remote.dialog.title")} onClose={onClose} wide>
      <p className="remote-dialog-hint">{t("remote.dialog.requirements")}</p>
      <div className="remote-host-list">
        {ordered.length === 0 && <div className="remote-dialog-empty">{t("remote.dialog.empty")}</div>}
        {ordered.map((host) => (
          <HostRow key={host.id} host={host} t={t}>
            <div className="remote-host-row-actions">
              {host.status === "online" && onPicked && (
                <button type="button" className="remote-dialog-button is-primary" onClick={() => openRemoteDirectoryPicker(host.id, onPicked)}>
                  {t("remote.dialog.openFolder")}
                </button>
              )}
              {host.error?.code === "other_version_busy" && (
                <button type="button" className="remote-dialog-button" onClick={() => void reconnectRemoteHost(host.id, "force")}>
                  {t("remote.banner.forceUpgrade")}
                </button>
              )}
              {host.status !== "connecting" && (
                <button type="button" className="remote-dialog-button" onClick={() => void reconnectRemoteHost(host.id)}>
                  {t("remote.dialog.reconnect")}
                </button>
              )}
              {host.status === "online" && (
                <button type="button" className="remote-dialog-button" onClick={() => void disconnect(host)}>
                  {t("remote.dialog.disconnect")}
                </button>
              )}
              <button type="button" className="remote-dialog-button" onClick={() => void runDoctor(host.id)}>
                {t("remote.dialog.diagnose")}
              </button>
              <button type="button" className="remote-dialog-button is-danger" onClick={() => void remove(host)}>
                {t("remote.dialog.remove")}
              </button>
            </div>
            {doctor?.hostId === host.id && (
              <div className="remote-doctor">
                {doctor.loading ? (
                  <div className="remote-host-row-meta">{t("remote.dialog.diagnosing")}</div>
                ) : doctor.steps.map((step) => (
                  <details key={step.name} className={`remote-doctor-step${step.ok ? " is-ok" : " is-error"}`} open={!step.ok}>
                    <summary>{step.ok ? "✓" : "✗"} {step.name}</summary>
                    {step.detail && <pre>{step.detail}</pre>}
                  </details>
                ))}
              </div>
            )}
          </HostRow>
        ))}
      </div>

      <form className="remote-add-form" onSubmit={(event) => void add(event)}>
        <label className="remote-add-field">
          <span>{t("remote.dialog.target")}</span>
          <input
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder={t("remote.dialog.targetPlaceholder")}
            list="remote-ssh-config-hosts"
            autoComplete="off"
            spellCheck={false}
            autoFocus={hosts.length === 0}
          />
          <datalist id="remote-ssh-config-hosts">
            {suggestions.map((host) => (
              <option key={host.alias} value={host.alias}>
                {[host.user, host.hostName].filter(Boolean).join("@")}
              </option>
            ))}
          </datalist>
        </label>
        <label className="remote-add-field is-narrow">
          <span>{t("remote.dialog.label")}</span>
          <input value={label} onChange={(event) => setLabel(event.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <button type="submit" className="remote-dialog-button is-primary" disabled={adding || !target.trim()}>
          {t("remote.dialog.connect")}
        </button>
      </form>
      {error && <div className="remote-dialog-error">{error}</div>}
    </RemoteModal>
  );
}
