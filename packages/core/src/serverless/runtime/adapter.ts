/**
 * Serverless runtime adapter (Node/Bun).
 *
 * This module is **bundled into the Lambda deployment artifact** and runs inside
 * the AWS Lambda Node.js runtime, so it must rely only on globals available
 * there: `Request`, `Response`, `Headers`, `URL`, `Buffer`, `atob`/`btoa`.
 * It contains no AWS SDK calls and no Node-only filesystem access.
 *
 * It translates the three event sources of a Vapor-style serverless app into
 * plain, framework-agnostic callbacks:
 *   - HTTP  : API Gateway v2 (payload format 2.0) ⇄ WHATWG `Request`/`Response`
 *   - Queue : SQS records → per-message job handler with partial-batch failures
 *   - CLI   : `{ command, args }` → command handler (scheduler / migrations)
 */

// ── Event/response shapes (minimal subsets of the AWS types) ────────────────

export interface ApiGatewayProxyEventV2 {
  version: '2.0'
  rawPath: string
  rawQueryString?: string
  cookies?: string[]
  headers?: Record<string, string | undefined>
  body?: string
  isBase64Encoded?: boolean
  requestContext: {
    domainName?: string
    http: {
      method: string
      path: string
      protocol?: string
      sourceIp?: string
      userAgent?: string
    }
  }
}

export interface ApiGatewayProxyResultV2 {
  statusCode: number
  headers?: Record<string, string>
  cookies?: string[]
  body?: string
  isBase64Encoded?: boolean
}

export interface SqsRecord {
  messageId: string
  receiptHandle?: string
  body: string
  attributes?: Record<string, string>
  messageAttributes?: Record<string, unknown>
  eventSourceARN?: string
}

export interface SqsEvent {
  Records: SqsRecord[]
}

export interface SqsBatchResponse {
  batchItemFailures: Array<{ itemIdentifier: string }>
}

export interface CliEvent {
  command: string
  args?: string[]
}

export interface CliResult {
  statusCode: number
  output: string
}

// ── Handler callback contracts ──────────────────────────────────────────────

export type FetchHandler = (request: Request) => Response | Promise<Response>
export type JobHandler = (payload: unknown, record: SqsRecord) => unknown | Promise<unknown>
export type CommandHandler = (event: CliEvent) => CliResult | Promise<CliResult>

/** Lambda handler invoked by API Gateway v2. */
export type LambdaHttpHandler = (event: ApiGatewayProxyEventV2) => Promise<ApiGatewayProxyResultV2>
/** Lambda handler invoked by an SQS event source mapping. */
export type LambdaQueueHandler = (event: SqsEvent) => Promise<SqsBatchResponse>
/** Lambda handler invoked by EventBridge / on-demand for CLI commands. */
export type LambdaCliHandler = (event: CliEvent) => Promise<CliResult>

export interface ServerlessApp {
  fetch?: FetchHandler
  queue?: JobHandler
  cli?: CommandHandler
}

/**
 * Normalize whatever the user's entry module exports into a {@link ServerlessApp}.
 * Accepts a bare fetch function, an object with `fetch`/`queue`/`cli`, or a
 * Bun.serve-style `{ default: { fetch } }`.
 */
export function resolveApp(mod: unknown): ServerlessApp {
  const m = mod as Record<string, unknown>
  const def = (m?.default ?? m) as Record<string, unknown>
  if (typeof def === 'function') return { fetch: def as FetchHandler }
  return {
    fetch: (def?.fetch ?? m?.fetch) as FetchHandler | undefined,
    queue: (def?.queue ?? m?.queue) as JobHandler | undefined,
    cli: (def?.cli ?? m?.cli) as CommandHandler | undefined,
  }
}

// ── Body / content helpers ──────────────────────────────────────────────────

const TEXT_CONTENT = /^(?:text\/|application\/(?:json|xml|javascript|graphql|x-www-form-urlencoded|.*\+json|.*\+xml)|image\/svg)/i

function isTextContentType(contentType: string | null): boolean {
  // No declared type → treat as text (the common case for `new Response(str)`).
  // Binary payloads in practice always carry an explicit content-type.
  if (!contentType) return true
  return TEXT_CONTENT.test(contentType)
}

// ── HTTP ────────────────────────────────────────────────────────────────────

export interface HttpAdapterOptions {
  /**
   * Read maintenance state from the environment. When `MAINTENANCE_MODE` is
   * truthy, requests get a 503 unless they carry the bypass secret in the
   * `x-maintenance-bypass` header or a `tscloud_bypass` cookie.
   */
  maintenance?: {
    enabled: boolean
    bypassSecret?: string
  }
}

function readMaintenance(opts?: HttpAdapterOptions): { enabled: boolean, bypassSecret?: string } {
  if (opts?.maintenance) return opts.maintenance
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  return {
    enabled: env.MAINTENANCE_MODE === '1' || env.MAINTENANCE_MODE === 'true',
    bypassSecret: env.MAINTENANCE_BYPASS_SECRET,
  }
}

/** Translate an API Gateway v2 event into a WHATWG `Request`. */
export function eventToRequest(event: ApiGatewayProxyEventV2): Request {
  const host = event.requestContext?.domainName ?? 'localhost'
  const query = event.rawQueryString ? `?${event.rawQueryString}` : ''
  const url = `https://${host}${event.rawPath || '/'}${query}`

  const headers = new Headers()
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(key, value)
  }
  if (event.cookies?.length) headers.set('cookie', event.cookies.join('; '))

  const method = event.requestContext.http.method
  let body: Uint8Array | undefined
  if (event.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    body = event.isBase64Encoded
      ? new Uint8Array(Buffer.from(event.body, 'base64'))
      : new TextEncoder().encode(event.body)
  }

  return new Request(url, { method, headers, body })
}

/** Serialize a WHATWG `Response` into an API Gateway v2 result. */
export async function responseToResult(response: Response): Promise<ApiGatewayProxyResultV2> {
  const headers: Record<string, string> = {}
  const cookies: string[] = []

  // `getSetCookie` is available in the Lambda runtime's undici Headers.
  const setCookies = typeof (response.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
    ? (response.headers as { getSetCookie: () => string[] }).getSetCookie()
    : []
  for (const c of setCookies) cookies.push(c)

  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return
    headers[key] = value
  })

  const buffer = Buffer.from(await response.arrayBuffer())
  const textual = isTextContentType(response.headers.get('content-type'))

  return {
    statusCode: response.status,
    headers,
    ...(cookies.length ? { cookies } : {}),
    body: textual ? buffer.toString('utf-8') : buffer.toString('base64'),
    isBase64Encoded: !textual,
  }
}

/**
 * Wrap a fetch-style handler into a Lambda HTTP handler for API Gateway v2.
 * Honors maintenance mode (503 + bypass) before invoking the app.
 */
export function createHttpHandler(handler: FetchHandler | undefined, opts?: HttpAdapterOptions): LambdaHttpHandler {
  return async (event: ApiGatewayProxyEventV2): Promise<ApiGatewayProxyResultV2> => {
    // Warmer pings (from the scheduled keep-warm rule) just keep the container
    // alive — short-circuit before treating the event as an HTTP request.
    if ((event as unknown as { warmer?: boolean }).warmer) {
      return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'warm', isBase64Encoded: false }
    }

    if (!handler) {
      return { statusCode: 501, headers: { 'content-type': 'text/plain' }, body: 'No HTTP handler configured', isBase64Encoded: false }
    }

    const maintenance = readMaintenance(opts)
    if (maintenance.enabled) {
      const bypass = event.headers?.['x-maintenance-bypass']
        ?? (event.cookies?.find(c => c.startsWith('tscloud_bypass='))?.split('=')[1])
      if (!maintenance.bypassSecret || bypass !== maintenance.bypassSecret) {
        return {
          statusCode: 503,
          headers: { 'content-type': 'text/plain', 'retry-after': '120' },
          body: 'Service temporarily unavailable (maintenance mode)',
          isBase64Encoded: false,
        }
      }
    }

    const request = eventToRequest(event)
    const response = await handler(request)
    return responseToResult(response)
  }
}

// ── Queue ─────────────────────────────────────────────────────────────────--

function parseRecordBody(body: string): unknown {
  try {
    return JSON.parse(body)
  }
  catch {
    return body
  }
}

/**
 * Wrap a job handler into a Lambda SQS handler. Each record is processed
 * individually; failures are reported via `batchItemFailures` so only failed
 * messages are retried (requires `ReportBatchItemFailures` on the mapping).
 */
export function createQueueHandler(handler: JobHandler | undefined): LambdaQueueHandler {
  return async (event: SqsEvent): Promise<SqsBatchResponse> => {
    const batchItemFailures: Array<{ itemIdentifier: string }> = []
    // Warmer pings invoke the function directly (no SQS Records) — keep the
    // container warm without treating the ping as a job.
    if ((event as unknown as { warmer?: boolean }).warmer) return { batchItemFailures }
    if (!handler) return { batchItemFailures }

    for (const record of event.Records ?? []) {
      try {
        await handler(parseRecordBody(record.body), record)
      }
      catch {
        batchItemFailures.push({ itemIdentifier: record.messageId })
      }
    }
    return { batchItemFailures }
  }
}

// ── CLI / scheduler ─────────────────────────────────────────────────────────

/**
 * Wrap a command handler into a Lambda CLI handler. Used by the EventBridge
 * scheduler (`{ command: 'schedule:run' }`) and on-demand invocations
 * (deploy hooks, migrations, `cloud command`).
 */
export function createCliHandler(handler: CommandHandler | undefined): LambdaCliHandler {
  return async (event: CliEvent): Promise<CliResult> => {
    // Warmer pings keep the container warm without running a command.
    if ((event as unknown as { warmer?: boolean }).warmer) return { statusCode: 0, output: 'warm' }
    if (!handler) return { statusCode: 501, output: 'No CLI handler configured' }
    return handler(event)
  }
}

/** Convenience: build all three Lambda handlers from a resolved app. */
export function createHandlers(app: ServerlessApp, opts?: HttpAdapterOptions): {
  http: LambdaHttpHandler
  queue: LambdaQueueHandler
  cli: LambdaCliHandler
} {
  return {
    http: createHttpHandler(app.fetch, opts),
    queue: createQueueHandler(app.queue),
    cli: createCliHandler(app.cli),
  }
}
