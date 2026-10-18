import { aggregateRunningEvents } from "@/lib/remote/aggregate";

export const dynamic = "force-dynamic";

// Merged GET /api/agent/running/events: same frames, plus `remoteHosts`.
export async function GET(req: Request) {
  return aggregateRunningEvents(req);
}
