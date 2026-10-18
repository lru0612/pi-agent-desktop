import { NextResponse } from "next/server";

import { getRemoteHostManager } from "@/lib/remote/host-manager";
import { hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// PATCH /api/remote-hosts/<id>  body: { label?: string }
export async function PATCH(req: Request, { params }: Context) {
  const { id } = await params;
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const body = await req.json().catch(() => ({})) as { label?: unknown };
  const host = getRemoteHostManager().update(id, {
    label: typeof body.label === "string" ? body.label.slice(0, 64) : undefined,
  });
  if (!host) return NextResponse.json({ error: "Unknown host" }, { status: 404 });
  return NextResponse.json({ host });
}

// DELETE /api/remote-hosts/<id>?stopRemote=1
// Forgets the host locally; optionally stops its remote server too.
export async function DELETE(req: Request, { params }: Context) {
  const { id } = await params;
  const stopRemote = new URL(req.url).searchParams.get("stopRemote") === "1";
  const removed = await getRemoteHostManager().remove(id, { stopRemote });
  if (!removed) return NextResponse.json({ error: "Unknown host" }, { status: 404 });
  return NextResponse.json({ success: true });
}
