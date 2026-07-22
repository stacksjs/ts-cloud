import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashPassword } from './dashboard-auth'
import { startLocalDashboardServer } from './local-dashboard-server'
import { saveUsers } from './dashboard-users'

let root: string | undefined
let running: Awaited<ReturnType<typeof startLocalDashboardServer>> | undefined

function storedZip(path: string): Uint8Array {
  const name = new TextEncoder().encode(path); const body = new TextEncoder().encode('hello'); const bytes = new Uint8Array(30 + name.length + body.length); const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint32(18, body.length, true); view.setUint32(22, body.length, true); view.setUint16(26, name.length, true); bytes.set(name, 30); bytes.set(body, 30 + name.length); return bytes
}

afterEach(() => { running?.server.stop(true); running = undefined; if (root) rmSync(root, { recursive: true, force: true }); root = undefined })

describe('dashboard application onboarding integration', () => {
  it('detects, resumes, validates, and explicitly applies the same secret-free plan', async () => {
    root = mkdtempSync(join(tmpdir(), 'ts-cloud-dashboard-onboarding-'))
    saveUsers(root, [{ username: 'owner', passwordHash: hashPassword('correct horse battery staple'), role: 'admin', sites: {}, name: 'Owner', createdAt: new Date().toISOString() }])
    running = await startLocalDashboardServer({ cwd: root, host: '127.0.0.1', port: 0, config: { project: { name: 'Acme', slug: 'acme', region: 'us-east-1' }, environments: { production: { type: 'production' } }, sites: {} } as any })
    const base = running.url.replace(/\/$/, ''); const call = (path: string, init?: RequestInit) => running!.server.fetch(new Request(`${base}${path}`, init))
    const login = await call('/api/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }) }); const session = login.headers.get('set-cookie')?.split(';')[0] ?? ''; const headers = { origin: base, cookie: session, 'content-type': 'application/json' }
    const initial = await (await call('/api/onboarding?env=production', { headers: { cookie: session } })).json() as any
    const environment = initial.environments.find((item: any) => item.slug === 'production')
    const detection = await (await call('/api/onboarding/detect?env=production', { method: 'POST', headers, body: JSON.stringify({ files: [{ path: 'package.json', content: '{"scripts":{"start":"bun run server.ts"}}' }, { path: 'bun.lock' }] }) })).json() as any
    expect(detection.candidates[0]).toMatchObject({ framework: 'bun', strategy: 'server', evidence: expect.any(Array) })
    const draftInput = { schemaVersion: 1, name: 'Web', slug: 'web', projectId: initial.project.id, environmentId: environment.id, source: { kind: 'local', root: '.' }, build: { kind: 'server', runtime: 'bun', startCommand: 'bun run server.ts' }, runtime: { target: 'server', architecture: 'arm64', port: 3000, healthCheck: { protocol: 'http', path: '/health' } }, environment: { DATABASE_PASSWORD: { secretRef: 'DATABASE_PASSWORD' } }, requiredSecretNames: ['DATABASE_PASSWORD'], domain: { hostname: 'web.example.com', tls: true } }
    const createdResponse = await call('/api/onboarding/drafts?env=production', { method: 'POST', headers, body: JSON.stringify({ draft: draftInput, step: 'environment' }) }); expect(createdResponse.status).toBe(201); const created = await createdResponse.json() as any
    expect(created.draft).toMatchObject({ status: 'draft', step: 'environment', suppliedSecretNames: [] })
    const planned = await (await call('/api/onboarding/plan?env=production', { method: 'POST', headers, body: JSON.stringify({ draft: draftInput }) })).json() as any
    expect(planned.plan).toMatchObject({ valid: false, missingSecrets: ['DATABASE_PASSWORD'], capabilityRequirements: expect.any(Array), costDrivers: expect.any(Array) })
    const updated = await (await call('/api/onboarding/drafts?env=production', { method: 'PATCH', headers, body: JSON.stringify({ id: created.draft.id, version: created.draft.version, draft: draftInput, step: 'review', suppliedSecretNames: ['DATABASE_PASSWORD'] }) })).json() as any
    expect(updated.draft).toMatchObject({ status: 'ready', step: 'review', version: 2 })
    const rejected = await call('/api/onboarding/apply?env=production', { method: 'POST', headers, body: JSON.stringify({ id: updated.draft.id, version: 2, confirmEnvironment: 'staging' }) }); expect(rejected.status).toBe(422)
    expect((await (await call('/api/onboarding?env=production', { headers: { cookie: session } })).json() as any).resources).toHaveLength(0)
    const appliedResponse = await call('/api/onboarding/apply?env=production', { method: 'POST', headers, body: JSON.stringify({ id: updated.draft.id, version: 2, confirmEnvironment: 'production' }) }); expect(appliedResponse.status).toBe(202)
    const applied = await appliedResponse.json() as any
    expect(applied).toMatchObject({ resource: { slug: 'web' }, operation: { kind: 'application.create', state: 'queued' }, plan: { valid: true, serializedManifest: expect.any(String) } })
    const queue = await (await call('/api/queue?env=production', { headers: { cookie: session } })).json() as any
    expect(queue.operations).toMatchObject([{ operation: { id: applied.operation.id, state: 'queued' }, job: { maxAttempts: 3 }, target: { slug: 'web' } }])
    const logs = await (await call(`/api/queue/logs?id=${applied.operation.id}`, { headers: { cookie: session } })).json() as any
    expect(logs.entries).toMatchObject([{ stream: 'system', message: 'Queued for durable execution.' }])
    const cancelled = await (await call('/api/queue/cancel', { method: 'POST', headers, body: JSON.stringify({ id: applied.operation.id }) })).json() as any
    expect(cancelled.operation).toMatchObject({ id: applied.operation.id, state: 'cancelled' })
    const retried = await (await call('/api/queue/retry', { method: 'POST', headers, body: JSON.stringify({ id: applied.operation.id, errorClass: 'provider_unavailable' }) })).json() as any
    expect(retried.operation).toMatchObject({ id: applied.operation.id, state: 'queued' })

    const artifactResponse = await call('/api/onboarding/artifacts?env=production', { method: 'POST', headers: { origin: base, cookie: session, 'content-type': 'application/octet-stream', 'x-artifact-filename': 'site.zip' }, body: storedZip('dist/index.html') }); expect(artifactResponse.status).toBe(201); expect(await artifactResponse.json()).toMatchObject({ artifact: { format: 'zip', entryCount: 1 } })
    const registryResponse = await call('/api/onboarding/registries?env=production', { method: 'POST', headers, body: JSON.stringify({ provider: 'generic', name: 'Private OCI', host: 'https://registry.example', username: 'robot', password: 'registry-runtime-secret' }) }); expect(registryResponse.status).toBe(201); const registry = await registryResponse.json() as any; expect(registry.registry).toMatchObject({ credentialConfigured: true }); expect(JSON.stringify(registry)).not.toContain('registry-runtime-secret')
    const preview = await (await call('/api/onboarding/registries?env=production', { method: 'DELETE', headers, body: JSON.stringify({ id: registry.registry.id, preview: true }) })).json() as any; expect(preview).toMatchObject({ preview: true, affectedDrafts: [] })
    const disconnected = await (await call('/api/onboarding/registries?env=production', { method: 'DELETE', headers, body: JSON.stringify({ id: registry.registry.id }) })).json() as any; expect(disconnected.registry).toMatchObject({ status: 'disconnected', credentialConfigured: false })
  })
})
