import { NextResponse } from "next/server";

import { guardRemoteHostMutation } from "@/lib/remote/api-guard";
import { findServerBundleDir, readServerBundle } from "@/lib/remote/bundle";
import { getRemoteHostManager } from "@/lib/remote/host-manager";
import { normalizeSshTarget, parseSshTarget } from "@/lib/remote/hosts-store";

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
  const refused = guardRemoteHostMutation(req, { json: "required" });
  if (refused) return refused;
  let body: { ssh?: unknown; label?: unknown };
  try {
    body = await req.json() as { ssh?: unknown; label?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const raw = typeof body.ssh === "string" ? body.ssh.trim() : "";
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 64) : undefined;
  if (!raw) return NextResponse.json({ error: "SSH target is required" }, { status: 400 });
  // Accept "user@host -p 2222" the way people type it; the manager stores the
  // normalised "-p 2222 user@host" form, so validate that one.
  let ssh: string;
  try {
    ssh = normalizeSshTarget(raw);
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
