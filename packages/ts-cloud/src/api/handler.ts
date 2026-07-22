import type { ApiTokenPrincipal, AutomationIdentityStore } from '../automation'
import type { ControlPlaneStore } from '../control-plane'
import type { SourceConnectionStore } from '../source'
import type { ApiDeploymentRequest, ApiErrorEnvelope, ApiPage } from './types'
import { listSourceReferences, reconcileSourceWebhook, syncSourceRepositories, webhookEndpoint } from '../source'
import { AutomationApiService, ApiServiceError } from './service'
import { API_VERSION, openApiDocument } from './openapi'

interface ApiV1HandlerOptions {
  controlPlane: ControlPlaneStore
  identities: AutomationIdentityStore
  sources?: SourceConnectionStore
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
      const readBody = async (): Promise<Record<string, any>> => {
        const text = await request.text()
        if (text.length > 1024 * 1024) throw new ApiServiceError('payload_too_large', 'Request body exceeds 1 MB.', 413)
        try { return JSON.parse(text) as Record<string, any> }
        catch { throw new ApiServiceError('invalid_json', 'Request body must be valid JSON.', 400) }
      }
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
      else if (request.method === 'GET' && url.pathname === '/api/v1/source/connections') {
        if (!options.sources) throw new ApiServiceError('not_found', 'Source integrations are unavailable.', 404)
        service.authorize(principal, 'sources:read', principal.token.scope)
        body = page(options.sources.listConnections(principal.serviceAccount.organizationId) as unknown as Array<Record<string, unknown>>, url, requestId, ['createdAt', 'id'])
      }
      else if (request.method === 'GET' && url.pathname === '/api/v1/source/repositories') {
        if (!options.sources) throw new ApiServiceError('not_found', 'Source integrations are unavailable.', 404)
        service.authorize(principal, 'sources:read', principal.token.scope)
        const connection = options.sources.getConnection(url.searchParams.get('connectionId') ?? '')
        if (!connection || connection.organizationId !== principal.serviceAccount.organizationId) throw new ApiServiceError('not_found', 'Source connection was not found.', 404)
        if (url.searchParams.get('sync') === 'true') {
          service.authorize(principal, 'sources:manage', { type: 'organization' })
          await syncSourceRepositories(options.sources, connection.id, { search: url.searchParams.get('search') ?? undefined })
        }
        body = page(options.sources.listRepositories(connection.id, url.searchParams.get('search') ?? undefined) as unknown as Array<Record<string, unknown>>, url, requestId, ['fullName', 'id'])
      }
      else if (request.method === 'GET' && url.pathname === '/api/v1/source/refs') {
        if (!options.sources) throw new ApiServiceError('not_found', 'Source integrations are unavailable.', 404)
        service.authorize(principal, 'sources:read', principal.token.scope)
        const connectionId = url.searchParams.get('connectionId') ?? ''
        const connection = options.sources.getConnection(connectionId)
        if (!connection || connection.organizationId !== principal.serviceAccount.organizationId) throw new ApiServiceError('not_found', 'Source connection was not found.', 404)
        body = await listSourceReferences(options.sources, { connectionId, repository: url.searchParams.get('repository') ?? '', repositoryId: url.searchParams.get('repositoryId') ?? undefined, type: url.searchParams.get('type') === 'tags' ? 'tags' : 'branches', cursor: url.searchParams.get('cursor') ?? undefined, deployKeyId: url.searchParams.get('deployKeyId') ?? undefined })
      }
      else if (request.method === 'POST' && url.pathname === '/api/v1/source/connections') {
        if (!options.sources) throw new ApiServiceError('not_found', 'Source integrations are unavailable.', 404)
        service.authorize(principal, 'sources:manage', { type: 'organization' })
        const input = await readBody()
        const provider = String(input.provider ?? '')
        if (!['github', 'gitlab', 'bitbucket', 'gitea', 'generic_https', 'generic_ssh'].includes(provider)) throw new ApiServiceError('validation_error', 'A supported provider is required.', 422)
        const credential = provider === 'github' && (input.privateKey || input.appId)
          ? { appId: typeof input.appId === 'string' ? input.appId : undefined, installationId: typeof input.installationId === 'string' ? input.installationId : undefined, privateKey: typeof input.privateKey === 'string' ? input.privateKey : undefined }
          : provider !== 'generic_ssh' && input.token ? { token: String(input.token), username: typeof input.username === 'string' ? input.username : undefined } : undefined
        let connection!: ReturnType<SourceConnectionStore['createConnection']>
        let repository: ReturnType<SourceConnectionStore['upsertRepository']> | undefined
        let deployKey: ReturnType<SourceConnectionStore['createDeployKey']> | undefined
        options.controlPlane.database.transaction(() => {
          connection = options.sources!.createConnection({ organizationId: principal.serviceAccount.organizationId, provider: provider as any, name: String(input.name ?? provider), host: String(input.host ?? ''), owner: typeof input.owner === 'string' ? input.owner : undefined, authKind: input.authKind, credential, createdByActorId: principal.actor.id })
          if (typeof input.repositoryUrl === 'string' && typeof input.repositoryFullName === 'string') repository = options.sources!.upsertRepository({ connectionId: connection.id, providerRepositoryId: `manual:${input.repositoryFullName}`, fullName: input.repositoryFullName, cloneUrl: input.repositoryUrl, defaultBranch: String(input.defaultBranch ?? 'main'), visibility: 'unknown', archived: false, metadata: { source: 'api' } })
          if (provider === 'generic_ssh') deployKey = options.sources!.createDeployKey({ connectionId: connection.id, name: String(input.deployKeyName ?? 'Repository deploy key'), publicKey: String(input.publicKey ?? ''), privateKey: String(input.deployPrivateKey ?? ''), host: String(input.sshHost ?? ''), hostKey: String(input.hostKey ?? ''), actorId: principal.actor.id })
        })()
        return response({ connection, repository, deployKey, requestId }, 201, requestId, rateHeaders)
      }
      else if (request.method === 'POST' && url.pathname === '/api/v1/source/bindings') {
        if (!options.sources) throw new ApiServiceError('not_found', 'Source integrations are unavailable.', 404)
        const input = await readBody()
        const projectId = String(input.projectId ?? '')
        service.authorize(principal, 'sources:manage', { type: 'project', id: projectId })
        const connection = options.sources.getConnection(String(input.connectionId ?? ''))
        if (!connection || connection.organizationId !== principal.serviceAccount.organizationId) throw new ApiServiceError('not_found', 'Source connection was not found.', 404)
        const binding = options.sources.createBinding({ projectId, environmentId: typeof input.environmentId === 'string' ? input.environmentId : undefined, resourceId: typeof input.resourceId === 'string' ? input.resourceId : undefined, connectionId: connection.id, repositoryId: typeof input.repositoryId === 'string' ? input.repositoryId : undefined, repositoryFullName: String(input.repositoryFullName ?? ''), defaultBranch: String(input.defaultBranch ?? 'main'), branchRule: typeof input.branchRule === 'string' ? input.branchRule : undefined, tagRule: typeof input.tagRule === 'string' ? input.tagRule : undefined, monorepoRoot: String(input.monorepoRoot ?? '.'), includePaths: Array.isArray(input.includePaths) ? input.includePaths.map(String) : [], excludePaths: Array.isArray(input.excludePaths) ? input.excludePaths.map(String) : [], submodules: input.submodules === true, cloneDepth: typeof input.cloneDepth === 'number' ? input.cloneDepth : undefined, deployKeyId: typeof input.deployKeyId === 'string' && input.deployKeyId ? input.deployKeyId : undefined, autoDeploy: input.autoDeploy !== false, pullRequestPreviews: input.pullRequestPreviews !== false, actorId: principal.actor.id })
        return response({ binding, requestId }, 201, requestId, rateHeaders)
      }
      else if (request.method === 'POST' && url.pathname === '/api/v1/source/webhooks') {
        if (!options.sources) throw new ApiServiceError('not_found', 'Source integrations are unavailable.', 404)
        service.authorize(principal, 'sources:manage', { type: 'organization' })
        const input = await readBody()
        const connection = options.sources.getConnection(String(input.connectionId ?? ''))
        if (!connection || connection.organizationId !== principal.serviceAccount.organizationId) throw new ApiServiceError('not_found', 'Source connection was not found.', 404)
        const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl : undefined
        if (!baseUrl) throw new ApiServiceError('validation_error', 'baseUrl is required.', 422)
        const created = options.sources.createWebhook({ connectionId: connection.id, repositoryId: typeof input.repositoryId === 'string' ? input.repositoryId : undefined, repositoryFullName: String(input.repositoryFullName ?? ''), events: Array.isArray(input.events) ? input.events.map(String) : undefined })
        const endpoint = webhookEndpoint(baseUrl, created.webhook)
        const webhook = input.reconcile === false ? created.webhook : await reconcileSourceWebhook(options.sources, created.webhook.id, baseUrl)
        return response({ webhook, endpoint, endpointRevealOnce: true, requestId }, 201, requestId, rateHeaders)
      }
      else if (request.method === 'DELETE' && url.pathname === '/api/v1/source/connections') {
        if (!options.sources) throw new ApiServiceError('not_found', 'Source integrations are unavailable.', 404)
        service.authorize(principal, 'sources:manage', { type: 'organization' })
        const input = await readBody()
        const connection = options.sources.getConnection(String(input.id ?? ''))
        if (!connection || connection.organizationId !== principal.serviceAccount.organizationId) throw new ApiServiceError('not_found', 'Source connection was not found.', 404)
        const affectedBindings = options.sources.listBindings({ connectionId: connection.id, status: 'active' })
        if (input.preview === true) return response({ preview: true, affectedBindings, requestId }, 200, requestId, rateHeaders)
        return response({ ...options.sources.disconnectConnection(connection.id, principal.actor.id), requestId }, 200, requestId, rateHeaders)
      }
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
      if (url.pathname.startsWith('/api/v1/source/'))
        return failure('validation_error', error instanceof Error ? error.message : 'Source request could not be completed.', 422, requestId, undefined, rateHeaders)
      return failure('internal_error', 'The API request could not be completed.', 500, requestId, undefined, rateHeaders)
    }
  }
}
