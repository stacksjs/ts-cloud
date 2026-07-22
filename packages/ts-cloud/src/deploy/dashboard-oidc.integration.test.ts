import type { OidcFetch } from '../auth'
import { afterEach, describe, expect, it } from 'bun:test'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLocalDashboardServer } from './local-dashboard-server'

let root: string | undefined
let running: Awaited<ReturnType<typeof startLocalDashboardServer>> | undefined
const priorEnvironment = new Map<string, string | undefined>()

function environment(key: string, value: string): void {
  if (!priorEnvironment.has(key))
    priorEnvironment.set(key, process.env[key])
  process.env[key] = value
}

afterEach(() => {
  running?.server.stop(true)
  running = undefined
  if (root)
    rmSync(root, { recursive: true, force: true })
  root = undefined
  for (const [key, value] of priorEnvironment) {
    if (value === undefined)
      delete process.env[key]
    else
      process.env[key] = value
  }
  priorEnvironment.clear()
})

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function cookie(response: Response): string {
  return response.headers.get('set-cookie')?.split(';')[0] ?? ''
}

describe('dashboard OIDC integration', () => {
  it('configures, signs in, provisions, and disables a provider without exposing tokens', async () => {
    root = mkdtempSync(join(tmpdir(), 'ts-cloud-dashboard-oidc-'))
    environment('TS_CLOUD_UI_USERNAME', 'owner')
    environment('TS_CLOUD_UI_PASSWORD', 'correct horse battery staple')
    const issuer = 'http://localhost:9143'
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwk = keys.publicKey.export({ format: 'jwk' })
    Object.assign(jwk, { kid: 'dashboard-test-key', alg: 'RS256', use: 'sig' })
    let nonce = ''
    let tokenExchange = false
    const oidcFetch: OidcFetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/.well-known/openid-configuration')) {
        return json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/keys`,
          response_types_supported: ['code'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        })
      }
      if (url.endsWith('/keys'))
        return json({ keys: [jwk] })
      if (url.endsWith('/token')) {
        const body = init?.body as URLSearchParams
        expect(body.get('code')).toBe('signed-code')
        expect(body.get('code_verifier')?.length).toBeGreaterThanOrEqual(43)
        tokenExchange = true
        const now = Math.floor(Date.now() / 1000)
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'dashboard-test-key' })).toString('base64url')
        const payload = Buffer.from(JSON.stringify({
          iss: issuer,
          aud: 'dashboard-client',
          sub: 'employee-123',
          nonce,
          email: 'chris@acme.test',
          email_verified: true,
          name: 'Chris',
          iat: now,
          exp: now + 300,
        })).toString('base64url')
        const input = `${header}.${payload}`
        const signature = createSign('SHA256').update(input).end().sign(keys.privateKey).toString('base64url')
        return json({ access_token: 'must-not-persist', refresh_token: 'must-not-persist-either', id_token: `${input}.${signature}` })
      }
      throw new Error(`Unexpected OIDC request: ${url}`)
    }

    running = await startLocalDashboardServer({
      cwd: root,
      host: '127.0.0.1',
      port: 0,
      oidcFetch,
      config: {
        project: { name: 'Acme', slug: 'acme', region: 'us-east-1' },
        environments: { production: { type: 'production' } },
      } as any,
    })
    const base = running.url.replace(/\/$/, '')
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }),
    })
    expect(login.status).toBe(200)
    const ownerCookie = cookie(login)
    expect(ownerCookie).toStartWith('ts_cloud_session=v2.')

    const configured = await fetch(`${base}/api/auth/oidc/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie, origin: base },
      body: JSON.stringify({
        slug: 'workforce',
        name: 'Acme Workforce',
        issuer,
        clientId: 'dashboard-client',
        clientSecret: 'dashboard-secret',
        allowedDomains: ['acme.test'],
        defaultRole: 'viewer',
      }),
    })
    expect(configured.status).toBe(200)
    const provider = (await configured.json() as any).provider
    expect(provider.hasClientSecret).toBe(true)
    expect(JSON.stringify(provider)).not.toContain('dashboard-secret')

    const started = await fetch(`${base}/auth/oidc/workforce/start?return=${encodeURIComponent('/server/sites?env=production')}`, { redirect: 'manual' })
    expect(started.status).toBe(302)
    const authorization = new URL(started.headers.get('location')!)
    nonce = authorization.searchParams.get('nonce')!
    const state = authorization.searchParams.get('state')!
    expect(authorization.searchParams.get('redirect_uri')).toBe(`${base}/auth/oidc/workforce/callback`)

    const callback = await fetch(`${base}/auth/oidc/workforce/callback?code=signed-code&state=${encodeURIComponent(state)}`, { redirect: 'manual' })
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe('/server/sites?env=production')
    expect(tokenExchange).toBe(true)
    const oidcCookie = cookie(callback)
    const me = await fetch(`${base}/api/me`, { headers: { cookie: oidcCookie } })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ user: { username: 'chris', email: 'chris@acme.test' }, membership: { roleTemplate: 'viewer', status: 'active' } })
    const security = await fetch(`${base}/api/auth/security`, { headers: { cookie: oidcCookie } })
    const securityBody = await security.json() as any
    expect(securityBody.sessions.find((session: any) => session.id === securityBody.currentSessionId)?.authMethod).toBe('oidc')

    const disabled = await fetch(`${base}/api/auth/oidc/providers`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie, origin: base },
      body: JSON.stringify({ id: provider.id, enabled: false }),
    })
    expect(disabled.status).toBe(200)
    expect(await disabled.json()).toMatchObject({ provider: { enabled: false, enforceSso: false } })
    const unavailable = await fetch(`${base}/auth/oidc/workforce/start`, { redirect: 'manual' })
    expect(unavailable.headers.get('location')).toBe('/login?sso_error=start')
  }, 20_000)
})
