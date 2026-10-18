import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";

import webPackage from "../../../package.json";
import { APP_VERSION } from "@/lib/branding";
import { REMOTE_PROTOCOL_VERSION, type RemoteServerInfo } from "@/lib/remote/protocol";
import { userHome } from "@/lib/user-home";

export const dynamic = "force-dynamic";

const startedAt = new Date().toISOString();

// Handshake endpoint for remote hosts: the local proxy calls it through the SSH
// tunnel to check that the server on the far side is a pi-web build it can
// drive. Sits under /api, so proxy.ts applies the Host/Origin fence and the
// PI_WEB_PASSWORD check like any other route.
export async function GET() {
  const info: RemoteServerInfo = {
    protocol: REMOTE_PROTOCOL_VERSION,
    appVersion: APP_VERSION,
    piWeb: webPackage.version,
    pi: PI_VERSION,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    home: userHome(),
    pid: process.pid,
    headless: process.env.PI_REMOTE_HEADLESS === "1",
    startedAt,
  };
  return Response.json(info, { headers: { "Cache-Control": "no-store" } });
}
