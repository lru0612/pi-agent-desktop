import { NextResponse } from "next/server";

import { getRemoteHostManager } from "@/lib/remote/host-manager";
import { diagnoseHost } from "@/lib/remote/ssh-config";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// GET /api/remote-hosts/<id>/doctor — step-by-step connection check plus the
// tail of the remote server log.
export async function GET(_req: Request, { params }: Context) {
  const { id } = await params;
  const host = getRemoteHostManager().get(id);
  if (!host) return NextResponse.json({ error: "Unknown host" }, { status: 404 });
  const steps = await diagnoseHost(host.ssh);
  return NextResponse.json({ host, steps }, { headers: { "Cache-Control": "no-store" } });
}
