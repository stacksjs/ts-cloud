import { describe, expect, it } from 'bun:test'
import { AutomationIdentityStore } from '../automation'
import { ControlPlaneStore } from '../control-plane'
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
  const account = identities.createServiceAccount({ organizationId: organization.id, slug: 'production-ci', name: 'Production CI', roleTemplate: 'deployer', scope: { type: 'environment', id: production.id } }).serviceAccount
  const issued = identities.createToken({ serviceAccountId: account.id, name: 'CI', capabilities: ['project:read', 'deployments:read', 'deployments:create'], scope: { type: 'environment', id: production.id } })
  const handler = createApiV1Handler({ controlPlane, identities, rateLimit })
  const call = (path: string, init: RequestInit = {}, token = issued.secret) => handler(new Request(`https://cloud.acme.test${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } })) as Promise<Response>
  return { controlPlane, organization, project, production, staging, productionService, identities, account, issued, handler, call }
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
    const deployed = await client.createDeployment({ projectId: project.id, environmentId: production.id, serviceId: productionService.id }, 'client-build-123')
    expect(deployed.operation).toMatchObject({ state: 'queued', resourceId: productionService.id })
    controlPlane.close()
  })

  it('pins required OpenAPI operations and write-only authorization', () => {
    const document = openApiDocument() as any
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(['/api/v1/projects', '/api/v1/services', '/api/v1/deployments', '/api/v1/operations', '/api/v1/events', '/api/v1/events/stream']))
    expect(document.components.securitySchemes.bearerAuth).toMatchObject({ scheme: 'bearer', bearerFormat: 'tsc_v1' })
    expect(document.paths['/api/v1/deployments'].post.parameters[0]).toMatchObject({ name: 'Idempotency-Key', required: true })
  })
})
