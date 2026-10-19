/** Backend-qualified client identities; physical paths are never modified. */
import { hostedProjectKey } from "./project-identity.ts";

export function workspaceNavigation(query: { session?: string; cwd?: string }, host?: string | null): string {
  const params = new URLSearchParams();
  if (query.session) params.set("session", query.session);
  else if (query.cwd) params.set("cwd", query.cwd);
  if (host) params.set("host", host);
  return `?${params}`;
}

export function parkedWorkspaceDraft(cwd: string, host?: string | null): string {
  return `parked-new:${hostedProjectKey(cwd, host)}`;
}

export function newWorkspaceDraft(id: string, cwd: string, host?: string | null): string {
  return `new:${id}:${hostedProjectKey(cwd, host)}`;
}
