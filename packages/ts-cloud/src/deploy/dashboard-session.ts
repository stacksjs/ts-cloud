/**
 * Cookie-backed sessions for the management dashboard.
 *
 * Sessions are stateless signed tokens (`payload.signature`, HMAC-SHA256) so
 * they survive a dashboard restart without a session store. The payload carries
 * only the username and an expiry; every request re-loads the user from the
 * store, so a revoked or downgraded grant takes effect immediately rather than
 * lingering until the token expires.
 *
 * The signing secret is resolved from `TS_CLOUD_DASHBOARD_SECRET`, else
 * generated once and persisted to `.ts-cloud/dashboard-secret`. Rotating it
 * invalidates every outstanding session.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const SESSION_COOKIE = 'ts_cloud_session'
export const SECRET_FILE: string = join('.ts-cloud', 'dashboard-secret')

/** Eight hours: long enough to work through a deploy, short enough to expire. */
export const SESSION_TTL_MS: number = 8 * 60 * 60 * 1000

export interface SessionPayload {
  /** Username the session belongs to. */
  u: string
  /** Expiry, epoch milliseconds. */
  exp: number
  /** Organization membership versions at issuance; changes revoke the session. */
  mv?: Record<string, number>
}

/**
 * Resolve the HMAC signing secret, generating and persisting one on first use.
 * The file is written 0600 — it is equivalent to every dashboard credential.
 */
export function resolveSessionSecret(cwd: string): string {
  const fromEnv = process.env.TS_CLOUD_DASHBOARD_SECRET?.trim()
  if (fromEnv) return fromEnv

  const file = join(cwd, SECRET_FILE)
  try {
    if (existsSync(file)) {
      const saved = readFileSync(file, 'utf8').trim()
      if (saved) return saved
    }
  } catch {
    // Unreadable secret — fall through and mint a new one. Existing sessions
    // become invalid, which is the safe direction to fail.
  }

  const secret = randomBytes(32).toString('base64url')
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${secret}\n`)
    chmodSync(file, 0o600)
  } catch {
    // Can't persist (read-only checkout) — the secret still works for this
    // process, sessions just won't survive a restart.
  }
  return secret
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url')
}

/** Issue a signed session token for `username`. */
export function createSessionToken(
  username: string,
  secret: string,
  ttlMs: number = SESSION_TTL_MS,
  membershipVersions?: Record<string, number>,
): string {
  const payload: SessionPayload = {
    u: username,
    exp: Date.now() + ttlMs,
    ...(membershipVersions ? { mv: membershipVersions } : {}),
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${encoded}.${sign(encoded, secret)}`
}

/**
 * Verify a token and return its payload, or null when the signature is invalid,
 * the token is malformed, or it has expired. Signature is compared before the
 * payload is trusted for anything.
 */
export function verifySessionToken(token: string | undefined, secret: string): SessionPayload | null {
  if (!token) return null

  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null

  const encoded = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  const expected = sign(encoded, secret)

  // timingSafeEqual throws on length mismatch, so length-check first. The
  // length of an HMAC is not a secret.
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload
    if (typeof payload?.u !== 'string' || typeof payload?.exp !== 'number') return null
    if (
      payload.mv !== undefined &&
      (!payload.mv ||
        typeof payload.mv !== 'object' ||
        Array.isArray(payload.mv) ||
        Object.values(payload.mv).some((version) => !Number.isInteger(version) || version < 1))
    )
      return null
    if (Date.now() >= payload.exp) return null
    return payload
  } catch {
    return null
  }
}

/** Read one cookie from a request's `Cookie` header. */
export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

/**
 * Serialize the session cookie. `HttpOnly` keeps it away from page scripts,
 * `SameSite=Lax` blocks cross-site POSTs from carrying it (the dashboard's CSRF
 * defense), and `Secure` is set whenever the dashboard is not on loopback —
 * in production it is always behind TLS.
 */
export function serializeSessionCookie(
  token: string,
  options: { secure: boolean; maxAgeMs?: number } = { secure: true },
): string {
  const maxAge = Math.floor((options.maxAgeMs ?? SESSION_TTL_MS) / 1000)
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ]
  if (options.secure) attrs.push('Secure')
  return attrs.join('; ')
}

/** Cookie that clears the session (logout). */
export function clearSessionCookie(options: { secure: boolean } = { secure: true }): string {
  const attrs = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (options.secure) attrs.push('Secure')
  return attrs.join('; ')
}
