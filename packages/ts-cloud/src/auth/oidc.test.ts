import { describe, expect, it } from 'bun:test'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { ControlPlaneStore } from '../control-plane'
import { AuthenticationStore } from './store'
import type { OidcFetch } from './oidc'
import { beginOidcAuthorization, completeOidcAuthorization, sanitizeOidcReturnPath } from './oidc'

const NOW = new Date('2026-07-21T12:00:00.000Z')
const ISSUER = 'https://identity.acme.test'
const ORIGIN = 'https://cloud.acme.test'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function fixture() {
  const controlPlane = new ControlPlaneStore({ path: ':memory:', now: () => NOW })
  const auth = new AuthenticationStore(controlPlane, { now: () => NOW, encryptionKey: 'oidc-test-key' })
  const organization = controlPlane.createOrganization({ slug: 'acme', name: 'Acme' })
  const provider = auth.upsertOidcProvider({
    organizationId: organization.id,
    slug: 'workforce',
    name: 'Acme Workforce',
    issuer: ISSUER,
    clientId: 'ts-cloud',
    clientSecret: 'client-secret',
    allowedDomains: ['acme.test'],
  })
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = keys.publicKey.export({ format: 'jwk' })
  Object.assign(jwk, { kid: 'signing-key', alg: 'RS256', use: 'sig' })
  const discovery = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/keys`,
    response_types_supported: ['code'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
  }
  function sign(claims: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'signing-key', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    const input = `${header}.${payload}`
    const signature = createSign('SHA256').update(input).end().sign(keys.privateKey).toString('base64url')
    return `${input}.${signature}`
  }
  return { auth, controlPlane, provider, discovery, jwk, sign }
}

function providerFetch(
  discovery: Record<string, unknown>,
  jwk: object,
  token: (request: { url: string, init?: RequestInit }) => Record<string, unknown>,
): OidcFetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/.well-known/openid-configuration'))
      return json(discovery)
    if (url.endsWith('/keys'))
      return json({ keys: [jwk] })
    if (url.endsWith('/token'))
      return json(token({ url, init }))
    throw new Error(`Unexpected OIDC request: ${url}`)
  })
}

describe('OIDC authorization code flow', () => {
  it('binds state, nonce, PKCE, redirect URI, issuer and a verified domain', async () => {
    const { auth, controlPlane, discovery, jwk, sign } = fixture()
    let nonce = ''
    const requestBodies: URLSearchParams[] = []
    const mockFetch = providerFetch(discovery, jwk, ({ init }) => {
      const body = init?.body as URLSearchParams
      requestBodies.push(body)
      expect(init?.headers).toMatchObject({ authorization: `Basic ${Buffer.from('ts-cloud:client-secret').toString('base64')}` })
      return {
        access_token: 'discard-this-access-token',
        refresh_token: 'discard-this-refresh-token',
        token_type: 'Bearer',
        id_token: sign({
          iss: ISSUER,
          aud: 'ts-cloud',
          sub: 'employee-123',
          nonce,
          email: 'Chris@Acme.Test',
          email_verified: true,
          name: 'Chris',
          iat: Math.floor(NOW.getTime() / 1000),
          exp: Math.floor(NOW.getTime() / 1000) + 300,
        }),
      }
    })
    const started = await beginOidcAuthorization(auth, 'workforce', ORIGIN, '/projects?environment=production', mockFetch)
    const authorization = new URL(started.authorizationUrl)
    nonce = authorization.searchParams.get('nonce')!

    expect(authorization.origin).toBe(ISSUER)
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('code_challenge')).toHaveLength(43)
    expect(authorization.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/oidc/workforce/callback`)
    const completed = await completeOidcAuthorization(auth, {
      providerSlug: 'workforce',
      state: authorization.searchParams.get('state')!,
      code: 'authorization-code',
      origin: ORIGIN,
      now: NOW,
    }, mockFetch)

    expect(completed).toMatchObject({
      returnPath: '/projects?environment=production',
      identity: { subject: 'employee-123', email: 'chris@acme.test', name: 'Chris' },
    })
    expect(requestBodies[0].get('code_verifier')?.length).toBeGreaterThanOrEqual(43)
    expect(requestBodies[0].get('redirect_uri')).toBe(`${ORIGIN}/auth/oidc/workforce/callback`)
    expect(JSON.stringify(controlPlane.database.query('SELECT * FROM auth_oidc_transactions').get())).not.toContain('discard-this')
    controlPlane.close()
  })

  it('rejects invalid state, cross-provider state, replay, and nonce mismatch', async () => {
    const { auth, controlPlane, provider, discovery, jwk, sign } = fixture()
    const other = auth.upsertOidcProvider({
      organizationId: provider.organizationId,
      slug: 'other',
      name: 'Other',
      issuer: 'https://other.acme.test',
      clientId: 'other-client',
      clientSecret: 'other-secret',
      allowedDomains: ['acme.test'],
    })
    expect(other.id).not.toBe(provider.id)
    const mockFetch = providerFetch(discovery, jwk, () => ({
      id_token: sign({
        iss: ISSUER,
        aud: 'ts-cloud',
        sub: 'employee-123',
        nonce: 'wrong-nonce',
        email: 'chris@acme.test',
        email_verified: true,
        iat: Math.floor(NOW.getTime() / 1000),
        exp: Math.floor(NOW.getTime() / 1000) + 300,
      }),
    }))
    const started = await beginOidcAuthorization(auth, 'workforce', ORIGIN, '/', mockFetch)
    const state = new URL(started.authorizationUrl).searchParams.get('state')!

    await expect(completeOidcAuthorization(auth, { providerSlug: 'workforce', state: 'invalid', code: 'code', origin: ORIGIN }, mockFetch)).rejects.toThrow('transaction is invalid')
    await expect(completeOidcAuthorization(auth, { providerSlug: 'other', state, code: 'code', origin: ORIGIN }, mockFetch)).rejects.toThrow('transaction is invalid')
    await expect(completeOidcAuthorization(auth, { providerSlug: 'workforce', state, code: 'code', origin: ORIGIN, now: NOW }, mockFetch)).rejects.toThrow('nonce is invalid')
    await expect(completeOidcAuthorization(auth, { providerSlug: 'workforce', state, code: 'code', origin: ORIGIN }, mockFetch)).rejects.toThrow('consumed')
    controlPlane.close()
  })

  it('fails closed on discovery mismatch or provider outage', async () => {
    const { auth, controlPlane, discovery } = fixture()
    const mismatched: OidcFetch = async () => json({ ...discovery, issuer: 'https://attacker.test' })
    await expect(beginOidcAuthorization(auth, 'workforce', ORIGIN, '/', mismatched)).rejects.toThrow('does not match')

    const unavailable: OidcFetch = async () => json({ error: 'unavailable' }, 503)
    await expect(beginOidcAuthorization(auth, 'workforce', ORIGIN, '/', unavailable)).rejects.toThrow('HTTP 503')
    expect(controlPlane.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM auth_oidc_transactions').get()?.count).toBe(0)
    controlPlane.close()
  })

  it('prevents external return URLs and protocol-relative redirects', () => {
    expect(sanitizeOidcReturnPath('https://attacker.test/phish')).toBe('/')
    expect(sanitizeOidcReturnPath('//attacker.test/phish')).toBe('/')
    expect(sanitizeOidcReturnPath('/\\attacker.test/phish')).toBe('/')
    expect(sanitizeOidcReturnPath('/projects#activity')).toBe('/projects#activity')
  })
})
