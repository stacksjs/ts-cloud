import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlPlaneStore } from '../control-plane'
import { ReleaseStore } from '../release'
import { hashPassword } from './dashboard-auth'
import { startLocalDashboardServer } from './local-dashboard-server'
import { saveUsers } from './dashboard-users'

let root: string | undefined
let running: Awaited<ReturnType<typeof startLocalDashboardServer>> | undefined
let store: ControlPlaneStore | undefined

afterEach(() => { running?.server.stop(true); running = undefined; store?.close(); store = undefined; if (root) rmSync(root, { recursive: true, force: true }); root = undefined })

describe('dashboard release integration', () => {
  it('shows immutable identity, comparison, pinning, and an exact rollback preview target', async () => {
    root = mkdtempSync(join(tmpdir(), 'ts-cloud-dashboard-releases-'))
    saveUsers(root, [{ username: 'owner', passwordHash: hashPassword('correct horse battery staple'), role: 'admin', sites: {}, name: 'Owner', createdAt: new Date().toISOString() }])
    running = await startLocalDashboardServer({ cwd: root, host: '127.0.0.1', port: 0, queueWorker: false, config: { project: { name: 'Acme', slug: 'acme', region: 'us-east-1' }, environments: { production: { type: 'production' } }, sites: { web: { domain: 'example.com', root: 'dist' } } } as any })
    store = new ControlPlaneStore({ cwd: root })
    const project = store.getProjectBySlug('acme')!; const organization = store.getOrganizationBySlug('acme')!; const environment = store.getEnvironmentBySlug(project.id, 'production')!; const resource = store.listResources(project.id, environment.id).find(item => item.slug === 'web')!; const releases = new ReleaseStore(store)
    const artifact1 = releases.registerArtifact({ organizationId: organization.id, digest: `sha256:${'1'.repeat(64)}`, kind: 'static', uri: 's3://immutable/web-1', size: 10, provenance: { builder: 'ci' } }); const first = releases.create({ organizationId: organization.id, projectId: project.id, environmentId: environment.id, resourceId: resource.id, artifactId: artifact1.id, kind: 'static', sourceSha: 'a'.repeat(40), config: { PUBLIC_URL: 'one' }, manifest: { domains: ['example.com'] }, strategy: 'atomic' }); releases.transition(first.id, 'activating', { message: 'switch' }); releases.transition(first.id, 'active', { message: 'healthy' })
    const artifact2 = releases.registerArtifact({ organizationId: organization.id, digest: `sha256:${'2'.repeat(64)}`, kind: 'static', uri: 's3://immutable/web-2', size: 11, provenance: { builder: 'ci' } }); const current = releases.create({ organizationId: organization.id, projectId: project.id, environmentId: environment.id, resourceId: resource.id, artifactId: artifact2.id, kind: 'static', sourceSha: 'b'.repeat(40), config: { PUBLIC_URL: 'two' }, manifest: { domains: ['example.com'] }, strategy: 'atomic' }); releases.transition(current.id, 'activating', { message: 'switch' }); releases.transition(current.id, 'active', { message: 'healthy' })
    const base = running.url.replace(/\/$/, ''); const call = (path: string, init?: RequestInit) => running!.server.fetch(new Request(`${base}${path}`, init)); const login = await call('/api/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }) }); const session = login.headers.get('set-cookie')?.split(';')[0] ?? ''; const headers = { origin: base, cookie: session, 'content-type': 'application/json' }
    const listed = await (await call('/api/releases', { headers: { cookie: session } })).json() as any
    expect(listed.releases[0]).toMatchObject({ id: current.id, status: 'active', artifact: { digest: artifact2.digest }, previous: { id: first.id }, comparison: { artifactChanged: true, sourceChanged: true, configChanged: true }, capabilities: expect.any(Array) })
    expect(await (await call('/api/releases/action', { method: 'POST', headers, body: JSON.stringify({ id: current.id, action: 'pin', pinned: true, reason: 'incident baseline' }) })).json()).toMatchObject({ release: { pinned: true, pinReason: 'incident baseline' } })
    const rejected = await call('/api/releases/action', { method: 'POST', headers, body: JSON.stringify({ id: current.id, action: 'rollback', targetReleaseId: first.id, confirm: 'wrong' }) }); expect(rejected.status).toBe(409)
    expect(await (await call('/api/releases/action', { method: 'POST', headers, body: JSON.stringify({ id: current.id, action: 'rollback', targetReleaseId: first.id, confirm: 'web' }) })).json()).toMatchObject({ operation: { kind: 'release.rollback', input: { targetReleaseId: first.id }, state: 'queued' } })
  }, 10_000)
})
