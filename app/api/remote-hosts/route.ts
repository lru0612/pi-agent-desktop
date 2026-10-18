import { NextResponse } from "next/server";

import { findServerBundleDir, readServerBundle } from "@/lib/remote/bundle";
import { getRemoteHostManager } from "@/lib/remote/host-manager";
import { parseSshTarget } from "@/lib/remote/hosts-store";
import { hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// GET /api/remote-hosts — configured hosts with live connection state.
export async function GET() {
  const manager = getRemoteHostManager();
  const bundleDir = findServerBundleDir();
  let bundle: { version: string } | null = null;
  try {
    bundle = bundleDir ? { version: readServerBundle(bundleDir).version } : null;
  } catch {
    bundle = null;
  }
  return NextResponse.json(
    { hosts: manager.list(), bundle },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// POST /api/remote-hosts  body: { ssh: string, label?: string }
// Adds a host and starts connecting; poll GET for progress.
export async function POST(req: Request) {
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: { ssh?: unknown; label?: unknown };
  try {
    body = await req.json() as { ssh?: unknown; label?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const ssh = typeof body.ssh === "string" ? body.ssh.trim() : "";
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 64) : undefined;
  if (!ssh) return NextResponse.json({ error: "SSH target is required" }, { status: 400 });
  try {
    parseSshTarget(ssh);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
  try {
    const host = getRemoteHostManager().add({ ssh, label });
    return NextResponse.json({ host }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
