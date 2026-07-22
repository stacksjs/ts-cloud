import type { ControlPlaneStore, JsonValue } from '../control-plane'
import type { CreatePreviewDefinitionInput, PreviewDefinition, PreviewInstance, PreviewResource, PreviewStatus, UpsertPreviewInput } from './types'
import { createHash } from 'node:crypto'
import { sanitizeControlPlaneValue } from '../control-plane'

type Row = Record<string, unknown>
const SHA = /^[a-f0-9]{40,64}$/i
const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,127}$/

function optional(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined }
function json(value: unknown): JsonValue { try { return JSON.parse(String(value)) as JsonValue } catch { return {} } }
function strings(value: unknown): string[] { const parsed = json(value); return Array.isArray(parsed) ? parsed.map(String) : [] }
function definition(row: Row): PreviewDefinition {
  return { id: String(row.id), projectId: String(row.project_id), resourceId: String(row.resource_id), baseEnvironmentId: String(row.base_environment_id), enabled: Number(row.enabled) === 1, branchRule: optional(row.branch_rule), domainPattern: String(row.domain_pattern), ttlHours: Number(row.ttl_hours), keepCount: Number(row.keep_count), publicAccess: Number(row.public_access) === 1, authenticationRequired: Number(row.authentication_required) === 1, allowForks: Number(row.allow_forks) === 1, inheritedSecrets: strings(row.inherited_secrets), resourceOverrides: json(row.resource_overrides), databaseStrategy: String(row.database_strategy) as PreviewDefinition['databaseStrategy'], maxMonthlyCost: Number(row.max_monthly_cost), maxCpu: Number(row.max_cpu), maxMemoryMb: Number(row.max_memory_mb), cleanupOnClose: Number(row.cleanup_on_close) === 1, version: Number(row.version), createdByActorId: optional(row.created_by_actor_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}
function instance(row: Row): PreviewInstance {
  return { id: String(row.id), definitionId: String(row.definition_id), projectId: String(row.project_id), resourceId: String(row.resource_id), baseEnvironmentId: String(row.base_environment_id), identityKey: String(row.identity_key), sourceProvider: optional(row.source_provider), repository: optional(row.repository), branch: String(row.branch), pullRequestNumber: row.pull_request_number == null ? undefined : Number(row.pull_request_number), fork: Number(row.fork) === 1, commitSha: String(row.commit_sha), name: String(row.name), stackName: String(row.stack_name), url: optional(row.url), status: String(row.status) as PreviewStatus, expiresAt: String(row.expires_at), latestOperationId: optional(row.latest_operation_id), createdByActorId: optional(row.created_by_actor_id), costEstimate: row.cost_estimate == null ? undefined : Number(row.cost_estimate), desiredState: json(row.desired_state), observedState: json(row.observed_state), teardownError: optional(row.teardown_error), version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at), destroyedAt: optional(row.destroyed_at) }
}
function resource(row: Row): PreviewResource {
  return { id: String(row.id), previewId: String(row.preview_id), provider: String(row.provider), providerResourceId: String(row.provider_resource_id), kind: String(row.kind), tags: json(row.tags) as Record<string, string>, observedState: json(row.observed_state), discoveredAt: String(row.discovered_at), deletedAt: optional(row.deleted_at) }
}
function integer(value: number | undefined, fallback: number, min: number, max: number): number { return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value!))) : fallback }
function decimal(value: number | undefined, fallback: number, min: number, max: number): number { return Number.isFinite(value) ? Math.min(max, Math.max(min, value!)) : fallback }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || 'preview' }

export class PreviewEnvironmentStore {
  private readonly now: () => Date
  private readonly id: () => string
  constructor(readonly controlPlane: ControlPlaneStore, options: { now?: () => Date, id?: () => string } = {}) { this.now = options.now ?? (() => new Date()); this.id = options.id ?? (() => crypto.randomUUID()) }

  createDefinition(input: CreatePreviewDefinitionInput): PreviewDefinition {
    const resource = this.controlPlane.getResource(input.resourceId)
    const environment = this.controlPlane.listEnvironments(input.projectId).find(item => item.id === input.baseEnvironmentId)
    if (!resource || resource.projectId !== input.projectId || resource.environmentId !== environment?.id) throw new Error('Preview resource and base environment must belong to the same project scope')
    if (resource.kind !== 'application') throw new Error('Preview environments currently support application resources only')
    if (!/^https:\/\//.test(input.domainPattern) || !input.domainPattern.includes('{name}')) throw new Error('Preview domainPattern must be HTTPS and include {name}')
    if (input.publicAccess && input.authenticationRequired === false) throw new Error('Public preview environments require an authentication policy')
    const inheritedSecrets = [...new Set(input.inheritedSecrets ?? [])]
    if (inheritedSecrets.some(name => !SECRET_NAME.test(name))) throw new Error('Inherited preview secret names must use uppercase environment-variable identifiers')
    const id = this.id(); const now = this.now().toISOString()
    this.controlPlane.database.run(`INSERT INTO preview_definitions (id, project_id, resource_id, base_environment_id, enabled, branch_rule, domain_pattern, ttl_hours, keep_count, public_access, authentication_required, allow_forks, inherited_secrets, resource_overrides, database_strategy, max_monthly_cost, max_cpu, max_memory_mb, cleanup_on_close, created_by_actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, input.projectId, input.resourceId, input.baseEnvironmentId, input.branchRule ?? null, input.domainPattern, integer(input.ttlHours, 24, 1, 720), integer(input.keepCount, 10, 1, 100), input.publicAccess ? 1 : 0, input.authenticationRequired === false ? 0 : 1, input.allowForks ? 1 : 0, JSON.stringify(inheritedSecrets), JSON.stringify(sanitizeControlPlaneValue(input.resourceOverrides ?? {})), input.databaseStrategy ?? 'disabled', decimal(input.maxMonthlyCost, 25, 0, 10000), decimal(input.maxCpu, 1, 0.1, 64), integer(input.maxMemoryMb, 1024, 128, 131072), input.cleanupOnClose === false ? 0 : 1, input.createdByActorId ?? null, now, now])
    this.controlPlane.appendEvent({ projectId: input.projectId, resourceId: input.resourceId, actorId: input.createdByActorId, type: 'preview.definition.created', payload: { definitionId: id, baseEnvironmentId: input.baseEnvironmentId, ttlHours: integer(input.ttlHours, 24, 1, 720), inheritedSecretNames: inheritedSecrets } })
    return this.getDefinition(id)!
  }

  getDefinition(id: string): PreviewDefinition | undefined { const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM preview_definitions WHERE id=?').get(id); return row ? definition(row) : undefined }
  getDefinitionForResource(resourceId: string): PreviewDefinition | undefined { const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM preview_definitions WHERE resource_id=?').get(resourceId); return row ? definition(row) : undefined }
  listDefinitions(projectId: string): PreviewDefinition[] { return this.controlPlane.database.query<Row, [string]>('SELECT * FROM preview_definitions WHERE project_id=? ORDER BY updated_at DESC').all(projectId).map(definition) }
  listInstances(input: { projectId?: string, definitionId?: string, status?: PreviewStatus } = {}): PreviewInstance[] { const rows = this.controlPlane.database.query<Row, []>('SELECT * FROM preview_instances ORDER BY created_at DESC').all().map(instance); return rows.filter(item => (!input.projectId || item.projectId === input.projectId) && (!input.definitionId || item.definitionId === input.definitionId) && (!input.status || item.status === input.status)) }
  getInstance(id: string): PreviewInstance | undefined { const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM preview_instances WHERE id=?').get(id); return row ? instance(row) : undefined }
  findForPullRequest(definitionId: string, repository: string, pullRequestNumber: number): PreviewInstance | undefined { const row = this.controlPlane.database.query<Row, [string, string]>('SELECT * FROM preview_instances WHERE definition_id=? AND identity_key=?').get(definitionId, `pr:${repository}:${pullRequestNumber}`); return row ? instance(row) : undefined }
  findForBranch(definitionId: string, repository: string, branch: string): PreviewInstance | undefined { const row = this.controlPlane.database.query<Row, [string, string]>('SELECT * FROM preview_instances WHERE definition_id=? AND identity_key=?').get(definitionId, `branch:${repository}:${branch}`); return row ? instance(row) : undefined }

  upsert(input: UpsertPreviewInput): { preview: PreviewInstance, created: boolean, changed: boolean, inheritedSecrets: string[] } {
    const policy = this.getDefinition(input.definitionId)
    if (!policy?.enabled) throw new Error('Preview environments are not enabled for this application')
    if (!SHA.test(input.commitSha)) throw new Error('Preview deployment requires an immutable 40-64 character commit SHA')
    if (input.fork && !policy.allowForks) throw new Error('Untrusted fork previews are disabled')
    const identityKey = input.pullRequestNumber ? `pr:${input.repository ?? 'unknown'}:${input.pullRequestNumber}` : `branch:${input.repository ?? 'local'}:${input.branch}`
    const hash = createHash('sha256').update(`${policy.id}:${identityKey}`).digest('hex').slice(0, 8)
    const label = input.pullRequestNumber ? `pr-${input.pullRequestNumber}` : slug(input.branch)
    const name = `${label.slice(0, 28)}-${hash}`
    const stackName = `preview-${name}`.slice(0, 63)
    const url = policy.domainPattern.replaceAll('{name}', name).replaceAll('{project}', slug(policy.projectId)).replaceAll('{branch}', slug(input.branch)).replaceAll('{pr}', String(input.pullRequestNumber ?? 'branch'))
    const now = input.now ?? this.now(); const nowIso = now.toISOString(); const expiresAt = new Date(now.getTime() + policy.ttlHours * 60 * 60 * 1000).toISOString()
    const existingRow = this.controlPlane.database.query<Row, [string, string]>('SELECT * FROM preview_instances WHERE definition_id=? AND identity_key=?').get(policy.id, identityKey)
    if (existingRow) {
      const existing = instance(existingRow); const changed = existing.commitSha !== input.commitSha || existing.status === 'destroyed'
      if (changed) this.controlPlane.database.run(`UPDATE preview_instances SET commit_sha=?, branch=?, fork=?, status='queued', expires_at=?, url=?, teardown_error=NULL, destroyed_at=NULL, version=version+1, updated_at=? WHERE id=?`, [input.commitSha, input.branch, input.fork ? 1 : 0, expiresAt, url, nowIso, existing.id])
      return { preview: this.getInstance(existing.id)!, created: false, changed, inheritedSecrets: input.fork ? [] : policy.inheritedSecrets }
    }
    const id = this.id(); const desiredState = sanitizeControlPlaneValue({ source: { provider: input.sourceProvider ?? null, repository: input.repository ?? null, branch: input.branch, commitSha: input.commitSha, pullRequestNumber: input.pullRequestNumber ?? null, fork: !!input.fork }, policy: { databaseStrategy: policy.databaseStrategy, resourceOverrides: policy.resourceOverrides, maxMonthlyCost: policy.maxMonthlyCost, maxCpu: policy.maxCpu, maxMemoryMb: policy.maxMemoryMb, publicAccess: policy.publicAccess, authenticationRequired: policy.authenticationRequired }, inheritedSecretNames: input.fork ? [] : policy.inheritedSecrets })
    this.controlPlane.database.run(`INSERT INTO preview_instances (id, definition_id, project_id, resource_id, base_environment_id, identity_key, source_provider, repository, branch, pull_request_number, fork, commit_sha, name, stack_name, url, status, expires_at, created_by_actor_id, desired_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`, [id, policy.id, policy.projectId, policy.resourceId, policy.baseEnvironmentId, identityKey, input.sourceProvider ?? null, input.repository ?? null, input.branch, input.pullRequestNumber ?? null, input.fork ? 1 : 0, input.commitSha, name, stackName, url, expiresAt, input.createdByActorId ?? null, JSON.stringify(desiredState), nowIso, nowIso])
    this.controlPlane.appendEvent({ projectId: policy.projectId, resourceId: policy.resourceId, actorId: input.createdByActorId, type: 'preview.created', payload: { previewId: id, identityKey, commitSha: input.commitSha, expiresAt, fork: !!input.fork } })
    return { preview: this.getInstance(id)!, created: true, changed: true, inheritedSecrets: input.fork ? [] : policy.inheritedSecrets }
  }

  transition(id: string, status: PreviewStatus, input: { operationId?: string, observedState?: JsonValue, teardownError?: string, costEstimate?: number } = {}): PreviewInstance {
    const current = this.getInstance(id); if (!current) throw new Error(`Preview ${id} was not found`)
    const now = this.now().toISOString(); const destroyedAt = status === 'destroyed' ? now : null
    this.controlPlane.database.run('UPDATE preview_instances SET status=?, latest_operation_id=COALESCE(?, latest_operation_id), observed_state=?, teardown_error=?, cost_estimate=COALESCE(?, cost_estimate), destroyed_at=?, version=version+1, updated_at=? WHERE id=?', [status, input.operationId ?? null, JSON.stringify(sanitizeControlPlaneValue(input.observedState ?? current.observedState)), input.teardownError ?? null, input.costEstimate ?? null, destroyedAt, now, id])
    this.controlPlane.appendEvent({ projectId: current.projectId, resourceId: current.resourceId, operationId: input.operationId, type: `preview.${status}`, level: status === 'failed' || status === 'cleanup_failed' ? 'error' : 'info', payload: { previewId: id, commitSha: current.commitSha, teardownError: input.teardownError ?? null } })
    return this.getInstance(id)!
  }

  extend(id: string, hours: number): PreviewInstance { const current = this.getInstance(id); const policy = current ? this.getDefinition(current.definitionId) : undefined; if (!current || !policy) throw new Error(`Preview ${id} was not found`); const bounded = integer(hours, policy.ttlHours, 1, 720); const expires = new Date(Math.max(Date.now(), new Date(current.expiresAt).getTime()) + bounded * 3600000).toISOString(); this.controlPlane.database.run('UPDATE preview_instances SET expires_at=?, version=version+1, updated_at=? WHERE id=?', [expires, this.now().toISOString(), id]); return this.getInstance(id)! }
  expired(now: Date = this.now()): PreviewInstance[] { return this.listInstances().filter(item => ['queued', 'deploying', 'active', 'updating', 'failed', 'cleanup_failed'].includes(item.status) && new Date(item.expiresAt) <= now) }

  recordResource(input: { previewId: string, provider: string, providerResourceId: string, kind: string, tags: Record<string, string>, observedState?: JsonValue }): PreviewResource {
    const preview = this.getInstance(input.previewId); if (!preview) throw new Error(`Preview ${input.previewId} was not found`)
    const required = { 'ts-cloud:preview': preview.id, 'ts-cloud:project': preview.projectId, 'ts-cloud:expires-at': preview.expiresAt }
    for (const [key, value] of Object.entries(required)) if (input.tags[key] !== value) throw new Error(`Preview resource is missing immutable tag ${key}`)
    const id = this.id(); const now = this.now().toISOString()
    this.controlPlane.database.run(`INSERT INTO preview_resources (id, preview_id, provider, provider_resource_id, kind, tags, observed_state, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(preview_id, provider, provider_resource_id) DO UPDATE SET kind=excluded.kind, tags=excluded.tags, observed_state=excluded.observed_state, deleted_at=NULL`, [id, preview.id, input.provider, input.providerResourceId, input.kind, JSON.stringify(input.tags), JSON.stringify(sanitizeControlPlaneValue(input.observedState ?? {})), now])
    const row = this.controlPlane.database.query<Row, [string, string, string]>('SELECT * FROM preview_resources WHERE preview_id=? AND provider=? AND provider_resource_id=?').get(preview.id, input.provider, input.providerResourceId)!
    return resource(row)
  }
  listResources(previewId: string): PreviewResource[] { return this.controlPlane.database.query<Row, [string]>('SELECT * FROM preview_resources WHERE preview_id=? ORDER BY kind, provider_resource_id').all(previewId).map(resource) }
}
