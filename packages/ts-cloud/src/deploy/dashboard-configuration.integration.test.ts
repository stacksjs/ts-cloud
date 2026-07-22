import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashPassword } from './dashboard-auth'
import { startLocalDashboardServer } from './local-dashboard-server'
import { saveUsers } from './dashboard-users'

let root: string | undefined
let running: Awaited<ReturnType<typeof startLocalDashboardServer>> | undefined
afterEach(() => { running?.server.stop(true); running = undefined; if (root) rmSync(root, { recursive: true, force: true }); root = undefined })

describe('dashboard configuration integration', () => {
  test('imports, previews, masks, reveals, rotates, exports, and deletes scoped configuration', async () => {
    root = mkdtempSync(join(tmpdir(), 'ts-cloud-dashboard-configuration-'))
    saveUsers(root, [{ username: 'owner', passwordHash: hashPassword('correct horse battery staple'), role: 'admin', sites: {}, createdAt: new Date().toISOString() }])
    running = await startLocalDashboardServer({ cwd: root, host: '127.0.0.1', port: 0, queueWorker: false, config: { project: { name: 'Acme', slug: 'acme', region: 'us-east-1' }, environments: { production: { type: 'production' } }, sites: { web: { domain: 'example.com', root: 'dist' } } } as any })
    const base = running.url.replace(/\/$/, ''), call = (path: string, init?: RequestInit) => running!.server.fetch(new Request(`${base}${path}`, init))
    const login = await call('/api/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }) })
    const session = login.headers.get('set-cookie')?.split(';')[0] ?? '', headers = { origin: base, cookie: session, 'content-type': 'application/json' }

    const imported = await call('/api/configuration/import?env=production', { method: 'POST', headers: { ...headers, 'idempotency-key': 'import-1' }, body: JSON.stringify({ scopeType: 'project', source: 'PUBLIC_URL=https://example.test\nTOKEN=secret-value', secretKeys: ['TOKEN'] }) })
    expect(imported.status).toBe(200)
    expect(await imported.json()).toMatchObject({ ok: true, mutation: { added: ['PUBLIC_URL', 'TOKEN'] } })

    const listResponse = await call('/api/configuration?env=production&scopeType=project', { headers: { cookie: session } }), listed = await listResponse.json() as any
    expect(listResponse.headers.get('cache-control')).toBe('no-store')
    expect(listed.entries).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'PUBLIC_URL', kind: 'variable', value: 'https://example.test' }), expect.objectContaining({ key: 'TOKEN', kind: 'secret', backend: 'local_encrypted' })]))
    expect(JSON.stringify(listed)).not.toContain('secret-value')
    const token = listed.entries.find((entry: any) => entry.key === 'TOKEN')

    const plan = await call('/api/configuration/plan?env=production', { method: 'POST', headers, body: JSON.stringify({ scopeType: 'project', values: { PUBLIC_URL: 'https://new.test', TOKEN: 'secret-value', ADDED: 'yes' } }) }), planBody = await plan.json() as any
    expect(planBody.plan).toMatchObject({ added: ['ADDED'], changed: ['PUBLIC_URL'], unchanged: ['TOKEN'] })
    expect(JSON.stringify(planBody)).not.toContain('secret-value')

    const reveal = await call('/api/configuration/reveal?env=production', { method: 'POST', headers, body: JSON.stringify({ id: token.id }) })
    expect(await reveal.json()).toEqual({ ok: true, value: 'secret-value' })

    const unconfirmed = await call('/api/configuration?env=production', { method: 'POST', headers, body: JSON.stringify({ scopeType: 'project', key: 'TOKEN', kind: 'secret', value: 'rotated-value', expectedVersion: token.version }) })
    expect(unconfirmed.status).toBe(409)
    const rotated = await call('/api/configuration?env=production', { method: 'POST', headers: { ...headers, 'idempotency-key': 'rotate-1' }, body: JSON.stringify({ scopeType: 'project', key: 'TOKEN', kind: 'secret', value: 'rotated-value', expectedVersion: token.version, confirm: 'TOKEN' }) }), rotatedBody = await rotated.json() as any
    expect(rotatedBody).toMatchObject({ ok: true, entry: { key: 'TOKEN', version: 2, backendVersion: '2' }, mutation: { changed: ['TOKEN'] } })
    expect(JSON.stringify(rotatedBody)).not.toContain('rotated-value')

    const exported = await call('/api/configuration/export?env=production&scopeType=project', { headers: { cookie: session } })
    expect(await exported.text()).toBe('PUBLIC_URL="https://example.test"\n')

    const removed = await call('/api/configuration?env=production', { method: 'DELETE', headers, body: JSON.stringify({ id: token.id, expectedVersion: 2, confirm: 'TOKEN' }) })
    expect(await removed.json()).toMatchObject({ ok: true, mutation: { removed: ['TOKEN'] } })
  })
})
