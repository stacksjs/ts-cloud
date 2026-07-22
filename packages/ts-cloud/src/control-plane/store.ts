import type { Changes, SQLQueryBindings } from 'bun:sqlite'
import type {
  AppendEventInput,
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
  CreateActorInput,
  CreateEnvironmentInput,
  CreateOperationInput,
  CreateProjectInput,
  CreateResourceInput,
  EventListOptions,
  ImportSnapshotOptions,
  JsonValue,
  OperationListOptions,
  OperationState,
  ReconcileResult,
  TransitionOperationInput,
  UpdateProjectInput,
  UpdateResourceInput,
} from './types'
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Database } from 'bun:sqlite'
import { CONTROL_PLANE_SCHEMA_VERSION, controlPlaneMigrations } from './migrations'
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
    id: String(row.id), sequence: Number(row.sequence), projectId: optionalString(row.project_id),
    operationId: optionalString(row.operation_id), resourceId: optionalString(row.resource_id), actorId: optionalString(row.actor_id),
    correlationId: String(row.correlation_id), type: String(row.type), level: String(row.level) as ControlPlaneEvent['level'],
    payload: parseJson(row.payload), createdAt: String(row.created_at),
  }
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
    run(this.database,
      `INSERT INTO events (id, project_id, operation_id, resource_id, actor_id, correlation_id, type, level, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.projectId ?? null, input.operationId ?? null, input.resourceId ?? null, input.actorId ?? null,
        correlationId, input.type, input.level ?? 'info', json(input.payload ?? {}), this.now()],
    )
    return mapEvent(this.database.query<Row, [string]>('SELECT * FROM events WHERE id = ?').get(id)!)
  }

  listEvents(options: EventListOptions = {}): ControlPlaneEvent[] {
    const filters: string[] = []
    const bindings: SQLQueryBindings[] = []
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
      projects: this.database.query<Row, []>('SELECT * FROM projects ORDER BY id').all().map(mapProject),
      environments: this.database.query<Row, []>('SELECT * FROM environments ORDER BY id').all().map(mapEnvironment),
      resources: this.database.query<Row, []>('SELECT * FROM resources ORDER BY id').all().map(mapResource),
      actors: this.database.query<Row, []>('SELECT * FROM actors ORDER BY id').all().map(mapActor),
      operations: this.database.query<Row, []>('SELECT * FROM operations ORDER BY id').all().map(mapOperation),
      events: this.database.query<Row, []>('SELECT * FROM events ORDER BY sequence').all().map(mapEvent),
      settings,
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
        this.database.run('DELETE FROM events')
        this.database.run('DELETE FROM operations')
        this.database.run('DELETE FROM resources')
        this.database.run('DELETE FROM environments')
        this.database.run('DELETE FROM projects')
        this.database.run('DELETE FROM actors')
        this.database.run('DELETE FROM settings')
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
          `INSERT INTO events (sequence, id, project_id, operation_id, resource_id, actor_id, correlation_id, type, level, payload, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [item.sequence, item.id, item.projectId ?? null, item.operationId ?? null, item.resourceId ?? null, item.actorId ?? null,
            item.correlationId, item.type, item.level, json(item.payload), item.createdAt],
        )
      }
      for (const [key, value] of Object.entries(snapshot.settings))
        run(this.database, 'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', [key, json(value), this.now()])
    })
  }
}
