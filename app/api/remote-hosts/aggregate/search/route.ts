import { aggregateSearch } from "@/lib/remote/aggregate";

export const dynamic = "force-dynamic";

// Merged GET /api/sessions/search: local transcripts plus every online host's
// (remote hits carry `session.host`).
export async function GET(req: Request) {
  return aggregateSearch(req);
}
