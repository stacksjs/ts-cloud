import type { SQLQueryBindings } from 'bun:sqlite'
import type { AuthorizationCapability, AuthorizationScope, ControlPlaneStore } from '../control-plane'
import type { ApiIdempotencyRecord, ApiToken, ApiTokenPrincipal, CreateApiTokenInput, CreateServiceAccountInput, ServiceAccount } from './types'
import { createHash, randomBytes } from 'node:crypto'
import { AUTHORIZATION_CAPABILITIES, authorizeOrganization } from '../control-plane'

type Row = Record<string, unknown>

const CAPABILITIES = new Set<string>(AUTHORIZATION_CAPABILITIES)
export const API_TOKEN_DEFAULT_TTL_MS: number = 90 * 24 * 60 * 60 * 1000
export const API_TOKEN_MAX_TTL_MS: number = 365 * 24 * 60 * 60 * 1000
export const API_IDEMPOTENCY_TTL_MS: number = 24 * 60 * 60 * 1000

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function parseCapabilities(value: unknown): AuthorizationCapability[] {
  try {
    const parsed = JSON.parse(String(value)) as unknown[]
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string' && CAPABILITIES.has(item)) as AuthorizationCapability[] : []
  }
  catch {
    return []
  }
}

function scope(row: Row): AuthorizationScope {
  const type = String(row.scope_type) as AuthorizationScope['type']
  return type === 'organization' ? { type } : { type, id: String(row.scope_id) } as AuthorizationScope
}

function mapServiceAccount(row: Row): ServiceAccount {
  const disabledAt = optionalString(row.disabled_at)
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    actorId: String(row.actor_id),
    slug: String(row.slug),
    name: String(row.name),
    description: optionalString(row.description),
    createdByActorId: optionalString(row.created_by_actor_id),
    disabledAt,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    state: disabledAt ? 'disabled' : 'active',
  }
}

function mapToken(row: Row, now: string): ApiToken {
  const revokedAt = optionalString(row.revoked_at)
  const expiresAt = String(row.expires_at)
  return {
    id: String(row.id),
    serviceAccountId: String(row.service_account_id),
    name: String(row.name),
    prefix: String(row.token_prefix),
    capabilities: parseCapabilities(row.capabilities),
    scope: scope(row),
    expiresAt,
    lastUsedAt: optionalString(row.last_used_at),
    lastNetworkHint: optionalString(row.last_network_hint),
    revokedAt,
    rotatedFromTokenId: optionalString(row.rotated_from_token_id),
    createdByActorId: optionalString(row.created_by_actor_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    state: revokedAt ? 'revoked' : expiresAt <= now ? 'expired' : 'active',
  }
}

function mapIdempotency(row: Row): ApiIdempotencyRecord {
  let responseBody: unknown = {}
  try { responseBody = JSON.parse(String(row.response_body)) }
  catch { /* invalid historical response is treated as empty */ }
  return {
    id: String(row.id),
    tokenId: String(row.token_id),
    key: String(row.idempotency_key),
    requestHash: String(row.request_hash),
    operationId: optionalString(row.operation_id),
    responseStatus: Number(row.response_status),
    responseBody,
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
  }
}

export class AutomationIdentityStore {
  private readonly nowFn: () => Date
  private readonly idFn: () => string

  constructor(private readonly controlPlane: ControlPlaneStore, options: { now?: () => Date, id?: () => string } = {}) {
    this.nowFn = options.now ?? (() => new Date())
    this.idFn = options.id ?? (() => crypto.randomUUID())
  }

  private now(): string { return this.nowFn().toISOString() }

  private run(sql: string, bindings: SQLQueryBindings[]): void {
    this.controlPlane.database.run(sql, bindings)
  }

  createServiceAccount(input: CreateServiceAccountInput): { serviceAccount: ServiceAccount, membership: ApiTokenPrincipal['membership'] } {
    if (!this.controlPlane.getOrganization(input.organizationId))
      throw new Error('Service-account organization was not found')
    const slug = input.slug.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(slug))
      throw new Error('Service-account slug must be 2-48 lowercase letters, numbers or dashes')
    const name = input.name.trim().slice(0, 100)
    if (!name)
      throw new Error('Service-account name is required')
    const actor = this.controlPlane.createActor({
      kind: 'service_account',
      externalId: `service-account:${input.organizationId}:${slug}`,
      displayName: name,
      metadata: { source: 'api', serviceAccountSlug: slug },
    })
    const id = this.idFn()
    const now = this.now()
    this.run(
      `INSERT INTO service_accounts (id, organization_id, actor_id, slug, name, description, created_by_actor_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.organizationId, actor.id, slug, name, input.description?.trim().slice(0, 500) || null, input.createdByActorId ?? null, now, now],
    )
    const membership = this.controlPlane.createMembership({
      organizationId: input.organizationId,
      actorId: actor.id,
      roleTemplate: input.roleTemplate,
      scope: input.scope,
      source: 'manual',
      performedByActorId: input.createdByActorId,
    })
    const membershipScope = input.scope ?? { type: 'organization' as const }
    this.controlPlane.appendEvent({ organizationId: input.organizationId, actorId: input.createdByActorId, type: 'api.service_account.created', payload: { serviceAccountId: id, roleTemplate: input.roleTemplate, scope: { type: membershipScope.type, id: membershipScope.id ?? null } } })
    return { serviceAccount: this.getServiceAccount(id)!, membership }
  }

  getServiceAccount(id: string): ServiceAccount | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM service_accounts WHERE id = ?').get(id)
    return row ? mapServiceAccount(row) : undefined
  }

  getServiceAccountBySlug(organizationId: string, slug: string): ServiceAccount | undefined {
    const row = this.controlPlane.database.query<Row, [string, string]>('SELECT * FROM service_accounts WHERE organization_id = ? AND slug = ? COLLATE NOCASE').get(organizationId, slug.trim())
    return row ? mapServiceAccount(row) : undefined
  }

  listServiceAccounts(organizationId: string, options: { includeDisabled?: boolean } = {}): ServiceAccount[] {
    return this.controlPlane.database.query<Row, [string]>('SELECT * FROM service_accounts WHERE organization_id = ? ORDER BY name COLLATE NOCASE').all(organizationId)
      .map(mapServiceAccount).filter(account => options.includeDisabled || account.state === 'active')
  }

  disableServiceAccount(id: string): ServiceAccount {
    const account = this.getServiceAccount(id)
    if (!account)
      throw new Error('Service account was not found')
    const now = this.now()
    this.controlPlane.transaction(() => {
      this.run('UPDATE service_accounts SET disabled_at = ?, updated_at = ? WHERE id = ?', [now, now, id])
      this.run('UPDATE api_tokens SET revoked_at = ?, updated_at = ? WHERE service_account_id = ? AND revoked_at IS NULL', [now, now, id])
      const membership = this.controlPlane.getMembershipForActor(account.organizationId, account.actorId)
      if (membership?.status === 'active')
        this.controlPlane.revokeMembership(membership.id)
    })
    return this.getServiceAccount(id)!
  }

  createToken(input: CreateApiTokenInput): { token: ApiToken, secret: string } {
    const account = this.getServiceAccount(input.serviceAccountId)
    if (!account || account.state !== 'active')
      throw new Error('Service account is unavailable')
    const membership = this.controlPlane.getMembershipForActor(account.organizationId, account.actorId)
    if (!membership || membership.status !== 'active')
      throw new Error('Service-account membership is unavailable')
    const capabilities = [...new Set(input.capabilities)]
    if (capabilities.length === 0 || capabilities.some(capability => !CAPABILITIES.has(capability)))
      throw new Error('API token requires valid explicit capabilities')
    const tokenScope = input.scope ?? membership.scope
    const target = this.controlPlane.resolveAuthorizationTarget(account.organizationId, tokenScope)
    if (!target)
      throw new Error('API token scope was not found in this organization')
    for (const capability of capabilities) {
      if (!authorizeOrganization({ membership, grants: this.controlPlane.listGrants(membership.id), capability, target }).allowed)
        throw new Error(`Service-account membership does not grant ${capability} at the token scope`)
    }
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : new Date(this.nowFn().getTime() + API_TOKEN_DEFAULT_TTL_MS)
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= this.nowFn().getTime() + 60_000 || expiresAt.getTime() > this.nowFn().getTime() + API_TOKEN_MAX_TTL_MS)
      throw new Error('API token expiry must be between one minute and one year from now')
    const id = this.idFn()
    const raw = randomBytes(32).toString('base64url')
    const secret = `tsc_v1.${id}.${raw}`
    const prefix = `tsc_v1.${id.slice(0, 8)}`
    const now = this.now()
    this.run(
      `INSERT INTO api_tokens (id, service_account_id, name, token_hash, token_prefix, capabilities, scope_type, scope_id,
      expires_at, rotated_from_token_id, created_by_actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, account.id, input.name.trim().slice(0, 100) || 'API token', hash(secret), prefix, JSON.stringify(capabilities.sort()), tokenScope.type,
        tokenScope.type === 'organization' ? null : tokenScope.id ?? null, expiresAt.toISOString(), input.rotatedFromTokenId ?? null, input.createdByActorId ?? null, now, now],
    )
    this.controlPlane.appendEvent({ organizationId: account.organizationId, actorId: input.createdByActorId, type: 'api.token.created', payload: { serviceAccountId: account.id, tokenId: id, prefix, capabilities, scope: { type: tokenScope.type, id: tokenScope.id ?? null }, expiresAt: expiresAt.toISOString(), rotatedFromTokenId: input.rotatedFromTokenId ?? null } })
    return { token: this.getToken(id)!, secret }
  }

  getToken(id: string): ApiToken | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM api_tokens WHERE id = ?').get(id)
    return row ? mapToken(row, this.now()) : undefined
  }

  listTokens(serviceAccountId: string, options: { includeInactive?: boolean } = {}): ApiToken[] {
    return this.controlPlane.database.query<Row, [string]>('SELECT * FROM api_tokens WHERE service_account_id = ? ORDER BY created_at DESC').all(serviceAccountId)
      .map(row => mapToken(row, this.now())).filter(token => options.includeInactive || token.state === 'active')
  }

  verifyToken(secret: string, networkHint?: string): ApiTokenPrincipal | undefined {
    const match = /^tsc_v1\.([^.]+)\.[A-Za-z0-9_-]{40,}$/.exec(secret)
    if (!match)
      return undefined
    const row = this.controlPlane.database.query<Row, [string, string]>('SELECT * FROM api_tokens WHERE id = ? AND token_hash = ?').get(match[1], hash(secret))
    if (!row)
      return undefined
    const token = mapToken(row, this.now())
    const serviceAccount = this.getServiceAccount(token.serviceAccountId)
    if (!serviceAccount || serviceAccount.state !== 'active' || token.state !== 'active')
      return undefined
    const actor = this.controlPlane.getActor(serviceAccount.actorId)
    const membership = this.controlPlane.getMembershipForActor(serviceAccount.organizationId, serviceAccount.actorId)
    if (!actor || actor.disabledAt || !membership || membership.status !== 'active')
      return undefined
    const now = this.now()
    this.run('UPDATE api_tokens SET last_used_at = ?, last_network_hint = ?, updated_at = ? WHERE id = ?', [now, networkHint?.slice(0, 128) ?? null, now, token.id])
    return { serviceAccount, token: this.getToken(token.id)!, actor, membership }
  }

  rotateToken(tokenId: string, createdByActorId?: string): { token: ApiToken, secret: string } {
    const current = this.getToken(tokenId)
    if (!current || current.state !== 'active')
      throw new Error('Active API token was not found')
    return this.createToken({
      serviceAccountId: current.serviceAccountId,
      name: `${current.name} (rotated)`,
      capabilities: current.capabilities,
      scope: current.scope,
      expiresAt: current.expiresAt,
      createdByActorId,
      rotatedFromTokenId: current.id,
    })
  }

  revokeToken(tokenId: string, actorId?: string): ApiToken {
    const token = this.getToken(tokenId)
    if (!token)
      throw new Error('API token was not found')
    if (token.state === 'active') {
      const now = this.now()
      this.run('UPDATE api_tokens SET revoked_at = ?, updated_at = ? WHERE id = ?', [now, now, tokenId])
      const account = this.getServiceAccount(token.serviceAccountId)
      this.controlPlane.appendEvent({ organizationId: account?.organizationId, actorId, type: 'api.token.revoked', payload: { serviceAccountId: token.serviceAccountId, tokenId } })
    }
    return this.getToken(tokenId)!
  }

  getIdempotency(tokenId: string, key: string): ApiIdempotencyRecord | undefined {
    const row = this.controlPlane.database.query<Row, [string, string, string]>('SELECT * FROM api_idempotency_records WHERE token_id = ? AND idempotency_key = ? AND expires_at > ?').get(tokenId, key, this.now())
    return row ? mapIdempotency(row) : undefined
  }

  saveIdempotency(input: Omit<ApiIdempotencyRecord, 'id' | 'createdAt' | 'expiresAt'>): ApiIdempotencyRecord {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.key))
      throw new Error('Idempotency-Key must contain 8-128 safe characters')
    const existing = this.getIdempotency(input.tokenId, input.key)
    if (existing) {
      if (existing.requestHash !== input.requestHash)
        throw new Error('Idempotency-Key was already used for a different request')
      return existing
    }
    const id = this.idFn()
    const now = this.now()
    const expiresAt = new Date(this.nowFn().getTime() + API_IDEMPOTENCY_TTL_MS).toISOString()
    this.run(
      `INSERT INTO api_idempotency_records (id, token_id, idempotency_key, request_hash, operation_id, response_status, response_body, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.tokenId, input.key, input.requestHash, input.operationId ?? null, input.responseStatus, JSON.stringify(input.responseBody), expiresAt, now],
    )
    return this.getIdempotency(input.tokenId, input.key)!
  }

  purgeExpired(): { tokens: number, idempotency: number } {
    const now = this.now()
    const tokens = this.controlPlane.database.run('DELETE FROM api_tokens WHERE (expires_at < ? OR revoked_at IS NOT NULL) AND created_at < ?', [now, new Date(this.nowFn().getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()]).changes
    const idempotency = this.controlPlane.database.run('DELETE FROM api_idempotency_records WHERE expires_at < ?', [now]).changes
    return { tokens, idempotency }
  }
}
