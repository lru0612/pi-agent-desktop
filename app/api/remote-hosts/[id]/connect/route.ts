import { NextResponse } from "next/server";

import { getRemoteHostManager } from "@/lib/remote/host-manager";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// POST /api/remote-hosts/<id>/connect  body (optional): { replace?: "if-idle" | "force" }
// Reconnects now. `replace: "force"` replaces another server version on the
// host even if it is running tasks (they are interrupted).
export async function POST(req: Request, { params }: Context) {
  const { id } = await params;
  const body = await req.json().catch(() => ({})) as { replace?: unknown };
  const replace = body.replace === "force" || body.replace === "if-idle" ? body.replace : undefined;
  const host = getRemoteHostManager().connect(id, { replace });
  if (!host) return NextResponse.json({ error: "Unknown host" }, { status: 404 });
  return NextResponse.json({ host });
}
