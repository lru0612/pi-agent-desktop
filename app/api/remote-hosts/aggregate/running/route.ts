import { aggregateRunning } from "@/lib/remote/aggregate";

export const dynamic = "force-dynamic";

// Merged GET /api/agent/running snapshot.
export async function GET() {
  return aggregateRunning();
}
