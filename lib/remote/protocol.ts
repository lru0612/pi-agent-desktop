/**
 * Remote-host protocol constants shared by the local proxy and the headless
 * server it talks to. Fork-owned (see docs/remote-hosts-design.zh-CN.md).
 *
 * Bump REMOTE_PROTOCOL_VERSION whenever a change makes a local UI unable to
 * drive a remote server of the previous build (route shape, payload fields).
 */
export const REMOTE_PROTOCOL_VERSION = 1;

/** Response of `GET /api/remote-info` on a (headless) pi-web server. */
export interface RemoteServerInfo {
  protocol: number;
  /** pi-agent-desktop distribution version (src-tauri/pi-agent-desktop-package.json). */
  appVersion: string;
  /** Bundled pi-web version (package.json). */
  piWeb: string;
  /** Bundled pi SDK version. */
  pi: string;
  /** `${process.platform}-${process.arch}` of the server. */
  platform: string;
  node: string;
  home: string;
  pid: number;
  /** True when started by desktop/headless-launcher.cjs. */
  headless: boolean;
  startedAt: string;
}
