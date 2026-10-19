"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { localFetch, routeApiUrl } from "@/lib/remote/client";
import { createBackendApi, type BackendApi, type BackendId } from "@/lib/remote/scoped-api";

const BackendContext = createContext<BackendId | undefined>(undefined);
const workspaceApi: BackendApi = {
  host: undefined,
  fetch: (input, init) => globalThis.fetch(input, init),
  url: routeApiUrl,
};

/** Settings and pickers bind their requests to a backend, not the active chat. */
export function BackendScopeProvider({ host, children }: { host: BackendId; children: ReactNode }) {
  return <BackendContext.Provider value={host}>{children}</BackendContext.Provider>;
}

export function useBackendApi(): BackendApi {
  const host = useContext(BackendContext);
  return useMemo(() => host === undefined
    ? workspaceApi
    : createBackendApi(host, localFetch, () => window.location.origin), [host]);
}
