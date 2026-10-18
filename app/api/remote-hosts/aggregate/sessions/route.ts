import { aggregateSessions } from "@/lib/remote/aggregate";

export const dynamic = "force-dynamic";

// Merged GET /api/sessions: local sessions plus every remote host's (remote
// rows carry `host`). Offline hosts contribute their last cached list.
export async function GET(req: Request) {
  return aggregateSessions(req);
}
