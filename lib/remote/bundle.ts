/**
 * Locates the server tree that gets installed on remote hosts and streams it
 * as a tarball (fork-owned, server-only).
 *
 * The packaged desktop app runs the very tree it uploads (server.js chdirs into
 * it), so local UI and remote API always come from the same build. In `next
 * dev` the tree staged by `npm run desktop:prepare` is used instead.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { isSafeVersion } from "./bootstrap-script";

export interface ServerBundle {
  dir: string;
  /** Install id on the remote: `<appVersion>-<buildId8>`. */
  version: string;
  appVersion: string;
}

function isServerTree(dir: string): boolean {
  return existsSync(join(dir, "headless-launcher.cjs")) && existsSync(join(dir, "server.js"));
}

export function findServerBundleDir(): string | null {
  const candidates = [
    process.env.PI_REMOTE_BUNDLE_DIR,
    process.cwd(),
    join(process.cwd(), "src-tauri", "resources", "server"),
  ];
  for (const candidate of candidates) {
    if (candidate && isServerTree(resolve(candidate))) return resolve(candidate);
  }
  return null;
}

export function readServerBundle(dir: string): ServerBundle {
  let appVersion = "0.0.0";
  try {
    appVersion = JSON.parse(readFileSync(join(dir, "pi-remote-version.json"), "utf8")).appVersion ?? appVersion;
  } catch {
    // Unstamped tree (should not happen for prepared builds).
  }
  let buildId = "";
  for (const distDir of [".next-desktop", ".next"]) {
    try {
      buildId = readFileSync(join(dir, distDir, "BUILD_ID"), "utf8").trim();
      if (buildId) break;
    } catch {
      // try the next dist dir
    }
  }
  const suffix = buildId.replace(/[^0-9A-Za-z]/g, "").slice(0, 8) || "nobuild";
  const version = `${appVersion}-${suffix}`;
  if (!isSafeVersion(version)) throw new Error(`unsafe bundle version: ${version}`);
  return { dir, version, appVersion };
}

/** Files that are useless on a remote Linux/macOS host. */
const TAR_EXCLUDES = [
  "./node_modules/@img",
  "./node_modules/node-pty/prebuilds/win32-*",
  "./.next-desktop/cache",
  "./.next/cache",
];

/**
 * Spawn `tar -czf - …` for the bundle. Platform-specific node-pty prebuilds for
 * other OSes are dropped; the remote keeps the one matching its platform.
 */
export function spawnBundleTar(bundle: ServerBundle, remotePlatform: string): ChildProcess {
  const excludes = [...TAR_EXCLUDES];
  if (remotePlatform.startsWith("linux")) excludes.push("./node_modules/node-pty/prebuilds/darwin-*");
  if (remotePlatform.startsWith("darwin")) excludes.push("./node_modules/node-pty/prebuilds/linux-*");
  const args = ["-czf", "-", "-C", bundle.dir, ...excludes.flatMap((pattern) => ["--exclude", pattern]), "."];
  // COPYFILE_DISABLE keeps macOS tar from adding AppleDouble ._ files.
  return spawn("tar", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    windowsHide: true,
  });
}

/** Remote platforms the packaged server can run on (node-pty prebuilds exist). */
export function isSupportedRemotePlatform(platform: string): boolean {
  return ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"].includes(platform);
}
