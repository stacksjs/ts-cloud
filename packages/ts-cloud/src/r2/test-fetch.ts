/**
 * A routed fake `fetch` for the R2 tests: no network, every request recorded.
 *
 * Routes are keyed `METHOD /path` with the path below `/client/v4` and the
 * query string dropped. A handler returns the `result` (wrapped in Cloudflare's
 * success envelope), or a {@link CloudflareFailure} for an error envelope. An
 * unrouted request fails the test loudly instead of silently answering.
 */

export interface RecordedRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: Record<string, string>
  body: any
}

export class CloudflareFailure {
  constructor(
    readonly status: number,
    readonly errors: Array<{ code: number, message: string }>,
  ) {}
}

export type RouteHandler = (request: RecordedRequest) => unknown

export function fakeCloudflare(routes: Record<string, RouteHandler | unknown>): {
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  calls: RecordedRequest[]
  writes: () => RecordedRequest[]
} {
  const calls: RecordedRequest[] = []

  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input)
    const path = url.pathname.replace(/^\/client\/v4/, '')
    const method = (init.method || 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init.headers as Record<string, string>) || {}))
      headers[key.toLowerCase()] = value
    const request: RecordedRequest = {
      method,
      path,
      query: url.searchParams,
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    }
    calls.push(request)

    const key = `${method} ${path}`
    if (!(key in routes))
      throw new Error(`unexpected request: ${key}`)

    const route = routes[key]
    const result = typeof route === 'function' ? (route as RouteHandler)(request) : route
    if (result instanceof CloudflareFailure) {
      return new Response(JSON.stringify({ success: false, errors: result.errors, messages: [], result: null }), {
        status: result.status,
      })
    }
    return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: result ?? null }), {
      status: 200,
    })
  }

  return { fetch, calls, writes: () => calls.filter(call => call.method !== 'GET') }
}
