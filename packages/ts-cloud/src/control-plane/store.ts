import type { Changes, SQLQueryBindings } from 'bun:sqlite'
import type {
  AppendEventInput,
  AuthorizationGrant,
  AuthorizationScope,
  AuthorizationScopeType,
  AuthorizationTarget,
  CompactResult,
  ControlPlaneActor,
  ControlPlaneEnvironment,
  ControlPlaneEvent,
  ControlPlaneHealth,
  ControlPlaneOperation,
  ControlPlaneProject,
  ControlPlaneResource,
  ControlPlaneSnapshot,
  ControlPlaneStoreOptions,
  ControlPlaneTag,
  ControlPlaneOrganization,
  CreateActorInput,
  CreateEnvironmentInput,
  CreateGrantInput,
  CreateInvitationInput,
  CreateMembershipInput,
  CreateOperationInput,
  CreateOrganizationInput,
  CreateProjectInput,
  CreateResourceInput,
  EventListOptions,
  ImportSnapshotOptions,
  JsonValue,
  OperationListOptions,
  OperationState,
  NavigationPreference,
  OrganizationInvitation,
  OrganizationMembership,
  ReconcileResult,
  SavedFilter,
  TransitionOperationInput,
  UpdateProjectInput,
  UpdateResourceInput,
} from './types'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Database } from 'bun:sqlite'
import { CONTROL_PLANE_SCHEMA_VERSION, controlPlaneMigrations } from './migrations'
import { AUTHORIZATION_CAPABILITIES } from './authorization'
import { InvalidOperationTransitionError, OptimisticConcurrencyError, UnsupportedSchemaVersionError } from './types'

export const CONTROL_PLANE_DATABASE_FILE: string = join('.ts-cloud', 'control-plane.sqlite')
export const MAX_CONTROL_PLANE_JSON_BYTES: number = 64 * 1024
export const MAX_CONTROL_PLANE_ERROR_BYTES: number = 16 * 1024

const TERMINAL_STATES: readonly OperationState[] = ['succeeded', 'failed', 'cancelled', 'timed_out']
const TRANSITIONS: Readonly<Record<OperationState, readonly OperationState[]>> = {
  queued: ['running', 'cancelled', 'timed_out'],
  running: ['queued', 'succeeded', 'failed', 'cancelled', 'timed_out'],
  succeeded: [],
  failed: ['queued'],
  cancelled: ['queued'],
  timed_out: ['queued'],
}
const SENSITIVE_KEY = /(?:^|_)(?:authorization|cookie|credential|password|passwd|secret|token|api_?key|private_?key|access_?key)(?:$|_)/i
const SENSITIVE_TEXT = /(?:authorization|password|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)\s*[=:]\s*[^\s,;]+/gi

type Row = Record<string, unknown>

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

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function redactValue(value: unknown, key?: string): JsonValue {
  if (key && SENSITIVE_KEY.test(key))
    return '[REDACTED]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number')
    return value
  if (typeof value === 'string')
    return value.replace(SENSITIVE_TEXT, '[REDACTED]')
  if (Array.isArray(value))
    return value.map(item => redactValue(item))
  if (value && typeof value === 'object') {
    const result: Record<string, JsonValue> = {}
    for (const [childKey, child] of Object.entries(value))
      result[childKey] = redactValue(child, childKey)
    return result
  }
  return String(value ?? '')
}

export function sanitizeControlPlaneValue(value: unknown, maxBytes: number = MAX_CONTROL_PLANE_JSON_BYTES): JsonValue {
  const redacted = redactValue(value)
  const encoded = JSON.stringify(redacted)
  if (Buffer.byteLength(encoded) <= maxBytes)
    return redacted
  return { truncated: true, originalBytes: Buffer.byteLength(encoded), preview: encoded.slice(0, Math.max(0, maxBytes - 128)) }
}

function json(value: unknown): string {
  return JSON.stringify(sanitizeControlPlaneValue(value))
}

function clampError(value: string | undefined): string | undefined {
  if (!value)
    return undefined
  const redacted = value.replace(SENSITIVE_TEXT, '[REDACTED]')
  return Buffer.byteLength(redacted) <= MAX_CONTROL_PLANE_ERROR_BYTES
    ? redacted
    : `${redacted.slice(0, MAX_CONTROL_PLANE_ERROR_BYTES - 24)}\n[output truncated]`
}

function mapProject(row: Row): ControlPlaneProject {
  return {
    id: String(row.id), slug: String(row.slug), name: String(row.name),
    description: optionalString(row.description), organizationId: optionalString(row.organization_id),
    desiredConfigHash: optionalString(row.desired_config_hash), version: Number(row.version),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function mapEnvironment(row: Row): ControlPlaneEnvironment {
  return {
    id: String(row.id), projectId: String(row.project_id), slug: String(row.slug), name: String(row.name),
    kind: String(row.kind), region: optionalString(row.region), desiredState: parseJson(row.desired_state),
    discoveredState: parseJson(row.discovered_state), version: Number(row.version),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function mapResource(row: Row): ControlPlaneResource {
  return {
    id: String(row.id), projectId: String(row.project_id), environmentId: optionalString(row.environment_id),
    kind: String(row.kind), slug: String(row.slug), name: String(row.name), provider: optionalString(row.provider),
    providerId: optionalString(row.provider_id), desiredState: parseJson(row.desired_state),
    discoveredState: parseJson(row.discovered_state), metadata: parseJson(row.metadata), version: Number(row.version),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function mapActor(row: Row): ControlPlaneActor {
  return {
    id: String(row.id), kind: String(row.kind) as ControlPlaneActor['kind'], externalId: optionalString(row.external_id),
    displayName: String(row.display_name), metadata: parseJson(row.metadata), disabledAt: optionalString(row.disabled_at),
    version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function mapOperation(row: Row): ControlPlaneOperation {
  return {
    id: String(row.id), projectId: optionalString(row.project_id), environmentId: optionalString(row.environment_id),
    resourceId: optionalString(row.resource_id), actorId: optionalString(row.actor_id), kind: String(row.kind),
    state: String(row.state) as OperationState, correlationId: String(row.correlation_id),
    idempotencyKey: optionalString(row.idempotency_key), input: parseJson(row.input), output: parseJson(row.output),
    error: optionalString(row.error), attempt: Number(row.attempt), priority: Number(row.priority),
    leaseOwner: optionalString(row.lease_owner), leaseExpiresAt: optionalString(row.lease_expires_at),
    cancelRequestedAt: optionalString(row.cancel_requested_at), startedAt: optionalString(row.started_at),
    finishedAt: optionalString(row.finished_at), version: Number(row.version),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function mapEvent(row: Row): ControlPlaneEvent {
  return {
    id: String(row.id), sequence: Number(row.sequence), organizationId: optionalString(row.organization_id), projectId: optionalString(row.project_id),
    operationId: optionalString(row.operation_id), resourceId: optionalString(row.resource_id), actorId: optionalString(row.actor_id),
    correlationId: String(row.correlation_id), type: String(row.type), level: String(row.level) as ControlPlaneEvent['level'],
    payload: parseJson(row.payload), createdAt: String(row.created_at),
  }
}

function mapTag(row: Row): ControlPlaneTag {
  return {
    id: String(row.id), projectId: String(row.project_id), name: String(row.name), normalizedName: String(row.normalized_name),
    color: String(row.color), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function mapSavedFilter(row: Row): SavedFilter {
  return {
    id: String(row.id), actorKey: String(row.actor_key), name: String(row.name), routeId: String(row.route_id),
    query: parseJson(row.query) as Record<string, JsonValue>, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function mapNavigationPreference(row: Row): NavigationPreference {
  return {
    actorKey: String(row.actor_key), entityType: String(row.entity_type), entityId: String(row.entity_id),
    favorite: Number(row.favorite) === 1, lastVisitedAt: String(row.last_visited_at), visitCount: Number(row.visit_count),
  }
}

function mapOrganization(row: Row): ControlPlaneOrganization {
  return {
    id: String(row.id), slug: String(row.slug), name: String(row.name),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function mapScope(row: Row): AuthorizationScope {
  const type = String(row.scope_type) as AuthorizationScopeType
  return { type, ...(type === 'organization' ? {} : { id: String(row.scope_id) }) }
}

function mapMembership(row: Row): OrganizationMembership {
  return {
    id: String(row.id), organizationId: String(row.organization_id), actorId: String(row.actor_id),
    roleTemplate: String(row.role_template) as OrganizationMembership['roleTemplate'], scope: mapScope(row),
    status: String(row.status) as OrganizationMembership['status'], sessionVersion: Number(row.session_version),
    lastActiveAt: optionalString(row.last_active_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function mapInvitation(row: Row, now: string): OrganizationInvitation {
  const acceptedAt = optionalString(row.accepted_at)
  const revokedAt = optionalString(row.revoked_at)
  const expiresAt = String(row.expires_at)
  const state: OrganizationInvitation['state'] = revokedAt ? 'revoked' : acceptedAt ? 'accepted' : expiresAt <= now ? 'expired' : 'pending'
  return {
    id: String(row.id), organizationId: String(row.organization_id), email: String(row.email),
    roleTemplate: String(row.role_template) as OrganizationInvitation['roleTemplate'], scope: mapScope(row),
    invitedByActorId: optionalString(row.invited_by_actor_id), acceptedByActorId: optionalString(row.accepted_by_actor_id),
    expiresAt, acceptedAt, revokedAt, state, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function mapGrant(row: Row): AuthorizationGrant {
  return {
    id: String(row.id), organizationId: String(row.organization_id), membershipId: String(row.membership_id),
    effect: String(row.effect) as AuthorizationGrant['effect'], capability: String(row.capability) as AuthorizationGrant['capability'],
    scope: mapScope(row), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function scopePayload(scope: AuthorizationScope): JsonValue {
  return { type: scope.type, id: scope.id ?? null }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function run(database: Database, sql: string, bindings: SQLQueryBindings[]): Changes {
  return database.run(sql, bindings)
}

export class ControlPlaneStore {
  readonly path: string
  readonly database: Database
  private readonly nowFn: () => Date
  private readonly idFn: () => string

  constructor(options: ControlPlaneStoreOptions = {}) {
    this.path = options.path ?? join(options.cwd ?? process.cwd(), CONTROL_PLANE_DATABASE_FILE)
    this.nowFn = options.now ?? (() => new Date())
    this.idFn = options.id ?? (() => crypto.randomUUID())
    const inMemory = this.path === ':memory:'
    if (!inMemory) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      try { chmodSync(dirname(this.path), 0o700) } catch {}
    }
    this.database = new Database(this.path, { create: true, strict: true })
    this.database.run('PRAGMA foreign_keys = ON')
    this.database.run(`PRAGMA busy_timeout = ${Math.max(100, options.busyTimeoutMs ?? 5_000)}`)
    if (!inMemory) {
      this.database.run('PRAGMA journal_mode = WAL')
      this.database.run('PRAGMA synchronous = NORMAL')
    }
    this.migrate()
    if (!inMemory)
      this.secureDatabaseFiles()
  }

  private now(): string {
    return this.nowFn().toISOString()
  }

  private secureDatabaseFiles(): void {
    for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (!existsSync(path))
        continue
      try { chmodSync(path, 0o600) } catch {}
    }
  }

  private migrate(): void {
    const row = this.database.query<Row, []>('PRAGMA user_version').get()
    const current = Number(row?.user_version ?? 0)
    if (current > CONTROL_PLANE_SCHEMA_VERSION)
      throw new UnsupportedSchemaVersionError(current, CONTROL_PLANE_SCHEMA_VERSION)
    if (current === CONTROL_PLANE_SCHEMA_VERSION)
      return

    let backupPath: string | undefined
    if (current > 0 && this.path !== ':memory:') {
      backupPath = `${this.path}.v${current}.${Date.now()}.bak`
      writeFileSync(backupPath, this.database.serialize(), { mode: 0o600 })
    }

    try {
      const apply = this.database.transaction(() => {
        for (const migration of controlPlaneMigrations) {
          if (migration.version <= current)
            continue
          this.database.run(migration.sql)
          run(this.database, 'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [migration.version, migration.name, this.now()])
          this.database.run(`PRAGMA user_version = ${migration.version}`)
        }
      })
      apply.exclusive()
      if (backupPath)
        this.setSetting('storage.last_backup', { path: backupPath, createdAt: this.now(), reason: 'pre-migration' })
    }
    catch (error) {
      const restore = backupPath ? ` Restore from ${backupPath}.` : ''
      throw new Error(`Control-plane migration from schema ${current} failed.${restore} ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  close(): void {
    if (this.path !== ':memory:')
      this.secureDatabaseFiles()
    this.database.close()
  }

  transaction<T>(callback: () => T): T {
    return this.database.transaction(callback).immediate()
  }

  createProject(input: CreateProjectInput): ControlPlaneProject {
    const id = input.id ?? this.idFn()
    const now = this.now()
    run(this.database,
      'INSERT INTO projects (id, slug, name, description, organization_id, desired_config_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, input.slug, input.name, input.description ?? null, input.organizationId ?? null, input.desiredConfigHash ?? null, now, now],
    )
    return this.getProject(id)!
  }

  getProject(id: string): ControlPlaneProject | undefined {
    const row = this.database.query<Row, [string]>('SELECT * FROM projects WHERE id = ?').get(id)
    return row ? mapProject(row) : undefined
  }

  getProjectBySlug(slug: string): ControlPlaneProject | undefined {
    const row = this.database.query<Row, [string]>('SELECT * FROM projects WHERE slug = ?').get(slug)
    return row ? mapProject(row) : undefined
  }

  listProjects(): ControlPlaneProject[] {
    return this.database.query<Row, []>('SELECT * FROM projects ORDER BY name COLLATE NOCASE, id').all().map(mapProject)
  }

  updateProject(id: string, expectedVersion: number, input: UpdateProjectInput): ControlPlaneProject {
    const current = this.getProject(id)
    if (!current || current.version !== expectedVersion)
      throw new OptimisticConcurrencyError('Project', id, expectedVersion)
    const result = run(this.database,
      `UPDATE projects SET name = ?, description = ?, organization_id = ?, desired_config_hash = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?`,
      [
        input.name ?? current.name,
        input.description === null ? null : (input.description ?? current.description ?? null),
        input.organizationId === null ? null : (input.organizationId ?? current.organizationId ?? null),
        input.desiredConfigHash === null ? null : (input.desiredConfigHash ?? current.desiredConfigHash ?? null),
        this.now(), id, expectedVersion,
      ],
    )
    if (result.changes !== 1)
      throw new OptimisticConcurrencyError('Project', id, expectedVersion)
    return this.getProject(id)!
  }

  createEnvironment(input: CreateEnvironmentInput): ControlPlaneEnvironment {
    const id = input.id ?? this.idFn()
    const now = this.now()
    run(this.database,
      `INSERT INTO environments (id, project_id, slug, name, kind, region, desired_state, discovered_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.projectId, input.slug, input.name, input.kind, input.region ?? null,
        json(input.desiredState ?? {}), json(input.discoveredState ?? {}), now, now],
    )
    return mapEnvironment(this.database.query<Row, [string]>('SELECT * FROM environments WHERE id = ?').get(id)!)
  }

  listEnvironments(projectId: string): ControlPlaneEnvironment[] {
    return this.database.query<Row, [string]>('SELECT * FROM environments WHERE project_id = ? ORDER BY name COLLATE NOCASE, id').all(projectId).map(mapEnvironment)
  }

  getEnvironmentBySlug(projectId: string, slug: string): ControlPlaneEnvironment | undefined {
    const row = this.database.query<Row, [string, string]>('SELECT * FROM environments WHERE project_id = ? AND slug = ?').get(projectId, slug)
    return row ? mapEnvironment(row) : undefined
  }

  createResource(input: CreateResourceInput): ControlPlaneResource {
    const id = input.id ?? this.idFn()
    const now = this.now()
    run(this.database,
      `INSERT INTO resources (id, project_id, environment_id, kind, slug, name, provider, provider_id, desired_state, discovered_state, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.projectId, input.environmentId ?? null, input.kind, input.slug, input.name, input.provider ?? null,
        input.providerId ?? null, json(input.desiredState ?? {}), json(input.discoveredState ?? {}), json(input.metadata ?? {}), now, now],
    )
    return mapResource(this.database.query<Row, [string]>('SELECT * FROM resources WHERE id = ?').get(id)!)
  }

  listResources(projectId: string, environmentId?: string): ControlPlaneResource[] {
    const rows = environmentId
      ? this.database.query<Row, [string, string]>('SELECT * FROM resources WHERE project_id = ? AND environment_id = ? ORDER BY kind, name COLLATE NOCASE').all(projectId, environmentId)
      : this.database.query<Row, [string]>('SELECT * FROM resources WHERE project_id = ? ORDER BY kind, name COLLATE NOCASE').all(projectId)
    return rows.map(mapResource)
  }

  getResource(id: string): ControlPlaneResource | undefined {
    const row = this.database.query<Row, [string]>('SELECT * FROM resources WHERE id = ?').get(id)
    return row ? mapResource(row) : undefined
  }

  updateResource(id: string, expectedVersion: number, input: UpdateResourceInput): ControlPlaneResource {
    const current = this.getResource(id)
    if (!current || current.version !== expectedVersion)
      throw new OptimisticConcurrencyError('Resource', id, expectedVersion)
    const result = run(this.database,
      `UPDATE resources SET name = ?, provider = ?, provider_id = ?, desired_state = ?, discovered_state = ?, metadata = ?,
      version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
      [
        input.name ?? current.name,
        input.provider === null ? null : (input.provider ?? current.provider ?? null),
        input.providerId === null ? null : (input.providerId ?? current.providerId ?? null),
        json(input.desiredState ?? current.desiredState),
        json(input.discoveredState ?? current.discoveredState),
        json(input.metadata ?? current.metadata),
        this.now(), id, expectedVersion,
      ],
    )
    if (result.changes !== 1)
      throw new OptimisticConcurrencyError('Resource', id, expectedVersion)
    return this.getResource(id)!
  }

  createActor(input: CreateActorInput): ControlPlaneActor {
    const id = input.id ?? this.idFn()
    const now = this.now()
    run(this.database,
      'INSERT INTO actors (id, kind, external_id, display_name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, input.kind, input.externalId ?? null, input.displayName, json(input.metadata ?? {}), now, now],
    )
    return mapActor(this.database.query<Row, [string]>('SELECT * FROM actors WHERE id = ?').get(id)!)
  }

  getActorByExternalId(kind: ControlPlaneActor['kind'], externalId: string): ControlPlaneActor | undefined {
    const row = this.database.query<Row, [ControlPlaneActor['kind'], string]>('SELECT * FROM actors WHERE kind = ? AND external_id = ?').get(kind, externalId)
    return row ? mapActor(row) : undefined
  }

  getActor(id: string): ControlPlaneActor | undefined {
    const row = this.database.query<Row, [string]>('SELECT * FROM actors WHERE id = ?').get(id)
    return row ? mapActor(row) : undefined
  }

  createOrganization(input: CreateOrganizationInput): ControlPlaneOrganization {
    const slug = input.slug.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug))
      throw new Error('Organization slugs must contain 3-64 lowercase letters, numbers, or dashes')
    const name = input.name.trim()
    if (!name || name.length > 100)
      throw new Error('Organization names must contain 1-100 characters')
    const id = input.id ?? this.idFn()
    const now = this.now()
    run(this.database, 'INSERT INTO organizations (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [id, slug, name, now, now])
    return this.getOrganization(id)!
  }

  getOrganization(id: string): ControlPlaneOrganization | undefined {
    const row = this.database.query<Row, [string]>('SELECT * FROM organizations WHERE id = ?').get(id)
    return row ? mapOrganization(row) : undefined
  }

  getOrganizationBySlug(slug: string): ControlPlaneOrganization | undefined {
    const row = this.database.query<Row, [string]>('SELECT * FROM organizations WHERE slug = ?').get(slug.trim().toLowerCase())
    return row ? mapOrganization(row) : undefined
  }

  listOrganizations(actorId?: string): ControlPlaneOrganization[] {
    const rows = actorId
      ? this.database.query<Row, [string]>(
          `SELECT organizations.* FROM organizations JOIN organization_memberships ON organization_memberships.organization_id = organizations.id
          WHERE organization_memberships.actor_id = ? AND organization_memberships.status = 'active' ORDER BY organizations.name COLLATE NOCASE`,
        ).all(actorId)
      : this.database.query<Row, []>('SELECT * FROM organizations ORDER BY name COLLATE NOCASE').all()
    return rows.map(mapOrganization)
  }

  private normalizeAuthorizationScope(organizationId: string, scope: AuthorizationScope = { type: 'organization' }): AuthorizationScope {
    if (scope.type === 'organization') {
      if (scope.id && scope.id !== organizationId)
        throw new Error('Organization scope does not match the requested organization')
      return { type: 'organization' }
    }
    if (!scope.id)
      throw new Error(`${scope.type} scopes require an ID`)
    const target = this.resolveAuthorizationTarget(organizationId, scope)
    if (!target)
      throw new Error('Authorization scope was not found in this organization')
    return { type: scope.type, id: scope.id }
  }

  resolveAuthorizationTarget(organizationId: string, scope: AuthorizationScope): AuthorizationTarget | undefined {
    if (!this.getOrganization(organizationId))
      return undefined
    if (scope.type === 'organization')
      return { organizationId }
    if (!scope.id)
      return undefined
    if (scope.type === 'project') {
      const project = this.database.query<Row, [string, string]>('SELECT id FROM projects WHERE id = ? AND organization_id = ?').get(scope.id, organizationId)
      return project ? { organizationId, projectId: String(project.id) } : undefined
    }
    if (scope.type === 'environment') {
      const environment = this.database.query<Row, [string, string]>(
        'SELECT environments.id, environments.project_id FROM environments JOIN projects ON projects.id = environments.project_id WHERE environments.id = ? AND projects.organization_id = ?',
      ).get(scope.id, organizationId)
      return environment ? { organizationId, projectId: String(environment.project_id), environmentId: String(environment.id) } : undefined
    }
    const resource = this.database.query<Row, [string, string]>(
      `SELECT resources.id, resources.project_id, resources.environment_id FROM resources
      JOIN projects ON projects.id = resources.project_id WHERE resources.id = ? AND projects.organization_id = ?`,
    ).get(scope.id, organizationId)
    return resource
      ? { organizationId, projectId: String(resource.project_id), environmentId: optionalString(resource.environment_id), resourceId: String(resource.id) }
      : undefined
  }

  createMembership(input: CreateMembershipInput): OrganizationMembership {
    if (!this.getActor(input.actorId))
      throw new Error('Membership actor was not found')
    const scope = this.normalizeAuthorizationScope(input.organizationId, input.scope)
    if (input.roleTemplate === 'owner' && scope.type !== 'organization')
      throw new Error('Owners must be scoped to the organization')
    const id = input.id ?? this.idFn()
    const now = this.now()
    run(this.database,
      `INSERT INTO organization_memberships (id, organization_id, actor_id, role_template, scope_type, scope_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.organizationId, input.actorId, input.roleTemplate, scope.type, scope.id ?? null, now, now],
    )
    const membership = this.getMembership(id)!
    this.appendEvent({ organizationId: input.organizationId, actorId: input.actorId, type: 'organization.membership.created', payload: { membershipId: id, roleTemplate: input.roleTemplate, scope: scopePayload(scope) } })
    return membership
  }

  getMembership(id: string): OrganizationMembership | undefined {
    const row = this.database.query<Row, [string]>('SELECT * FROM organization_memberships WHERE id = ?').get(id)
    return row ? mapMembership(row) : undefined
  }

  getMembershipForActor(organizationId: string, actorId: string): OrganizationMembership | undefined {
    const row = this.database.query<Row, [string, string]>('SELECT * FROM organization_memberships WHERE organization_id = ? AND actor_id = ?').get(organizationId, actorId)
    return row ? mapMembership(row) : undefined
  }

  listMemberships(organizationId: string, options: { includeRevoked?: boolean } = {}): OrganizationMembership[] {
    const revoked = options.includeRevoked ? '' : 'AND status = \'active\''
    return this.database.query<Row, [string]>(
      `SELECT * FROM organization_memberships WHERE organization_id = ? ${revoked} ORDER BY created_at, id`,
    ).all(organizationId).map(mapMembership)
  }

  updateMembership(input: { id: string, roleTemplate: OrganizationMembership['roleTemplate'], scope?: AuthorizationScope, actorId?: string }): OrganizationMembership {
    const current = this.getMembership(input.id)
    if (!current)
      throw new Error('Membership was not found')
    const scope = this.normalizeAuthorizationScope(current.organizationId, input.scope ?? current.scope)
    if (input.roleTemplate === 'owner' && scope.type !== 'organization')
      throw new Error('Owners must be scoped to the organization')
    if (current.roleTemplate === 'owner' && current.status === 'active' && (input.roleTemplate !== 'owner' || scope.type !== 'organization'))
      this.assertAnotherOwner(current)
    run(this.database,
      `UPDATE organization_memberships SET role_template = ?, scope_type = ?, scope_id = ?, session_version = session_version + 1, updated_at = ? WHERE id = ?`,
      [input.roleTemplate, scope.type, scope.id ?? null, this.now(), current.id],
    )
    this.appendEvent({ organizationId: current.organizationId, actorId: input.actorId, type: 'organization.membership.updated', payload: { membershipId: current.id, from: { roleTemplate: current.roleTemplate, scope: scopePayload(current.scope) }, to: { roleTemplate: input.roleTemplate, scope: scopePayload(scope) } } })
    return this.getMembership(current.id)!
  }

  revokeMembership(id: string, actorId?: string): OrganizationMembership {
    const current = this.getMembership(id)
    if (!current)
      throw new Error('Membership was not found')
    if (current.status === 'revoked')
      return current
    if (current.roleTemplate === 'owner')
      this.assertAnotherOwner(current)
    run(this.database,
      `UPDATE organization_memberships SET status = 'revoked', session_version = session_version + 1, updated_at = ? WHERE id = ?`,
      [this.now(), id],
    )
    this.appendEvent({ organizationId: current.organizationId, actorId, type: 'organization.membership.revoked', payload: { membershipId: id } })
    return this.getMembership(id)!
  }

  touchMembership(id: string): OrganizationMembership {
    const now = this.now()
    run(this.database, 'UPDATE organization_memberships SET last_active_at = ?, updated_at = ? WHERE id = ? AND status = ?', [now, now, id, 'active'])
    const membership = this.getMembership(id)
    if (!membership)
      throw new Error('Membership was not found')
    return membership
  }

  private assertAnotherOwner(current: OrganizationMembership): void {
    const owners = Number(this.database.query<Row, [string, string]>('SELECT COUNT(*) AS count FROM organization_memberships WHERE organization_id = ? AND status = ? AND role_template = \'owner\'').get(current.organizationId, 'active')?.count ?? 0)
    if (owners <= 1)
      throw new Error('Cannot remove or demote the last organization owner')
  }

  createInvitation(input: CreateInvitationInput): { invitation: OrganizationInvitation, token: string } {
    const email = input.email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      throw new Error('A valid invitation email is required')
    const scope = this.normalizeAuthorizationScope(input.organizationId, input.scope)
    if (input.roleTemplate === 'owner' && scope.type !== 'organization')
      throw new Error('Owners must be scoped to the organization')
    const token = randomBytes(32).toString('base64url')
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const id = input.id ?? this.idFn()
    const now = this.now()
    const expiresAt = new Date(this.nowFn().getTime() + Math.min(30 * 86_400_000, Math.max(60_000, input.expiresInMs ?? 7 * 86_400_000))).toISOString()
    run(this.database,
      `INSERT INTO organization_invitations (id, organization_id, email, role_template, scope_type, scope_id, token_hash, invited_by_actor_id, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.organizationId, email, input.roleTemplate, scope.type, scope.id ?? null, tokenHash, input.invitedByActorId ?? null, expiresAt, now, now],
    )
    this.appendEvent({ organizationId: input.organizationId, actorId: input.invitedByActorId, type: 'organization.invitation.created', payload: { invitationId: id, email, roleTemplate: input.roleTemplate, scope: scopePayload(scope), expiresAt } })
    return { invitation: this.getInvitation(id)!, token }
  }

  getInvitation(id: string): OrganizationInvitation | undefined {
    const row = this.database.query<Row, [string]>('SELECT * FROM organization_invitations WHERE id = ?').get(id)
    return row ? mapInvitation(row, this.now()) : undefined
  }

  listInvitations(organizationId: string): OrganizationInvitation[] {
    return this.database.query<Row, [string]>('SELECT * FROM organization_invitations WHERE organization_id = ? ORDER BY created_at DESC').all(organizationId).map(row => mapInvitation(row, this.now()))
  }

  acceptInvitation(token: string, actorId: string): { invitation: OrganizationInvitation, membership: OrganizationMembership } {
    const tokenHash = createHash('sha256').update(token).digest('hex')
    return this.transaction(() => {
      const row = this.database.query<Row, [string]>('SELECT * FROM organization_invitations WHERE token_hash = ?').get(tokenHash)
      if (!row)
        throw new Error('Invitation is invalid')
      const invitation = mapInvitation(row, this.now())
      if (invitation.state !== 'pending')
        throw new Error(`Invitation is ${invitation.state}`)
      if (!this.getActor(actorId))
        throw new Error('Invitation actor was not found')
      const changed = run(this.database,
        'UPDATE organization_invitations SET accepted_by_actor_id = ?, accepted_at = ?, updated_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?',
        [actorId, this.now(), this.now(), invitation.id, this.now()],
      )
      if (changed.changes !== 1)
        throw new Error('Invitation is no longer available')
      const existing = this.getMembershipForActor(invitation.organizationId, actorId)
      const membership = existing ?? this.createMembership({
        organizationId: invitation.organizationId,
        actorId,
        roleTemplate: invitation.roleTemplate,
        scope: invitation.scope,
      })
      this.appendEvent({ organizationId: invitation.organizationId, actorId, type: 'organization.invitation.accepted', payload: { invitationId: invitation.id, membershipId: membership.id } })
      return { invitation: this.getInvitation(invitation.id)!, membership }
    })
  }

  revokeInvitation(id: string, actorId?: string): OrganizationInvitation {
    const invitation = this.getInvitation(id)
    if (!invitation)
      throw new Error('Invitation was not found')
    if (invitation.acceptedAt)
      throw new Error('Accepted invitations cannot be revoked')
    if (!invitation.revokedAt)
      run(this.database, 'UPDATE organization_invitations SET revoked_at = ?, updated_at = ? WHERE id = ?', [this.now(), this.now(), id])
    this.appendEvent({ organizationId: invitation.organizationId, actorId, type: 'organization.invitation.revoked', payload: { invitationId: id } })
    return this.getInvitation(id)!
  }

  reissueInvitation(id: string, actorId?: string): { invitation: OrganizationInvitation, token: string } {
    const previous = this.getInvitation(id)
    if (!previous)
      throw new Error('Invitation was not found')
    if (previous.state === 'accepted')
      throw new Error('Accepted invitations cannot be reissued')
    this.revokeInvitation(id, actorId)
    return this.createInvitation({
      organizationId: previous.organizationId,
      email: previous.email,
      roleTemplate: previous.roleTemplate,
      scope: previous.scope,
      invitedByActorId: actorId,
    })
  }

  upsertGrant(input: CreateGrantInput): AuthorizationGrant {
    if (!AUTHORIZATION_CAPABILITIES.includes(input.capability))
      throw new Error('Unknown authorization capability')
    const membership = this.getMembership(input.membershipId)
    if (!membership || membership.organizationId !== input.organizationId)
      throw new Error('Grant membership was not found in this organization')
    const scope = this.normalizeAuthorizationScope(input.organizationId, input.scope)
    const now = this.now()
    const existing = this.database.query<Row, [string, string, string, string, string | null]>(
      'SELECT * FROM authorization_grants WHERE membership_id = ? AND effect = ? AND capability = ? AND scope_type = ? AND scope_id IS ?',
    ).get(input.membershipId, input.effect, input.capability, scope.type, scope.id ?? null)
    if (existing)
      return mapGrant(existing)
    const id = input.id ?? this.idFn()
    run(this.database,
      `INSERT INTO authorization_grants (id, organization_id, membership_id, effect, capability, scope_type, scope_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.organizationId, input.membershipId, input.effect, input.capability, scope.type, scope.id ?? null, now, now],
    )
    this.appendEvent({ organizationId: input.organizationId, type: 'organization.grant.created', payload: { grantId: id, membershipId: input.membershipId, effect: input.effect, capability: input.capability, scope: scopePayload(scope) } })
    return this.getGrant(id)!
  }

  getGrant(id: string): AuthorizationGrant | undefined {
    const row = this.database.query<Row, [string]>('SELECT * FROM authorization_grants WHERE id = ?').get(id)
    return row ? mapGrant(row) : undefined
  }

  listGrants(membershipId: string): AuthorizationGrant[] {
    return this.database.query<Row, [string]>('SELECT * FROM authorization_grants WHERE membership_id = ? ORDER BY effect DESC, capability, scope_type, scope_id').all(membershipId).map(mapGrant)
  }

  removeGrant(id: string, actorId?: string): boolean {
    const grant = this.getGrant(id)
    if (!grant)
      return false
    const removed = run(this.database, 'DELETE FROM authorization_grants WHERE id = ?', [id]).changes === 1
    if (removed)
      this.appendEvent({ organizationId: grant.organizationId, actorId, type: 'organization.grant.removed', payload: { grantId: id, membershipId: grant.membershipId } })
    return removed
  }

  createOperation(input: CreateOperationInput): ControlPlaneOperation {
    if (input.idempotencyKey) {
      const existing = this.database.query<Row, [string]>('SELECT * FROM operations WHERE idempotency_key = ?').get(input.idempotencyKey)
      if (existing)
        return mapOperation(existing)
    }
    const id = input.id ?? this.idFn()
    const correlationId = input.correlationId ?? this.idFn()
    const now = this.now()
    try {
      return this.transaction(() => {
        run(this.database,
          `INSERT INTO operations (id, project_id, environment_id, resource_id, actor_id, kind, state, correlation_id, idempotency_key, input, output, priority, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, '{}', ?, ?, ?)`,
          [id, input.projectId ?? null, input.environmentId ?? null, input.resourceId ?? null, input.actorId ?? null,
            input.kind, correlationId, input.idempotencyKey ?? null, json(input.input ?? {}), input.priority ?? 0, now, now],
        )
        this.appendEvent({ projectId: input.projectId, operationId: id, resourceId: input.resourceId, actorId: input.actorId, correlationId, type: 'operation.queued', payload: { kind: input.kind } })
        return this.getOperation(id)!
      })
    }
    catch (error) {
      if (input.idempotencyKey) {
        const existing = this.database.query<Row, [string]>('SELECT * FROM operations WHERE idempotency_key = ?').get(input.idempotencyKey)
        if (existing)
          return mapOperation(existing)
      }
      throw error
    }
  }

  getOperation(id: string): ControlPlaneOperation | undefined {
    const row = this.database.query<Row, [string]>('SELECT * FROM operations WHERE id = ?').get(id)
    return row ? mapOperation(row) : undefined
  }

  listOperations(options: OperationListOptions = {}): ControlPlaneOperation[] {
    const filters: string[] = []
    const bindings: SQLQueryBindings[] = []
    if (options.projectId) { filters.push('project_id = ?'); bindings.push(options.projectId) }
    if (options.state) { filters.push('state = ?'); bindings.push(options.state) }
    if (options.kind) { filters.push('kind = ?'); bindings.push(options.kind) }
    if (options.before) { filters.push('created_at < ?'); bindings.push(options.before) }
    const limit = Math.min(500, Math.max(1, options.limit ?? 100))
    bindings.push(limit)
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    return this.database.query<Row, SQLQueryBindings[]>(`SELECT * FROM operations ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...bindings).map(mapOperation)
  }

  claimNextOperation(workerId: string, leaseMs: number = 60_000, kinds?: readonly string[]): ControlPlaneOperation | undefined {
    const now = this.now()
    const expires = new Date(this.nowFn().getTime() + leaseMs).toISOString()
    return this.transaction(() => {
      const kindFilter = kinds?.length ? `AND kind IN (${placeholders(kinds.length)})` : ''
      const bindings: SQLQueryBindings[] = kinds ? [...kinds] : []
      const row = this.database.query<Row, SQLQueryBindings[]>(
        `SELECT * FROM operations WHERE state = 'queued' ${kindFilter} ORDER BY priority DESC, created_at ASC, id ASC LIMIT 1`,
      ).get(...bindings)
      if (!row)
        return undefined
      const operation = mapOperation(row)
      const result = run(this.database,
        `UPDATE operations SET state = 'running', attempt = attempt + 1, lease_owner = ?, lease_expires_at = ?,
        started_at = COALESCE(started_at, ?), updated_at = ?, version = version + 1 WHERE id = ? AND state = 'queued' AND version = ?`,
        [workerId, expires, now, now, operation.id, operation.version],
      )
      if (result.changes !== 1)
        return undefined
      this.appendEvent({ projectId: operation.projectId, operationId: operation.id, resourceId: operation.resourceId, actorId: operation.actorId, correlationId: operation.correlationId, type: 'operation.running', payload: { attempt: operation.attempt + 1, workerId } })
      return this.getOperation(operation.id)
    })
  }

  claimOperation(id: string, workerId: string, leaseMs: number = 60_000): ControlPlaneOperation | undefined {
    const now = this.now()
    const expires = new Date(this.nowFn().getTime() + leaseMs).toISOString()
    return this.transaction(() => {
      const operation = this.getOperation(id)
      if (!operation || operation.state !== 'queued')
        return undefined
      const result = run(this.database,
        `UPDATE operations SET state = 'running', attempt = attempt + 1, lease_owner = ?, lease_expires_at = ?,
        started_at = COALESCE(started_at, ?), updated_at = ?, version = version + 1 WHERE id = ? AND state = 'queued' AND version = ?`,
        [workerId, expires, now, now, operation.id, operation.version],
      )
      if (result.changes !== 1)
        return undefined
      this.appendEvent({ projectId: operation.projectId, operationId: operation.id, resourceId: operation.resourceId, actorId: operation.actorId, correlationId: operation.correlationId, type: 'operation.running', payload: { attempt: operation.attempt + 1, workerId } })
      return this.getOperation(operation.id)
    })
  }

  transitionOperation(id: string, input: TransitionOperationInput): ControlPlaneOperation {
    return this.transaction(() => {
      const current = this.getOperation(id)
      if (!current)
        throw new Error(`Operation ${id} was not found`)
      const expectedVersion = input.expectedVersion ?? current.version
      if (current.version !== expectedVersion)
        throw new OptimisticConcurrencyError('Operation', id, expectedVersion)
      if (!TRANSITIONS[current.state].includes(input.to))
        throw new InvalidOperationTransitionError(current.state, input.to)
      const now = this.now()
      const terminal = TERMINAL_STATES.includes(input.to)
      const retry = input.to === 'queued'
      const result = run(this.database,
        `UPDATE operations SET state = ?, output = ?, error = ?, lease_owner = ?, lease_expires_at = ?,
        finished_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`,
        [input.to, json(input.output ?? current.output), clampError(input.error) ?? null,
          retry || terminal ? null : (input.leaseOwner ?? current.leaseOwner ?? null),
          retry || terminal ? null : (input.leaseExpiresAt ?? current.leaseExpiresAt ?? null),
          terminal ? now : null, now, id, expectedVersion],
      )
      if (result.changes !== 1)
        throw new OptimisticConcurrencyError('Operation', id, expectedVersion)
      this.appendEvent({
        projectId: current.projectId, operationId: id, resourceId: current.resourceId, actorId: current.actorId,
        correlationId: current.correlationId, type: `operation.${input.to}`, level: input.to === 'failed' ? 'error' : 'info',
        payload: { from: current.state, to: input.to, error: clampError(input.error) ?? null },
      })
      return this.getOperation(id)!
    })
  }

  requestCancellation(id: string): ControlPlaneOperation {
    const now = this.now()
    run(this.database, `UPDATE operations SET cancel_requested_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND state IN ('queued', 'running')`, [now, now, id])
    const operation = this.getOperation(id)
    if (!operation)
      throw new Error(`Operation ${id} was not found`)
    return operation
  }

  reconcileOrphanedOperations(options: { policy?: 'requeue' | 'fail', now?: Date } = {}): ReconcileResult {
    const cutoff = (options.now ?? this.nowFn()).toISOString()
    const policy = options.policy ?? 'fail'
    const rows = this.database.query<Row, [string]>(
      `SELECT * FROM operations WHERE state = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    ).all(cutoff).map(mapOperation)
    let requeued = 0
    let failed = 0
    for (const operation of rows) {
      if (policy === 'requeue') {
        this.transitionOperation(operation.id, { to: 'queued', expectedVersion: operation.version, error: 'Worker lease expired; operation requeued after restart.' })
        requeued++
      }
      else {
        this.transitionOperation(operation.id, { to: 'failed', expectedVersion: operation.version, error: 'Worker lease expired or dashboard restarted before completion.' })
        failed++
      }
    }
    return { requeued, failed }
  }

  appendEvent(input: AppendEventInput): ControlPlaneEvent {
    const id = input.id ?? this.idFn()
    const correlationId = input.correlationId ?? this.idFn()
    const organizationId = input.organizationId ?? (input.projectId
      ? optionalString(this.database.query<Row, [string]>('SELECT organization_id FROM projects WHERE id = ?').get(input.projectId)?.organization_id)
      : undefined)
    run(this.database,
      `INSERT INTO events (id, organization_id, project_id, operation_id, resource_id, actor_id, correlation_id, type, level, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, organizationId ?? null, input.projectId ?? null, input.operationId ?? null, input.resourceId ?? null, input.actorId ?? null,
        correlationId, input.type, input.level ?? 'info', json(input.payload ?? {}), this.now()],
    )
    return mapEvent(this.database.query<Row, [string]>('SELECT * FROM events WHERE id = ?').get(id)!)
  }

  listEvents(options: EventListOptions = {}): ControlPlaneEvent[] {
    const filters: string[] = []
    const bindings: SQLQueryBindings[] = []
    if (options.organizationId) { filters.push('organization_id = ?'); bindings.push(options.organizationId) }
    if (options.projectId) { filters.push('project_id = ?'); bindings.push(options.projectId) }
    if (options.operationId) { filters.push('operation_id = ?'); bindings.push(options.operationId) }
    if (options.resourceId) { filters.push('resource_id = ?'); bindings.push(options.resourceId) }
    if (options.correlationId) { filters.push('correlation_id = ?'); bindings.push(options.correlationId) }
    if (options.afterSequence !== undefined) { filters.push('sequence > ?'); bindings.push(options.afterSequence) }
    const limit = Math.min(1_000, Math.max(1, options.limit ?? 200))
    bindings.push(limit)
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    return this.database.query<Row, SQLQueryBindings[]>(`SELECT * FROM events ${where} ORDER BY sequence ASC LIMIT ?`).all(...bindings).map(mapEvent)
  }

  setSetting(key: string, value: JsonValue): void {
    run(this.database,
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, json(value), this.now()],
    )
  }

  getSetting(key: string): JsonValue | undefined {
    const row = this.database.query<Row, [string]>('SELECT value FROM settings WHERE key = ?').get(key)
    return row ? parseJson(row.value) : undefined
  }

  upsertTag(projectId: string, name: string, color: string = '#5a8be0'): ControlPlaneTag {
    const normalizedName = name.trim().toLowerCase().replace(/\s+/g, '-')
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(normalizedName))
      throw new Error('Tag names must contain 1-32 letters, numbers, or dashes')
    if (!/^#[0-9a-f]{6}$/i.test(color))
      throw new Error('Tag colors must be six-digit hex colors')
    const now = this.now()
    const existing = this.database.query<Row, [string, string]>('SELECT * FROM tags WHERE project_id = ? AND normalized_name = ?').get(projectId, normalizedName)
    if (existing) {
      run(this.database, 'UPDATE tags SET name = ?, color = ?, updated_at = ? WHERE id = ?', [name.trim(), color.toLowerCase(), now, String(existing.id)])
      return mapTag(this.database.query<Row, [string]>('SELECT * FROM tags WHERE id = ?').get(String(existing.id))!)
    }
    const id = this.idFn()
    run(this.database,
      'INSERT INTO tags (id, project_id, name, normalized_name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, projectId, name.trim(), normalizedName, color.toLowerCase(), now, now],
    )
    return mapTag(this.database.query<Row, [string]>('SELECT * FROM tags WHERE id = ?').get(id)!)
  }

  listTags(projectId: string): ControlPlaneTag[] {
    return this.database.query<Row, [string]>('SELECT * FROM tags WHERE project_id = ? ORDER BY normalized_name').all(projectId).map(mapTag)
  }

  assignTag(resourceId: string, tagId: string): void {
    const tag = this.database.query<Row, [string, string]>(
      'SELECT tags.id FROM tags JOIN resources ON resources.project_id = tags.project_id WHERE tags.id = ? AND resources.id = ?',
    ).get(tagId, resourceId)
    if (!tag)
      throw new Error('The tag and resource must belong to the same project')
    run(this.database, 'INSERT OR IGNORE INTO resource_tags (resource_id, tag_id, created_at) VALUES (?, ?, ?)', [resourceId, tagId, this.now()])
  }

  removeTag(resourceId: string, tagId: string): void {
    run(this.database, 'DELETE FROM resource_tags WHERE resource_id = ? AND tag_id = ?', [resourceId, tagId])
  }

  listResourceTags(projectId: string): Array<{ resourceId: string, tag: ControlPlaneTag }> {
    const rows = this.database.query<Row, [string]>(
      `SELECT resource_tags.resource_id, tags.* FROM resource_tags JOIN tags ON tags.id = resource_tags.tag_id
      WHERE tags.project_id = ? ORDER BY tags.normalized_name`,
    ).all(projectId)
    return rows.map(row => ({ resourceId: String(row.resource_id), tag: mapTag(row) }))
  }

  saveFilter(actorKey: string, name: string, routeId: string, query: Record<string, JsonValue>): SavedFilter {
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 64)
      throw new Error('Saved filter names must contain 1-64 characters')
    if (!routeId || routeId.length > 160 || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(routeId))
      throw new Error('Saved filter routes must be local route IDs or paths')
    const serializedQuery = json(query)
    if (serializedQuery.length > 8192)
      throw new Error('Saved filter queries must be smaller than 8 KB')
    const existing = this.database.query<Row, [string, string]>('SELECT * FROM saved_filters WHERE actor_key = ? AND name = ?').get(actorKey, trimmed)
    const now = this.now()
    if (existing) {
      run(this.database, 'UPDATE saved_filters SET route_id = ?, query = ?, updated_at = ? WHERE id = ?', [routeId, serializedQuery, now, String(existing.id)])
      return mapSavedFilter(this.database.query<Row, [string]>('SELECT * FROM saved_filters WHERE id = ?').get(String(existing.id))!)
    }
    const id = this.idFn()
    run(this.database, 'INSERT INTO saved_filters (id, actor_key, name, route_id, query, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, actorKey, trimmed, routeId, serializedQuery, now, now])
    return mapSavedFilter(this.database.query<Row, [string]>('SELECT * FROM saved_filters WHERE id = ?').get(id)!)
  }

  listSavedFilters(actorKey: string): SavedFilter[] {
    return this.database.query<Row, [string]>('SELECT * FROM saved_filters WHERE actor_key = ? ORDER BY updated_at DESC, name').all(actorKey).map(mapSavedFilter)
  }

  deleteSavedFilter(actorKey: string, id: string): boolean {
    return run(this.database, 'DELETE FROM saved_filters WHERE actor_key = ? AND id = ?', [actorKey, id]).changes === 1
  }

  recordNavigation(actorKey: string, entityType: string, entityId: string): NavigationPreference {
    const now = this.now()
    run(this.database,
      `INSERT INTO navigation_items (actor_key, entity_type, entity_id, last_visited_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(actor_key, entity_type, entity_id) DO UPDATE SET last_visited_at = excluded.last_visited_at, visit_count = visit_count + 1`,
      [actorKey, entityType, entityId, now],
    )
    return mapNavigationPreference(this.database.query<Row, [string, string, string]>('SELECT * FROM navigation_items WHERE actor_key = ? AND entity_type = ? AND entity_id = ?').get(actorKey, entityType, entityId)!)
  }

  setFavorite(actorKey: string, entityType: string, entityId: string, favorite: boolean): NavigationPreference {
    const now = this.now()
    run(this.database,
      `INSERT INTO navigation_items (actor_key, entity_type, entity_id, favorite, last_visited_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(actor_key, entity_type, entity_id) DO UPDATE SET favorite = excluded.favorite`,
      [actorKey, entityType, entityId, favorite ? 1 : 0, now],
    )
    return mapNavigationPreference(this.database.query<Row, [string, string, string]>('SELECT * FROM navigation_items WHERE actor_key = ? AND entity_type = ? AND entity_id = ?').get(actorKey, entityType, entityId)!)
  }

  listNavigation(actorKey: string, options: { favoritesOnly?: boolean, limit?: number } = {}): NavigationPreference[] {
    const favorite = options.favoritesOnly ? 'AND favorite = 1' : ''
    const limit = Math.min(100, Math.max(1, options.limit ?? 20))
    return this.database.query<Row, [string, number]>(
      `SELECT * FROM navigation_items WHERE actor_key = ? ${favorite} ORDER BY favorite DESC, last_visited_at DESC LIMIT ?`,
    ).all(actorKey, limit).map(mapNavigationPreference)
  }

  compact(options: { eventRetentionDays?: number, operationRetentionDays?: number, vacuum?: boolean } = {}): CompactResult {
    const eventCutoff = new Date(this.nowFn().getTime() - (options.eventRetentionDays ?? 90) * 86_400_000).toISOString()
    const operationCutoff = new Date(this.nowFn().getTime() - (options.operationRetentionDays ?? 365) * 86_400_000).toISOString()
    const counts = this.transaction(() => {
      const events = run(this.database, 'DELETE FROM events WHERE created_at < ?', [eventCutoff]).changes
      const operations = run(this.database,
        `DELETE FROM operations WHERE created_at < ? AND state IN ('succeeded', 'failed', 'cancelled', 'timed_out')`,
        [operationCutoff],
      ).changes
      return { events, operations }
    })
    if (options.vacuum !== false)
      this.database.run('VACUUM')
    return { deletedEvents: counts.events, deletedOperations: counts.operations, vacuumed: options.vacuum !== false }
  }

  createBackup(reason: string = 'manual'): string {
    if (this.path === ':memory:')
      throw new Error('Cannot create a filesystem backup for an in-memory control plane')
    const backupPath = `${this.path}.${Date.now()}.bak`
    writeFileSync(backupPath, this.database.serialize(), { mode: 0o600 })
    this.setSetting('storage.last_backup', { path: backupPath, createdAt: this.now(), reason })
    return backupPath
  }

  integrityCheck(): 'ok' | 'corrupt' {
    const rows = this.database.query<Row, []>('PRAGMA integrity_check').all()
    return rows.length === 1 && Object.values(rows[0])[0] === 'ok' ? 'ok' : 'corrupt'
  }

  health(): ControlPlaneHealth {
    const operations = Object.fromEntries(
      (['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out'] as OperationState[]).map(state => [state, 0]),
    ) as Record<OperationState, number>
    for (const row of this.database.query<Row, []>('SELECT state, COUNT(*) AS count FROM operations GROUP BY state').all())
      operations[String(row.state) as OperationState] = Number(row.count)
    const journal = this.database.query<Row, []>('PRAGMA journal_mode').get()
    const backup = this.getSetting('storage.last_backup')
    const lastBackupAt = backup && !Array.isArray(backup) && typeof backup === 'object' && typeof backup.createdAt === 'string' ? backup.createdAt : undefined
    return {
      path: this.path,
      schemaVersion: Number(this.database.query<Row, []>('PRAGMA user_version').get()?.user_version ?? 0),
      supportedSchemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      integrity: this.integrityCheck(),
      journalMode: String(journal?.journal_mode ?? 'unknown'),
      databaseBytes: this.path !== ':memory:' && existsSync(this.path) ? statSync(this.path).size : this.database.serialize().byteLength,
      lastBackupAt,
      operations,
      pendingRetryableOperations: operations.queued + operations.failed + operations.timed_out,
    }
  }

  exportSnapshot(): ControlPlaneSnapshot {
    const settings: Record<string, JsonValue> = {}
    for (const row of this.database.query<Row, []>('SELECT key, value FROM settings ORDER BY key').all())
      settings[String(row.key)] = parseJson(row.value)
    return {
      format: 'ts-cloud-control-plane',
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      exportedAt: this.now(),
      organizations: this.database.query<Row, []>('SELECT * FROM organizations ORDER BY id').all().map(mapOrganization),
      memberships: this.database.query<Row, []>('SELECT * FROM organization_memberships ORDER BY id').all().map(mapMembership),
      invitations: this.database.query<Row, []>('SELECT * FROM organization_invitations ORDER BY id').all().map(row => ({ ...mapInvitation(row, this.now()), tokenHash: String(row.token_hash) })),
      grants: this.database.query<Row, []>('SELECT * FROM authorization_grants ORDER BY id').all().map(mapGrant),
      projects: this.database.query<Row, []>('SELECT * FROM projects ORDER BY id').all().map(mapProject),
      environments: this.database.query<Row, []>('SELECT * FROM environments ORDER BY id').all().map(mapEnvironment),
      resources: this.database.query<Row, []>('SELECT * FROM resources ORDER BY id').all().map(mapResource),
      actors: this.database.query<Row, []>('SELECT * FROM actors ORDER BY id').all().map(mapActor),
      operations: this.database.query<Row, []>('SELECT * FROM operations ORDER BY id').all().map(mapOperation),
      events: this.database.query<Row, []>('SELECT * FROM events ORDER BY sequence').all().map(mapEvent),
      settings,
      tags: this.database.query<Row, []>('SELECT * FROM tags ORDER BY id').all().map(mapTag),
      resourceTags: this.database.query<Row, []>('SELECT * FROM resource_tags ORDER BY resource_id, tag_id').all().map(row => ({ resourceId: String(row.resource_id), tagId: String(row.tag_id), createdAt: String(row.created_at) })),
      savedFilters: this.database.query<Row, []>('SELECT * FROM saved_filters ORDER BY id').all().map(mapSavedFilter),
      navigationItems: this.database.query<Row, []>('SELECT * FROM navigation_items ORDER BY actor_key, entity_type, entity_id').all().map(mapNavigationPreference),
    }
  }

  importSnapshot(snapshot: ControlPlaneSnapshot, options: ImportSnapshotOptions = {}): void {
    if (snapshot.format !== 'ts-cloud-control-plane')
      throw new Error('Unsupported control-plane snapshot format')
    if (snapshot.schemaVersion > CONTROL_PLANE_SCHEMA_VERSION)
      throw new UnsupportedSchemaVersionError(snapshot.schemaVersion, CONTROL_PLANE_SCHEMA_VERSION)

    this.transaction(() => {
      const populated = Number(this.database.query<Row, []>('SELECT COUNT(*) AS count FROM projects').get()?.count ?? 0) > 0
        || Number(this.database.query<Row, []>('SELECT COUNT(*) AS count FROM operations').get()?.count ?? 0) > 0
      if (populated && !options.replace)
        throw new Error('Control plane is not empty; pass replace: true to import this snapshot')
      if (options.replace) {
        this.database.run('DELETE FROM authorization_grants')
        this.database.run('DELETE FROM organization_invitations')
        this.database.run('DELETE FROM organization_memberships')
        this.database.run('DELETE FROM resource_tags')
        this.database.run('DELETE FROM tags')
        this.database.run('DELETE FROM saved_filters')
        this.database.run('DELETE FROM navigation_items')
        this.database.run('DELETE FROM events')
        this.database.run('DELETE FROM operations')
        this.database.run('DELETE FROM resources')
        this.database.run('DELETE FROM environments')
        this.database.run('DELETE FROM projects')
        this.database.run('DELETE FROM actors')
        this.database.run('DELETE FROM organizations')
        this.database.run('DELETE FROM settings')
      }

      for (const item of snapshot.organizations ?? []) {
        run(this.database, 'INSERT INTO organizations (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          [item.id, item.slug, item.name, item.createdAt, item.updatedAt])
      }
      for (const item of snapshot.projects) {
        run(this.database,
          `INSERT INTO projects (id, slug, name, description, organization_id, desired_config_hash, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [item.id, item.slug, item.name, item.description ?? null, item.organizationId ?? null, item.desiredConfigHash ?? null, item.version, item.createdAt, item.updatedAt],
        )
      }
      for (const item of snapshot.environments) {
        run(this.database,
          `INSERT INTO environments (id, project_id, slug, name, kind, region, desired_state, discovered_state, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [item.id, item.projectId, item.slug, item.name, item.kind, item.region ?? null, json(item.desiredState), json(item.discoveredState), item.version, item.createdAt, item.updatedAt],
        )
      }
      for (const item of snapshot.resources) {
        run(this.database,
          `INSERT INTO resources (id, project_id, environment_id, kind, slug, name, provider, provider_id, desired_state, discovered_state, metadata, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [item.id, item.projectId, item.environmentId ?? null, item.kind, item.slug, item.name, item.provider ?? null, item.providerId ?? null,
            json(item.desiredState), json(item.discoveredState), json(item.metadata), item.version, item.createdAt, item.updatedAt],
        )
      }
      for (const item of snapshot.actors) {
        run(this.database,
          `INSERT INTO actors (id, kind, external_id, display_name, metadata, disabled_at, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [item.id, item.kind, item.externalId ?? null, item.displayName, json(item.metadata), item.disabledAt ?? null, item.version, item.createdAt, item.updatedAt],
        )
      }
      for (const item of snapshot.memberships ?? []) {
        run(this.database,
          `INSERT INTO organization_memberships (id, organization_id, actor_id, role_template, scope_type, scope_id, status, session_version, last_active_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [item.id, item.organizationId, item.actorId, item.roleTemplate, item.scope.type, item.scope.id ?? null, item.status, item.sessionVersion, item.lastActiveAt ?? null, item.createdAt, item.updatedAt],
        )
      }
      for (const item of snapshot.invitations ?? []) {
        const tokenHash = item.tokenHash ?? createHash('sha256').update(`revoked:${item.id}:${this.idFn()}`).digest('hex')
        run(this.database,
          `INSERT INTO organization_invitations (id, organization_id, email, role_template, scope_type, scope_id, token_hash, invited_by_actor_id, accepted_by_actor_id, expires_at, accepted_at, revoked_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [item.id, item.organizationId, item.email, item.roleTemplate, item.scope.type, item.scope.id ?? null, tokenHash, item.invitedByActorId ?? null,
            item.acceptedByActorId ?? null, item.expiresAt, item.acceptedAt ?? null, item.tokenHash ? (item.revokedAt ?? null) : (item.revokedAt ?? this.now()), item.createdAt, item.updatedAt],
        )
      }
      for (const item of snapshot.grants ?? []) {
        run(this.database,
          `INSERT INTO authorization_grants (id, organization_id, membership_id, effect, capability, scope_type, scope_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [item.id, item.organizationId, item.membershipId, item.effect, item.capability, item.scope.type, item.scope.id ?? null, item.createdAt, item.updatedAt],
        )
      }
      for (const item of snapshot.operations) {
        run(this.database,
          `INSERT INTO operations (id, project_id, environment_id, resource_id, actor_id, kind, state, correlation_id, idempotency_key,
          input, output, error, attempt, priority, lease_owner, lease_expires_at, cancel_requested_at, started_at, finished_at, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [item.id, item.projectId ?? null, item.environmentId ?? null, item.resourceId ?? null, item.actorId ?? null, item.kind, item.state,
            item.correlationId, item.idempotencyKey ?? null, json(item.input), json(item.output), clampError(item.error) ?? null, item.attempt, item.priority,
            item.leaseOwner ?? null, item.leaseExpiresAt ?? null, item.cancelRequestedAt ?? null, item.startedAt ?? null, item.finishedAt ?? null,
            item.version, item.createdAt, item.updatedAt],
        )
      }
      for (const item of snapshot.events) {
        run(this.database,
          `INSERT INTO events (sequence, id, organization_id, project_id, operation_id, resource_id, actor_id, correlation_id, type, level, payload, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [item.sequence, item.id, item.organizationId ?? null, item.projectId ?? null, item.operationId ?? null, item.resourceId ?? null, item.actorId ?? null,
            item.correlationId, item.type, item.level, json(item.payload), item.createdAt],
        )
      }
      for (const [key, value] of Object.entries(snapshot.settings))
        run(this.database, 'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', [key, json(value), this.now()])
      for (const item of snapshot.tags ?? []) {
        run(this.database, 'INSERT INTO tags (id, project_id, name, normalized_name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [item.id, item.projectId, item.name, item.normalizedName, item.color, item.createdAt, item.updatedAt])
      }
      for (const item of snapshot.resourceTags ?? [])
        run(this.database, 'INSERT INTO resource_tags (resource_id, tag_id, created_at) VALUES (?, ?, ?)', [item.resourceId, item.tagId, item.createdAt])
      for (const item of snapshot.savedFilters ?? []) {
        run(this.database, 'INSERT INTO saved_filters (id, actor_key, name, route_id, query, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [item.id, item.actorKey, item.name, item.routeId, json(item.query), item.createdAt, item.updatedAt])
      }
      for (const item of snapshot.navigationItems ?? []) {
        run(this.database, 'INSERT INTO navigation_items (actor_key, entity_type, entity_id, favorite, last_visited_at, visit_count) VALUES (?, ?, ?, ?, ?, ?)',
          [item.actorKey, item.entityType, item.entityId, item.favorite ? 1 : 0, item.lastVisitedAt, item.visitCount])
      }
    })
  }
}
