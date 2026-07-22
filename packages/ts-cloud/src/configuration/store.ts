import type { SQLQueryBindings } from 'bun:sqlite'
import type { ControlPlaneStore, JsonValue } from '../control-plane'
import type { ConfigurationDependency, ConfigurationEntry, ConfigurationScope } from './model'

type Row = Record<string, SQLQueryBindings>
const optional = (value: unknown): string | undefined => (value == null ? undefined : String(value))
const bool = (value: unknown): boolean => Number(value) === 1
const json = <T>(value: unknown, fallback: T): T => {
  try {
    return value == null ? fallback : (JSON.parse(String(value)) as T)
  } catch {
    return fallback
  }
}

function entry(row: Row): ConfigurationEntry {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    scope: {
      type: String(row.scope_type) as ConfigurationScope['type'],
      id: String(row.scope_id),
      environmentId: optional(row.environment_id),
      resourceId: optional(row.resource_id),
      previewId: optional(row.preview_id),
    },
    key: String(row.key),
    kind: String(row.kind) as ConfigurationEntry['kind'],
    value: optional(row.value),
    valueFingerprint: String(row.value_fingerprint),
    secretRef: optional(row.secret_ref),
    backend: String(row.backend) as ConfigurationEntry['backend'],
    backendVersion: optional(row.backend_version),
    origin: String(row.origin) as ConfigurationEntry['origin'],
    required: bool(row.required),
    metadata: json(row.metadata, {}),
    lastUsedAt: optional(row.last_used_at),
    rotatedAt: optional(row.rotated_at),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function dependency(row: Row): ConfigurationDependency {
  return {
    entryId: String(row.entry_id),
    resourceId: String(row.resource_id),
    injectionTarget: String(row.injection_target) as ConfigurationDependency['injectionTarget'],
    required: bool(row.required),
    requiresRedeploy: bool(row.requires_redeploy),
    lastDeployedVersion: row.last_deployed_version == null ? undefined : Number(row.last_deployed_version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

export class ConfigurationStore {
  constructor(
    readonly controlPlane: ControlPlaneStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(id: string): ConfigurationEntry | undefined {
    const row = this.controlPlane.database
      .query<Row, [string]>('SELECT * FROM configuration_entries WHERE id=?')
      .get(id)
    return row ? entry(row) : undefined
  }

  find(projectId: string, scope: ConfigurationScope, key: string): ConfigurationEntry | undefined {
    const row = this.controlPlane.database
      .query<Row, [string, string, string, string]>(
        'SELECT * FROM configuration_entries WHERE project_id=? AND scope_type=? AND scope_id=? AND key=?',
      )
      .get(projectId, scope.type, scope.id, key)
    return row ? entry(row) : undefined
  }

  list(input: {
    projectId: string
    scope?: ConfigurationScope
    kind?: ConfigurationEntry['kind']
  }): ConfigurationEntry[] {
    const clauses = ['project_id=?'],
      values: SQLQueryBindings[] = [input.projectId]
    if (input.scope) {
      clauses.push('scope_type=?', 'scope_id=?')
      values.push(input.scope.type, input.scope.id)
    }
    if (input.kind) {
      clauses.push('kind=?')
      values.push(input.kind)
    }
    return this.controlPlane.database
      .query<Row, SQLQueryBindings[]>(
        `SELECT * FROM configuration_entries WHERE ${clauses.join(' AND ')} ORDER BY key,scope_type,scope_id`,
      )
      .all(...values)
      .map(entry)
  }

  create(input: Omit<ConfigurationEntry, 'id' | 'version' | 'createdAt' | 'updatedAt'>): ConfigurationEntry {
    this.validateScope(input)
    this.validateEntry(input)
    const id = crypto.randomUUID(),
      now = this.now().toISOString()
    this.controlPlane.database.run(
      'INSERT INTO configuration_entries (id,organization_id,project_id,scope_type,scope_id,environment_id,resource_id,preview_id,key,kind,value,value_fingerprint,secret_ref,backend,backend_version,origin,required,metadata,last_used_at,rotated_at,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.organizationId,
        input.projectId,
        input.scope.type,
        input.scope.id,
        input.scope.environmentId ?? null,
        input.scope.resourceId ?? null,
        input.scope.previewId ?? null,
        input.key,
        input.kind,
        input.value ?? null,
        input.valueFingerprint,
        input.secretRef ?? null,
        input.backend,
        input.backendVersion ?? null,
        input.origin,
        input.required ? 1 : 0,
        JSON.stringify(input.metadata),
        input.lastUsedAt ?? null,
        input.rotatedAt ?? null,
        1,
        now,
        now,
      ],
    )
    return this.get(id)!
  }

  update(
    id: string,
    expectedVersion: number,
    patch: Pick<
      ConfigurationEntry,
      'value' | 'valueFingerprint' | 'secretRef' | 'backend' | 'backendVersion' | 'required' | 'metadata' | 'rotatedAt'
    >,
  ): ConfigurationEntry {
    const current = this.get(id)
    if (!current) throw new Error('Configuration entry was not found.')
    this.validateEntry({ ...current, ...patch })
    const result = this.controlPlane.database.run(
      'UPDATE configuration_entries SET value=?,value_fingerprint=?,secret_ref=?,backend=?,backend_version=?,required=?,metadata=?,rotated_at=?,version=version+1,updated_at=? WHERE id=? AND version=?',
      [
        patch.value ?? null,
        patch.valueFingerprint,
        patch.secretRef ?? null,
        patch.backend,
        patch.backendVersion ?? null,
        patch.required ? 1 : 0,
        JSON.stringify(patch.metadata),
        patch.rotatedAt ?? null,
        this.now().toISOString(),
        id,
        expectedVersion,
      ],
    )
    if (result.changes !== 1) throw new Error('Configuration entry changed; refresh and retry.')
    return this.get(id)!
  }

  remove(id: string, expectedVersion: number): ConfigurationEntry {
    const current = this.get(id)
    if (!current) throw new Error('Configuration entry was not found.')
    if (current.version !== expectedVersion) throw new Error('Configuration entry changed; refresh and retry.')
    const result = this.controlPlane.database.run('DELETE FROM configuration_entries WHERE id=? AND version=?', [
      id,
      expectedVersion,
    ])
    if (result.changes < 1) throw new Error('Configuration entry changed; refresh and retry.')
    return current
  }

  setDependency(input: Omit<ConfigurationDependency, 'createdAt' | 'updatedAt'>): ConfigurationDependency {
    const now = this.now().toISOString()
    this.controlPlane.database.run(
      `INSERT INTO configuration_dependencies (entry_id,resource_id,injection_target,required,requires_redeploy,last_deployed_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(entry_id,resource_id) DO UPDATE SET injection_target=excluded.injection_target,required=excluded.required,requires_redeploy=excluded.requires_redeploy,last_deployed_version=excluded.last_deployed_version,updated_at=excluded.updated_at`,
      [
        input.entryId,
        input.resourceId,
        input.injectionTarget,
        input.required ? 1 : 0,
        input.requiresRedeploy ? 1 : 0,
        input.lastDeployedVersion ?? null,
        now,
        now,
      ],
    )
    return this.dependencies(input.entryId).find((item) => item.resourceId === input.resourceId)!
  }

  dependencies(entryId: string): ConfigurationDependency[] {
    return this.controlPlane.database
      .query<Row, [string]>('SELECT * FROM configuration_dependencies WHERE entry_id=? ORDER BY resource_id')
      .all(entryId)
      .map(dependency)
  }

  dependenciesForResource(resourceId: string): ConfigurationDependency[] {
    return this.controlPlane.database
      .query<Row, [string]>('SELECT * FROM configuration_dependencies WHERE resource_id=? ORDER BY entry_id')
      .all(resourceId)
      .map(dependency)
  }

  mutation(idempotencyKey: string): { requestHash: string; result: Record<string, JsonValue> } | undefined {
    const row = this.controlPlane.database
      .query<{ request_hash: string; result: string }, [string]>(
        'SELECT request_hash,result FROM configuration_mutations WHERE idempotency_key=?',
      )
      .get(idempotencyKey)
    return row ? { requestHash: row.request_hash, result: json(row.result, {}) } : undefined
  }

  recordMutation(input: {
    projectId: string
    idempotencyKey: string
    requestHash: string
    result: Record<string, JsonValue>
    actorId?: string
  }): void {
    this.controlPlane.database.run(
      'INSERT INTO configuration_mutations (id,project_id,idempotency_key,request_hash,result,actor_id,created_at) VALUES (?,?,?,?,?,?,?)',
      [
        crypto.randomUUID(),
        input.projectId,
        input.idempotencyKey,
        input.requestHash,
        JSON.stringify(input.result),
        input.actorId ?? null,
        this.now().toISOString(),
      ],
    )
  }

  private validateEntry(input: Pick<ConfigurationEntry, 'key' | 'kind' | 'value' | 'secretRef' | 'backend'>): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(input.key)) throw new Error(`Invalid configuration key: ${input.key}`)
    if (input.kind === 'variable' && (input.value == null || input.secretRef || input.backend !== 'plaintext'))
      throw new Error('Variables require a plaintext value and cannot use a secret backend.')
    if (input.kind === 'secret' && (input.value != null || !input.secretRef || input.backend === 'plaintext'))
      throw new Error('Secrets require a non-plaintext backend reference and cannot store a plaintext value.')
  }

  private validateScope(input: Pick<ConfigurationEntry, 'organizationId' | 'projectId' | 'scope'>): void {
    const project = this.controlPlane.getProject(input.projectId)
    if (!project || project.organizationId !== input.organizationId)
      throw new Error('Configuration project does not belong to the organization.')

    const scope = input.scope
    if (scope.type === 'project') {
      if (scope.id !== input.projectId || scope.environmentId || scope.resourceId || scope.previewId)
        throw new Error('Project configuration scope must reference only its project.')
      return
    }

    if (scope.type === 'environment') {
      const environment = this.controlPlane.database
        .query<{ project_id: string }, [string]>('SELECT project_id FROM environments WHERE id=?')
        .get(scope.id)
      if (
        !environment ||
        environment.project_id !== input.projectId ||
        (scope.environmentId && scope.environmentId !== scope.id) ||
        scope.resourceId ||
        scope.previewId
      )
        throw new Error('Environment configuration scope does not belong to the project.')
      return
    }

    if (scope.type === 'service' || scope.type === 'function') {
      const resource = this.controlPlane.getResource(scope.id)
      if (
        !resource ||
        resource.projectId !== input.projectId ||
        (scope.type === 'function' && resource.kind !== 'function') ||
        (scope.resourceId && scope.resourceId !== scope.id) ||
        (scope.environmentId && resource.environmentId !== scope.environmentId) ||
        scope.previewId
      )
        throw new Error(
          `${scope.type === 'function' ? 'Function' : 'Service'} configuration scope does not belong to the project.`,
        )
      return
    }

    const preview = this.controlPlane.database
      .query<{ project_id: string; base_environment_id: string; resource_id: string }, [string]>(
        'SELECT project_id,base_environment_id,resource_id FROM preview_instances WHERE id=?',
      )
      .get(scope.id)
    if (
      !preview ||
      preview.project_id !== input.projectId ||
      (scope.previewId && scope.previewId !== scope.id) ||
      (scope.environmentId && scope.environmentId !== preview.base_environment_id) ||
      (scope.resourceId && scope.resourceId !== preview.resource_id)
    )
      throw new Error('Preview configuration scope does not belong to the project.')
  }
}
