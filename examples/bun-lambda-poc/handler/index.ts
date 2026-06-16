/**
 * PoC API handler — a plain `Bun.serve`-style fetch function.
 *
 * This is the exact shape of the Stacks HTTP server (`{ fetch(request) }`), so
 * the production swap later is simply "point `fetch` at the Stacks router".
 * The bun-lambda runtime layer adapts each Lambda invocation into the `Request`
 * passed here and serializes the returned `Response` back to API Gateway /
 * Function URL payload format 2.0.
 */
export default {
  async fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url)

    // Health check / root — what the issue's acceptance step curls.
    if (pathname === '/' || pathname.endsWith('/health')) {
      return Response.json({
        ok: true,
        message: 'hello from bun on lambda',
        runtime: `bun ${Bun.version}`,
        method: req.method,
        path: pathname,
        ts: new Date().toISOString(),
      })
    }

    return Response.json({ ok: false, error: 'not found', path: pathname }, { status: 404 })
  },
}
