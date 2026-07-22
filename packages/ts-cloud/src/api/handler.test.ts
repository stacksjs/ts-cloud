import { describe, expect, it } from 'bun:test'
import { AutomationIdentityStore } from '../automation'
import { ControlPlaneStore } from '../control-plane'
import { ApplicationDraftStore, RegistryConnectionStore } from '../onboarding'
import { SourceConnectionStore } from '../source'
import { TsCloudClient } from './client'
import { createApiV1Handler } from './handler'
import { openApiDocument } from './openapi'

function fixture(rateLimit = 120) {
  const controlPlane = new ControlPlaneStore({ path: ':memory:' })
  const organization = controlPlane.createOrganization({ slug: 'acme', name: 'Acme' })
  const project = controlPlane.createProject({ organizationId: organization.id, slug: 'web', name: 'Web' })
  const production = controlPlane.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' })
  const staging = controlPlane.createEnvironment({ projectId: project.id, slug: 'staging', name: 'Staging', kind: 'staging' })
  const productionService = controlPlane.createResource({ projectId: project.id, environmentId: production.id, kind: 'application', slug: 'web', name: 'Web', metadata: { apiKey: 'redact-me', revision: 'abc123' } })
  controlPlane.createResource({ projectId: project.id, environmentId: staging.id, kind: 'application', slug: 'web-staging', name: 'Staging Web' })
  const identities = new AutomationIdentityStore(controlPlane)
  const sources = new SourceConnectionStore(controlPlane, { encryptionKey: 'api-fixture-key' })
  const applicationDrafts = new ApplicationDraftStore(controlPlane)
  const registryConnections = new RegistryConnectionStore(controlPlane, { encryptionKey: 'api-registry-fixture-key' })
  const account = identities.createServiceAccount({ organizationId: organization.id, slug: 'production-ci', name: 'Production CI', roleTemplate: 'deployer', scope: { type: 'environment', id: production.id } }).serviceAccount
  const issued = identities.createToken({ serviceAccountId: account.id, name: 'CI', capabilities: ['project:read', 'deployments:read', 'deployments:create', 'applications:read', 'applications:manage'], scope: { type: 'environment', id: production.id } })
  const handler = createApiV1Handler({ controlPlane, identities, sources, applications: { drafts: applicationDrafts, registries: registryConnections }, rateLimit })
  const call = (path: string, init: RequestInit = {}, token = issued.secret) => handler(new Request(`https://cloud.acme.test${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } })) as Promise<Response>
  return { controlPlane, organization, project, production, staging, productionService, identities, sources, applicationDrafts, registryConnections, account, issued, handler, call }
}

describe('/api/v1 contract', () => {
  it('serves a versioned OpenAPI document and stable unauthorized errors', async () => {
    const { controlPlane, handler } = fixture()
    const document = await handler(new Request('https://cloud.acme.test/api/v1/openapi.json')) as Response
    expect(document.status).toBe(200)
    expect(await document.json()).toMatchObject({ openapi: '3.1.0', info: { title: 'ts-cloud API' }, paths: { '/api/v1/deployments': {} } })
    const unauthorized = await handler(new Request('https://cloud.acme.test/api/v1/projects')) as Response
    const body = await unauthorized.json() as any
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get('www-authenticate')).toContain('invalid_token')
    expect(body.error).toMatchObject({ code: 'unauthorized', requestId: unauthorized.headers.get('x-request-id') })
    controlPlane.close()
  })

  it('limits an environment token to its own services and redacts metadata', async () => {
    const { controlPlane, project, production, staging, call } = fixture()
    const projects = await (await call('/api/v1/projects')).json() as any
    expect(projects.data.map((item: any) => item.id)).toEqual([project.id])
    const environments = await (await call(`/api/v1/projects/${project.id}/environments`)).json() as any
    expect(environments.data.map((item: any) => item.id)).toEqual([production.id])
    expect(environments.data.map((item: any) => item.id)).not.toContain(staging.id)
    const services = await (await call(`/api/v1/services?projectId=${project.id}&environmentId=${production.id}`)).json() as any
    expect(services.data).toHaveLength(1)
    expect(services.data[0].metadata).toEqual({ apiKey: '[REDACTED]', revision: 'abc123' })
    const forbidden = await call(`/api/v1/services?projectId=${project.id}&environmentId=${staging.id}`)
    expect(forbidden.status).toBe(404)
    controlPlane.close()
  })

  it('requires idempotency and returns the same operation for a replay', async () => {
    const { controlPlane, project, production, productionService, call } = fixture()
    const input = { projectId: project.id, environmentId: production.id, serviceId: productionService.id, action: 'deploy' }
    const missing = await call('/api/v1/deployments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    expect(missing.status).toBe(428)
    const first = await call('/api/v1/deployments', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'build-12345678' }, body: JSON.stringify(input) })
    const firstBody = await first.json() as any
    expect(first.status).toBe(202)
    expect(firstBody).toMatchObject({ operation: { state: 'queued', kind: 'deployment.create', actorId: expect.any(String) }, idempotentReplay: false })
    expect(controlPlane.database.query<Record<string, string>, [string]>('SELECT lock_key FROM operation_jobs WHERE operation_id=?').get(firstBody.operation.id)?.lock_key).toBe(`resource:${productionService.id}`)
    const replay = await call('/api/v1/deployments', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'build-12345678' }, body: JSON.stringify(input) })
    expect(await replay.json()).toMatchObject({ operation: { id: firstBody.operation.id }, idempotentReplay: true })
    expect(replay.headers.get('idempotent-replayed')).toBe('true')
    const conflict = await call('/api/v1/deployments', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'build-12345678' }, body: JSON.stringify({ ...input, action: 'rollback' }) })
    expect(await conflict.json()).toMatchObject({ error: { code: 'idempotency_conflict' } })
    expect(controlPlane.listOperations({ projectId: project.id })).toHaveLength(1)
    controlPlane.close()
  })

  it('keeps cursor pages stable and returns explicit rate-limit metadata', async () => {
    const { controlPlane, call } = fixture(2)
    const first = await call('/api/v1/projects?limit=1')
    expect(first.headers.get('x-ratelimit-remaining')).toBe('1')
    const second = await call('/api/v1/projects')
    expect(second.headers.get('x-ratelimit-remaining')).toBe('0')
    const limited = await call('/api/v1/projects')
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBeDefined()
    expect(await limited.json()).toMatchObject({ error: { code: 'rate_limited' } })
    controlPlane.close()
  })

  it('uses the generated TypeScript client against the same handler', async () => {
    const { controlPlane, issued, handler, project, production, productionService } = fixture()
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => handler(new Request(String(input), init)) as Promise<Response>) as typeof fetch
    const client = new TsCloudClient({ baseUrl: 'https://cloud.acme.test', token: issued.secret, fetch: mockFetch })
    expect((await client.listProjects()).data[0].id).toBe(project.id)
    expect((await client.detectApplication({ files: [{ path: 'package.json', content: '{"scripts":{"start":"bun server.ts"}}' }, { path: 'bun.lock' }] })).candidates[0]).toMatchObject({ framework: 'bun' })
    const deployed = await client.createDeployment({ projectId: project.id, environmentId: production.id, serviceId: productionService.id }, 'client-build-123')
    expect(deployed.operation).toMatchObject({ state: 'queued', resourceId: productionService.id })
    controlPlane.close()
  })

  it('manages encrypted source connections through organization-scoped automation', async () => {
    const { controlPlane, organization, project, production, productionService, identities, handler } = fixture()
    const account = identities.createServiceAccount({ organizationId: organization.id, slug: 'source-automation', name: 'Source Automation', roleTemplate: 'admin', scope: { type: 'organization' } }).serviceAccount
    const issued = identities.createToken({ serviceAccountId: account.id, name: 'Sources', capabilities: ['sources:read', 'sources:manage'], scope: { type: 'organization' } })
    const call = (path: string, init: RequestInit = {}) => handler(new Request(`https://cloud.acme.test${path}`, { ...init, headers: { authorization: `Bearer ${issued.secret}`, 'content-type': 'application/json', ...init.headers } })) as Promise<Response>
    const createdResponse = await call('/api/v1/source/connections', { method: 'POST', body: JSON.stringify({ provider: 'generic_https', name: 'Private Git', host: 'https://git.example', authKind: 'access_token', token: 'runtime-source-secret', repositoryFullName: 'acme/web', repositoryUrl: 'https://git.example/acme/web.git' }) })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as any
    expect(created.connection).toMatchObject({ provider: 'generic_https', credentialConfigured: true })
    expect(JSON.stringify(created)).not.toContain('runtime-source-secret')
    const listed = await (await call('/api/v1/source/connections')).json() as any
    expect(listed.data).toMatchObject([{ id: created.connection.id, name: 'Private Git' }])
    const bindingResponse = await call('/api/v1/source/bindings', { method: 'POST', body: JSON.stringify({ projectId: project.id, environmentId: production.id, resourceId: productionService.id, connectionId: created.connection.id, repositoryId: created.repository.id, repositoryFullName: 'acme/web', defaultBranch: 'main' }) })
    expect(bindingResponse.status).toBe(201)
    expect(await bindingResponse.json()).toMatchObject({ binding: { status: 'active', resourceId: productionService.id } })
    const webhookResponse = await call('/api/v1/source/webhooks', { method: 'POST', body: JSON.stringify({ connectionId: created.connection.id, repositoryId: created.repository.id, repositoryFullName: 'acme/web', baseUrl: 'https://deploy.example', reconcile: false }) })
    expect(webhookResponse.status).toBe(201)
    expect(await webhookResponse.json()).toMatchObject({ endpointRevealOnce: true, endpoint: expect.stringContaining('/api/source/webhooks/') })
    const preview = await (await call('/api/v1/source/connections', { method: 'DELETE', body: JSON.stringify({ id: created.connection.id, preview: true }) })).json() as any
    expect(preview.affectedBindings).toHaveLength(1)
    controlPlane.close()
  })

  it('plans, resumes, and idempotently creates applications without returning secrets', async () => {
    const { controlPlane, organization, project, production, identities, handler } = fixture()
    const account = identities.createServiceAccount({ organizationId: organization.id, slug: 'application-automation', name: 'Application Automation', roleTemplate: 'admin', scope: { type: 'organization' } }).serviceAccount
    const issued = identities.createToken({ serviceAccountId: account.id, name: 'Applications', capabilities: ['applications:read', 'applications:manage'], scope: { type: 'organization' } })
    const call = (path: string, init: RequestInit = {}) => handler(new Request(`https://cloud.acme.test${path}`, { ...init, headers: { authorization: `Bearer ${issued.secret}`, 'content-type': 'application/json', ...init.headers } })) as Promise<Response>
    const detected = await (await call('/api/v1/application-detections', { method: 'POST', body: JSON.stringify({ files: [{ path: 'package.json', content: '{"scripts":{"start":"bun run server.ts"}}' }, { path: 'bun.lock' }] }) })).json() as any
    expect(detected.candidates[0]).toMatchObject({ framework: 'bun', strategy: 'server', confidence: expect.any(Number) })
    const draftInput = {
      schemaVersion: 1,
      name: 'API Worker',
      slug: 'api-worker',
      projectId: project.id,
      environmentId: production.id,
      source: { kind: 'local', root: '.' },
      build: { kind: 'server', runtime: 'bun', startCommand: 'bun run server.ts' },
      runtime: { architecture: 'arm64', port: 3000, target: 'server', healthCheck: { protocol: 'http', path: '/health' } },
      environment: { NODE_ENV: 'production', DATABASE_URL: { secretRef: 'DATABASE_URL' } },
      requiredSecretNames: ['DATABASE_URL'],
    }
    const planned = await (await call('/api/v1/application-plans', { method: 'POST', body: JSON.stringify({ draft: draftInput, suppliedSecretNames: ['DATABASE_URL'] }) })).json() as any
    expect(planned.plan).toMatchObject({ valid: true, missingSecrets: [], manifest: { spec: { build: { kind: 'server' } } } })
    const createdResponse = await call('/api/v1/application-drafts', { method: 'POST', body: JSON.stringify({ projectId: project.id, name: 'API draft', draft: draftInput, step: 'review', suppliedSecretNames: ['DATABASE_URL'] }) })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as any
    expect(created.draft).toMatchObject({ status: 'ready', version: 1, suppliedSecretNames: ['DATABASE_URL'] })
    expect(JSON.stringify(created)).not.toContain('database-password')
    const listed = await (await call(`/api/v1/application-drafts?projectId=${project.id}`)).json() as any
    expect(listed.data).toMatchObject([{ id: created.draft.id, step: 'review' }])
    const before = controlPlane.listResources(project.id, production.id).length
    const wrong = await call('/api/v1/applications', { method: 'POST', headers: { 'idempotency-key': 'application-wrong-target' }, body: JSON.stringify({ draftId: created.draft.id, version: 1, confirmEnvironment: 'staging' }) })
    expect(wrong.status).toBe(422)
    expect(controlPlane.listResources(project.id, production.id)).toHaveLength(before)
    const request = { draftId: created.draft.id, version: 1, confirmEnvironment: 'production' }
    const applied = await call('/api/v1/applications', { method: 'POST', headers: { 'idempotency-key': 'application-create-1' }, body: JSON.stringify(request) })
    const appliedBody = await applied.json() as any
    expect(applied.status).toBe(202)
    expect(appliedBody).toMatchObject({ resource: { slug: 'api-worker' }, operation: { kind: 'application.create', state: 'queued' }, plan: { valid: true }, idempotentReplay: false })
    const replay = await call('/api/v1/applications', { method: 'POST', headers: { 'idempotency-key': 'application-create-1' }, body: JSON.stringify(request) })
    expect(replay.headers.get('idempotent-replayed')).toBe('true')
    expect(await replay.json()).toMatchObject({ operation: { id: appliedBody.operation.id }, idempotentReplay: true })
    expect(controlPlane.listOperations({ projectId: project.id }).filter(item => item.kind === 'application.create')).toHaveLength(1)

    const registryResponse = await call('/api/v1/registry-connections', { method: 'POST', body: JSON.stringify({ provider: 'ghcr', name: 'Private images', host: 'ghcr.io', username: 'acme', token: 'registry-super-secret' }) })
    const registry = await registryResponse.json() as any
    expect(registryResponse.status).toBe(201)
    expect(registry.registry).toMatchObject({ credentialConfigured: true, status: 'pending' })
    expect(JSON.stringify(registry)).not.toContain('registry-super-secret')
    const disconnected = await call('/api/v1/registry-connections', { method: 'DELETE', body: JSON.stringify({ id: registry.registry.id }) })
    expect(await disconnected.json()).toMatchObject({ registry: { status: 'disconnected', credentialConfigured: false } })
    controlPlane.close()
  })

  it('authenticates event streams and closes them after token revocation', async () => {
    const { controlPlane, organization, production, identities, handler } = fixture()
    const account = identities.createServiceAccount({ organizationId: organization.id, slug: 'event-relay', name: 'Event Relay', roleTemplate: 'admin', scope: { type: 'environment', id: production.id } }).serviceAccount
    const issued = identities.createToken({ serviceAccountId: account.id, name: 'Events', capabilities: ['audit:read'], scope: { type: 'environment', id: production.id } })
    const response = await handler(new Request('https://cloud.acme.test/api/v1/events/stream', { headers: { authorization: `Bearer ${issued.secret}` } })) as Response
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('connected')
    identities.revokeToken(issued.token.id)
    expect((await reader.read()).done).toBe(true)
    controlPlane.close()
  }, 3_000)

  it('pins required OpenAPI operations and write-only authorization', () => {
    const document = openApiDocument() as any
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(['/api/v1/projects', '/api/v1/services', '/api/v1/deployments', '/api/v1/operations', '/api/v1/events', '/api/v1/events/stream', '/api/v1/source/connections', '/api/v1/source/repositories', '/api/v1/source/refs', '/api/v1/source/bindings', '/api/v1/source/webhooks', '/api/v1/application-detections', '/api/v1/application-plans', '/api/v1/application-drafts', '/api/v1/applications', '/api/v1/application-artifacts', '/api/v1/registry-connections']))
    expect(document.components.securitySchemes.bearerAuth).toMatchObject({ scheme: 'bearer', bearerFormat: 'tsc_v1' })
    expect(document.paths['/api/v1/deployments'].post.parameters[0]).toMatchObject({ name: 'Idempotency-Key', required: true })
    expect(document.paths['/api/v1/applications'].post.parameters[0]).toMatchObject({ name: 'Idempotency-Key', required: true })
    expect(document.components.schemas.RegistryConnectionRequest.properties.token).toMatchObject({ writeOnly: true })
  })
})
