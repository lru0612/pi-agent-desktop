import { NextResponse } from "next/server";

import { guardRemoteHostMutation } from "@/lib/remote/api-guard";
import { getRemoteHostManager } from "@/lib/remote/host-manager";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// POST /api/remote-hosts/<id>/disconnect — closes the tunnel; the remote
// server (and any running agent) keeps going.
export async function POST(req: Request, { params }: Context) {
  const { id } = await params;
  const refused = guardRemoteHostMutation(req);
  if (refused) return refused;
  const host = getRemoteHostManager().disconnect(id);
  if (!host) return NextResponse.json({ error: "Unknown host" }, { status: 404 });
  return NextResponse.json({ host });
}
