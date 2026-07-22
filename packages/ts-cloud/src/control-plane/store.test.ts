import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { controlPlaneMigrations } from './migrations'
import { searchControlPlane } from './search'
import { ControlPlaneStore, sanitizeControlPlaneValue } from './store'
import { InvalidOperationTransitionError, OptimisticConcurrencyError } from './types'

const tempDirectories: string[] = []

function temporaryDatabase(): { directory: string, path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'ts-cloud-control-plane-'))
  tempDirectories.push(directory)
  return { directory, path: join(directory, '.ts-cloud', 'control-plane.sqlite') }
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('ControlPlaneStore schema and persistence', () => {
  it('initializes a healthy WAL database with restrictive permissions', () => {
    const { path } = temporaryDatabase()
    const store = new ControlPlaneStore({ path })
    const health = store.health()

    expect(health.integrity).toBe('ok')
    expect(health.schemaVersion).toBe(health.supportedSchemaVersion)
    expect(health.journalMode).toBe('wal')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(`${path}-shm`).mode & 0o777).toBe(0o600)
    expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600)
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)
    store.close()
  })

  it('persists entities and operations across restarts', () => {
    const { path } = temporaryDatabase()
    const first = new ControlPlaneStore({ path })
    const project = first.createProject({ slug: 'acme', name: 'Acme' })
    const environment = first.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' })
    const resource = first.createResource({ projectId: project.id, environmentId: environment.id, kind: 'application', slug: 'web', name: 'Web' })
    const operation = first.createOperation({ projectId: project.id, environmentId: environment.id, resourceId: resource.id, kind: 'deploy' })
    first.close()

    const second = new ControlPlaneStore({ path })
    expect(second.getProject(project.id)?.slug).toBe('acme')
    expect(second.getResource(resource.id)?.name).toBe('Web')
    expect(second.getOperation(operation.id)?.state).toBe('queued')
    expect(second.listEvents({ operationId: operation.id }).map(event => event.type)).toEqual(['operation.queued'])
    second.close()
  })

  it('backs up an existing schema before applying a forward migration', () => {
    const { path } = temporaryDatabase()
    const parent = join(path, '..')
    mkdirSync(parent, { recursive: true })
    const database = new Database(path, { create: true })
    database.run(controlPlaneMigrations[0].sql)
    database.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'core_control_plane', '2025-01-01T00:00:00.000Z')")
    database.run('PRAGMA user_version = 1')
    database.close()

    const migrated = new ControlPlaneStore({ path })
    const backup = migrated.getSetting('storage.last_backup') as { path: string }
    expect(existsSync(backup.path)).toBe(true)
    expect(backup.path.startsWith(`${path}.v1.`)).toBe(true)
    expect(migrated.health().schemaVersion).toBe(29)
    expect(existsSync(parent)).toBe(true)
    migrated.close()
  })

  it('keeps migration numbering contiguous', () => {
    expect(controlPlaneMigrations.map(migration => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29])
  })
})

describe('ControlPlaneStore concurrency and operation state', () => {
  it('rejects stale resource mutations from another writer', () => {
    const { path } = temporaryDatabase()
    const first = new ControlPlaneStore({ path })
    const project = first.createProject({ slug: 'acme', name: 'Acme' })
    const resource = first.createResource({ projectId: project.id, kind: 'application', slug: 'web', name: 'Web' })
    const second = new ControlPlaneStore({ path })

    first.updateResource(resource.id, resource.version, { name: 'Web v2' })
    expect(() => second.updateResource(resource.id, resource.version, { name: 'Stale write' })).toThrow(OptimisticConcurrencyError)
    expect(second.getResource(resource.id)?.name).toBe('Web v2')
    first.close()
    second.close()
  })

  it('deduplicates operations and enforces valid state transitions', () => {
    const store = new ControlPlaneStore({ path: ':memory:' })
    const first = store.createOperation({ kind: 'deploy', idempotencyKey: 'deploy:acme:sha' })
    const duplicate = store.createOperation({ kind: 'deploy', idempotencyKey: 'deploy:acme:sha' })
    expect(duplicate.id).toBe(first.id)

    const running = store.claimNextOperation('worker-1')!
    expect(running.state).toBe('running')
    expect(running.attempt).toBe(1)
    const succeeded = store.transitionOperation(running.id, { to: 'succeeded', expectedVersion: running.version, output: { release: 'r1' } })
    expect(succeeded.state).toBe('succeeded')
    expect(() => store.transitionOperation(succeeded.id, { to: 'running' })).toThrow(InvalidOperationTransitionError)
    expect(store.listEvents({ operationId: first.id }).map(event => event.type)).toEqual([
      'operation.queued',
      'operation.running',
      'operation.succeeded',
    ])
    store.close()
  })

  it('deterministically fails orphaned running work after restart', () => {
    const { path } = temporaryDatabase()
    const initialTime = new Date('2026-01-01T00:00:00.000Z')
    const first = new ControlPlaneStore({ path, now: () => initialTime })
    const operation = first.createOperation({ kind: 'deploy' })
    first.claimNextOperation('worker-1', 1_000)
    first.close()

    const restarted = new ControlPlaneStore({ path, now: () => new Date('2026-01-01T00:01:00.000Z') })
    expect(restarted.reconcileOrphanedOperations()).toEqual({ requeued: 0, failed: 1 })
    expect(restarted.getOperation(operation.id)?.state).toBe('failed')
    restarted.close()
  })
})

describe('ControlPlaneStore safety and portability', () => {
  it('redacts nested secrets and bounds oversized payloads', () => {
    const sanitized = sanitizeControlPlaneValue({
      password: 'hunter2',
      nested: { apiKey: 'secret-key', message: 'authorization=Bearer-value visible' },
    }) as Record<string, any>
    expect(sanitized.password).toBe('[REDACTED]')
    expect(sanitized.nested.apiKey).toBe('[REDACTED]')
    expect(sanitized.nested.message).toContain('[REDACTED]')
    expect(JSON.stringify(sanitizeControlPlaneValue({ output: 'x'.repeat(1000) }, 200)).length).toBeLessThanOrEqual(220)
  })

  it('exports and imports a complete portable snapshot', () => {
    const source = new ControlPlaneStore({ path: ':memory:' })
    const organization = source.createOrganization({ slug: 'acme-inc', name: 'Acme Inc' })
    const actor = source.createActor({ kind: 'user', externalId: 'dashboard:chris', displayName: 'Chris' })
    const project = source.createProject({ organizationId: organization.id, slug: 'acme', name: 'Acme' })
    const membership = source.createMembership({ organizationId: organization.id, actorId: actor.id, roleTemplate: 'owner' })
    source.upsertGrant({ organizationId: organization.id, membershipId: membership.id, effect: 'deny', capability: 'runtime:terminal' })
    source.createInvitation({ organizationId: organization.id, email: 'dev@acme.test', roleTemplate: 'deployer' })
    source.createResource({ projectId: project.id, kind: 'database', slug: 'primary', name: 'Primary' })
    source.createOperation({ projectId: project.id, kind: 'backup' })
    source.setSetting('ui.theme', 'system')
    const tag = source.upsertTag(project.id, 'customer-facing', '#35d19b')
    source.assignTag(source.listResources(project.id)[0].id, tag.id)
    source.saveFilter('dashboard:chris', 'Production databases', 'databases.list', { environment: 'production' })
    source.setFavorite('dashboard:chris', 'resource', source.listResources(project.id)[0].id, true)
    const snapshot = source.exportSnapshot()

    const target = new ControlPlaneStore({ path: ':memory:' })
    target.importSnapshot(snapshot)
    expect(target.exportSnapshot()).toMatchObject({
      organizations: [{ slug: 'acme-inc' }],
      memberships: [{ roleTemplate: 'owner' }],
      invitations: [{ email: 'dev@acme.test', state: 'pending' }],
      grants: [{ effect: 'deny', capability: 'runtime:terminal' }],
      projects: [{ slug: 'acme' }],
      resources: [{ slug: 'primary' }],
      operations: [{ kind: 'backup', state: 'queued' }],
      settings: { 'ui.theme': 'system' },
      tags: [{ name: 'customer-facing' }],
      savedFilters: [{ name: 'Production databases' }],
      navigationItems: [{ favorite: true }],
    })
    expect(() => target.importSnapshot(snapshot)).toThrow('not empty')
    source.close()
    target.close()
  })

  it('persists tags, saved filters, favorites, and recent navigation per user', () => {
    const store = new ControlPlaneStore({ path: ':memory:' })
    const project = store.createProject({ slug: 'acme', name: 'Acme' })
    const resource = store.createResource({ projectId: project.id, kind: 'application', slug: 'web', name: 'Web' })
    const tag = store.upsertTag(project.id, 'Customer Facing', '#35D19B')
    store.assignTag(resource.id, tag.id)
    expect(store.listResourceTags(project.id)[0].tag.normalizedName).toBe('customer-facing')

    const filter = store.saveFilter('dashboard:chris', 'Prod', 'services.list', { env: 'production' })
    expect(store.listSavedFilters('dashboard:chris')).toEqual([filter])
    expect(() => store.saveFilter('dashboard:chris', 'Unsafe', 'javascript:alert(1)', {})).toThrow('local route')
    store.recordNavigation('dashboard:chris', 'resource', resource.id)
    store.recordNavigation('dashboard:chris', 'resource', resource.id)
    store.setFavorite('dashboard:chris', 'resource', resource.id, true)
    expect(store.listNavigation('dashboard:chris', { favoritesOnly: true })[0]).toMatchObject({ favorite: true, visitCount: 2 })
    store.close()
  })

  it('compacts expired terminal history but preserves queued work', () => {
    let now = new Date('2025-01-01T00:00:00.000Z')
    const store = new ControlPlaneStore({ path: ':memory:', now: () => now })
    const oldTerminal = store.createOperation({ kind: 'deploy' })
    const running = store.claimNextOperation('worker')!
    store.transitionOperation(running.id, { to: 'succeeded', expectedVersion: running.version })
    now = new Date('2026-01-01T00:00:00.000Z')
    const queued = store.createOperation({ kind: 'deploy' })

    const result = store.compact({ eventRetentionDays: 30, operationRetentionDays: 30, vacuum: false })
    expect(result.deletedOperations).toBe(1)
    expect(store.getOperation(oldTerminal.id)).toBeUndefined()
    expect(store.getOperation(queued.id)?.state).toBe('queued')
    store.close()
  })
})

describe('control-plane search', () => {
  it('finds safe service metadata, tags, and deployment SHAs without indexing secrets', () => {
    const store = new ControlPlaneStore({ path: ':memory:' })
    const project = store.createProject({ slug: 'acme', name: 'Acme Cloud' })
    const environment = store.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' })
    const resource = store.createResource({
      projectId: project.id,
      environmentId: environment.id,
      kind: 'application',
      slug: 'billing-api',
      name: 'Billing API',
      provider: 'hetzner',
      desiredState: { domain: 'billing.acme.test', env: { DATABASE_PASSWORD: 'never-index-this' } },
    })
    const tag = store.upsertTag(project.id, 'payments')
    store.assignTag(resource.id, tag.id)
    store.createResource({
      projectId: project.id,
      environmentId: environment.id,
      kind: 'server',
      slug: 'primary-server',
      name: 'Primary compute',
      desiredState: { label: 'edge-west-1' },
    })
    store.createResource({ projectId: project.id, environmentId: environment.id, kind: 'database', slug: 'orders', name: 'Orders database' })
    store.createOperation({ projectId: project.id, environmentId: environment.id, resourceId: resource.id, kind: 'deploy.release', input: { sha: 'abc123def', token: 'also-never-index-this' } })

    expect(searchControlPlane(store, { projectId: project.id, query: 'billing.acme' })[0]).toMatchObject({ type: 'service', title: 'Billing API' })
    expect(searchControlPlane(store, { projectId: project.id, query: 'payments' })[0]).toMatchObject({ type: 'service' })
    expect(searchControlPlane(store, { projectId: project.id, query: 'edge-west' })[0]).toMatchObject({ type: 'server', title: 'Primary compute' })
    expect(searchControlPlane(store, { projectId: project.id, query: 'orders database' })[0]).toMatchObject({ type: 'database' })
    expect(searchControlPlane(store, { projectId: project.id, query: 'abc123' })[0]).toMatchObject({ type: 'deployment' })
    expect(searchControlPlane(store, { projectId: project.id, query: 'never-index-this' })).toEqual([])
    expect(searchControlPlane(store, { projectId: project.id, query: 'also-never-index-this' })).toEqual([])
    store.close()
  })

  it('does not leak ungranted resources or project-wide activity', () => {
    const store = new ControlPlaneStore({ path: ':memory:' })
    const project = store.createProject({ slug: 'acme', name: 'Acme' })
    store.createResource({ projectId: project.id, kind: 'application', slug: 'public', name: 'Public Site' })
    store.createResource({ projectId: project.id, kind: 'application', slug: 'private-admin', name: 'Private Admin' })
    store.createOperation({ projectId: project.id, kind: 'deploy.private-admin', input: { sha: 'secretsha' } })

    const allowed = new Set(['public'])
    expect(searchControlPlane(store, { projectId: project.id, query: 'public', allowedResourceSlugs: allowed })).toHaveLength(1)
    expect(searchControlPlane(store, { projectId: project.id, query: 'private', allowedResourceSlugs: allowed })).toEqual([])
    expect(searchControlPlane(store, { projectId: project.id, query: 'secretsha', allowedResourceSlugs: allowed })).toEqual([])
    store.close()
  })

  it('searches ten thousand resources within the local interaction budget', () => {
    const store = new ControlPlaneStore({ path: ':memory:' })
    const project = store.createProject({ slug: 'scale', name: 'Scale' })
    store.transaction(() => {
      for (let index = 0; index < 10_000; index++) {
        store.createResource({ projectId: project.id, kind: 'application', slug: `service-${index}`, name: `Service ${index}` })
      }
    })
    const started = performance.now()
    const results = searchControlPlane(store, { projectId: project.id, query: 'Service 9876' })
    const elapsed = performance.now() - started
    expect(results[0]).toMatchObject({ title: 'Service 9876' })
    expect(elapsed).toBeLessThan(500)
    store.close()
  })
})
