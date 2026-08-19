import type { AuthenticationStore } from './store'
import type { AuthOidcProvider } from './types'
import { constants, createHash, createPublicKey, createVerify, timingSafeEqual } from 'node:crypto'

export interface OidcDiscoveryDocument {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  response_types_supported?: string[]
  id_token_signing_alg_values_supported?: string[]
  code_challenge_methods_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
}

export interface VerifiedOidcIdentity {
  provider: AuthOidcProvider
  subject: string
  email: string
  name?: string
  claims: Record<string, unknown>
}

export type OidcFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const SUPPORTED_ALGORITHMS = new Set(['RS256', 'PS256', 'ES256'])
const CLOCK_SKEW_SECONDS = 60

function secureUrl(value: string, label: string): URL {
  const url = new URL(value)
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error(`${label} must use HTTPS`)
  if (url.username || url.password || url.hash) throw new Error(`${label} contains unsupported URL components`)
  return url
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`)
  return value as Record<string, unknown>
}

async function readJson(response: Response, label: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`)
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json'))
    throw new Error(`${label} returned an unsupported content type`)
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > 1024 * 1024) throw new Error(`${label} response is too large`)
  const body = await response.text()
  if (body.length > 1024 * 1024) throw new Error(`${label} response is too large`)
  try {
    return readObject(JSON.parse(body), label)
  } catch (error) {
    if (error instanceof Error && error.message === `${label} is invalid`) throw error
    throw new Error(`${label} returned invalid JSON`)
  }
}

function safeEquals(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest()
  const rightHash = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftHash, rightHash)
}

export function sanitizeOidcReturnPath(value: string | undefined): string {
  if (!value) return '/'
  const path = value.trim()
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\r\n]/.test(path)) return '/'
  try {
    const parsed = new URL(path, 'https://local.invalid')
    return parsed.origin === 'https://local.invalid' ? `${parsed.pathname}${parsed.search}${parsed.hash}` : '/'
  } catch {
    return '/'
  }
}

export async function discoverOidcProvider(
  provider: AuthOidcProvider,
  fetchFn: OidcFetch = fetch,
): Promise<OidcDiscoveryDocument> {
  const issuer = secureUrl(provider.issuer, 'OIDC issuer')
  const discoveryUrl = new URL(`${issuer.pathname.replace(/\/$/, '')}/.well-known/openid-configuration`, issuer.origin)
  const document = await readJson(
    await fetchFn(discoveryUrl, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    }),
    'OIDC discovery',
  )
  if (document.issuer !== provider.issuer) throw new Error('OIDC discovery issuer does not match the configured issuer')
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (typeof document[field] !== 'string') throw new Error(`OIDC discovery is missing ${field}`)
    secureUrl(document[field], `OIDC ${field}`)
  }
  if (Array.isArray(document.response_types_supported) && !document.response_types_supported.includes('code'))
    throw new Error('OIDC provider does not support authorization code flow')
  if (
    Array.isArray(document.code_challenge_methods_supported) &&
    !document.code_challenge_methods_supported.includes('S256')
  )
    throw new Error('OIDC provider does not support PKCE S256')
  const algorithms = Array.isArray(document.id_token_signing_alg_values_supported)
    ? document.id_token_signing_alg_values_supported.filter((value) => typeof value === 'string')
    : []
  if (algorithms.length > 0 && !algorithms.some((algorithm) => SUPPORTED_ALGORITHMS.has(algorithm)))
    throw new Error('OIDC provider does not offer a supported ID-token signing algorithm')
  return document as unknown as OidcDiscoveryDocument
}

export async function beginOidcAuthorization(
  auth: AuthenticationStore,
  providerSlug: string,
  origin: string,
  returnPath?: string,
  fetchFn: OidcFetch = fetch,
): Promise<{ authorizationUrl: string; expiresAt: string }> {
  const provider = auth.getOidcProviderBySlug(providerSlug)
  if (!provider?.enabled) throw new Error('OIDC provider is unavailable')
  const applicationOrigin = secureUrl(origin, 'Application origin').origin
  const discovery = await discoverOidcProvider(provider, fetchFn)
  const redirectUri = `${applicationOrigin}/auth/oidc/${encodeURIComponent(provider.slug)}/callback`
  const transaction = auth.beginOidcTransaction(provider.id, redirectUri, sanitizeOidcReturnPath(returnPath))
  const authorizationUrl = new URL(discovery.authorization_endpoint)
  authorizationUrl.searchParams.set('response_type', 'code')
  authorizationUrl.searchParams.set('client_id', provider.clientId)
  authorizationUrl.searchParams.set('redirect_uri', redirectUri)
  authorizationUrl.searchParams.set('scope', provider.scopes.join(' '))
  authorizationUrl.searchParams.set('state', transaction.state)
  authorizationUrl.searchParams.set('nonce', transaction.nonce)
  authorizationUrl.searchParams.set(
    'code_challenge',
    createHash('sha256').update(transaction.verifier).digest('base64url'),
  )
  authorizationUrl.searchParams.set('code_challenge_method', 'S256')
  return { authorizationUrl: authorizationUrl.href, expiresAt: transaction.transaction.expiresAt }
}

function parseJwt(token: string): {
  header: Record<string, unknown>
  claims: Record<string, unknown>
  signingInput: string
  signature: Buffer
} {
  if (token.length > 32 * 1024) throw new Error('OIDC ID token is too large')
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error('OIDC ID token is malformed')
  try {
    return {
      header: readObject(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')), 'OIDC ID-token header'),
      claims: readObject(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')), 'OIDC ID-token claims'),
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2], 'base64url'),
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('OIDC')) throw error
    throw new Error('OIDC ID token is malformed')
  }
}

async function verifyIdTokenSignature(
  token: string,
  discovery: OidcDiscoveryDocument,
  fetchFn: OidcFetch,
): Promise<Record<string, unknown>> {
  const parsed = parseJwt(token)
  const algorithm = typeof parsed.header.alg === 'string' ? parsed.header.alg : ''
  const keyId = typeof parsed.header.kid === 'string' ? parsed.header.kid : ''
  if (!SUPPORTED_ALGORITHMS.has(algorithm) || !keyId) throw new Error('OIDC ID token uses an unsupported signing key')
  if (
    discovery.id_token_signing_alg_values_supported &&
    !discovery.id_token_signing_alg_values_supported.includes(algorithm)
  )
    throw new Error('OIDC ID-token algorithm was not advertised by the provider')
  const jwks = await readJson(
    await fetchFn(discovery.jwks_uri, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    }),
    'OIDC signing-key request',
  )
  if (!Array.isArray(jwks.keys)) throw new Error('OIDC signing-key response is invalid')
  const jwk = jwks.keys.find((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
    const key = candidate as Record<string, unknown>
    return key.kid === keyId && (!key.alg || key.alg === algorithm) && (!key.use || key.use === 'sig')
  }) as Record<string, unknown> | undefined
  if (!jwk) throw new Error('OIDC ID-token signing key was not found')
  const key = createPublicKey({ key: jwk, format: 'jwk' })
  const verifier = createVerify('SHA256').update(parsed.signingInput).end()
  const valid =
    algorithm === 'PS256'
      ? verifier.verify({ key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, parsed.signature)
      : algorithm === 'ES256'
        ? verifier.verify({ key, dsaEncoding: 'ieee-p1363' }, parsed.signature)
        : verifier.verify(key, parsed.signature)
  if (!valid) throw new Error('OIDC ID-token signature is invalid')
  return parsed.claims
}

function verifyIdTokenClaims(
  claims: Record<string, unknown>,
  provider: AuthOidcProvider,
  nonce: string,
  now: Date,
): VerifiedOidcIdentity {
  if (claims.iss !== provider.issuer) throw new Error('OIDC ID-token issuer is invalid')
  const audience =
    typeof claims.aud === 'string'
      ? [claims.aud]
      : Array.isArray(claims.aud)
        ? claims.aud.filter((value) => typeof value === 'string')
        : []
  if (!audience.includes(provider.clientId)) throw new Error('OIDC ID-token audience is invalid')
  if ((audience.length > 1 || claims.azp !== undefined) && claims.azp !== provider.clientId)
    throw new Error('OIDC ID-token authorized party is invalid')
  const timestamp = Math.floor(now.getTime() / 1000)
  if (typeof claims.exp !== 'number' || claims.exp < timestamp - CLOCK_SKEW_SECONDS)
    throw new Error('OIDC ID token is expired')
  if (typeof claims.iat !== 'number' || claims.iat > timestamp + CLOCK_SKEW_SECONDS)
    throw new Error('OIDC ID-token issued-at time is invalid')
  if (typeof claims.nonce !== 'string' || !safeEquals(claims.nonce, nonce))
    throw new Error('OIDC ID-token nonce is invalid')
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 512)
    throw new Error('OIDC ID-token subject is invalid')
  if (claims.email_verified !== true || typeof claims.email !== 'string')
    throw new Error('OIDC provider did not return a verified email address')
  const email = claims.email.trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error('OIDC provider returned an invalid email address')
  const domain = email.split('@')[1]
  if (!domain || !provider.allowedDomains.includes(domain))
    throw new Error('OIDC email domain is not allowed for this organization')
  return {
    provider,
    subject: claims.sub,
    email,
    name: typeof claims.name === 'string' ? claims.name.slice(0, 120) : undefined,
    claims,
  }
}

export async function completeOidcAuthorization(
  auth: AuthenticationStore,
  input: { providerSlug: string; state: string; code: string; origin: string; now?: Date },
  fetchFn: OidcFetch = fetch,
): Promise<{ identity: VerifiedOidcIdentity; returnPath: string }> {
  const provider = auth.getOidcProviderBySlug(input.providerSlug)
  if (!provider?.enabled) throw new Error('OIDC provider is unavailable')
  if (!input.state || input.state.length > 512 || !input.code || input.code.length > 4096)
    throw new Error('OIDC callback is incomplete')
  const applicationOrigin = secureUrl(input.origin, 'Application origin').origin
  const consumed = auth.consumeOidcTransaction(provider.id, input.state)
  const expectedRedirectUri = `${applicationOrigin}/auth/oidc/${encodeURIComponent(provider.slug)}/callback`
  if (consumed.transaction.redirectUri !== expectedRedirectUri)
    throw new Error('OIDC callback redirect URI does not match the original request')
  const { clientSecret } = auth.getOidcProviderCredentials(provider.id)
  const discovery = await discoverOidcProvider(provider, fetchFn)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: consumed.transaction.redirectUri,
    code_verifier: consumed.verifier,
  })
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  }
  const authMethods = discovery.token_endpoint_auth_methods_supported ?? ['client_secret_basic']
  if (authMethods.includes('client_secret_basic')) {
    const encodeCredential = (value: string): string => new URLSearchParams({ value }).toString().slice('value='.length)
    const credentials = `${encodeCredential(provider.clientId)}:${encodeCredential(clientSecret)}`
    headers.authorization = `Basic ${Buffer.from(credentials).toString('base64')}`
  } else if (authMethods.includes('client_secret_post')) {
    body.set('client_id', provider.clientId)
    body.set('client_secret', clientSecret)
  } else {
    throw new Error('OIDC provider does not support a configured client authentication method')
  }
  const tokens = await readJson(
    await fetchFn(discovery.token_endpoint, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    }),
    'OIDC token exchange',
  )
  if (typeof tokens.id_token !== 'string') throw new Error('OIDC token response did not include an ID token')
  const claims = await verifyIdTokenSignature(tokens.id_token, discovery, fetchFn)
  return {
    identity: verifyIdTokenClaims(claims, provider, consumed.nonce, input.now ?? new Date()),
    returnPath: consumed.transaction.returnPath,
  }
}
