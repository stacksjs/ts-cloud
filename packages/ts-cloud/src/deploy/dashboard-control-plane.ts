import type { CloudConfig, EnvironmentType } from '@ts-cloud/core'
import type {
  ControlPlaneActor,
  ControlPlaneEnvironment,
  ControlPlaneOperation,
  ControlPlaneProject,
  JsonValue,
} from '../control-plane'
import type { DashboardUser } from './dashboard-auth'
import { createHash } from 'node:crypto'
import { ControlPlaneStore, sanitizeControlPlaneValue } from '../control-plane'

export interface DashboardControlPlane {
  store: ControlPlaneStore
  project: ControlPlaneProject
  environments: Map<string, ControlPlaneEnvironment>
  reconciliation: { requeued: number, failed: number }
}

export interface TrackDashboardOperationInput<T extends { ok: boolean }> {
  controlPlane: DashboardControlPlane
  environment: EnvironmentType
  actor: DashboardUser
  kind: string
  resourceSlug?: string
  input?: JsonValue
  execute: () => Promise<T>
}

export interface TrackedDashboardOperationResult<T extends { ok: boolean }> {
  result: T
  operation: ControlPlaneOperation
}

function stableConfigHash(config: CloudConfig): string {
  return createHash('sha256').update(stableJson(config)).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(item => stableJson(item)).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined && typeof child !== 'function')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function ensureActor(store: ControlPlaneStore, user: DashboardUser): ControlPlaneActor {
  const externalId = `dashboard:${user.username.toLowerCase()}`
  return store.getActorByExternalId('user', externalId) ?? store.createActor({
    kind: 'user',
    externalId,
    displayName: user.name ?? user.username,
    metadata: { source: 'dashboard', role: user.role },
  })
}

export function initializeDashboardControlPlane(cwd: string, config: CloudConfig): DashboardControlPlane {
  const store = new ControlPlaneStore({ cwd })
  const hash = stableConfigHash(config)
  const existing = store.getProjectBySlug(config.project.slug)
  const project = existing
    ? (existing.name !== config.project.name || existing.desiredConfigHash !== hash
        ? store.updateProject(existing.id, existing.version, { name: config.project.name, desiredConfigHash: hash })
        : existing)
    : store.createProject({ slug: config.project.slug, name: config.project.name, desiredConfigHash: hash })

  const environments = new Map<string, ControlPlaneEnvironment>()
  for (const [slug, desired] of Object.entries(config.environments ?? {})) {
    const found = store.getEnvironmentBySlug(project.id, slug)
    const environment = found ?? store.createEnvironment({
      projectId: project.id,
      slug,
      name: slug.replace(/(^|[-_])(\w)/g, (_match, _separator, letter: string) => letter.toUpperCase()),
      kind: String((desired as { type?: string })?.type ?? slug),
      region: (desired as { region?: string })?.region ?? config.project.region,
      desiredState: sanitizeControlPlaneValue(desired),
    })
    environments.set(slug, environment)

    const existingResources = new Set(store.listResources(project.id, environment.id).map(resource => `${resource.kind}:${resource.slug}`))
    for (const [siteSlug, site] of Object.entries(config.sites ?? {})) {
      if (existingResources.has(`application:${siteSlug}`))
        continue
      store.createResource({
        projectId: project.id,
        environmentId: environment.id,
        kind: 'application',
        slug: siteSlug,
        name: siteSlug,
        desiredState: sanitizeControlPlaneValue(site),
        metadata: { source: 'cloud-config' },
      })
    }
  }

  const reconciliation = store.reconcileOrphanedOperations({ policy: 'fail' })
  return { store, project, environments, reconciliation }
}

export async function trackDashboardOperation<T extends { ok: boolean }>(input: TrackDashboardOperationInput<T>): Promise<TrackedDashboardOperationResult<T>> {
  const { controlPlane, environment, actor: user } = input
  const actor = ensureActor(controlPlane.store, user)
  const environmentRecord = controlPlane.environments.get(environment)
  const resource = input.resourceSlug && environmentRecord
    ? controlPlane.store.listResources(controlPlane.project.id, environmentRecord.id).find(item => item.slug === input.resourceSlug)
    : undefined
  const operation = controlPlane.store.createOperation({
    projectId: controlPlane.project.id,
    environmentId: environmentRecord?.id,
    resourceId: resource?.id,
    actorId: actor.id,
    kind: input.kind,
    input: input.input ?? {},
  })
  const running = controlPlane.store.claimOperation(operation.id, `dashboard:${process.pid}`, 15 * 60 * 1000)
  if (!running)
    throw new Error(`Could not claim control-plane operation ${operation.id}`)

  try {
    const result = await input.execute()
    const record = controlPlane.store.transitionOperation(operation.id, {
      to: result.ok ? 'succeeded' : 'failed',
      expectedVersion: running.version,
      error: result.ok ? undefined : operationError(result),
      output: summarizeResult(result),
    })
    return { result, operation: record }
  }
  catch (error) {
    controlPlane.store.transitionOperation(operation.id, {
      to: 'failed',
      expectedVersion: running.version,
      error: error instanceof Error ? error.message : String(error),
      output: { ok: false, threw: true },
    })
    throw error
  }
}

function operationError(result: { ok: boolean }): string {
  const record = result as Record<string, unknown>
  return String(record.error ?? record.stderr ?? 'Operation failed')
}

function summarizeResult(result: { ok: boolean }): JsonValue {
  const record = result as Record<string, unknown>
  const stdout = typeof record.stdout === 'string' ? record.stdout : ''
  const stderr = typeof record.stderr === 'string' ? record.stderr : ''
  const summary: Record<string, JsonValue> = {
    ok: result.ok,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
  }
  if (typeof record.operation === 'string')
    summary.operation = record.operation
  if (typeof record.error === 'string')
    summary.error = record.error
  return sanitizeControlPlaneValue(summary)
}
