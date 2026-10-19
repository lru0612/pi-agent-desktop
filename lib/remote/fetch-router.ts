/** Browser fetch adapter kept injectable for regression tests. */
import type { RouteDecision } from "./router.ts";

export interface RoutedRequest {
  decision: RouteDecision;
  path: string;
  method: string;
  body: unknown;
}

export function createRoutedFetch(options: {
  origin: () => string;
  resolve: (url: string, body: unknown) => RouteDecision;
  transport: typeof globalThis.fetch;
  /** Abort, rather than guess, if a Request body is read across a scope change. */
  scope: () => string | null;
  onRequest?: (request: RoutedRequest) => void;
  onResponse?: (request: RoutedRequest, response: Response) => void | Promise<void>;
}): typeof globalThis.fetch {
  return async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const origin = options.origin();
    const url = new URL(raw, origin);
    if (url.origin !== origin || !url.pathname.startsWith("/api/")) return options.transport(input, init);

    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let body: unknown = init?.body;
    // fetch(new Request(...)) is equivalent to fetch(url, {body: ...}); do not
    // lose its cwd/id when routing or consume the caller's body stream.
    if (body === undefined && input instanceof Request && method !== "GET" && method !== "HEAD"
      && input.headers.get("content-type")?.includes("application/json")) {
      const scope = options.scope();
      body = await input.clone().text();
      if (scope !== options.scope()) throw new DOMException("Workspace changed before request dispatch", "AbortError");
    }
    const decision = options.resolve(raw, body);
    const path = url.pathname.replace(/^\/api\/r\/[^/]+\//, "/api/");
    const request = { decision, path, method, body };
    options.onRequest?.(request);
    const target = decision.changed
      ? input instanceof Request ? new Request(new URL(decision.url, origin), input) : decision.url
      : input;
    const response = await options.transport(target, init);
    // Learn ids BEFORE exposing a create/fork/list response to its consumer.
    // Otherwise the next dependent request can race the side-channel clone.
    await options.onResponse?.(request, response);
    return response;
  };
}
