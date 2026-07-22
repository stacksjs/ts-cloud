import type { ApiTokenPrincipal, AutomationIdentityStore } from '../automation'
import type { ControlPlaneStore } from '../control-plane'
import type { SourceConnectionStore } from '../source'
import type { ApplicationArtifactStore, ApplicationDraftStore, RegistryConnectionStore } from '../onboarding'
import type { ApiDeploymentRequest, ApiErrorEnvelope, ApiPage } from './types'
import { createHash } from 'node:crypto'
import { listSourceReferences, reconcileSourceWebhook, syncSourceRepositories, webhookEndpoint } from '../source'
import { applyApplicationDraft, detectApplication, planApplication } from '../onboarding'
import { DurableOperationQueue } from '../queue'
import { PreviewEnvironmentService } from '../preview'
import { ComposeApplicationService, listComposeTemplates } from '../compose'
import { AutomationApiService, ApiServiceError } from './service'
import { API_VERSION, openApiDocument } from './openapi'

interface ApiV1HandlerOptions {
  controlPlane: ControlPlaneStore
  identities: AutomationIdentityStore
  sources?: SourceConnectionStore
  applications?: { drafts: ApplicationDraftStore, artifacts?: ApplicationArtifactStore, registries: RegistryConnectionStore }
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
  const queue = new DurableOperationQueue(options.controlPlane)
  const previews = new PreviewEnvironmentService(options.controlPlane)
  const compose = new ComposeApplicationService(options.controlPlane)
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
      const operationLogs = /^\/api\/v1\/operations\/([^/]+)\/logs(?:\/(stream))?$/.exec(url.pathname)
      const operationAction = /^\/api\/v1\/operations\/([^/]+)\/(cancel|retry)$/.exec(url.pathname)
      const previewAction = /^\/api\/v1\/previews\/([^/]+)\/(destroy|extend|rebuild)$/.exec(url.pathname)
      const composeAction = /^\/api\/v1\/compose-applications\/([^/]+)\/(deploy|redeploy|start|stop|scale|delete)$/.exec(url.pathname)
      const composeServices = /^\/api\/v1\/compose-applications\/([^/]+)\/services$/.exec(url.pathname)
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
      else if (request.method === 'GET' && url.pathname === '/api/v1/previews') {
        const projectId = url.searchParams.get('projectId') ?? undefined
        const values = previews.previews.listInstances({ projectId }).filter((preview) => { try { service.authorize(principal, 'deployments:read', { type: 'resource', id: preview.resourceId }); return true } catch { return false } }).map(preview => ({ ...preview } as Record<string, unknown>))
        body = page(values, url, requestId)
      }
      else if (request.method === 'GET' && url.pathname === '/api/v1/compose-templates') body = page(listComposeTemplates().map(value => ({ ...value } as Record<string, unknown>)), url, requestId, ['id', 'version'])
      else if (request.method === 'GET' && url.pathname === '/api/v1/compose-applications') {
        const projectId = url.searchParams.get('projectId'); if (!projectId) throw new ApiServiceError('validation_error', 'projectId is required.', 422)
        service.authorize(principal, 'project:read', { type: 'project', id: projectId })
        const values = compose.applications.list({ projectId, environmentId: url.searchParams.get('environmentId') ?? undefined }).filter((application) => { try { service.authorize(principal, 'deployments:read', { type: 'resource', id: application.resourceId }); return true } catch { return false } }).map(application => ({ ...application, services: compose.applications.services(application.id) } as Record<string, unknown>))
        body = page(values, url, requestId)
      }
      else if (request.method === 'POST' && url.pathname === '/api/v1/compose-applications/preview') {
        const input = await readBody(); const projectId = String(input.projectId ?? ''); service.authorize(principal, 'project:read', { type: 'project', id: projectId })
        body = { result: compose.applications.preview(String(input.source ?? ''), { name: String(input.name ?? ''), slug: typeof input.slug === 'string' ? input.slug : undefined, projectId, environmentId: String(input.environmentId ?? '') }), requestId }
      }
      else if (request.method === 'POST' && url.pathname === '/api/v1/compose-applications') {
        const input = await readBody(); const projectId = String(input.projectId ?? ''); service.authorize(principal, 'applications:manage', { type: 'environment', id: String(input.environmentId ?? '') })
        const target = { name: String(input.name ?? ''), slug: typeof input.slug === 'string' ? input.slug : undefined, projectId, environmentId: String(input.environmentId ?? ''), createdByActorId: principal.actor.id }
        const result = typeof input.templateId === 'string' ? compose.applications.fromTemplate(input.templateId, input.inputs && typeof input.inputs === 'object' && !Array.isArray(input.inputs) ? input.inputs as Record<string, string> : {}, { ...target, version: typeof input.templateVersion === 'string' ? input.templateVersion : undefined }) : compose.applications.import(String(input.source ?? ''), target)
        body = { application: result.application, diagnostics: result.parsed.diagnostics, requestId }
      }
      else if (request.method === 'GET' && composeServices) {
        const application = compose.applications.get(decodeURIComponent(composeServices[1])); if (!application) throw new ApiServiceError('not_found', 'Compose application was not found.', 404)
        service.authorize(principal, 'deployments:read', { type: 'resource', id: application.resourceId }); body = { application, services: compose.applications.services(application.id), requestId }
      }
      else if (request.method === 'POST' && composeAction) {
        const application = compose.applications.get(decodeURIComponent(composeAction[1])); if (!application) throw new ApiServiceError('not_found', 'Compose application was not found.', 404)
        const action = composeAction[2] as 'deploy' | 'redeploy' | 'start' | 'stop' | 'scale' | 'delete'; const input = await readBody()
        service.authorize(principal, action === 'delete' || action === 'stop' ? 'deployments:cancel' : 'deployments:create', { type: 'resource', id: application.resourceId })
        body = { operation: service.operation(compose.enqueue(application, action, { actorId: principal.actor.id, service: typeof input.service === 'string' ? input.service : undefined, replicas: Number.isFinite(Number(input.replicas)) ? Number(input.replicas) : undefined, removeVolumes: input.removeVolumes === true, confirmation: typeof input.confirm === 'string' ? input.confirm : undefined })), requestId }
      }
      else if (request.method === 'GET' && url.pathname === '/api/v1/preview-definitions') {
        const projectId = url.searchParams.get('projectId')
        if (!projectId) throw new ApiServiceError('validation_error', 'projectId is required.', 422)
        service.authorize(principal, 'project:read', { type: 'project', id: projectId })
        body = page(previews.previews.listDefinitions(projectId).map(value => ({ ...value } as Record<string, unknown>)), url, requestId)
      }
      else if (request.method === 'POST' && url.pathname === '/api/v1/preview-definitions') {
        const input = await readBody()
        service.authorize(principal, 'config:write', { type: 'resource', id: String(input.resourceId ?? '') })
        body = { definition: previews.previews.createDefinition({ ...input, projectId: String(input.projectId ?? ''), resourceId: String(input.resourceId ?? ''), baseEnvironmentId: String(input.baseEnvironmentId ?? ''), domainPattern: String(input.domainPattern ?? ''), createdByActorId: principal.actor.id }), requestId }
      }
      else if (request.method === 'POST' && url.pathname === '/api/v1/previews') {
        const input = await readBody(); const policy = previews.previews.getDefinition(String(input.definitionId ?? ''))
        if (!policy) throw new ApiServiceError('not_found', 'Preview definition was not found.', 404)
        service.authorize(principal, 'deployments:create', { type: 'resource', id: policy.resourceId })
        const persisted = previews.previews.upsert({ definitionId: policy.id, sourceProvider: 'api', repository: typeof input.repository === 'string' ? input.repository : 'api', branch: String(input.branch ?? ''), pullRequestNumber: Number(input.pullRequestNumber) || undefined, fork: input.fork === true, commitSha: String(input.commitSha ?? ''), createdByActorId: principal.actor.id })
        body = { preview: persisted.preview, operation: service.operation(previews.enqueueDeploy(persisted.preview, { created: persisted.created, actorId: principal.actor.id })), requestId }
      }
      else if (request.method === 'POST' && previewAction) {
        const preview = previews.previews.getInstance(decodeURIComponent(previewAction[1])); if (!preview) throw new ApiServiceError('not_found', 'Preview was not found.', 404)
        const input = await readBody(); const action = previewAction[2]
        if (action === 'destroy') {
          service.authorize(principal, 'deployments:cancel', { type: 'resource', id: preview.resourceId })
          if (input.confirm !== preview.name) throw new ApiServiceError('confirmation_required', `Type ${preview.name} to confirm preview teardown.`, 409)
          body = { operation: service.operation(previews.enqueueDestroy(preview, 'api', principal.actor.id)), requestId }
        }
        else if (action === 'extend') {
          service.authorize(principal, 'deployments:create', { type: 'resource', id: preview.resourceId })
          body = { preview: previews.previews.extend(preview.id, Number(input.hours)), requestId }
        }
        else {
          service.authorize(principal, 'deployments:create', { type: 'resource', id: preview.resourceId })
          body = { operation: service.operation(previews.enqueueDeploy(preview, { actorId: principal.actor.id, reason: 'manual_rebuild' })), requestId }
        }
      }
      else if (request.method === 'POST' && url.pathname === '/api/v1/previews/cleanup') {
        service.authorize(principal, 'automation:manage', { type: 'organization' }); const input = await readBody()
        if (!input.dryRun && input.confirm !== 'cleanup previews') throw new ApiServiceError('confirmation_required', 'Type cleanup previews to confirm preview cleanup.', 409)
        body = { ...previews.cleanup({ dryRun: input.dryRun === true, maxAgeHours: Number(input.maxAgeHours) || undefined, keepCount: Number(input.keepCount) || undefined, actorId: principal.actor.id }), requestId }
      }
      else if (request.method === 'GET' && url.pathname === '/api/v1/queue') {
        const projectId = url.searchParams.get('projectId') ?? undefined
        const state = url.searchParams.get('state') as any
        const values = queue.list({ projectId, state: ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out'].includes(state) ? state : undefined, limit: 500 }).filter((item) => {
          const requested = item.operation.resourceId ? { type: 'resource' as const, id: item.operation.resourceId } : item.operation.environmentId ? { type: 'environment' as const, id: item.operation.environmentId } : item.operation.projectId ? { type: 'project' as const, id: item.operation.projectId } : { type: 'organization' as const }
          try { service.authorize(principal, 'deployments:read', requested); return true } catch { return false }
        }).map(item => ({ ...service.operation(item.operation), queue: item.job, approximatePosition: item.approximatePosition }))
        body = page(values, url, requestId)
      }
      else if (request.method === 'GET' && url.pathname === '/api/v1/queue/settings') {
        service.authorize(principal, 'deployments:read', principal.token.scope)
        body = { concurrency: queue.limits, requestId }
      }
      else if (request.method === 'PATCH' && url.pathname === '/api/v1/queue/settings') {
        service.authorize(principal, 'automation:manage', { type: 'organization' })
        const input = await readBody()
        if (input.confirm !== 'update queue limits') throw new ApiServiceError('confirmation_required', 'Type update queue limits to confirm production concurrency changes.', 409)
        body = { concurrency: queue.configureConcurrency(input.concurrency ?? {}, { organizationId: principal.serviceAccount.organizationId, actorId: principal.actor.id }), requestId }
      }
      else if (request.method === 'DELETE' && url.pathname === '/api/v1/queue/history') {
        service.authorize(principal, 'automation:manage', { type: 'organization' })
        const input = await readBody()
        if (input.confirm !== 'clear completed') throw new ApiServiceError('confirmation_required', 'Type clear completed to confirm queue retention cleanup.', 409)
        body = { deleted: queue.clearCompleted({ before: typeof input.before === 'string' ? input.before : undefined, actorId: principal.actor.id, projectId: typeof input.projectId === 'string' ? input.projectId : undefined }), requestId }
      }
      else if (request.method === 'GET' && operationLogs) {
        const operation = options.controlPlane.getOperation(decodeURIComponent(operationLogs[1]))
        if (!operation) throw new ApiServiceError('not_found', 'Operation was not found.', 404)
        const requested = operation.resourceId ? { type: 'resource' as const, id: operation.resourceId } : operation.environmentId ? { type: 'environment' as const, id: operation.environmentId } : operation.projectId ? { type: 'project' as const, id: operation.projectId } : { type: 'organization' as const }
        service.authorize(principal, 'deployments:read', requested)
        const lastEventId = request.headers.get('last-event-id')?.trim()
        const after = Number(lastEventId || url.searchParams.get('after') || 0)
        if (operationLogs[2] === 'stream') {
          const encoder = new TextEncoder(); let cursor = after; let timer: ReturnType<typeof setInterval> | undefined; let closed = false
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const flush = () => {
                if (closed) return
                if (!options.identities.verifyToken(bearerToken, networkHint)) { closed = true; if (timer) clearInterval(timer); controller.close(); return }
                const entries = queue.logs(operation.id, { after: cursor, limit: 500 })
                for (const entry of entries) { cursor = entry.sequence; controller.enqueue(encoder.encode(`id: ${entry.sequence}\nevent: log\ndata: ${JSON.stringify(entry)}\n\n`)) }
                const current = options.controlPlane.getOperation(operation.id)
                if (current && ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(current.state) && !queue.logs(operation.id, { after: cursor, limit: 1 }).length) { closed = true; if (timer) clearInterval(timer); controller.enqueue(encoder.encode(`event: complete\ndata: ${JSON.stringify({ state: current.state, cursor })}\n\n`)); controller.close() }
              }
              flush(); if (!closed) timer = setInterval(flush, 500)
              request.signal.addEventListener('abort', () => { closed = true; if (timer) clearInterval(timer); try { controller.close() } catch {} }, { once: true })
            },
            cancel() { closed = true; if (timer) clearInterval(timer) },
          })
          return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-request-id': requestId, ...rateHeaders } })
        }
        const entries = queue.logs(operation.id, { after, limit: Number(url.searchParams.get('limit')) || undefined })
        body = { data: entries, cursor: entries.at(-1)?.sequence ?? after, hasMore: entries.length >= Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200)), requestId }
      }
      else if (request.method === 'POST' && operationAction) {
        const operation = options.controlPlane.getOperation(decodeURIComponent(operationAction[1]))
        if (!operation) throw new ApiServiceError('not_found', 'Operation was not found.', 404)
        const requested = operation.resourceId ? { type: 'resource' as const, id: operation.resourceId } : operation.environmentId ? { type: 'environment' as const, id: operation.environmentId } : operation.projectId ? { type: 'project' as const, id: operation.projectId } : { type: 'organization' as const }
        const input = await readBody()
        if (operationAction[2] === 'cancel') {
          service.authorize(principal, 'deployments:cancel', requested)
          body = { operation: service.operation(queue.requestCancellation(operation.id, principal.actor.id)), requestId }
        }
        else {
          service.authorize(principal, 'deployments:create', requested)
          body = { operation: service.operation(queue.retry(operation.id, String(input.errorClass ?? 'manual'), { delayMs: Number(input.delayMs) || 0, actorId: principal.actor.id })), requestId }
        }
      }
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
      else if (request.method === 'POST' && url.pathname === '/api/v1/application-detections') {
        service.authorize(principal, 'applications:manage', principal.token.scope)
        const input = await readBody(); if (!Array.isArray(input.files) || input.files.length > 10_000) throw new ApiServiceError('validation_error', 'files must contain at most 10,000 entries.', 422)
        body = { candidates: detectApplication(input.files.map((item: any) => ({ path: String(item.path ?? ''), size: Number(item.size ?? 0), content: typeof item.content === 'string' ? item.content.slice(0, 256 * 1024) : undefined }))), requestId }
      }
      else if (request.method === 'POST' && url.pathname === '/api/v1/application-plans') {
        service.authorize(principal, 'applications:manage', principal.token.scope)
        const input = await readBody(); body = { plan: planApplication(input.draft, Array.isArray(input.suppliedSecretNames) ? input.suppliedSecretNames.map(String) : []), requestId }
      }
      else if (request.method === 'GET' && url.pathname === '/api/v1/application-drafts') {
        if (!options.applications) throw new ApiServiceError('not_found', 'Application onboarding is unavailable.', 404)
        const projectId = url.searchParams.get('projectId') ?? ''; service.authorize(principal, 'applications:read', { type: 'project', id: projectId })
        body = page(options.applications.drafts.list(projectId) as unknown as Array<Record<string, unknown>>, url, requestId, ['updatedAt', 'id'])
      }
      else if (request.method === 'POST' && url.pathname === '/api/v1/application-drafts') {
        if (!options.applications) throw new ApiServiceError('not_found', 'Application onboarding is unavailable.', 404)
        const input = await readBody(); const projectId = String(input.projectId ?? input.draft?.projectId ?? ''); service.authorize(principal, 'applications:manage', { type: 'project', id: projectId }); const project = options.controlPlane.getProject(projectId)
        if (!project || project.organizationId !== principal.serviceAccount.organizationId) throw new ApiServiceError('not_found', 'Project was not found.', 404)
        const draft = options.applications.drafts.create({ organizationId: project.organizationId, projectId, name: String(input.name ?? input.draft?.name ?? 'Application draft'), draft: { ...input.draft, projectId }, step: input.step, suppliedSecretNames: Array.isArray(input.suppliedSecretNames) ? input.suppliedSecretNames.map(String) : [], actorId: principal.actor.id })
        return response({ draft, requestId }, 201, requestId, rateHeaders)
      }
      else if (request.method === 'PATCH' && url.pathname === '/api/v1/application-drafts') {
        if (!options.applications) throw new ApiServiceError('not_found', 'Application onboarding is unavailable.', 404)
        const input = await readBody(); const current = options.applications.drafts.get(String(input.id ?? '')); if (!current) throw new ApiServiceError('not_found', 'Application draft was not found.', 404); service.authorize(principal, 'applications:manage', { type: 'project', id: current.projectId })
        body = { draft: options.applications.drafts.update(current.id, Number(input.version), { draft: { ...input.draft, projectId: current.projectId }, step: input.step, suppliedSecretNames: Array.isArray(input.suppliedSecretNames) ? input.suppliedSecretNames.map(String) : undefined, actorId: principal.actor.id }), requestId }
      }
      else if (request.method === 'POST' && url.pathname === '/api/v1/applications') {
        if (!options.applications) throw new ApiServiceError('not_found', 'Application onboarding is unavailable.', 404)
        const idempotencyKey = request.headers.get('idempotency-key') ?? ''
        if (!idempotencyKey) throw new ApiServiceError('idempotency_required', 'Idempotency-Key is required for application creation.', 428)
        if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw new ApiServiceError('validation_error', 'Idempotency-Key must contain 8-128 safe characters.', 422)
        const input = await readBody()
        const current = options.applications.drafts.get(String(input.draftId ?? ''))
        if (!current) throw new ApiServiceError('not_found', 'Application draft was not found.', 404)
        service.authorize(principal, 'applications:manage', { type: 'project', id: current.projectId })
        const requestHash = createHash('sha256').update(`POST\n/api/v1/applications\n${JSON.stringify(input)}`).digest('hex')
        const existing = options.identities.getIdempotency(principal.token.id, idempotencyKey)
        if (existing) {
          if (existing.requestHash !== requestHash) throw new ApiServiceError('idempotency_conflict', 'Idempotency-Key was already used for another request.', 409)
          const operation = existing.operationId ? options.controlPlane.getOperation(existing.operationId) : undefined
          const resource = operation?.resourceId ? options.controlPlane.getResource(operation.resourceId) : undefined
          if (!operation || !resource) throw new ApiServiceError('idempotency_unavailable', 'The original application operation is no longer available.', 409)
          return response({ resource, operation: service.operation(operation), plan: planApplication(current.input, current.suppliedSecretNames), idempotentReplay: true, requestId }, 202, requestId, { ...rateHeaders, 'idempotent-replayed': 'true' })
        }
        const result = applyApplicationDraft({ controlPlane: options.controlPlane, drafts: options.applications.drafts, draftId: current.id, expectedVersion: Number(input.version), confirmEnvironment: String(input.confirmEnvironment ?? ''), actorId: principal.actor.id })
        options.identities.saveIdempotency({ tokenId: principal.token.id, key: idempotencyKey, requestHash, operationId: result.operation.id, responseStatus: 202, responseBody: { draftId: current.id } })
        return response({ resource: result.resource, operation: service.operation(result.operation), plan: result.plan, idempotentReplay: false, requestId }, 202, requestId, rateHeaders)
      }
      else if (request.method === 'GET' && url.pathname === '/api/v1/registry-connections') {
        if (!options.applications) throw new ApiServiceError('not_found', 'Application onboarding is unavailable.', 404); service.authorize(principal, 'applications:read', principal.token.scope)
        body = page(options.applications.registries.list(principal.serviceAccount.organizationId) as unknown as Array<Record<string, unknown>>, url, requestId, ['createdAt', 'id'])
      }
      else if (request.method === 'POST' && url.pathname === '/api/v1/registry-connections') {
        if (!options.applications) throw new ApiServiceError('not_found', 'Application onboarding is unavailable.', 404); service.authorize(principal, 'applications:manage', { type: 'organization' }); const input = await readBody()
        const registry = options.applications.registries.create({ organizationId: principal.serviceAccount.organizationId, provider: input.provider, name: String(input.name ?? 'Container registry'), host: String(input.host ?? ''), credential: input.token || input.password ? { username: typeof input.username === 'string' ? input.username : undefined, password: typeof input.password === 'string' ? input.password : undefined, token: typeof input.token === 'string' ? input.token : undefined } : undefined, credentialExpiresAt: typeof input.credentialExpiresAt === 'string' ? input.credentialExpiresAt : undefined, actorId: principal.actor.id })
        return response({ registry, requestId }, 201, requestId, rateHeaders)
      }
      else if (request.method === 'PATCH' && url.pathname === '/api/v1/registry-connections') {
        if (!options.applications) throw new ApiServiceError('not_found', 'Application onboarding is unavailable.', 404); service.authorize(principal, 'applications:manage', { type: 'organization' }); const input = await readBody(); const registry = options.applications.registries.get(String(input.id ?? ''))
        if (!registry || registry.organizationId !== principal.serviceAccount.organizationId) throw new ApiServiceError('not_found', 'Registry connection was not found.', 404)
        if (input.action === 'test') body = { registry: await options.applications.registries.test(registry.id, { image: typeof input.image === 'string' ? input.image : undefined }), requestId }
        else if (input.action === 'rotate') body = { registry: options.applications.registries.rotate(registry.id, { username: input.username, password: input.password, token: input.token }, { expiresAt: input.expiresAt, actorId: principal.actor.id }), requestId }
        else throw new ApiServiceError('validation_error', 'action must be test or rotate.', 422)
      }
      else if (request.method === 'DELETE' && url.pathname === '/api/v1/registry-connections') {
        if (!options.applications) throw new ApiServiceError('not_found', 'Application onboarding is unavailable.', 404); service.authorize(principal, 'applications:manage', { type: 'organization' }); const input = await readBody(); const registry = options.applications.registries.get(String(input.id ?? ''))
        if (!registry || registry.organizationId !== principal.serviceAccount.organizationId) throw new ApiServiceError('not_found', 'Registry connection was not found.', 404)
        body = { registry: options.applications.registries.disconnect(registry.id, principal.actor.id), requestId }
      }
      else if (request.method === 'POST' && url.pathname === '/api/v1/application-artifacts') {
        if (!options.applications?.artifacts) throw new ApiServiceError('not_found', 'Application artifact storage is unavailable.', 404)
        const projectId = request.headers.get('x-project-id') ?? ''; service.authorize(principal, 'applications:manage', { type: 'project', id: projectId }); const project = options.controlPlane.getProject(projectId); if (!project || project.organizationId !== principal.serviceAccount.organizationId) throw new ApiServiceError('not_found', 'Project was not found.', 404)
        const declared = Number(request.headers.get('content-length') ?? 0)
        if (declared > 100 * 1024 * 1024) throw new ApiServiceError('payload_too_large', 'Artifact exceeds 100 MB.', 413)
        const artifact = options.applications.artifacts.create({ organizationId: project.organizationId, projectId, filename: request.headers.get('x-artifact-filename') ?? 'application.zip', bytes: new Uint8Array(await request.arrayBuffer()), actorId: principal.actor.id })
        return response({ artifact, requestId }, 201, requestId, rateHeaders)
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
      if (url.pathname.startsWith('/api/v1/source/') || url.pathname.startsWith('/api/v1/application') || url.pathname.startsWith('/api/v1/compose-') || url.pathname === '/api/v1/registry-connections')
        return failure('validation_error', error instanceof Error ? error.message : 'Integration request could not be completed.', 422, requestId, undefined, rateHeaders)
      return failure('internal_error', 'The API request could not be completed.', 500, requestId, undefined, rateHeaders)
    }
  }
}
