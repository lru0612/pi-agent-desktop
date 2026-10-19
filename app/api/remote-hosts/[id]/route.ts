import { NextResponse } from "next/server";

import { guardRemoteHostMutation } from "@/lib/remote/api-guard";
import { getRemoteHostManager } from "@/lib/remote/host-manager";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// PATCH /api/remote-hosts/<id>  body: { label?: string }
export async function PATCH(req: Request, { params }: Context) {
  const { id } = await params;
  const refused = guardRemoteHostMutation(req, { json: "required" });
  if (refused) return refused;
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
  const refused = guardRemoteHostMutation(req);
  if (refused) return refused;
  const stopRemote = new URL(req.url).searchParams.get("stopRemote") === "1";
  const removed = await getRemoteHostManager().remove(id, { stopRemote });
  if (!removed) return NextResponse.json({ error: "Unknown host" }, { status: 404 });
  return NextResponse.json({ success: true });
}
