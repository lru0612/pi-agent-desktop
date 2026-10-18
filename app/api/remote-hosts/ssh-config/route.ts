import { NextResponse } from "next/server";

import { listSshConfigHosts } from "@/lib/remote/ssh-config";

export const dynamic = "force-dynamic";

// GET /api/remote-hosts/ssh-config — concrete Host aliases from ~/.ssh/config,
// offered as suggestions in the "Add SSH host" dialog.
export async function GET() {
  return NextResponse.json({ hosts: listSshConfigHosts() }, { headers: { "Cache-Control": "no-store" } });
}
