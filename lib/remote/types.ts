/**
 * Types shared by the remote-host server modules and the client (fork-owned).
 * Keep this file free of Node imports: client components import it.
 */
import type { SessionInfo } from "@/lib/types";

export type RemoteHostStatus = "connecting" | "online" | "reconnecting" | "offline" | "error";

export interface RemoteHostError {
  code: string;
  message: string;
  detail?: string;
}

export interface RemoteHostSnapshot {
  id: string;
  label: string;
  ssh: string;
  status: RemoteHostStatus;
  /** Current connect step: probe | install | start | tunnel | login. */
  phase: string | null;
  error: RemoteHostError | null;
  /** Server build installed for this desktop build. */
  version: string | null;
  /** appVersion reported by the remote server. */
  remoteVersion: string | null;
  platform: string | null;
  home: string | null;
  connectedAt: number | null;
  lastOnlineAt: number | null;
  /** Set when another server version is busy and was not replaced. */
  busySessionIds: string[] | null;
  runningSessionIds: string[];
}

/** SessionInfo as returned by the merged list: remote rows carry their host. */
export type HostedSessionInfo = SessionInfo & {
  /** Remote host id; absent for local sessions. */
  host?: string;
};

/** Shape of GET /api/sessions. */
export interface RemoteSessionsPayload {
  sessions: HostedSessionInfo[];
  sessionListVersion: number;
  runningSessionIds?: string[];
  completionNotificationSuppressedSessionIds?: string[];
}

/** Extra field the merged running-events stream adds to every frame. */
export interface RemoteHostsFrameExtra {
  remoteHosts?: RemoteHostSnapshot[];
}
