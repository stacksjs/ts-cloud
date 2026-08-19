import type { ControlPlaneStore } from '../control-plane'
import type { ApplicationDraftInput, ApplicationDraftRecord } from './types'
import { sanitizeControlPlaneValue } from '../control-plane'
import { planApplication } from './plan'

type Row = Record<string, unknown>
const STEPS = new Set<ApplicationDraftRecord['step']>(['source', 'build', 'runtime', 'environment', 'domain', 'review'])

function parse<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === 'string' ? (JSON.parse(value) as T) : fallback
  } catch {
    return fallback
  }
}
function sensitive(name: string): boolean {
  return /(?:secret|token|password|passwd|private[_-]?key|api[_-]?key)/i.test(name)
}

function assertSecretFree(input: ApplicationDraftInput): void {
  for (const [name, value] of Object.entries(input.environment ?? {}))
    if (typeof value === 'string' && sensitive(name) && value)
      throw new Error(`${name} must be stored through the write-only secrets boundary`)
  if (input.build.kind === 'dockerfile')
    for (const [name, value] of Object.entries(input.build.buildArgs ?? {}))
      if (sensitive(name) && value) throw new Error(`${name} must be declared as a build secret name`)
  const serialized = JSON.stringify(input)
  if (/https?:\/\/[^/@\s]+:[^/@\s]+@/i.test(serialized))
    throw new Error('Drafts cannot contain credential-bearing URLs')
}

function mapDraft(row: Row): ApplicationDraftRecord {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    schemaVersion: Number(row.schema_version),
    name: String(row.name),
    step: String(row.step) as ApplicationDraftRecord['step'],
    input: parse(row.input, {} as ApplicationDraftInput),
    suppliedSecretNames: parse(row.supplied_secret_names, []),
    status: String(row.status) as ApplicationDraftRecord['status'],
    version: Number(row.version),
    createdByActorId: row.created_by_actor_id ? String(row.created_by_actor_id) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

export class ApplicationDraftStore {
  private readonly nowFn: () => Date
  private readonly idFn: () => string
  constructor(
    private readonly controlPlane: ControlPlaneStore,
    options: { now?: () => Date; id?: () => string } = {},
  ) {
    this.nowFn = options.now ?? (() => new Date())
    this.idFn = options.id ?? (() => crypto.randomUUID())
  }
  private now(): string {
    return this.nowFn().toISOString()
  }

  create(input: {
    organizationId: string
    projectId: string
    name: string
    draft: ApplicationDraftInput
    step?: ApplicationDraftRecord['step']
    suppliedSecretNames?: string[]
    actorId?: string
  }): ApplicationDraftRecord {
    assertSecretFree(input.draft)
    if (input.draft.projectId !== input.projectId) throw new Error('Draft project does not match its storage scope')
    const project = this.controlPlane.getProject(input.projectId)
    if (!project || project.organizationId !== input.organizationId) throw new Error('Draft project was not found')
    const id = this.idFn()
    const now = this.now()
    const step = input.step ?? 'source'
    if (!STEPS.has(step)) throw new Error('Invalid draft step')
    const supplied = [...new Set(input.suppliedSecretNames ?? [])].sort()
    const status = planApplication(input.draft, supplied).valid ? 'ready' : 'draft'
    this.controlPlane.database.run(
      'INSERT INTO application_drafts (id, organization_id, project_id, schema_version, name, step, input, supplied_secret_names, status, created_by_actor_id, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        input.organizationId,
        input.projectId,
        input.name.trim().slice(0, 100),
        step,
        JSON.stringify(input.draft),
        JSON.stringify(supplied),
        status,
        input.actorId ?? null,
        now,
        now,
      ],
    )
    this.controlPlane.appendEvent({
      organizationId: input.organizationId,
      projectId: input.projectId,
      actorId: input.actorId,
      type: 'application.draft.created',
      payload: { draftId: id, step, status, requiredSecretNames: input.draft.requiredSecretNames ?? [] },
    })
    return this.get(id)!
  }

  get(id: string): ApplicationDraftRecord | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM application_drafts WHERE id=?').get(id)
    return row ? mapDraft(row) : undefined
  }
  list(projectId: string): ApplicationDraftRecord[] {
    return this.controlPlane.database
      .query<Row, [string]>('SELECT * FROM application_drafts WHERE project_id=? ORDER BY updated_at DESC')
      .all(projectId)
      .map(mapDraft)
  }

  update(
    id: string,
    expectedVersion: number,
    input: {
      draft: ApplicationDraftInput
      step: ApplicationDraftRecord['step']
      suppliedSecretNames?: string[]
      actorId?: string
    },
  ): ApplicationDraftRecord {
    const current = this.get(id)
    if (!current || current.version !== expectedVersion)
      throw new Error(`Application draft ${id} changed since version ${expectedVersion}`)
    if (!STEPS.has(input.step)) throw new Error('Invalid draft step')
    if (input.draft.projectId !== current.projectId) throw new Error('Draft project cannot be changed')
    assertSecretFree(input.draft)
    const supplied = [...new Set(input.suppliedSecretNames ?? current.suppliedSecretNames)].sort()
    const status = planApplication(input.draft, supplied).valid ? 'ready' : 'draft'
    const now = this.now()
    const result = this.controlPlane.database.run(
      'UPDATE application_drafts SET name=?, step=?, input=?, supplied_secret_names=?, status=?, version=version+1, updated_at=? WHERE id=? AND version=?',
      [
        input.draft.name.slice(0, 100),
        input.step,
        JSON.stringify(input.draft),
        JSON.stringify(supplied),
        status,
        now,
        id,
        expectedVersion,
      ],
    )
    if (result.changes !== 1) throw new Error(`Application draft ${id} changed since version ${expectedVersion}`)
    this.controlPlane.appendEvent({
      organizationId: current.organizationId,
      projectId: current.projectId,
      actorId: input.actorId,
      type: 'application.draft.updated',
      payload: { draftId: id, fromVersion: expectedVersion, toVersion: expectedVersion + 1, step: input.step, status },
    })
    return this.get(id)!
  }

  markApplied(id: string, expectedVersion: number, actorId?: string): ApplicationDraftRecord {
    const current = this.get(id)
    if (!current || current.version !== expectedVersion)
      throw new Error(`Application draft ${id} changed since version ${expectedVersion}`)
    const plan = planApplication(current.input, current.suppliedSecretNames)
    if (!plan.valid)
      throw new Error(
        `Draft is not deployable: ${[...plan.issues.map((item) => item.message), ...plan.missingSecrets.map((name) => `Missing secret ${name}`)].join('; ')}`,
      )
    const now = this.now()
    this.controlPlane.database.run(
      "UPDATE application_drafts SET status='applied', step='review', version=version+1, updated_at=? WHERE id=? AND version=?",
      [now, id, expectedVersion],
    )
    this.controlPlane.appendEvent({
      organizationId: current.organizationId,
      projectId: current.projectId,
      actorId,
      type: 'application.draft.applied',
      payload: sanitizeControlPlaneValue({ draftId: id, manifest: plan.manifest }),
    })
    return this.get(id)!
  }
}
