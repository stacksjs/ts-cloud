import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { controlPlaneMigrations } from './migrations'
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
    const setup = new ControlPlaneStore({ path })
    setup.close()

    const database = new Database(path)
    database.run('DROP INDEX events_correlation_idx')
    database.run('DROP INDEX resources_environment_idx')
    database.run('DROP INDEX events_resource_idx')
    database.run('DROP INDEX events_operation_idx')
    database.run('DROP INDEX events_project_idx')
    database.run('DROP INDEX operations_correlation_idx')
    database.run('DROP INDEX operations_lease_idx')
    database.run('DROP INDEX operations_project_idx')
    database.run('DROP INDEX operations_queue_idx')
    database.run('DELETE FROM schema_migrations WHERE version = 2')
    database.run('PRAGMA user_version = 1')
    database.close()

    const migrated = new ControlPlaneStore({ path })
    const backup = migrated.getSetting('storage.last_backup') as { path: string }
    expect(existsSync(backup.path)).toBe(true)
    expect(backup.path.startsWith(`${path}.v1.`)).toBe(true)
    expect(migrated.health().schemaVersion).toBe(2)
    expect(existsSync(parent)).toBe(true)
    migrated.close()
  })

  it('keeps migration numbering contiguous', () => {
    expect(controlPlaneMigrations.map(migration => migration.version)).toEqual([1, 2])
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
    const project = source.createProject({ slug: 'acme', name: 'Acme' })
    source.createResource({ projectId: project.id, kind: 'database', slug: 'primary', name: 'Primary' })
    source.createOperation({ projectId: project.id, kind: 'backup' })
    source.setSetting('ui.theme', 'system')
    const snapshot = source.exportSnapshot()

    const target = new ControlPlaneStore({ path: ':memory:' })
    target.importSnapshot(snapshot)
    expect(target.exportSnapshot()).toMatchObject({
      projects: [{ slug: 'acme' }],
      resources: [{ slug: 'primary' }],
      operations: [{ kind: 'backup', state: 'queued' }],
      settings: { 'ui.theme': 'system' },
    })
    expect(() => target.importSnapshot(snapshot)).toThrow('not empty')
    source.close()
    target.close()
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
