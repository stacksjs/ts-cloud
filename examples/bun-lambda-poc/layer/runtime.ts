/**
 * Bun custom runtime for AWS Lambda (`provided.al2023`).
 *
 * Adapted from oven-sh/bun's `bun-lambda` package. It runs the AWS Lambda
 * Runtime API event loop inside Bun and adapts each invocation to a Web
 * `fetch(request) => Response` handler — the same shape as `Bun.serve` and the
 * Stacks HTTP server, so one handler runs locally and on Lambda unchanged.
 *
 * Handles API Gateway HTTP API / Lambda Function URL payload format 2.0.
 *
 * Lives at `/opt/runtime.ts` in the layer; `bootstrap` execs `bun /opt/runtime.ts`.
 */

const RUNTIME_API = process.env.AWS_LAMBDA_RUNTIME_API
if (!RUNTIME_API) {
  throw new Error('AWS_LAMBDA_RUNTIME_API is not set — runtime.ts must run inside Lambda')
}

const BASE = `http://${RUNTIME_API}/2018-06-01/runtime`
const TASK_ROOT = process.env.LAMBDA_TASK_ROOT ?? '/var/task'
const HANDLER = process.env._HANDLER ?? 'index.fetch'

type FetchHandler = (request: Request) => Response | Promise<Response>

/**
 * Resolve the handler from the `_HANDLER` config string (e.g. "index.fetch"):
 * import the module file and pull out the fetch function, supporting both
 * `export default { fetch }` and `export const fetch`.
 */
async function resolveHandler(): Promise<FetchHandler> {
  const lastDot = HANDLER.lastIndexOf('.')
  const file = lastDot === -1 ? HANDLER : HANDLER.slice(0, lastDot)
  const exportName = lastDot === -1 ? 'default' : HANDLER.slice(lastDot + 1)

  let mod: Record<string, any> | undefined
  for (const ext of ['.ts', '.js', '.mjs', '']) {
    try {
      mod = await import(`${TASK_ROOT}/${file}${ext}`)
      break
    } catch {
      // try the next extension
    }
  }
  if (!mod) throw new Error(`Cannot load handler module "${file}" from ${TASK_ROOT}`)

  const candidate = mod[exportName] ?? mod.default?.[exportName] ?? mod.default
  const fn = typeof candidate === 'function' ? candidate : candidate?.fetch
  if (typeof fn !== 'function') throw new TypeError(`Handler "${HANDLER}" did not resolve to a fetch function`)

  return fn as FetchHandler
}

/** API Gateway v2 / Function URL event -> Web Request. */
function eventToRequest(event: any): Request {
  const ctx = event.requestContext ?? {}
  const http = ctx.http ?? {}
  const method: string = http.method ?? event.httpMethod ?? 'GET'
  const host: string = event.headers?.host ?? event.headers?.Host ?? ctx.domainName ?? 'localhost'
  const path: string = event.rawPath ?? event.path ?? '/'
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : ''
  const url = `https://${host}${path}${qs}`

  const headers = new Headers()
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (typeof v === 'string') headers.set(k, v)
  }
  if (Array.isArray(event.cookies) && event.cookies.length > 0) headers.set('cookie', event.cookies.join('; '))

  let body: string | Uint8Array | undefined
  if (event.body != null && method !== 'GET' && method !== 'HEAD')
    body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body

  return new Request(url, { method, headers, body })
}

// Content types that are safe to return as UTF-8 text; everything else is base64.
const TEXT_TYPES = /^(?:text\/|application\/(?:json|javascript|xml|.*\+json|.*\+xml)|image\/svg)/i

/** Web Response -> API Gateway v2 / Function URL payload format 2.0 result. */
async function responseToResult(response: Response): Promise<any> {
  const headers: Record<string, string> = {}
  const cookies: string[] = []
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') cookies.push(value)
    else headers[key] = value
  })

  const isText = TEXT_TYPES.test(response.headers.get('content-type') ?? '')
  let body: string
  let isBase64Encoded = false
  if (isText) {
    body = await response.text()
  } else {
    body = Buffer.from(await response.arrayBuffer()).toString('base64')
    isBase64Encoded = true
  }

  return {
    statusCode: response.status,
    headers,
    ...(cookies.length > 0 ? { cookies } : {}),
    body,
    isBase64Encoded,
  }
}

async function postJson(path: string, payload: unknown): Promise<void> {
  await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

async function main(): Promise<void> {
  let handler: FetchHandler
  try {
    handler = await resolveHandler()
  } catch (err: any) {
    await postJson('/init/error', {
      errorType: 'Runtime.InitError',
      errorMessage: String(err?.message ?? err),
    })
    throw err
  }

  // Long-poll the Runtime API forever; Lambda freezes the process between events.
  while (true) {
    const next = await fetch(`${BASE}/invocation/next`)
    const requestId = next.headers.get('lambda-runtime-aws-request-id')
    if (!requestId) {
      // No request id means a malformed/empty poll; back off and retry.
      continue
    }

    try {
      const event = await next.json()
      const response = await handler(eventToRequest(event))
      await postJson(`/invocation/${requestId}/response`, await responseToResult(response))
    } catch (err: any) {
      await postJson(`/invocation/${requestId}/error`, {
        errorType: err?.name ?? 'Error',
        errorMessage: String(err?.message ?? err),
        stackTrace: typeof err?.stack === 'string' ? err.stack.split('\n') : [],
      })
    }
  }
}

main()
