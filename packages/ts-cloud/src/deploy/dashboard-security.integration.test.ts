import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashPassword } from './dashboard-auth'
import { startLocalDashboardServer } from './local-dashboard-server'
import { saveUsers } from './dashboard-users'

let root: string | undefined
let running: Awaited<ReturnType<typeof startLocalDashboardServer>> | undefined

afterEach(() => {
  running?.server.stop(true)
  running = undefined
  if (root)
    rmSync(root, { recursive: true, force: true })
  root = undefined
})

function cookie(response: Response): string {
  return response.headers.get('set-cookie')?.split(';')[0] ?? ''
}

describe('dashboard security posture integration', () => {
  it('blocks a critical production finding, honors an expiring waiver, and allows remediation', async () => {
    root = mkdtempSync(join(tmpdir(), 'ts-cloud-dashboard-security-'))
    saveUsers(root, [{
      username: 'owner', passwordHash: hashPassword('correct horse battery staple'), role: 'admin', sites: {}, name: 'Owner', createdAt: new Date().toISOString(),
    }])
    const syntheticCredential = ['sk', 'live', '51AbCdEfGhIjKlMnOpQrStUvWxYz123456789'].join('_')
    writeFileSync(join(root, 'app.ts'), `export const leaked = ${JSON.stringify(syntheticCredential)}\n`)
    running = await startLocalDashboardServer({
      cwd: root, host: '127.0.0.1', port: 0,
      config: { project: { name: 'Acme', slug: 'acme', region: 'us-east-1' }, environments: { production: { type: 'production' } } } as any,
    })
    const base = running.url.replace(/\/$/, '')
    const dashboardFetch = (path: string, init?: RequestInit): Response | Promise<Response> => running!.server.fetch(new Request(`${base}${path}`, init))
    const login = await dashboardFetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }) })
    const session = cookie(login)
    const headers = { cookie: session, origin: base }
    expect((await dashboardFetch('/security?env=production', { headers: { ...headers, accept: 'text/html' } })).status).toBe(200)

    const scan = await dashboardFetch('/api/security/scan?env=production', { method: 'POST', headers })
    expect(scan.status).toBe(200)
    const posture = await (await dashboardFetch('/api/security/posture?env=production', { headers })).json() as any
    const finding = posture.findings.find((item: any) => item.severity === 'critical')
    expect(finding).toMatchObject({ status: 'open', scannerId: 'source-secrets' })
    const blocked = await dashboardFetch('/api/security/review?env=production', { method: 'POST', headers })
    expect(await blocked.json()).toMatchObject({ decision: { outcome: 'block' } })

    const waiver = await dashboardFetch('/api/security/waivers?env=production', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ findingId: finding.id, policyId: posture.policies[0].id, reason: 'Emergency remediation window with an assigned rotation owner.', expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString() }),
    })
    expect(waiver.status).toBe(201)
    expect(await (await dashboardFetch('/api/security/review?env=production', { method: 'POST', headers })).json()).toMatchObject({ decision: { outcome: 'allow' } })

    writeFileSync(join(root, 'app.ts'), `export const configured = process.env.STRIPE_API_KEY\n`)
    await dashboardFetch('/api/security/scan?env=production', { method: 'POST', headers })
    const remediated = await (await dashboardFetch('/api/security/posture?env=production', { headers })).json() as any
    expect(remediated.findings.find((item: any) => item.id === finding.id)?.status).toBe('resolved')
    expect(await (await dashboardFetch('/api/security/review?env=production', { method: 'POST', headers })).json()).toMatchObject({ decision: { outcome: 'allow' } })
  })
})
