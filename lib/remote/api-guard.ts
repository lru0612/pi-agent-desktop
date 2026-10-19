import { NextResponse } from "next/server";

import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

/**
 * Defence in depth for the SSH host management routes. `proxy.ts` already
 * checks every /api request, but these routes start `ssh` with user-supplied
 * options and can stop a remote server, so they repeat the check like the
 * other settings writers do.
 *
 * `json: "required"` demands a JSON body; `"if-body"` only rejects a body
 * that is present but not JSON (an empty POST stays valid).
 */
export function guardRemoteHostMutation(
  request: Request,
  options: { json?: "required" | "if-body" } = {},
): NextResponse | null {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const json = options.json;
  if (!json) return null;
  const hasBody = request.headers.has("content-type")
    || Number(request.headers.get("content-length") ?? "0") > 0
    || request.headers.has("transfer-encoding");
  if ((json === "required" || hasBody) && !hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  return null;
}
