import type { CloudConfig, EnvironmentType } from '@ts-cloud/core'
import type {
  ControlPlaneActor,
  ControlPlaneEnvironment,
  ControlPlaneOperation,
  ControlPlaneOrganization,
  ControlPlaneProject,
  JsonValue,
} from '../control-plane'
import type { DashboardUser } from './dashboard-auth'
import { createHash } from 'node:crypto'
import { ControlPlaneStore, roleCapabilities, sanitizeControlPlaneValue } from '../control-plane'

export interface DashboardControlPlane {
  store: ControlPlaneStore
  organization: ControlPlaneOrganization
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
  const organizationSlug = config.project.slug.length >= 3 ? config.project.slug : `${config.project.slug}-org`
  const organization = (existing?.organizationId ? store.getOrganization(existing.organizationId) : undefined)
    ?? store.getOrganizationBySlug(organizationSlug)
    ?? store.createOrganization({ id: existing?.organizationId, slug: organizationSlug, name: config.project.name })
  const project = existing
    ? (existing.name !== config.project.name || existing.desiredConfigHash !== hash || existing.organizationId !== organization.id
        ? store.updateProject(existing.id, existing.version, { name: config.project.name, organizationId: organization.id, desiredConfigHash: hash })
        : existing)
    : store.createProject({ organizationId: organization.id, slug: config.project.slug, name: config.project.name, desiredConfigHash: hash })

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

    const existingResources = new Map(store.listResources(project.id, environment.id).map(resource => [`${resource.kind}:${resource.slug}`, resource]))
    const syncResource = (kind: string, slug: string, name: string, desiredState: JsonValue) => {
      const key = `${kind}:${slug}`
      const found = existingResources.get(key)
      const safeState = sanitizeControlPlaneValue(desiredState)
      if (found) {
        if (found.name !== name || stableJson(found.desiredState) !== stableJson(safeState))
          existingResources.set(key, store.updateResource(found.id, found.version, { name, desiredState: safeState }))
        return
      }
      const resource = store.createResource({
        projectId: project.id,
        environmentId: environment.id,
        kind,
        slug,
        name,
        provider: config.cloud?.provider,
        desiredState: safeState,
        metadata: { source: 'cloud-config' },
      })
      existingResources.set(key, resource)
    }

    for (const [siteSlug, site] of Object.entries(config.sites ?? {})) {
      syncResource('application', siteSlug, siteSlug, site as JsonValue)
    }

    const infrastructure = config.infrastructure
    if (infrastructure?.compute) {
      syncResource('server', `${project.slug}-server`, project.name, {
        ...(sanitizeControlPlaneValue(infrastructure.compute) as Record<string, JsonValue>),
        label: project.name,
      })
    }
    for (const [databaseSlug, database] of Object.entries(infrastructure?.databases ?? {}))
      syncResource('database', databaseSlug, databaseSlug, database as JsonValue)
    if (infrastructure?.appDatabase)
      syncResource('database', 'application-database', 'Application database', infrastructure.appDatabase as unknown as JsonValue)
    else if (infrastructure?.database)
      syncResource('database', 'application-database', 'Application database', { engine: infrastructure.database })
  }

  const reconciliation = store.reconcileOrphanedOperations({ policy: 'fail' })
  return { store, organization, project, environments, reconciliation }
}

const LEGACY_MEMBER_CAPABILITIES = ['project:read', 'config:read', 'deployments:read', 'deployments:create', 'runtime:read', 'runtime:logs'] as const

export function synchronizeDashboardUsers(controlPlane: DashboardControlPlane, users: readonly DashboardUser[]): void {
  const { store, organization, project } = controlPlane
  const activeActorIds = new Set<string>()
  for (const user of users) {
    const actor = ensureActor(store, user)
    activeActorIds.add(actor.id)
    const existing = store.getMembershipForActor(organization.id, actor.id)
    if (existing && existing.source !== 'legacy')
      continue

    const siteResources = store.listResources(project.id)
      .filter(resource => resource.kind === 'application' && Object.hasOwn(user.sites, resource.slug))
    const desiredRole = user.role === 'admin' ? 'owner' : 'viewer'
    const desiredScope = user.role === 'admin' || siteResources.length === 0
      ? { type: 'organization' as const }
      : { type: 'resource' as const, id: siteResources[0].id }
    const membership = existing
      ? (existing.roleTemplate !== desiredRole || stableJson(existing.scope) !== stableJson(desiredScope)
          ? store.updateMembership({ id: existing.id, roleTemplate: desiredRole, scope: desiredScope, actorId: actor.id })
          : existing)
      : store.createMembership({ organizationId: organization.id, actorId: actor.id, roleTemplate: desiredRole, scope: desiredScope, source: 'legacy' })

    const desiredGrants = new Set<string>()
    if (user.role === 'member' && siteResources.length === 0) {
      for (const capability of roleCapabilities('viewer'))
        desiredGrants.add(`deny|${capability}|organization|`)
    }
    for (const resource of siteResources) {
      const role = user.sites[resource.slug]
      for (const capability of LEGACY_MEMBER_CAPABILITIES)
        desiredGrants.add(`allow|${capability}|resource|${resource.id}`)
      if (role === 'owner')
        desiredGrants.add(`allow|config:write|resource|${resource.id}`)
    }

    for (const grant of store.listGrants(membership.id).filter(grant => grant.source === 'legacy')) {
      const key = `${grant.effect}|${grant.capability}|${grant.scope.type}|${grant.scope.id ?? ''}`
      if (!desiredGrants.has(key))
        store.removeGrant(grant.id, actor.id)
    }
    for (const key of desiredGrants) {
      const [effect, capability, scopeType, scopeId] = key.split('|')
      store.upsertGrant({
        organizationId: organization.id,
        membershipId: membership.id,
        effect: effect as 'allow' | 'deny',
        capability: capability as Parameters<typeof store.upsertGrant>[0]['capability'],
        scope: scopeType === 'organization' ? { type: 'organization' } : { type: scopeType as 'resource', id: scopeId },
        source: 'legacy',
      })
    }
  }

  for (const membership of store.listMemberships(organization.id)) {
    if (membership.source === 'legacy' && !activeActorIds.has(membership.actorId))
      store.revokeMembership(membership.id)
  }
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
