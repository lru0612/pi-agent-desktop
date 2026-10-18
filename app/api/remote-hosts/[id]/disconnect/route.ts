import { NextResponse } from "next/server";

import { getRemoteHostManager } from "@/lib/remote/host-manager";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// POST /api/remote-hosts/<id>/disconnect — closes the tunnel; the remote
// server (and any running agent) keeps going.
export async function POST(_req: Request, { params }: Context) {
  const { id } = await params;
  const host = getRemoteHostManager().disconnect(id);
  if (!host) return NextResponse.json({ error: "Unknown host" }, { status: 404 });
  return NextResponse.json({ host });
}
