import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlPlaneStore } from '../control-plane'
import { DurableOperationQueue } from './queue'
import { RetryableOperationError } from './types'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function scope(store: ControlPlaneStore) {
  const organization = store.createOrganization({ slug: 'queue-org', name: 'Queue Org' })
  const project = store.createProject({ organizationId: organization.id, slug: 'queue', name: 'Queue' })
  const environment = store.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' })
  const first = store.createResource({ projectId: project.id, environmentId: environment.id, kind: 'application', slug: 'first', name: 'First' })
  const second = store.createResource({ projectId: project.id, environmentId: environment.id, kind: 'application', slug: 'second', name: 'Second' })
  return { project, environment, first, second }
}

describe('durable operation queue', () => {
  it('survives restart, claims once, and prevents conflicting target work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ts-cloud-queue-')); roots.push(root)
    const path = join(root, 'control-plane.sqlite')
    const firstStore = new ControlPlaneStore({ path }); const target = scope(firstStore); const firstQueue = new DurableOperationQueue(firstStore, { workerId: 'worker-1', limits: { environment: 4 } })
    const first = firstQueue.enqueue({ projectId: target.project.id, environmentId: target.environment.id, resourceId: target.first.id, kind: 'deployment.create', lockKey: `resource:${target.first.id}`, resumePolicy: 'requeue', maxAttempts: 2 })
    const conflicting = firstQueue.enqueue({ projectId: target.project.id, environmentId: target.environment.id, resourceId: target.first.id, kind: 'deployment.rollback', lockKey: `resource:${target.first.id}` })
    firstStore.close()

    const restartedStore = new ControlPlaneStore({ path }); const restarted = new DurableOperationQueue(restartedStore, { workerId: 'worker-1', limits: { environment: 4 } })
    expect(restarted.view(first.operation.id)).toMatchObject({ operation: { state: 'queued' }, job: { resumePolicy: 'requeue' } })
    const claimed = restarted.claimNext()!
    expect(claimed.operation).toMatchObject({ id: first.operation.id, state: 'running', attempt: 1, leaseOwner: 'worker-1' })
    const duplicateWorker = new DurableOperationQueue(restartedStore, { workerId: 'worker-2', limits: { environment: 4 } })
    expect(duplicateWorker.claimNext()).toBeUndefined()
    expect(restarted.view(conflicting.operation.id)?.job.blockedReason).toBe(`resource_lock:resource:${target.first.id}`)
    restarted.complete(claimed.operation.id)
    expect(duplicateWorker.claimNext()?.operation.id).toBe(conflicting.operation.id)
    restartedStore.close()
  })

  it('preserves insertion order when queued timestamps are identical', () => {
    const now = new Date('2026-07-21T12:00:00.000Z')
    const store = new ControlPlaneStore({ path: ':memory:', now: () => now }); const target = scope(store)
    const queue = new DurableOperationQueue(store, { workerId: 'fifo-worker', now: () => now, limits: { environment: 4 } })
    const first = queue.enqueue({ projectId: target.project.id, environmentId: target.environment.id, resourceId: target.first.id, kind: 'deployment.create' })
    queue.enqueue({ projectId: target.project.id, environmentId: target.environment.id, resourceId: target.second.id, kind: 'deployment.rollback' })
    expect(queue.claimNext()?.operation.id).toBe(first.operation.id)
    store.close()
  })

  it('persists ordered cursor logs with redaction and truncation before storage', () => {
    const store = new ControlPlaneStore({ path: ':memory:' }); const target = scope(store); let id = 0
    const queue = new DurableOperationQueue(store, { id: () => `log-${++id}` })
    const queued = queue.enqueue({ projectId: target.project.id, resourceId: target.first.id, kind: 'deployment.create' })
    const first = queue.appendLog(queued.operation.id, 'authorization=Bearer-secret and exact-value', { stream: 'stdout', secrets: ['exact-value'] })
    const second = queue.appendLog(queued.operation.id, 'x'.repeat(20_000), { stream: 'stderr' })
    expect(first).toMatchObject({ redacted: true, truncated: false })
    expect(first.message).not.toContain('Bearer-secret')
    expect(first.message).not.toContain('exact-value')
    expect(second).toMatchObject({ redacted: false, truncated: true })
    expect(queue.logs(queued.operation.id, { after: first.sequence }).map(entry => entry.sequence)).toEqual([second.sequence])
    expect(store.database.query<Record<string, string>, [string]>('SELECT message FROM operation_logs WHERE id=?').get(first.id)?.message).not.toContain('Bearer-secret')
    store.close()
  })

  it('requeues only allow-listed retry classes with backoff and deterministic attempts', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z'); const store = new ControlPlaneStore({ path: ':memory:', now: () => now }); const target = scope(store)
    const queue = new DurableOperationQueue(store, { workerId: 'retry-worker', now: () => now })
    const queued = queue.enqueue({ projectId: target.project.id, resourceId: target.first.id, kind: 'deployment.create', maxAttempts: 2, retryClasses: ['provider_throttled'] })
    const first = await queue.runOne({ 'deployment.create': async () => { throw new RetryableOperationError('provider is throttling', 'provider_throttled') } })
    expect(first).toMatchObject({ handled: true, requeued: true, operation: { state: 'queued', attempt: 1 } })
    expect(queue.claimNext()).toBeUndefined()
    now = new Date('2026-01-01T00:00:02.000Z')
    const second = await queue.runOne({ 'deployment.create': async context => { context.checkpoint('publish', 'Publishing release'); return { release: 'r1' } } })
    expect(second).toMatchObject({ terminalState: 'succeeded', operation: { state: 'succeeded', attempt: 2 } })
    expect(queue.logs(queued.operation.id).map(entry => entry.stream)).toContain('step')
    store.close()
  })

  it('cancels queued work and reconciles expired worker leases from checkpoints', () => {
    let now = new Date('2026-01-01T00:00:00.000Z'); const store = new ControlPlaneStore({ path: ':memory:', now: () => now }); const target = scope(store)
    const queue = new DurableOperationQueue(store, { workerId: 'crash-worker', leaseMs: 1000, now: () => now })
    const cancelled = queue.enqueue({ projectId: target.project.id, resourceId: target.first.id, kind: 'deployment.create' })
    expect(queue.requestCancellation(cancelled.operation.id)).toMatchObject({ state: 'cancelled' })
    const recoverable = queue.enqueue({ projectId: target.project.id, resourceId: target.second.id, kind: 'deployment.create', resumePolicy: 'requeue', maxAttempts: 2 })
    expect(queue.claimNext()?.operation.id).toBe(recoverable.operation.id)
    queue.heartbeat(recoverable.operation.id, 'upload')
    now = new Date('2026-01-01T00:00:02.000Z')
    expect(queue.recoverExpired()).toEqual({ requeued: 1, failed: 0, cancelled: 0 })
    expect(queue.view(recoverable.operation.id)).toMatchObject({ operation: { state: 'queued' }, job: { currentStep: 'upload', blockedReason: 'worker_restart' } })
    expect(store.listEvents({ operationId: cancelled.operation.id }).map(event => event.type)).toContain('operation.cancellation_requested')
    store.close()
  })

  it('times out bounded handlers and marks non-cancellable provider work for reconciliation', async () => {
    const store = new ControlPlaneStore({ path: ':memory:' }); const target = scope(store); const queue = new DurableOperationQueue(store, { workerId: 'timeout-worker' })
    queue.enqueue({ projectId: target.project.id, resourceId: target.first.id, kind: 'provider.deploy', timeoutSeconds: 1, cancellationMode: 'provider_non_cancellable' })
    const result = await queue.runOne({ 'provider.deploy': async () => { await new Promise(resolve => setTimeout(resolve, 2_000)); return {} } })
    expect(result).toMatchObject({ terminalState: 'timed_out', operation: { state: 'timed_out', output: { reconciliationRequired: true } } })
    store.close()
  }, 3_000)
})
