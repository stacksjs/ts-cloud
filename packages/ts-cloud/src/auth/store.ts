import type { SQLQueryBindings } from 'bun:sqlite'
import type { ControlPlaneStore } from '../control-plane/store'
import type { JsonValue } from '../control-plane/types'
import type {
  AuthActionToken,
  AuthActionTokenType,
  AuthIdentity,
  AuthMfaChallenge,
  AuthMfaFactor,
  AuthOidcProvider,
  AuthOidcSubject,
  AuthOidcTransaction,
  AuthenticationStoreOptions,
  AuthSession,
  CreateAuthIdentityInput,
  CreateAuthSessionInput,
  UpsertAuthOidcProviderInput,
} from './types'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { encodeBase32, matchTotpCounter, totpUri } from './totp'

type Row = Record<string, unknown>

export const AUTH_SESSION_IDLE_TTL_MS: number = 30 * 60 * 1000
export const AUTH_SESSION_ABSOLUTE_TTL_MS: number = 12 * 60 * 60 * 1000
export const AUTH_ACTION_TOKEN_TTL_MS: number = 60 * 60 * 1000
export const AUTH_MFA_CHALLENGE_TTL_MS: number = 5 * 60 * 1000
export const AUTH_OIDC_TRANSACTION_TTL_MS: number = 10 * 60 * 1000

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function parseJson(value: unknown): JsonValue {
  if (typeof value !== 'string')
    return {}
  try {
    return JSON.parse(value) as JsonValue
  }
  catch {
    return {}
  }
}

function normalizeUsername(value: string): string {
  const username = value.trim()
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/i.test(username))
    throw new Error('Username must be 2-32 characters: letters, numbers, dot, dash or underscore')
  return username
}

function normalizeEmail(value: string | undefined): string | undefined {
  if (value === undefined || !value.trim())
    return undefined
  const email = value.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
    throw new Error('A valid email address is required')
  return email
}

function normalizeOidcSlug(value: string): string {
  const slug = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(slug))
    throw new Error('OIDC provider slug must be 2-48 lowercase letters, numbers or dashes')
  return slug
}

function normalizeOidcIssuer(value: string): string {
  const issuer = new URL(value.trim())
  if (issuer.search || issuer.hash || issuer.username || issuer.password)
    throw new Error('OIDC issuer cannot contain credentials, a query, or a fragment')
  if (issuer.protocol !== 'https:' && !(issuer.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(issuer.hostname)))
    throw new Error('OIDC issuer must use HTTPS')
  return issuer.href.replace(/\/$/, '')
}

function normalizeOidcDomains(values: string[]): string[] {
  const domains = [...new Set(values.map(value => value.trim().toLowerCase()).filter(Boolean))]
  if (domains.length === 0)
    throw new Error('At least one explicit OIDC email domain is required')
  if (domains.some(domain => !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain) || !domain.includes('.') || domain.includes('..')))
    throw new Error('OIDC email domains must be explicit DNS names without wildcards')
  return domains
}

function normalizeOidcScopes(values: string[] | undefined): string[] {
  const scopes = [...new Set(['openid', ...(values ?? ['email', 'profile'])].map(value => value.trim()).filter(Boolean))]
  if (scopes.some(scope => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope)))
    throw new Error('OIDC scopes contain unsupported characters')
  return scopes
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function mapIdentity(row: Row): AuthIdentity {
  return {
    id: String(row.id),
    actorId: String(row.actor_id),
    username: String(row.username),
    email: optionalString(row.email),
    emailVerifiedAt: optionalString(row.email_verified_at),
    passwordHash: String(row.password_hash),
    credentialVersion: Number(row.credential_version),
    requiresPasswordUpgrade: Number(row.requires_password_upgrade) === 1,
    disabledAt: optionalString(row.disabled_at),
    lastLoginAt: optionalString(row.last_login_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function mapActionToken(row: Row, now: string): AuthActionToken {
  const consumedAt = optionalString(row.consumed_at)
  const expiresAt = String(row.expires_at)
  return {
    id: String(row.id),
    identityId: String(row.identity_id),
    type: String(row.type) as AuthActionTokenType,
    metadata: parseJson(row.metadata),
    expiresAt,
    consumedAt,
    createdAt: String(row.created_at),
    state: consumedAt ? 'consumed' : expiresAt <= now ? 'expired' : 'pending',
  }
}

function mapSession(row: Row, now: string): AuthSession {
  const revokedAt = optionalString(row.revoked_at)
  const idleExpiresAt = String(row.idle_expires_at)
  const absoluteExpiresAt = String(row.absolute_expires_at)
  return {
    id: String(row.id),
    identityId: String(row.identity_id),
    credentialVersion: Number(row.credential_version),
    authMethod: String(row.auth_method) as AuthSession['authMethod'],
    userAgent: optionalString(row.user_agent),
    networkHint: optionalString(row.network_hint),
    createdAt: String(row.created_at),
    lastUsedAt: String(row.last_used_at),
    idleExpiresAt,
    absoluteExpiresAt,
    recentAuthAt: String(row.recent_auth_at),
    mfaAt: optionalString(row.mfa_at),
    revokedAt,
    state: revokedAt ? 'revoked' : idleExpiresAt <= now || absoluteExpiresAt <= now ? 'expired' : 'active',
  }
}

function mapMfaFactor(row: Row): AuthMfaFactor {
  const verifiedAt = optionalString(row.verified_at)
  const disabledAt = optionalString(row.disabled_at)
  return {
    id: String(row.id),
    identityId: String(row.identity_id),
    type: 'totp',
    label: String(row.label),
    createdAt: String(row.created_at),
    verifiedAt,
    disabledAt,
    state: disabledAt ? 'disabled' : verifiedAt ? 'active' : 'pending',
  }
}

function mapMfaChallenge(row: Row, now: string): AuthMfaChallenge {
  const consumedAt = optionalString(row.consumed_at)
  const expiresAt = String(row.expires_at)
  const attempts = Number(row.attempts)
  return {
    id: String(row.id),
    identityId: String(row.identity_id),
    purpose: String(row.purpose) as AuthMfaChallenge['purpose'],
    attempts,
    expiresAt,
    consumedAt,
    createdAt: String(row.created_at),
    state: consumedAt ? 'consumed' : attempts >= 5 ? 'locked' : expiresAt <= now ? 'expired' : 'pending',
  }
}

function stringArray(value: unknown): string[] {
  const parsed = parseJson(value)
  return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []
}

function mapOidcProvider(row: Row): AuthOidcProvider {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    slug: String(row.slug),
    name: String(row.name),
    issuer: String(row.issuer),
    clientId: String(row.client_id),
    hasClientSecret: typeof row.client_secret_ciphertext === 'string' && row.client_secret_ciphertext.length > 0,
    scopes: stringArray(row.scopes),
    allowedDomains: stringArray(row.allowed_domains),
    defaultRole: String(row.default_role) as AuthOidcProvider['defaultRole'],
    enabled: Number(row.enabled) === 1,
    enforceSso: Number(row.enforce_sso) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function mapOidcTransaction(row: Row, now: string): AuthOidcTransaction {
  const consumedAt = optionalString(row.consumed_at)
  const expiresAt = String(row.expires_at)
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    redirectUri: String(row.redirect_uri),
    returnPath: String(row.return_path),
    expiresAt,
    consumedAt,
    createdAt: String(row.created_at),
    state: consumedAt ? 'consumed' : expiresAt <= now ? 'expired' : 'pending',
  }
}

function mapOidcSubject(row: Row): AuthOidcSubject {
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    identityId: String(row.identity_id),
    subject: String(row.subject),
    email: String(row.email),
    linkedAt: String(row.linked_at),
    lastLoginAt: String(row.last_login_at),
  }
}

export class AuthenticationStore {
  private readonly nowFn: () => Date
  private readonly idFn: () => string
  private readonly encryptionKey?: Buffer

  constructor(private readonly controlPlane: ControlPlaneStore, options: AuthenticationStoreOptions = {}) {
    this.nowFn = options.now ?? (() => new Date())
    this.idFn = options.id ?? (() => crypto.randomUUID())
    this.encryptionKey = options.encryptionKey ? createHash('sha256').update(options.encryptionKey).digest() : undefined
  }

  private now(): string {
    return this.nowFn().toISOString()
  }

  private run(sql: string, bindings: SQLQueryBindings[]): void {
    this.controlPlane.database.run(sql, bindings)
  }

  private encrypt(value: string): string {
    if (!this.encryptionKey)
      throw new Error('Authentication encryption key is not configured')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv)
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`
  }

  private decrypt(value: string): string {
    if (!this.encryptionKey)
      throw new Error('Authentication encryption key is not configured')
    const [version, ivRaw, tagRaw, ciphertextRaw] = value.split('.')
    if (version !== 'v1' || !ivRaw || !tagRaw || !ciphertextRaw)
      throw new Error('Encrypted authentication value is unavailable')
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(ivRaw, 'base64url'))
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, 'base64url')), decipher.final()]).toString('utf8')
  }

  createIdentity(input: CreateAuthIdentityInput): AuthIdentity {
    if (!this.controlPlane.getActor(input.actorId))
      throw new Error('Authentication actor was not found')
    const username = normalizeUsername(input.username)
    const email = normalizeEmail(input.email)
    const id = input.id ?? this.idFn()
    const now = this.now()
    this.run(
      `INSERT INTO auth_identities (id, actor_id, username, email, email_verified_at, password_hash, requires_password_upgrade, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.actorId, username, email ?? null, input.emailVerified && email ? now : null, input.passwordHash, input.requiresPasswordUpgrade ? 1 : 0, now, now],
    )
    return this.getIdentity(id)!
  }

  getIdentity(id: string): AuthIdentity | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM auth_identities WHERE id = ?').get(id)
    return row ? mapIdentity(row) : undefined
  }

  getIdentityByActor(actorId: string): AuthIdentity | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM auth_identities WHERE actor_id = ?').get(actorId)
    return row ? mapIdentity(row) : undefined
  }

  getIdentityByUsername(username: string): AuthIdentity | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM auth_identities WHERE username = ? COLLATE NOCASE').get(username.trim())
    return row ? mapIdentity(row) : undefined
  }

  getIdentityByEmail(email: string): AuthIdentity | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM auth_identities WHERE email = ? COLLATE NOCASE').get(email.trim().toLowerCase())
    return row ? mapIdentity(row) : undefined
  }

  listIdentities(): AuthIdentity[] {
    return this.controlPlane.database.query<Row, []>('SELECT * FROM auth_identities ORDER BY username COLLATE NOCASE').all().map(mapIdentity)
  }

  updatePassword(identityId: string, passwordHash: string, options: { requiresUpgrade?: boolean, revokeSessions?: boolean } = {}): AuthIdentity {
    const identity = this.getIdentity(identityId)
    if (!identity)
      throw new Error('Authentication identity was not found')
    const now = this.now()
    this.controlPlane.transaction(() => {
      this.run(
        `UPDATE auth_identities SET password_hash = ?, credential_version = credential_version + 1,
        requires_password_upgrade = ?, updated_at = ? WHERE id = ?`,
        [passwordHash, options.requiresUpgrade ? 1 : 0, now, identityId],
      )
      if (options.revokeSessions !== false)
        this.run('UPDATE auth_sessions SET revoked_at = ? WHERE identity_id = ? AND revoked_at IS NULL', [now, identityId])
    })
    return this.getIdentity(identityId)!
  }

  /** Upgrade password-hash parameters without treating it as a credential change. */
  rehashPassword(identityId: string, passwordHash: string): AuthIdentity {
    const now = this.now()
    this.run('UPDATE auth_identities SET password_hash = ?, requires_password_upgrade = 0, updated_at = ? WHERE id = ?', [passwordHash, now, identityId])
    const identity = this.getIdentity(identityId)
    if (!identity)
      throw new Error('Authentication identity was not found')
    return identity
  }

  setVerifiedEmail(identityId: string, email: string): AuthIdentity {
    const normalized = normalizeEmail(email)!
    const now = this.now()
    this.run('UPDATE auth_identities SET email = ?, email_verified_at = ?, updated_at = ? WHERE id = ?', [normalized, now, now, identityId])
    const identity = this.getIdentity(identityId)
    if (!identity)
      throw new Error('Authentication identity was not found')
    return identity
  }

  recordLogin(identityId: string): AuthIdentity {
    const now = this.now()
    this.run('UPDATE auth_identities SET last_login_at = ?, updated_at = ? WHERE id = ?', [now, now, identityId])
    const identity = this.getIdentity(identityId)
    if (!identity)
      throw new Error('Authentication identity was not found')
    return identity
  }

  setDisabled(identityId: string, disabled: boolean): AuthIdentity {
    const now = this.now()
    this.controlPlane.transaction(() => {
      this.run('UPDATE auth_identities SET disabled_at = ?, credential_version = credential_version + 1, updated_at = ? WHERE id = ?', [disabled ? now : null, now, identityId])
      if (disabled)
        this.run('UPDATE auth_sessions SET revoked_at = ? WHERE identity_id = ? AND revoked_at IS NULL', [now, identityId])
    })
    const identity = this.getIdentity(identityId)
    if (!identity)
      throw new Error('Authentication identity was not found')
    return identity
  }

  createActionToken(identityId: string, type: AuthActionTokenType, options: { ttlMs?: number, metadata?: JsonValue } = {}): { actionToken: AuthActionToken, token: string } {
    if (!this.getIdentity(identityId))
      throw new Error('Authentication identity was not found')
    const token = randomBytes(32).toString('base64url')
    const id = this.idFn()
    const now = this.now()
    const expiresAt = new Date(this.nowFn().getTime() + Math.min(24 * 60 * 60 * 1000, Math.max(60_000, options.ttlMs ?? AUTH_ACTION_TOKEN_TTL_MS))).toISOString()
    this.run(
      'INSERT INTO auth_action_tokens (id, identity_id, type, token_hash, metadata, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, identityId, type, hashToken(token), JSON.stringify(options.metadata ?? {}), expiresAt, now],
    )
    return { actionToken: this.getActionToken(id)!, token }
  }

  getActionToken(id: string): AuthActionToken | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM auth_action_tokens WHERE id = ?').get(id)
    return row ? mapActionToken(row, this.now()) : undefined
  }

  consumeActionToken(token: string, type: AuthActionTokenType): AuthActionToken {
    return this.controlPlane.transaction(() => {
      const row = this.controlPlane.database.query<Row, [string, string]>(
        'SELECT * FROM auth_action_tokens WHERE token_hash = ? AND type = ?',
      ).get(hashToken(token), type)
      if (!row)
        throw new Error('Action token is invalid')
      const actionToken = mapActionToken(row, this.now())
      if (actionToken.state !== 'pending')
        throw new Error(`Action token is ${actionToken.state}`)
      const result = this.controlPlane.database.run(
        'UPDATE auth_action_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?',
        [this.now(), actionToken.id, this.now()],
      )
      if (result.changes !== 1)
        throw new Error('Action token is no longer available')
      return this.getActionToken(actionToken.id)!
    })
  }

  revokeActionTokens(identityId: string, type: AuthActionTokenType): number {
    return this.controlPlane.database.run(
      'UPDATE auth_action_tokens SET consumed_at = ? WHERE identity_id = ? AND type = ? AND consumed_at IS NULL',
      [this.now(), identityId, type],
    ).changes
  }

  createSession(input: CreateAuthSessionInput): { session: AuthSession, token: string } {
    const identity = this.getIdentity(input.identityId)
    if (!identity || identity.disabledAt)
      throw new Error('Authentication identity is unavailable')
    const id = this.idFn()
    const secret = randomBytes(32).toString('base64url')
    const token = `v2.${id}.${secret}`
    const now = this.now()
    const idleTtl = Math.min(24 * 60 * 60 * 1000, Math.max(60_000, input.idleTtlMs ?? AUTH_SESSION_IDLE_TTL_MS))
    const absoluteTtl = Math.min(30 * 24 * 60 * 60 * 1000, Math.max(idleTtl, input.absoluteTtlMs ?? AUTH_SESSION_ABSOLUTE_TTL_MS))
    this.run(
      `INSERT INTO auth_sessions (id, identity_id, token_hash, credential_version, auth_method, user_agent, network_hint,
      created_at, last_used_at, idle_expires_at, absolute_expires_at, recent_auth_at, mfa_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, identity.id, hashToken(token), identity.credentialVersion, input.authMethod ?? 'local', input.userAgent?.slice(0, 256) ?? null,
        input.networkHint?.slice(0, 128) ?? null, now, now, new Date(this.nowFn().getTime() + idleTtl).toISOString(),
        new Date(this.nowFn().getTime() + absoluteTtl).toISOString(), input.recentAuthAt ?? now, input.mfaAt ?? null],
    )
    return { session: this.getSession(id)!, token }
  }

  getSession(id: string): AuthSession | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM auth_sessions WHERE id = ?').get(id)
    return row ? mapSession(row, this.now()) : undefined
  }

  verifySessionToken(token: string): { identity: AuthIdentity, session: AuthSession } | undefined {
    const match = /^v2\.([^.]+)\.[A-Za-z0-9_-]{40,}$/.exec(token)
    if (!match)
      return undefined
    const row = this.controlPlane.database.query<Row, [string, string]>(
      'SELECT * FROM auth_sessions WHERE id = ? AND token_hash = ?',
    ).get(match[1], hashToken(token))
    if (!row)
      return undefined
    const session = mapSession(row, this.now())
    const identity = this.getIdentity(session.identityId)
    if (!identity || identity.disabledAt || session.state !== 'active' || session.credentialVersion !== identity.credentialVersion)
      return undefined
    const now = this.now()
    const idleWindow = new Date(row.idle_expires_at as string).getTime() - new Date(row.last_used_at as string).getTime()
    this.run('UPDATE auth_sessions SET last_used_at = ?, idle_expires_at = ? WHERE id = ?', [now, new Date(Math.min(this.nowFn().getTime() + idleWindow, new Date(session.absoluteExpiresAt).getTime())).toISOString(), session.id])
    return { identity, session: this.getSession(session.id)! }
  }

  listSessions(identityId: string, options: { includeInactive?: boolean } = {}): AuthSession[] {
    const rows = this.controlPlane.database.query<Row, [string]>('SELECT * FROM auth_sessions WHERE identity_id = ? ORDER BY last_used_at DESC').all(identityId)
      .map(row => mapSession(row, this.now()))
    return options.includeInactive ? rows : rows.filter(session => session.state === 'active')
  }

  revokeSession(identityId: string, sessionId: string): boolean {
    return this.controlPlane.database.run(
      'UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND identity_id = ? AND revoked_at IS NULL',
      [this.now(), sessionId, identityId],
    ).changes === 1
  }

  revokeOtherSessions(identityId: string, currentSessionId: string): number {
    return this.controlPlane.database.run(
      'UPDATE auth_sessions SET revoked_at = ? WHERE identity_id = ? AND id != ? AND revoked_at IS NULL',
      [this.now(), identityId, currentSessionId],
    ).changes
  }

  getMfaFactor(identityId: string): AuthMfaFactor | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM auth_mfa_factors WHERE identity_id = ?').get(identityId)
    return row ? mapMfaFactor(row) : undefined
  }

  beginTotpEnrollment(identityId: string, options: { label?: string, issuer?: string } = {}): { factor: AuthMfaFactor, secret: string, uri: string } {
    const identity = this.getIdentity(identityId)
    if (!identity)
      throw new Error('Authentication identity was not found')
    const current = this.getMfaFactor(identityId)
    if (current?.state === 'active')
      throw new Error('MFA is already enabled')
    const secret = encodeBase32(randomBytes(20))
    const label = options.label?.trim().slice(0, 80) || identity.email || identity.username
    const id = current?.id ?? this.idFn()
    const now = this.now()
    this.controlPlane.transaction(() => {
      if (current) {
        this.run(
          'UPDATE auth_mfa_factors SET label = ?, secret_ciphertext = ?, created_at = ?, verified_at = NULL, disabled_at = NULL WHERE id = ?',
          [label, this.encrypt(secret), now, id],
        )
      }
      else {
        this.run(
          'INSERT INTO auth_mfa_factors (id, identity_id, label, secret_ciphertext, created_at) VALUES (?, ?, ?, ?, ?)',
          [id, identityId, label, this.encrypt(secret), now],
        )
      }
      this.run('DELETE FROM auth_recovery_codes WHERE identity_id = ?', [identityId])
    })
    return { factor: this.getMfaFactor(identityId)!, secret, uri: totpUri({ secret, account: label, issuer: options.issuer }) }
  }

  verifyTotpEnrollment(identityId: string, code: string): { factor: AuthMfaFactor, recoveryCodes: string[] } {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM auth_mfa_factors WHERE identity_id = ?').get(identityId)
    if (!row || mapMfaFactor(row).state !== 'pending')
      throw new Error('MFA enrollment is not pending')
    const counter = matchTotpCounter(this.decrypt(String(row.secret_ciphertext)), code, this.nowFn().getTime())
    if (counter === undefined)
      throw new Error('Authenticator code is invalid')
    const recoveryCodes = Array.from({ length: 10 }, () => {
      const value = encodeBase32(randomBytes(8)).slice(0, 12)
      return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8)}`
    })
    const now = this.now()
    this.controlPlane.transaction(() => {
      this.run('UPDATE auth_mfa_factors SET verified_at = ?, disabled_at = NULL, last_used_step = ? WHERE identity_id = ?', [now, counter, identityId])
      this.run('DELETE FROM auth_recovery_codes WHERE identity_id = ?', [identityId])
      for (const recoveryCode of recoveryCodes) {
        this.run(
          'INSERT INTO auth_recovery_codes (id, identity_id, code_hash, created_at) VALUES (?, ?, ?, ?)',
          [this.idFn(), identityId, hashToken(`${identityId}:${recoveryCode.replace(/-/g, '').toUpperCase()}`), now],
        )
      }
    })
    return { factor: this.getMfaFactor(identityId)!, recoveryCodes }
  }

  verifyMfaCode(identityId: string, code: string, options: { consumeRecovery?: boolean } = {}): { valid: boolean, method?: 'totp' | 'recovery' } {
    const factorRow = this.controlPlane.database.query<Row, [string]>(
      'SELECT * FROM auth_mfa_factors WHERE identity_id = ? AND verified_at IS NOT NULL AND disabled_at IS NULL',
    ).get(identityId)
    if (!factorRow)
      return { valid: false }
    const counter = matchTotpCounter(this.decrypt(String(factorRow.secret_ciphertext)), code, this.nowFn().getTime())
    if (counter !== undefined) {
      const accepted = this.controlPlane.database.run(
        'UPDATE auth_mfa_factors SET last_used_step = ? WHERE identity_id = ? AND (last_used_step IS NULL OR last_used_step < ?)',
        [counter, identityId, counter],
      ).changes
      if (accepted === 1)
        return { valid: true, method: 'totp' }
    }
    const normalized = code.replace(/[-\s]/g, '').toUpperCase()
    if (!/^[A-Z2-7]{12}$/.test(normalized))
      return { valid: false }
    const codeHash = hashToken(`${identityId}:${normalized}`)
    const row = this.controlPlane.database.query<Row, [string, string]>(
      'SELECT * FROM auth_recovery_codes WHERE identity_id = ? AND code_hash = ? AND consumed_at IS NULL',
    ).get(identityId, codeHash)
    if (!row)
      return { valid: false }
    if (options.consumeRecovery !== false) {
      const consumed = this.controlPlane.database.run(
        'UPDATE auth_recovery_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
        [this.now(), String(row.id)],
      ).changes
      if (consumed !== 1)
        return { valid: false }
    }
    return { valid: true, method: 'recovery' }
  }

  remainingRecoveryCodes(identityId: string): number {
    return Number(this.controlPlane.database.query<Row, [string]>(
      'SELECT COUNT(*) AS count FROM auth_recovery_codes WHERE identity_id = ? AND consumed_at IS NULL',
    ).get(identityId)?.count ?? 0)
  }

  disableMfa(identityId: string): void {
    const now = this.now()
    this.controlPlane.transaction(() => {
      this.run('UPDATE auth_mfa_factors SET disabled_at = ? WHERE identity_id = ? AND disabled_at IS NULL', [now, identityId])
      this.run('DELETE FROM auth_recovery_codes WHERE identity_id = ?', [identityId])
      this.run('UPDATE auth_mfa_challenges SET consumed_at = ? WHERE identity_id = ? AND consumed_at IS NULL', [now, identityId])
    })
  }

  createMfaChallenge(identityId: string, purpose: AuthMfaChallenge['purpose']): { challenge: AuthMfaChallenge, token: string } {
    if (this.getMfaFactor(identityId)?.state !== 'active')
      throw new Error('MFA is not enabled')
    const token = randomBytes(32).toString('base64url')
    const id = this.idFn()
    const now = this.now()
    const expiresAt = new Date(this.nowFn().getTime() + AUTH_MFA_CHALLENGE_TTL_MS).toISOString()
    this.controlPlane.transaction(() => {
      this.run('UPDATE auth_mfa_challenges SET consumed_at = ? WHERE identity_id = ? AND purpose = ? AND consumed_at IS NULL', [now, identityId, purpose])
      this.run(
        'INSERT INTO auth_mfa_challenges (id, identity_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, identityId, purpose, hashToken(token), expiresAt, now],
      )
    })
    return { challenge: this.getMfaChallenge(id)!, token }
  }

  getMfaChallenge(id: string): AuthMfaChallenge | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM auth_mfa_challenges WHERE id = ?').get(id)
    return row ? mapMfaChallenge(row, this.now()) : undefined
  }

  inspectMfaChallengeToken(token: string, purpose: AuthMfaChallenge['purpose']): AuthMfaChallenge | undefined {
    const row = this.controlPlane.database.query<Row, [string, string]>(
      'SELECT * FROM auth_mfa_challenges WHERE token_hash = ? AND purpose = ?',
    ).get(hashToken(token), purpose)
    return row ? mapMfaChallenge(row, this.now()) : undefined
  }

  completeMfaChallenge(token: string, code: string, purpose: AuthMfaChallenge['purpose']): { identity: AuthIdentity, challenge: AuthMfaChallenge, method: 'totp' | 'recovery' } {
    const row = this.controlPlane.database.query<Row, [string, string]>(
      'SELECT * FROM auth_mfa_challenges WHERE token_hash = ? AND purpose = ?',
    ).get(hashToken(token), purpose)
    if (!row)
      throw new Error('MFA challenge is invalid')
    const challenge = mapMfaChallenge(row, this.now())
    if (challenge.state !== 'pending')
      throw new Error(`MFA challenge is ${challenge.state}`)
    const verification = this.verifyMfaCode(challenge.identityId, code)
    if (!verification.valid || !verification.method) {
      this.run('UPDATE auth_mfa_challenges SET attempts = attempts + 1 WHERE id = ?', [challenge.id])
      throw new Error('Authenticator or recovery code is invalid')
    }
    const consumed = this.controlPlane.database.run(
      'UPDATE auth_mfa_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND attempts < 5 AND expires_at > ?',
      [this.now(), challenge.id, this.now()],
    ).changes
    if (consumed !== 1)
      throw new Error('MFA challenge is no longer available')
    return { identity: this.getIdentity(challenge.identityId)!, challenge: this.getMfaChallenge(challenge.id)!, method: verification.method }
  }

  markSessionStepUp(sessionId: string, mfa: boolean = false): AuthSession {
    const now = this.now()
    this.run('UPDATE auth_sessions SET recent_auth_at = ?, mfa_at = CASE WHEN ? = 1 THEN ? ELSE mfa_at END WHERE id = ? AND revoked_at IS NULL', [now, mfa ? 1 : 0, now, sessionId])
    const session = this.getSession(sessionId)
    if (!session)
      throw new Error('Authentication session was not found')
    return session
  }

  isRecentlyAuthenticated(session: AuthSession, maxAgeMs: number = 10 * 60 * 1000): boolean {
    return this.nowFn().getTime() - new Date(session.recentAuthAt).getTime() <= maxAgeMs
  }

  upsertOidcProvider(input: UpsertAuthOidcProviderInput): AuthOidcProvider {
    if (!this.controlPlane.getOrganization(input.organizationId))
      throw new Error('OIDC provider organization was not found')
    const slug = normalizeOidcSlug(input.slug)
    const name = input.name.trim().slice(0, 80)
    if (!name)
      throw new Error('OIDC provider name is required')
    const issuer = normalizeOidcIssuer(input.issuer)
    const clientId = input.clientId.trim()
    if (!clientId || clientId.length > 512)
      throw new Error('OIDC client ID is required')
    const scopes = normalizeOidcScopes(input.scopes)
    const domains = normalizeOidcDomains(input.allowedDomains)
    const existing = input.id ? this.getOidcProvider(input.id) : this.getOidcProviderBySlug(slug)
    const now = this.now()
    if (existing) {
      if (existing.organizationId !== input.organizationId)
        throw new Error('OIDC provider belongs to another organization')
      this.run(
        `UPDATE auth_oidc_providers SET slug = ?, name = ?, issuer = ?, client_id = ?,
        client_secret_ciphertext = COALESCE(?, client_secret_ciphertext), scopes = ?, allowed_domains = ?,
        default_role = ?, enabled = ?, enforce_sso = ?, updated_at = ? WHERE id = ?`,
        [slug, name, issuer, clientId, input.clientSecret ? this.encrypt(input.clientSecret) : null,
          JSON.stringify(scopes), JSON.stringify(domains), input.defaultRole ?? existing.defaultRole,
          input.enabled ?? existing.enabled ? 1 : 0, input.enforceSso ?? existing.enforceSso ? 1 : 0, now, existing.id],
      )
      return this.getOidcProvider(existing.id)!
    }
    if (!input.clientSecret)
      throw new Error('OIDC client secret is required for a new provider')
    const id = input.id ?? this.idFn()
    this.run(
      `INSERT INTO auth_oidc_providers (id, organization_id, slug, name, issuer, client_id,
      client_secret_ciphertext, scopes, allowed_domains, default_role, enabled, enforce_sso, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.organizationId, slug, name, issuer, clientId, this.encrypt(input.clientSecret), JSON.stringify(scopes),
        JSON.stringify(domains), input.defaultRole ?? 'viewer', input.enabled === false ? 0 : 1, input.enforceSso ? 1 : 0, now, now],
    )
    return this.getOidcProvider(id)!
  }

  getOidcProvider(id: string): AuthOidcProvider | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM auth_oidc_providers WHERE id = ?').get(id)
    return row ? mapOidcProvider(row) : undefined
  }

  getOidcProviderBySlug(slug: string): AuthOidcProvider | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM auth_oidc_providers WHERE slug = ? COLLATE NOCASE').get(slug.trim())
    return row ? mapOidcProvider(row) : undefined
  }

  listOidcProviders(organizationId?: string, options: { includeDisabled?: boolean } = {}): AuthOidcProvider[] {
    const rows = organizationId
      ? this.controlPlane.database.query<Row, [string]>('SELECT * FROM auth_oidc_providers WHERE organization_id = ? ORDER BY name COLLATE NOCASE').all(organizationId)
      : this.controlPlane.database.query<Row, []>('SELECT * FROM auth_oidc_providers ORDER BY name COLLATE NOCASE').all()
    return rows.map(mapOidcProvider).filter(provider => options.includeDisabled || provider.enabled)
  }

  setOidcProviderEnabled(providerId: string, enabled: boolean): AuthOidcProvider {
    const now = this.now()
    const result = this.controlPlane.database.run(
      'UPDATE auth_oidc_providers SET enabled = ?, enforce_sso = CASE WHEN ? = 0 THEN 0 ELSE enforce_sso END, updated_at = ? WHERE id = ?',
      [enabled ? 1 : 0, enabled ? 1 : 0, now, providerId],
    )
    if (result.changes !== 1)
      throw new Error('OIDC provider was not found')
    if (!enabled)
      this.run('UPDATE auth_oidc_transactions SET consumed_at = ? WHERE provider_id = ? AND consumed_at IS NULL', [now, providerId])
    return this.getOidcProvider(providerId)!
  }

  getOidcProviderCredentials(providerId: string): { provider: AuthOidcProvider, clientSecret: string } {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM auth_oidc_providers WHERE id = ?').get(providerId)
    if (!row || typeof row.client_secret_ciphertext !== 'string')
      throw new Error('OIDC provider credentials are unavailable')
    return { provider: mapOidcProvider(row), clientSecret: this.decrypt(row.client_secret_ciphertext) }
  }

  beginOidcTransaction(providerId: string, redirectUri: string, returnPath: string): {
    transaction: AuthOidcTransaction
    state: string
    nonce: string
    verifier: string
  } {
    const provider = this.getOidcProvider(providerId)
    if (!provider?.enabled)
      throw new Error('OIDC provider is unavailable')
    const id = this.idFn()
    const state = randomBytes(32).toString('base64url')
    const nonce = randomBytes(32).toString('base64url')
    const verifier = randomBytes(64).toString('base64url')
    const now = this.now()
    const expiresAt = new Date(this.nowFn().getTime() + AUTH_OIDC_TRANSACTION_TTL_MS).toISOString()
    this.run(
      `INSERT INTO auth_oidc_transactions (id, provider_id, state_hash, nonce_ciphertext, verifier_ciphertext,
      redirect_uri, return_path, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, providerId, hashToken(state), this.encrypt(nonce), this.encrypt(verifier), redirectUri, returnPath, expiresAt, now],
    )
    return { transaction: this.getOidcTransaction(id)!, state, nonce, verifier }
  }

  getOidcTransaction(id: string): AuthOidcTransaction | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM auth_oidc_transactions WHERE id = ?').get(id)
    return row ? mapOidcTransaction(row, this.now()) : undefined
  }

  consumeOidcTransaction(providerId: string, state: string): { transaction: AuthOidcTransaction, nonce: string, verifier: string } {
    return this.controlPlane.transaction(() => {
      const row = this.controlPlane.database.query<Row, [string, string]>(
        'SELECT * FROM auth_oidc_transactions WHERE provider_id = ? AND state_hash = ?',
      ).get(providerId, hashToken(state))
      if (!row)
        throw new Error('OIDC transaction is invalid')
      const transaction = mapOidcTransaction(row, this.now())
      if (transaction.state !== 'pending')
        throw new Error(`OIDC transaction is ${transaction.state}`)
      const consumed = this.controlPlane.database.run(
        'UPDATE auth_oidc_transactions SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?',
        [this.now(), transaction.id, this.now()],
      ).changes
      if (consumed !== 1)
        throw new Error('OIDC transaction is no longer available')
      return {
        transaction: this.getOidcTransaction(transaction.id)!,
        nonce: this.decrypt(String(row.nonce_ciphertext)),
        verifier: this.decrypt(String(row.verifier_ciphertext)),
      }
    })
  }

  getOidcSubject(providerId: string, subject: string): AuthOidcSubject | undefined {
    const row = this.controlPlane.database.query<Row, [string, string]>(
      'SELECT * FROM auth_oidc_subjects WHERE provider_id = ? AND subject = ?',
    ).get(providerId, subject)
    return row ? mapOidcSubject(row) : undefined
  }

  linkOidcSubject(providerId: string, identityId: string, subject: string, email: string): AuthOidcSubject {
    const provider = this.getOidcProvider(providerId)
    const identity = this.getIdentity(identityId)
    if (!provider || !identity)
      throw new Error('OIDC provider or identity was not found')
    const normalizedEmail = normalizeEmail(email)!
    if (!subject.trim() || subject.length > 512)
      throw new Error('OIDC subject is invalid')
    const existing = this.getOidcSubject(providerId, subject)
    if (existing && existing.identityId !== identityId)
      throw new Error('OIDC subject is already linked to another identity')
    const now = this.now()
    if (existing) {
      this.run('UPDATE auth_oidc_subjects SET email = ?, last_login_at = ? WHERE id = ?', [normalizedEmail, now, existing.id])
      return this.getOidcSubject(providerId, subject)!
    }
    const id = this.idFn()
    this.run(
      'INSERT INTO auth_oidc_subjects (id, provider_id, identity_id, subject, email, linked_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, providerId, identityId, subject, normalizedEmail, now, now],
    )
    return this.getOidcSubject(providerId, subject)!
  }

  purgeExpired(): { actionTokens: number, sessions: number } {
    const now = this.now()
    const actionTokens = this.controlPlane.database.run('DELETE FROM auth_action_tokens WHERE expires_at < ? OR consumed_at IS NOT NULL', [now]).changes
    const sessions = this.controlPlane.database.run('DELETE FROM auth_sessions WHERE revoked_at IS NOT NULL OR idle_expires_at < ? OR absolute_expires_at < ?', [now, now]).changes
    this.controlPlane.database.run('DELETE FROM auth_mfa_challenges WHERE consumed_at IS NOT NULL OR expires_at < ?', [now])
    this.controlPlane.database.run('DELETE FROM auth_oidc_transactions WHERE consumed_at IS NOT NULL OR expires_at < ?', [now])
    return { actionTokens, sessions }
  }
}
