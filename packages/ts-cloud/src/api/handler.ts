import type { ApiTokenPrincipal, AutomationIdentityStore } from '../automation'
import type { ControlPlaneStore } from '../control-plane'
import type { ApiDeploymentRequest, ApiErrorEnvelope, ApiPage } from './types'
import { AutomationApiService, ApiServiceError } from './service'
import { API_VERSION, openApiDocument } from './openapi'

interface ApiV1HandlerOptions {
  controlPlane: ControlPlaneStore
  identities: AutomationIdentityStore
  now?: () => Date
  rateLimit?: number
}

function cursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function readCursor(value: string | null): Record<string, unknown> | undefined {
  if (!value)
    return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  }
  catch { return undefined }
}

function page<T extends Record<string, unknown>>(items: T[], url: URL, requestId: string, keys: string[] = ['createdAt', 'id']): ApiPage<T> {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50))
  const decoded = readCursor(url.searchParams.get('cursor'))
  if (url.searchParams.has('cursor') && !decoded)
    throw new ApiServiceError('invalid_cursor', 'The pagination cursor is invalid.', 400)
  let start = 0
  if (decoded) {
    const found = items.findIndex(item => keys.every(key => item[key] === decoded[key]))
    if (found < 0)
      throw new ApiServiceError('invalid_cursor', 'The pagination cursor is no longer available.', 400)
    start = found + 1
  }
  const data = items.slice(start, start + limit)
  const hasMore = start + limit < items.length
  const last = data.at(-1)
  return { data, page: { hasMore, nextCursor: hasMore && last ? cursor(Object.fromEntries(keys.map(key => [key, last[key]]))) : undefined }, requestId }
}

export function createApiV1Handler(options: ApiV1HandlerOptions): (request: Request, networkHint?: string) => Promise<Response | undefined> {
  const service = new AutomationApiService(options.controlPlane, options.identities)
  const windows = new Map<string, { start: number, count: number }>()
  const now = options.now ?? (() => new Date())
  const limit = options.rateLimit ?? 120

  const response = (body: unknown, status: number, requestId: string, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': requestId, 'x-api-version': API_VERSION, ...extra },
  })
  const failure = (code: string, message: string, status: number, requestId: string, details?: ApiErrorEnvelope['error']['details'], headers?: Record<string, string>) => response({ error: { code, message, requestId, details } } satisfies ApiErrorEnvelope, status, requestId, headers)

  return async (request: Request, networkHint?: string): Promise<Response | undefined> => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/v1'))
      return undefined
    const requestId = crypto.randomUUID()
    if (url.pathname === '/api/v1/openapi.json' && request.method === 'GET')
      return response(openApiDocument(), 200, requestId, { 'cache-control': 'public, max-age=300' })
    const authorization = request.headers.get('authorization') ?? ''
    const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
    const principal = bearerToken ? options.identities.verifyToken(bearerToken, networkHint) : undefined
    if (!principal)
      return failure('unauthorized', 'A valid bearer token is required.', 401, requestId, undefined, { 'www-authenticate': 'Bearer realm="ts-cloud", error="invalid_token"' })
    const window = windows.get(principal.token.id)
    const timestamp = now().getTime()
    const current = !window || timestamp - window.start >= 60_000 ? { start: timestamp, count: 0 } : window
    current.count += 1
    windows.set(principal.token.id, current)
    const remaining = Math.max(0, limit - current.count)
    const rateHeaders = { 'x-ratelimit-limit': String(limit), 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': String(Math.ceil((current.start + 60_000) / 1000)) }
    if (current.count > limit)
      return failure('rate_limited', 'API rate limit exceeded.', 429, requestId, undefined, { ...rateHeaders, 'retry-after': String(Math.max(1, Math.ceil((current.start + 60_000 - timestamp) / 1000))) })

    try {
      let body: unknown
      const projectEnvironments = /^\/api\/v1\/projects\/([^/]+)\/environments$/.exec(url.pathname)
      if (request.method === 'GET' && url.pathname === '/api/v1/projects')
        body = page(service.listProjects(principal), url, requestId)
      else if (request.method === 'GET' && projectEnvironments)
        body = page(service.listEnvironments(principal, decodeURIComponent(projectEnvironments[1])), url, requestId)
      else if (request.method === 'GET' && url.pathname === '/api/v1/services') {
        const projectId = url.searchParams.get('projectId')
        if (!projectId)
          throw new ApiServiceError('validation_error', 'projectId is required.', 422)
        body = page(service.listServices(principal, projectId, url.searchParams.get('environmentId') ?? undefined), url, requestId)
      }
      else if (request.method === 'GET' && url.pathname === '/api/v1/operations')
        body = page(service.listOperations(principal, url.searchParams.get('projectId') ?? undefined), url, requestId)
      else if (request.method === 'GET' && (url.pathname === '/api/v1/events' || url.pathname === '/api/v1/events/stream')) {
        const events = service.listEvents(principal, url.searchParams.get('projectId') ?? undefined, Number(url.searchParams.get('after')) || undefined)
        if (url.pathname.endsWith('/stream')) {
          const encoder = new TextEncoder()
          let after = events.reduce((last, event) => Math.max(last, Number(event.sequence)), Number(url.searchParams.get('after')) || 0)
          let timer: ReturnType<typeof setInterval> | undefined
          let closed = false
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const send = (event: Record<string, unknown>) => controller.enqueue(encoder.encode(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
              if (events.length) events.forEach(send)
              else controller.enqueue(encoder.encode(': connected\n\n'))
              timer = setInterval(() => {
                if (closed)
                  return
                const currentPrincipal = options.identities.verifyToken(bearerToken, networkHint)
                if (!currentPrincipal) {
                  closed = true
                  if (timer) clearInterval(timer)
                  controller.close()
                  return
                }
                try {
                  const next = service.listEvents(currentPrincipal, url.searchParams.get('projectId') ?? undefined, after)
                  for (const event of next) {
                    send(event)
                    after = Math.max(after, Number(event.sequence))
                  }
                  if (!next.length)
                    controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`))
                }
                catch {
                  closed = true
                  if (timer) clearInterval(timer)
                  controller.close()
                }
              }, 1_000)
              request.signal.addEventListener('abort', () => {
                closed = true
                if (timer) clearInterval(timer)
                try { controller.close() } catch { /* already closed */ }
              }, { once: true })
            },
            cancel() {
              closed = true
              if (timer) clearInterval(timer)
            },
          })
          return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'connection': 'keep-alive', 'x-accel-buffering': 'no', 'x-request-id': requestId, ...rateHeaders } })
        }
        body = page(events, url, requestId, ['sequence', 'id'])
      }
      else if (request.method === 'POST' && url.pathname === '/api/v1/deployments') {
        const idempotencyKey = request.headers.get('idempotency-key') ?? ''
        if (!idempotencyKey)
          throw new ApiServiceError('idempotency_required', 'Idempotency-Key is required for deployment requests.', 428)
        const text = await request.text()
        if (text.length > 1024 * 1024)
          throw new ApiServiceError('payload_too_large', 'Request body exceeds 1 MB.', 413)
        let deployment: ApiDeploymentRequest
        try { deployment = JSON.parse(text) as ApiDeploymentRequest }
        catch { throw new ApiServiceError('invalid_json', 'Request body must be valid JSON.', 400) }
        if (!deployment || typeof deployment.projectId !== 'string' || typeof deployment.environmentId !== 'string' || (deployment.action !== undefined && !['deploy', 'rollback'].includes(deployment.action)))
          throw new ApiServiceError('validation_error', 'projectId, environmentId, and a valid action are required.', 422)
        const created = service.createDeployment(principal, deployment, idempotencyKey)
        return response({ operation: created.operation, idempotentReplay: created.replay, requestId }, 202, requestId, { ...rateHeaders, ...(created.replay ? { 'idempotent-replayed': 'true' } : {}) })
      }
      else {
        throw new ApiServiceError('not_found', 'API resource was not found.', 404)
      }
      return response(body, 200, requestId, rateHeaders)
    }
    catch (error) {
      if (error instanceof ApiServiceError)
        return failure(error.code, error.message, error.status, requestId, error.details as ApiErrorEnvelope['error']['details'], rateHeaders)
      return failure('internal_error', 'The API request could not be completed.', 500, requestId, undefined, rateHeaders)
    }
  }
}
