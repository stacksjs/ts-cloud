import type { SQLQueryBindings } from 'bun:sqlite'
import type { ControlPlaneStore, JsonValue } from '../control-plane'
import type { SourceBinding, SourceCapabilities, SourceConnection, SourceConnectionStoreOptions, SourceCredential, SourceDeployKey, SourceProvider, SourceRepository, SourceWebhook, SourceWebhookDelivery } from './types'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { sanitizeControlPlaneValue } from '../control-plane'

type Row = Record<string, unknown>

const DEFAULT_CAPABILITIES: Record<SourceProvider, SourceCapabilities> = {
  github: { repositories: true, branches: true, tags: true, webhooks: true, pullRequests: true, tokenRefresh: true, deployKeys: true },
  gitlab: { repositories: true, branches: true, tags: true, webhooks: true, pullRequests: true, tokenRefresh: true, deployKeys: true },
  bitbucket: { repositories: true, branches: true, tags: true, webhooks: true, pullRequests: true, tokenRefresh: true, deployKeys: true },
  gitea: { repositories: true, branches: true, tags: true, webhooks: true, pullRequests: true, tokenRefresh: false, deployKeys: true },
  generic_https: { repositories: false, branches: true, tags: true, webhooks: false, pullRequests: false, tokenRefresh: false, deployKeys: false },
  generic_ssh: { repositories: false, branches: true, tags: true, webhooks: false, pullRequests: false, tokenRefresh: false, deployKeys: true },
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function parse<T>(value: unknown, fallback: T): T {
  try { return typeof value === 'string' ? JSON.parse(value) as T : fallback }
  catch { return fallback }
}

function json(value: unknown): string {
  return JSON.stringify(sanitizeControlPlaneValue(value))
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeHost(value: string): string {
  const raw = value.trim().replace(/\/$/, '')
  const url = new URL(raw.includes('://') ? raw : `https://${raw}`)
  if (url.username || url.password || url.search || url.hash)
    throw new Error('Source host cannot contain credentials, a query, or a fragment')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)))
    throw new Error('Source host must use HTTPS')
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}`
}

function normalizeName(value: string): string {
  const name = value.trim()
  if (name.length < 2 || name.length > 80)
    throw new Error('Connection name must contain 2-80 characters')
  return name
}

function normalizeRepository(value: string): string {
  const name = value.trim().replace(/^\/+|\/+$/g, '')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name))
    throw new Error('Repository must use owner/name format')
  return name
}

function normalizePath(value: string): string {
  const path = value.trim() || '.'
  if (path.startsWith('/') || path.split('/').includes('..') || /[\0\r\n]/.test(path))
    throw new Error('Monorepo root must stay inside the repository')
  return path.replace(/^\.\//, '') || '.'
}

function normalizePatterns(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))].slice(0, 100)
}

function safeCloneUrl(value: string): string {
  const cloneUrl = value.trim()
  if (/\r|\n/.test(cloneUrl) || /https?:\/\/[^/@\s]+:[^/@\s]+@/i.test(cloneUrl))
    throw new Error('Clone URL cannot contain credentials or control characters')
  if (!/^(?:https?:\/\/|ssh:\/\/|git@[A-Za-z0-9.-]+:)/.test(cloneUrl))
    throw new Error('Clone URL must use HTTPS or SSH')
  return cloneUrl
}

function mapConnection(row: Row): SourceConnection {
  return { id: String(row.id), organizationId: String(row.organization_id), provider: String(row.provider) as SourceProvider, name: String(row.name), host: String(row.host),
    owner: optional(row.owner), authKind: String(row.auth_kind) as SourceConnection['authKind'], credentialConfigured: !!row.credential_ciphertext,
    credentialFingerprint: optional(row.credential_fingerprint), grantedScopes: parse(row.granted_scopes, []), capabilities: parse(row.capabilities, DEFAULT_CAPABILITIES[String(row.provider) as SourceProvider]),
    status: String(row.status) as SourceConnection['status'], healthMessage: optional(row.health_message), lastTestedAt: optional(row.last_tested_at), lastSyncedAt: optional(row.last_synced_at), credentialExpiresAt: optional(row.credential_expires_at),
    version: Number(row.version), createdByActorId: optional(row.created_by_actor_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}

function mapRepository(row: Row): SourceRepository {
  return { id: String(row.id), connectionId: String(row.connection_id), providerRepositoryId: String(row.provider_repository_id), fullName: String(row.full_name), cloneUrl: String(row.clone_url),
    defaultBranch: String(row.default_branch), visibility: String(row.visibility) as SourceRepository['visibility'], archived: Number(row.archived) === 1, metadata: parse(row.metadata, {}), syncedAt: String(row.synced_at) }
}

function mapBinding(row: Row): SourceBinding {
  return { id: String(row.id), projectId: String(row.project_id), environmentId: optional(row.environment_id), resourceId: optional(row.resource_id), connectionId: String(row.connection_id), repositoryId: optional(row.repository_id),
    repositoryFullName: String(row.repository_full_name), defaultBranch: String(row.default_branch), branchRule: optional(row.branch_rule), tagRule: optional(row.tag_rule), monorepoRoot: String(row.monorepo_root), includePaths: parse(row.include_paths, []), excludePaths: parse(row.exclude_paths, []),
    submodules: Number(row.submodules) === 1, cloneDepth: row.clone_depth == null ? undefined : Number(row.clone_depth), deployKeyId: optional(row.deploy_key_id), autoDeploy: Number(row.auto_deploy) === 1, pullRequestPreviews: Number(row.pull_request_previews) === 1,
    status: String(row.status) as SourceBinding['status'], disabledReason: optional(row.disabled_reason), version: Number(row.version), createdByActorId: optional(row.created_by_actor_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}

function mapDeployKey(row: Row): SourceDeployKey {
  return { id: String(row.id), connectionId: String(row.connection_id), name: String(row.name), publicKey: String(row.public_key), publicKeyFingerprint: String(row.public_key_fingerprint), host: String(row.host), hostKey: String(row.host_key), hostKeyFingerprint: String(row.host_key_fingerprint), createdByActorId: optional(row.created_by_actor_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}

function mapWebhook(row: Row): SourceWebhook {
  return { id: String(row.id), connectionId: String(row.connection_id), repositoryId: optional(row.repository_id), repositoryFullName: String(row.repository_full_name), providerWebhookId: optional(row.provider_webhook_id),
    events: parse(row.events, []), status: String(row.status) as SourceWebhook['status'], healthMessage: optional(row.health_message), lastDeliveryAt: optional(row.last_delivery_at), lastReconciledAt: optional(row.last_reconciled_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}

function mapDelivery(row: Row): SourceWebhookDelivery {
  return { id: String(row.id), connectionId: String(row.connection_id), webhookId: String(row.webhook_id), providerDeliveryId: String(row.provider_delivery_id), event: String(row.event), action: optional(row.action), commitSha: optional(row.commit_sha),
    signatureStatus: String(row.signature_status) as SourceWebhookDelivery['signatureStatus'], status: String(row.status) as SourceWebhookDelivery['status'], payloadSummary: parse(row.payload_summary, {}), operationId: optional(row.operation_id), error: optional(row.error), receivedAt: String(row.received_at), processedAt: optional(row.processed_at) }
}

export class SourceConnectionStore {
  private readonly key?: Buffer
  private readonly nowFn: () => Date
  private readonly idFn: () => string

  constructor(private readonly controlPlane: ControlPlaneStore, options: SourceConnectionStoreOptions = {}) {
    this.key = options.encryptionKey ? createHash('sha256').update(options.encryptionKey).digest() : undefined
    this.nowFn = options.now ?? (() => new Date())
    this.idFn = options.id ?? (() => crypto.randomUUID())
  }

  private now(): string { return this.nowFn().toISOString() }
  private run(sql: string, values: SQLQueryBindings[]): void { this.controlPlane.database.run(sql, values) }
  private encrypt(value: string): string {
    if (!this.key) throw new Error('Source credential encryption key is not configured')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`
  }
  private decrypt(value: string): string {
    if (!this.key) throw new Error('Source credential encryption key is not configured')
    const [version, iv, tag, ciphertext] = value.split('.')
    if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Encrypted source credential is unavailable')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8')
  }

  createConnection(input: { organizationId: string, provider: SourceProvider, name: string, host: string, owner?: string, authKind?: SourceConnection['authKind'], credential?: SourceCredential, grantedScopes?: string[], credentialExpiresAt?: string, createdByActorId?: string }): SourceConnection {
    if (!this.controlPlane.getOrganization(input.organizationId)) throw new Error('Source connection organization was not found')
    const now = this.now()
    const id = this.idFn()
    const encoded = input.credential ? JSON.stringify(input.credential) : undefined
    this.run(`INSERT INTO source_connections (id, organization_id, provider, name, host, owner, auth_kind, credential_ciphertext, credential_fingerprint, granted_scopes, capabilities, status, credential_expires_at, created_by_actor_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`, [id, input.organizationId, input.provider, normalizeName(input.name), normalizeHost(input.host), input.owner?.trim() || null, input.authKind ?? (encoded ? 'access_token' : 'none'), encoded ? this.encrypt(encoded) : null,
      encoded ? hash(encoded).slice(0, 16) : null, json([...new Set(input.grantedScopes ?? [])].sort()), json(DEFAULT_CAPABILITIES[input.provider]), input.credentialExpiresAt ?? null, input.createdByActorId ?? null, now, now])
    this.controlPlane.appendEvent({ organizationId: input.organizationId, actorId: input.createdByActorId, type: 'source.connection.created', payload: { connectionId: id, provider: input.provider, host: normalizeHost(input.host), owner: input.owner ?? null, scopes: input.grantedScopes ?? [] } })
    return this.getConnection(id)!
  }

  getConnection(id: string): SourceConnection | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM source_connections WHERE id = ?').get(id)
    return row ? mapConnection(row) : undefined
  }
  listConnections(organizationId: string): SourceConnection[] {
    return this.controlPlane.database.query<Row, [string]>('SELECT * FROM source_connections WHERE organization_id = ? ORDER BY name').all(organizationId).map(mapConnection)
  }
  getCredential(id: string): SourceCredential | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT credential_ciphertext FROM source_connections WHERE id = ?').get(id)
    return row?.credential_ciphertext ? JSON.parse(this.decrypt(String(row.credential_ciphertext))) as SourceCredential : undefined
  }
  rotateCredential(id: string, credential: SourceCredential, input: { expiresAt?: string, actorId?: string } = {}): SourceConnection {
    const connection = this.getConnection(id)
    if (!connection || connection.status === 'disconnected') throw new Error('Active source connection was not found')
    const encoded = JSON.stringify(credential)
    this.run(`UPDATE source_connections SET credential_ciphertext = ?, credential_fingerprint = ?, credential_expires_at = ?, status = 'pending', health_message = NULL, version = version + 1, updated_at = ? WHERE id = ?`,
      [this.encrypt(encoded), hash(encoded).slice(0, 16), input.expiresAt ?? null, this.now(), id])
    this.controlPlane.appendEvent({ organizationId: connection.organizationId, actorId: input.actorId, type: 'source.credential.rotated', payload: { connectionId: id, fingerprint: hash(encoded).slice(0, 16), expiresAt: input.expiresAt ?? null } })
    return this.getConnection(id)!
  }
  updateHealth(id: string, input: { status: 'healthy' | 'degraded' | 'expired', message?: string, tested?: boolean, synced?: boolean }): SourceConnection {
    const connection = this.getConnection(id)
    if (!connection || connection.status === 'disconnected') throw new Error('Active source connection was not found')
    const now = this.now()
    this.run(`UPDATE source_connections SET status = ?, health_message = ?, last_tested_at = COALESCE(?, last_tested_at), last_synced_at = COALESCE(?, last_synced_at), version = version + 1, updated_at = ? WHERE id = ?`,
      [input.status, input.message?.slice(0, 1000) ?? null, input.tested ? now : null, input.synced ? now : null, now, id])
    return this.getConnection(id)!
  }

  upsertRepository(input: Omit<SourceRepository, 'id' | 'syncedAt'>): SourceRepository {
    const now = this.now()
    const existing = this.controlPlane.database.query<Row, [string, string]>('SELECT id FROM source_repositories WHERE connection_id = ? AND provider_repository_id = ?').get(input.connectionId, input.providerRepositoryId)
    const id = existing ? String(existing.id) : this.idFn()
    this.run(`INSERT INTO source_repositories (id, connection_id, provider_repository_id, full_name, clone_url, default_branch, visibility, archived, metadata, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id, provider_repository_id) DO UPDATE SET full_name=excluded.full_name, clone_url=excluded.clone_url, default_branch=excluded.default_branch, visibility=excluded.visibility, archived=excluded.archived, metadata=excluded.metadata, synced_at=excluded.synced_at`,
    [id, input.connectionId, input.providerRepositoryId, normalizeRepository(input.fullName), safeCloneUrl(input.cloneUrl), input.defaultBranch.trim() || 'main', input.visibility, input.archived ? 1 : 0, json(input.metadata), now])
    return mapRepository(this.controlPlane.database.query<Row, [string]>('SELECT * FROM source_repositories WHERE id = ?').get(id)!)
  }
  listRepositories(connectionId: string, search?: string, limit = 100): SourceRepository[] {
    const query = search?.trim().toLowerCase()
    const rows = query
      ? this.controlPlane.database.query<Row, [string, string, number]>('SELECT * FROM source_repositories WHERE connection_id = ? AND lower(full_name) LIKE ? ORDER BY full_name LIMIT ?').all(connectionId, `%${query}%`, Math.min(500, limit))
      : this.controlPlane.database.query<Row, [string, number]>('SELECT * FROM source_repositories WHERE connection_id = ? ORDER BY full_name LIMIT ?').all(connectionId, Math.min(500, limit))
    return rows.map(mapRepository)
  }
  getRepository(id: string): SourceRepository | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM source_repositories WHERE id = ?').get(id)
    return row ? mapRepository(row) : undefined
  }

  createDeployKey(input: { connectionId: string, name: string, publicKey: string, privateKey: string, host: string, hostKey: string, actorId?: string }): SourceDeployKey {
    if (!/^ssh-(?:ed25519|rsa)\s+[A-Za-z0-9+/=]+/.test(input.publicKey.trim())) throw new Error('A valid SSH public key is required')
    if (!/BEGIN (?:OPENSSH|RSA) PRIVATE KEY/.test(input.privateKey)) throw new Error('A valid SSH private key is required')
    if (!/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+)\s+[A-Za-z0-9+/=]+/.test(input.hostKey.trim())) throw new Error('A pinned SSH host key is required')
    const id = this.idFn(); const now = this.now()
    const publicFingerprint = `sha256:${hash(input.publicKey.trim())}`
    const hostFingerprint = `sha256:${hash(input.hostKey.trim())}`
    this.run(`INSERT INTO source_deploy_keys (id, connection_id, name, public_key, public_key_fingerprint, private_key_ciphertext, host, host_key, host_key_fingerprint, created_by_actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.connectionId, normalizeName(input.name), input.publicKey.trim(), publicFingerprint, this.encrypt(input.privateKey), input.host.trim().toLowerCase(), input.hostKey.trim(), hostFingerprint, input.actorId ?? null, now, now])
    const connection = this.getConnection(input.connectionId)!
    this.controlPlane.appendEvent({ organizationId: connection.organizationId, actorId: input.actorId, type: 'source.deploy_key.created', payload: { connectionId: input.connectionId, deployKeyId: id, publicFingerprint, hostFingerprint } })
    return mapDeployKey(this.controlPlane.database.query<Row, [string]>('SELECT * FROM source_deploy_keys WHERE id = ?').get(id)!)
  }
  getDeployKey(id: string): SourceDeployKey | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM source_deploy_keys WHERE id = ?').get(id)
    return row ? mapDeployKey(row) : undefined
  }
  getDeployPrivateKey(id: string): string {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT private_key_ciphertext FROM source_deploy_keys WHERE id = ?').get(id)
    if (!row) throw new Error('Deploy key was not found')
    return this.decrypt(String(row.private_key_ciphertext))
  }

  createBinding(input: { projectId: string, environmentId?: string, resourceId?: string, connectionId: string, repositoryId?: string, repositoryFullName: string, defaultBranch?: string, branchRule?: string, tagRule?: string, monorepoRoot?: string, includePaths?: string[], excludePaths?: string[], submodules?: boolean, cloneDepth?: number, deployKeyId?: string, autoDeploy?: boolean, pullRequestPreviews?: boolean, actorId?: string }): SourceBinding {
    const connection = this.getConnection(input.connectionId)
    if (!connection || connection.status === 'disconnected') throw new Error('Active source connection was not found')
    if (input.deployKeyId && this.getDeployKey(input.deployKeyId)?.connectionId !== connection.id) throw new Error('Deploy key does not belong to this connection')
    const id = this.idFn(); const now = this.now()
    this.run(`INSERT INTO source_bindings (id, project_id, environment_id, resource_id, connection_id, repository_id, repository_full_name, default_branch, branch_rule, tag_rule, monorepo_root, include_paths, exclude_paths, submodules, clone_depth, deploy_key_id, auto_deploy, pull_request_previews, status, created_by_actor_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`, [id, input.projectId, input.environmentId ?? null, input.resourceId ?? null, input.connectionId, input.repositoryId ?? null, normalizeRepository(input.repositoryFullName), input.defaultBranch?.trim() || 'main', input.branchRule?.trim() || null, input.tagRule?.trim() || null,
      normalizePath(input.monorepoRoot ?? '.'), json(normalizePatterns(input.includePaths)), json(normalizePatterns(input.excludePaths)), input.submodules ? 1 : 0, input.cloneDepth ?? null, input.deployKeyId ?? null, input.autoDeploy === false ? 0 : 1, input.pullRequestPreviews === false ? 0 : 1, input.actorId ?? null, now, now])
    this.controlPlane.appendEvent({ organizationId: connection.organizationId, projectId: input.projectId, actorId: input.actorId, type: 'source.binding.created', payload: { bindingId: id, connectionId: input.connectionId, repository: input.repositoryFullName, branch: input.defaultBranch ?? 'main' } })
    return this.getBinding(id)!
  }
  getBinding(id: string): SourceBinding | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM source_bindings WHERE id = ?').get(id)
    return row ? mapBinding(row) : undefined
  }
  listBindings(input: { connectionId?: string, projectId?: string, status?: SourceBinding['status'] } = {}): SourceBinding[] {
    const rows = this.controlPlane.database.query<Row, []>('SELECT * FROM source_bindings ORDER BY created_at DESC').all()
    return rows.map(mapBinding).filter(item => (!input.connectionId || item.connectionId === input.connectionId) && (!input.projectId || item.projectId === input.projectId) && (!input.status || item.status === input.status))
  }
  updateBinding(id: string, expectedVersion: number, input: { defaultBranch?: string, branchRule?: string, tagRule?: string, monorepoRoot?: string, includePaths?: string[], excludePaths?: string[], submodules?: boolean, cloneDepth?: number | null, deployKeyId?: string | null, autoDeploy?: boolean, pullRequestPreviews?: boolean, status?: SourceBinding['status'], disabledReason?: string, actorId?: string }): SourceBinding {
    const binding = this.getBinding(id)
    if (!binding || binding.version !== expectedVersion) throw new Error(`Source binding ${id} changed since version ${expectedVersion}`)
    if (input.deployKeyId && this.getDeployKey(input.deployKeyId)?.connectionId !== binding.connectionId) throw new Error('Deploy key does not belong to this connection')
    const now = this.now()
    const result = this.controlPlane.database.run(`UPDATE source_bindings SET default_branch=?, branch_rule=?, tag_rule=?, monorepo_root=?, include_paths=?, exclude_paths=?, submodules=?, clone_depth=?, deploy_key_id=?, auto_deploy=?, pull_request_previews=?, status=?, disabled_reason=?, version=version+1, updated_at=? WHERE id=? AND version=?`,
      [input.defaultBranch?.trim() || binding.defaultBranch, input.branchRule === undefined ? binding.branchRule ?? null : input.branchRule.trim() || null, input.tagRule === undefined ? binding.tagRule ?? null : input.tagRule.trim() || null, input.monorepoRoot === undefined ? binding.monorepoRoot : normalizePath(input.monorepoRoot),
        json(input.includePaths === undefined ? binding.includePaths : normalizePatterns(input.includePaths)), json(input.excludePaths === undefined ? binding.excludePaths : normalizePatterns(input.excludePaths)), (input.submodules ?? binding.submodules) ? 1 : 0, input.cloneDepth === undefined ? binding.cloneDepth ?? null : input.cloneDepth,
        input.deployKeyId === undefined ? binding.deployKeyId ?? null : input.deployKeyId, (input.autoDeploy ?? binding.autoDeploy) ? 1 : 0, (input.pullRequestPreviews ?? binding.pullRequestPreviews) ? 1 : 0, input.status ?? binding.status, input.disabledReason === undefined ? binding.disabledReason ?? null : input.disabledReason.slice(0, 1000), now, id, expectedVersion])
    if (result.changes !== 1) throw new Error(`Source binding ${id} changed since version ${expectedVersion}`)
    const connection = this.getConnection(binding.connectionId)!
    this.controlPlane.appendEvent({ organizationId: connection.organizationId, projectId: binding.projectId, actorId: input.actorId, type: 'source.binding.updated', payload: { bindingId: id, fromVersion: expectedVersion, toVersion: expectedVersion + 1, status: input.status ?? binding.status } })
    return this.getBinding(id)!
  }

  createWebhook(input: { connectionId: string, repositoryId?: string, repositoryFullName: string, events?: string[], endpointToken?: string, secret?: string }): { webhook: SourceWebhook, secret: string } {
    const connection = this.getConnection(input.connectionId)
    if (!connection || connection.status === 'disconnected') throw new Error('Active source connection was not found')
    const id = this.idFn(); const now = this.now(); const endpointToken = input.endpointToken ?? randomBytes(24).toString('base64url'); const secret = input.secret ?? randomBytes(32).toString('base64url')
    const events = [...new Set(input.events ?? ['push', 'pull_request'])].filter(value => ['push', 'pull_request'].includes(value))
    if (!events.length) throw new Error('At least one supported webhook event is required')
    this.run(`INSERT INTO source_webhooks (id, connection_id, repository_id, repository_full_name, endpoint_token_hash, endpoint_token_ciphertext, secret_ciphertext, events, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [id, input.connectionId, input.repositoryId ?? null, normalizeRepository(input.repositoryFullName), hash(endpointToken), this.encrypt(endpointToken), this.encrypt(secret), json(events), now, now])
    this.controlPlane.appendEvent({ organizationId: connection.organizationId, type: 'source.webhook.created', payload: { webhookId: id, connectionId: connection.id, repository: input.repositoryFullName, events } })
    return { webhook: { ...this.getWebhook(id)!, endpointToken }, secret }
  }
  getWebhook(id: string): SourceWebhook | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM source_webhooks WHERE id = ?').get(id)
    return row ? mapWebhook(row) : undefined
  }
  getWebhookByEndpointToken(endpointToken: string): SourceWebhook | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM source_webhooks WHERE endpoint_token_hash = ?').get(hash(endpointToken))
    return row ? mapWebhook(row) : undefined
  }
  getWebhookSecret(id: string): string {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT secret_ciphertext FROM source_webhooks WHERE id = ?').get(id)
    if (!row) throw new Error('Source webhook was not found')
    return this.decrypt(String(row.secret_ciphertext))
  }
  getWebhookEndpointToken(id: string): string {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT endpoint_token_ciphertext FROM source_webhooks WHERE id = ?').get(id)
    if (!row?.endpoint_token_ciphertext) throw new Error('Source webhook endpoint token is unavailable')
    return this.decrypt(String(row.endpoint_token_ciphertext))
  }
  listWebhooks(connectionId: string): SourceWebhook[] {
    return this.controlPlane.database.query<Row, [string]>('SELECT * FROM source_webhooks WHERE connection_id = ? ORDER BY repository_full_name').all(connectionId).map(mapWebhook)
  }
  updateWebhookState(id: string, input: { providerWebhookId?: string, status: SourceWebhook['status'], healthMessage?: string, reconciled?: boolean }): SourceWebhook {
    const webhook = this.getWebhook(id)
    if (!webhook) throw new Error('Source webhook was not found')
    const now = this.now()
    this.run(`UPDATE source_webhooks SET provider_webhook_id=COALESCE(?, provider_webhook_id), status=?, health_message=?, last_reconciled_at=COALESCE(?, last_reconciled_at), updated_at=? WHERE id=?`,
      [input.providerWebhookId ?? null, input.status, input.healthMessage?.slice(0, 1000) ?? null, input.reconciled ? now : null, now, id])
    return this.getWebhook(id)!
  }
  getDeliveryByProviderId(connectionId: string, providerDeliveryId: string): SourceWebhookDelivery | undefined {
    const row = this.controlPlane.database.query<Row, [string, string]>('SELECT * FROM source_webhook_deliveries WHERE connection_id = ? AND provider_delivery_id = ?').get(connectionId, providerDeliveryId)
    return row ? mapDelivery(row) : undefined
  }
  recordDelivery(input: { connectionId: string, webhookId: string, providerDeliveryId: string, event: string, action?: string, commitSha?: string, signatureStatus: SourceWebhookDelivery['signatureStatus'], status: SourceWebhookDelivery['status'], payloadSummary?: JsonValue, operationId?: string, error?: string }): { delivery: SourceWebhookDelivery, duplicate: boolean } {
    const existing = this.getDeliveryByProviderId(input.connectionId, input.providerDeliveryId)
    if (existing) return { delivery: existing, duplicate: true }
    const id = this.idFn(); const now = this.now()
    this.controlPlane.database.transaction(() => {
      this.run(`INSERT INTO source_webhook_deliveries (id, connection_id, webhook_id, provider_delivery_id, event, action, commit_sha, signature_status, status, payload_summary, operation_id, error, received_at, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.connectionId, input.webhookId, input.providerDeliveryId, input.event.slice(0, 100), input.action?.slice(0, 100) ?? null, input.commitSha?.slice(0, 128) ?? null, input.signatureStatus, input.status, json(input.payloadSummary ?? {}), input.operationId ?? null, input.error?.slice(0, 2000) ?? null, now, ['enqueued', 'ignored', 'rejected', 'failed'].includes(input.status) ? now : null])
      this.run('UPDATE source_webhooks SET last_delivery_at=?, updated_at=? WHERE id=?', [now, now, input.webhookId])
    })()
    return { delivery: this.getDeliveryByProviderId(input.connectionId, input.providerDeliveryId)!, duplicate: false }
  }
  updateDelivery(id: string, input: { status: SourceWebhookDelivery['status'], operationId?: string, error?: string }): SourceWebhookDelivery {
    this.run('UPDATE source_webhook_deliveries SET status=?, operation_id=?, error=?, processed_at=? WHERE id=?', [input.status, input.operationId ?? null, input.error?.slice(0, 2000) ?? null, this.now(), id])
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM source_webhook_deliveries WHERE id = ?').get(id)
    if (!row) throw new Error('Source webhook delivery was not found')
    return mapDelivery(row)
  }
  listDeliveries(webhookId: string, limit = 100): SourceWebhookDelivery[] {
    return this.controlPlane.database.query<Row, [string, number]>('SELECT * FROM source_webhook_deliveries WHERE webhook_id = ? ORDER BY received_at DESC LIMIT ?').all(webhookId, Math.min(500, Math.max(1, limit))).map(mapDelivery)
  }
  disconnectConnection(id: string, actorId?: string): { connection: SourceConnection, affectedBindings: SourceBinding[] } {
    const connection = this.getConnection(id)
    if (!connection) throw new Error('Source connection was not found')
    const affected = this.listBindings({ connectionId: id, status: 'active' })
    const now = this.now()
    this.controlPlane.database.transaction(() => {
      this.run(`UPDATE source_connections SET status='disconnected', credential_ciphertext=NULL, health_message='Disconnected by an administrator', version=version+1, updated_at=? WHERE id=?`, [now, id])
      this.run(`UPDATE source_bindings SET status='disabled', auto_deploy=0, disabled_reason='Source connection was disconnected', version=version+1, updated_at=? WHERE connection_id=? AND status='active'`, [now, id])
      this.run(`UPDATE source_webhooks SET status='disabled', health_message='Source connection was disconnected', updated_at=? WHERE connection_id=?`, [now, id])
    })()
    this.controlPlane.appendEvent({ organizationId: connection.organizationId, actorId, type: 'source.connection.disconnected', level: 'warning', payload: { connectionId: id, affectedBindingIds: affected.map(item => item.id), affectedRepositories: affected.map(item => item.repositoryFullName) } })
    return { connection: this.getConnection(id)!, affectedBindings: affected }
  }
}
