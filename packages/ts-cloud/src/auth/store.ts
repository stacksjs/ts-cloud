import type { SQLQueryBindings } from 'bun:sqlite'
import type { ControlPlaneStore } from '../control-plane/store'
import type { JsonValue } from '../control-plane/types'
import type {
  AuthActionToken,
  AuthActionTokenType,
  AuthIdentity,
  AuthenticationStoreOptions,
  AuthSession,
  CreateAuthIdentityInput,
  CreateAuthSessionInput,
} from './types'
import { createHash, randomBytes } from 'node:crypto'

type Row = Record<string, unknown>

export const AUTH_SESSION_IDLE_TTL_MS: number = 30 * 60 * 1000
export const AUTH_SESSION_ABSOLUTE_TTL_MS: number = 12 * 60 * 60 * 1000
export const AUTH_ACTION_TOKEN_TTL_MS: number = 60 * 60 * 1000

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

export class AuthenticationStore {
  private readonly nowFn: () => Date
  private readonly idFn: () => string

  constructor(private readonly controlPlane: ControlPlaneStore, options: AuthenticationStoreOptions = {}) {
    this.nowFn = options.now ?? (() => new Date())
    this.idFn = options.id ?? (() => crypto.randomUUID())
  }

  private now(): string {
    return this.nowFn().toISOString()
  }

  private run(sql: string, bindings: SQLQueryBindings[]): void {
    this.controlPlane.database.run(sql, bindings)
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

  purgeExpired(): { actionTokens: number, sessions: number } {
    const now = this.now()
    const actionTokens = this.controlPlane.database.run('DELETE FROM auth_action_tokens WHERE expires_at < ? OR consumed_at IS NOT NULL', [now]).changes
    const sessions = this.controlPlane.database.run('DELETE FROM auth_sessions WHERE revoked_at IS NOT NULL OR idle_expires_at < ? OR absolute_expires_at < ?', [now, now]).changes
    return { actionTokens, sessions }
  }
}
