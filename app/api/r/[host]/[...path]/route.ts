import { proxyToHost } from "@/lib/remote/proxy";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ host: string; path: string[] }> };

// /api/r/<host>/<rest> → the remote pi-web's /api/<rest> through its SSH
// tunnel. Lives under /api so proxy.ts fences it like every other route.
async function handle(req: Request, { params }: Context): Promise<Response> {
  const { host } = await params;
  return proxyToHost(req, host);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
