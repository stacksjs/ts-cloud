import type { ControlPlaneStore, JsonValue } from '../control-plane'
import type { ComposeApplicationManifest, ComposeApplicationRecord, ComposeDiagnostic, ComposeParseResult, ComposeServiceState } from './types'
import { sanitizeControlPlaneValue } from '../control-plane'
import { synchronizeComposeVolumes } from '../storage/compose'
import { parseCompose } from './parser'
import { renderComposeTemplate } from './templates'

type Row = Record<string, unknown>
function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}
function json<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value)) as T
  } catch {
    return fallback
  }
}
function application(row: Row): ComposeApplicationRecord {
  return {
    id: String(row.id),
    resourceId: String(row.resource_id),
    projectId: String(row.project_id),
    environmentId: String(row.environment_id),
    name: String(row.name),
    slug: String(row.slug),
    status: String(row.status) as ComposeApplicationRecord['status'],
    sourceKind: String(row.source_kind) as ComposeApplicationRecord['sourceKind'],
    sourceHash: String(row.source_hash),
    redactedSource: String(row.redacted_source),
    manifest: json(row.manifest, {} as ComposeApplicationManifest),
    diagnostics: json(row.diagnostics, [] as ComposeDiagnostic[]),
    templateId: optional(row.template_id),
    templateVersion: optional(row.template_version),
    latestOperationId: optional(row.latest_operation_id),
    createdByActorId: optional(row.created_by_actor_id),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: optional(row.deleted_at),
  }
}
function serviceState(row: Row): ComposeServiceState {
  return {
    applicationId: String(row.application_id),
    serviceName: String(row.service_name),
    status: String(row.status) as ComposeServiceState['status'],
    replicas: Number(row.replicas),
    healthyReplicas: Number(row.healthy_replicas),
    latestOperationId: optional(row.latest_operation_id),
    observedState: json(row.observed_state, {}),
    updatedAt: String(row.updated_at),
  }
}

export class ComposeApplicationStore {
  private readonly now: () => Date
  private readonly id: () => string
  constructor(
    readonly controlPlane: ControlPlaneStore,
    options: { now?: () => Date; id?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.id = options.id ?? (() => crypto.randomUUID())
  }

  private persist(
    parsed: ComposeParseResult,
    input: {
      sourceKind: 'compose' | 'template'
      templateId?: string
      templateVersion?: string
      createdByActorId?: string
    },
  ): ComposeApplicationRecord {
    if (!parsed.valid)
      throw new Error(
        `Compose definition contains ${parsed.diagnostics.filter((issue) => issue.severity === 'error').length} blocking diagnostic(s)`,
      )
    const { projectId, environmentId, name, slug } = parsed.manifest.metadata
    const environment = this.controlPlane.listEnvironments(projectId).find((item) => item.id === environmentId)
    if (!environment) throw new Error('Compose project and environment scope was not found')
    const existing = this.getBySlug(projectId, environmentId, slug)
    const now = this.now().toISOString()
    const manifest = JSON.stringify(parsed.manifest)
    const diagnostics = JSON.stringify(sanitizeControlPlaneValue(parsed.diagnostics))
    if (existing) {
      if (existing.status === 'deleted')
        throw new Error('A deleted Compose application cannot be overwritten; choose another slug')
      const resource = this.controlPlane.getResource(existing.resourceId)
      if (!resource) throw new Error('Compose application resource was not found')
      this.controlPlane.updateResource(resource.id, resource.version, {
        name,
        provider: resource.provider,
        providerId: resource.providerId,
        desiredState: parsed.manifest as unknown as JsonValue,
        discoveredState: resource.discoveredState,
        metadata: {
          sourceKind: input.sourceKind,
          templateId: input.templateId ?? null,
          templateVersion: input.templateVersion ?? null,
          sourceHash: parsed.sourceHash,
        },
      })
      this.controlPlane.database.run(
        `UPDATE compose_applications SET name=?, status='ready', source_kind=?, source_hash=?, redacted_source=?, manifest=?, diagnostics=?, template_id=?, template_version=?, version=version+1, updated_at=? WHERE id=?`,
        [
          name,
          input.sourceKind,
          parsed.sourceHash,
          parsed.redactedSource,
          manifest,
          diagnostics,
          input.templateId ?? null,
          input.templateVersion ?? null,
          now,
          existing.id,
        ],
      )
      const serviceNames = Object.keys(parsed.manifest.spec.services)
      if (serviceNames.length)
        this.controlPlane.database.run(
          `DELETE FROM compose_service_states WHERE application_id=? AND service_name NOT IN (${serviceNames.map(() => '?').join(',')})`,
          [existing.id, ...serviceNames],
        )
      for (const service of Object.values(parsed.manifest.spec.services))
        this.controlPlane.database.run(
          `INSERT INTO compose_service_states (application_id, service_name, status, replicas, healthy_replicas, observed_state, updated_at) VALUES (?, ?, 'pending', ?, 0, '{}', ?) ON CONFLICT(application_id, service_name) DO UPDATE SET replicas=excluded.replicas, updated_at=excluded.updated_at`,
          [existing.id, service.name, service.replicas, now],
        )
      this.controlPlane.appendEvent({
        projectId,
        resourceId: existing.resourceId,
        actorId: input.createdByActorId,
        type: 'compose.application.updated',
        payload: {
          applicationId: existing.id,
          sourceHash: parsed.sourceHash,
          diagnosticCount: parsed.diagnostics.length,
          templateId: input.templateId ?? null,
          templateVersion: input.templateVersion ?? null,
        },
      })
      const updated = this.get(existing.id)!
      synchronizeComposeVolumes(this.controlPlane, updated)
      return updated
    }
    const resource = this.controlPlane.createResource({
      projectId,
      environmentId,
      kind: 'compose_application',
      slug,
      name,
      desiredState: parsed.manifest as unknown as JsonValue,
      metadata: {
        sourceKind: input.sourceKind,
        templateId: input.templateId ?? null,
        templateVersion: input.templateVersion ?? null,
        sourceHash: parsed.sourceHash,
      },
    })
    const id = this.id()
    this.controlPlane.database.run(
      `INSERT INTO compose_applications (id, resource_id, project_id, environment_id, name, slug, status, source_kind, source_hash, redacted_source, manifest, diagnostics, template_id, template_version, created_by_actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        resource.id,
        projectId,
        environmentId,
        name,
        slug,
        input.sourceKind,
        parsed.sourceHash,
        parsed.redactedSource,
        manifest,
        diagnostics,
        input.templateId ?? null,
        input.templateVersion ?? null,
        input.createdByActorId ?? null,
        now,
        now,
      ],
    )
    for (const service of Object.values(parsed.manifest.spec.services))
      this.controlPlane.database.run(
        `INSERT INTO compose_service_states (application_id, service_name, status, replicas, healthy_replicas, observed_state, updated_at) VALUES (?, ?, 'pending', ?, 0, '{}', ?)`,
        [id, service.name, service.replicas, now],
      )
    this.controlPlane.appendEvent({
      projectId,
      resourceId: resource.id,
      actorId: input.createdByActorId,
      type: 'compose.application.created',
      payload: {
        applicationId: id,
        sourceHash: parsed.sourceHash,
        serviceNames: Object.keys(parsed.manifest.spec.services),
        templateId: input.templateId ?? null,
      },
    })
    const created = this.get(id)!
    synchronizeComposeVolumes(this.controlPlane, created)
    return created
  }

  import(
    source: string,
    input: { name: string; slug?: string; projectId: string; environmentId: string; createdByActorId?: string },
  ): { application: ComposeApplicationRecord; parsed: ComposeParseResult } {
    const parsed = parseCompose(source, input)
    return {
      application: this.persist(parsed, { sourceKind: 'compose', createdByActorId: input.createdByActorId }),
      parsed,
    }
  }
  fromTemplate(
    templateId: string,
    inputs: Record<string, string>,
    input: {
      name: string
      slug?: string
      projectId: string
      environmentId: string
      version?: string
      createdByActorId?: string
    },
  ): { application: ComposeApplicationRecord; parsed: ComposeParseResult } {
    const parsed = renderComposeTemplate(templateId, inputs, input, input.version)
    return {
      application: this.persist(parsed, {
        sourceKind: 'template',
        templateId,
        templateVersion: input.version ?? '1.0.0',
        createdByActorId: input.createdByActorId,
      }),
      parsed,
    }
  }
  preview(
    source: string,
    input: { name: string; slug?: string; projectId: string; environmentId: string },
  ): ComposeParseResult {
    return parseCompose(source, input)
  }
  get(id: string): ComposeApplicationRecord | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM compose_applications WHERE id=?').get(id)
    return row ? application(row) : undefined
  }
  getByResource(resourceId: string): ComposeApplicationRecord | undefined {
    const row = this.controlPlane.database
      .query<Row, [string]>('SELECT * FROM compose_applications WHERE resource_id=?')
      .get(resourceId)
    return row ? application(row) : undefined
  }
  getBySlug(projectId: string, environmentId: string, slug: string): ComposeApplicationRecord | undefined {
    const row = this.controlPlane.database
      .query<Row, [string, string, string]>(
        'SELECT * FROM compose_applications WHERE project_id=? AND environment_id=? AND slug=?',
      )
      .get(projectId, environmentId, slug)
    return row ? application(row) : undefined
  }
  list(
    input: { projectId?: string; environmentId?: string; includeDeleted?: boolean } = {},
  ): ComposeApplicationRecord[] {
    return this.controlPlane.database
      .query<Row, []>('SELECT * FROM compose_applications ORDER BY updated_at DESC')
      .all()
      .map(application)
      .filter(
        (item) =>
          (!input.projectId || item.projectId === input.projectId) &&
          (!input.environmentId || item.environmentId === input.environmentId) &&
          (input.includeDeleted || item.status !== 'deleted'),
      )
  }
  services(applicationId: string): ComposeServiceState[] {
    return this.controlPlane.database
      .query<Row, [string]>('SELECT * FROM compose_service_states WHERE application_id=? ORDER BY service_name')
      .all(applicationId)
      .map(serviceState)
  }
  transition(
    id: string,
    status: ComposeApplicationRecord['status'],
    input: {
      operationId?: string
      services?: Array<{
        name: string
        status: ComposeServiceState['status']
        replicas?: number
        healthyReplicas?: number
        observedState?: JsonValue
      }>
      error?: string
    } = {},
  ): ComposeApplicationRecord {
    const current = this.get(id)
    if (!current) throw new Error(`Compose application ${id} was not found`)
    const now = this.now().toISOString()
    const deletedAt = status === 'deleted' ? now : null
    this.controlPlane.database.run(
      'UPDATE compose_applications SET status=?, latest_operation_id=COALESCE(?, latest_operation_id), version=version+1, updated_at=?, deleted_at=? WHERE id=?',
      [status, input.operationId ?? null, now, deletedAt, id],
    )
    for (const state of input.services ?? [])
      if (current.manifest.spec.services[state.name])
        this.controlPlane.database.run(
          `INSERT INTO compose_service_states (application_id, service_name, status, replicas, healthy_replicas, latest_operation_id, observed_state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(application_id, service_name) DO UPDATE SET status=excluded.status, replicas=excluded.replicas, healthy_replicas=excluded.healthy_replicas, latest_operation_id=excluded.latest_operation_id, observed_state=excluded.observed_state, updated_at=excluded.updated_at`,
          [
            id,
            state.name,
            state.status,
            state.replicas ?? current.manifest.spec.services[state.name]!.replicas,
            state.healthyReplicas ?? 0,
            input.operationId ?? null,
            JSON.stringify(sanitizeControlPlaneValue(state.observedState ?? {})),
            now,
          ],
        )
    this.controlPlane.appendEvent({
      projectId: current.projectId,
      resourceId: current.resourceId,
      operationId: input.operationId,
      type: `compose.application.${status}`,
      level: status === 'failed' || status === 'degraded' ? 'error' : 'info',
      payload: { applicationId: id, error: input.error ?? null },
    })
    return this.get(id)!
  }
}
