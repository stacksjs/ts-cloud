import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlPlaneStore } from '../control-plane'
import { DurableOperationQueue } from './queue'
import { DurableQueueWorker } from './worker'

const stores: ControlPlaneStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function setup() {
  const store = new ControlPlaneStore({ path: ':memory:' })
  stores.push(store)
  const organization = store.createOrganization({ slug: 'worker-org', name: 'Worker Org' })
  const project = store.createProject({ organizationId: organization.id, slug: 'worker', name: 'Worker' })
  const environment = store.createEnvironment({
    projectId: project.id,
    slug: 'production',
    name: 'Production',
    kind: 'production',
  })
  const first = store.createResource({
    projectId: project.id,
    environmentId: environment.id,
    kind: 'application',
    slug: 'first',
    name: 'First',
  })
  const second = store.createResource({
    projectId: project.id,
    environmentId: environment.id,
    kind: 'application',
    slug: 'second',
    name: 'Second',
  })
  return { store, project, environment, first, second }
}

describe('durable queue worker', () => {
  it('runs independent targets in parallel up to its lane bound', async () => {
    const target = setup()
    const queue = new DurableOperationQueue(target.store, { limits: { environment: 2, project: 2 } })
    for (const resource of [target.first, target.second]) {
      queue.enqueue({
        projectId: target.project.id,
        environmentId: target.environment.id,
        resourceId: resource.id,
        kind: 'deployment.create',
        lockKey: `resource:${resource.id}`,
      })
    }

    let active = 0
    let peak = 0
    const worker = new DurableQueueWorker(
      queue,
      {
        'deployment.create': async () => {
          active++
          peak = Math.max(peak, active)
          await new Promise((resolve) => setTimeout(resolve, 20))
          active--
        },
      },
      { parallelism: 2 },
    )

    const results = await worker.drain()
    expect(results).toHaveLength(2)
    expect(peak).toBe(2)
    expect(queue.list().map((item) => item.operation.state)).toEqual(['succeeded', 'succeeded'])
  })

  it('relies on persisted resource locks to serialize conflicting work', async () => {
    const target = setup()
    const queue = new DurableOperationQueue(target.store, { limits: { environment: 4, project: 4 } })
    for (const kind of ['deployment.create', 'deployment.rollback']) {
      queue.enqueue({
        projectId: target.project.id,
        environmentId: target.environment.id,
        resourceId: target.first.id,
        kind,
        lockKey: `resource:${target.first.id}`,
      })
    }

    let active = 0
    let peak = 0
    const handler = async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active--
    }
    const worker = new DurableQueueWorker(
      queue,
      { 'deployment.create': handler, 'deployment.rollback': handler },
      { parallelism: 4 },
    )
    expect(await worker.drain()).toHaveLength(2)
    expect(peak).toBe(1)
  })

  it('polls for newly queued work and stops without claiming more', async () => {
    const target = setup()
    const queue = new DurableOperationQueue(target.store)
    let handled = 0
    const worker = new DurableQueueWorker(
      queue,
      {
        'deployment.create': async () => {
          handled++
        },
      },
      { parallelism: 1, pollIntervalMs: 5 },
    ).start()
    queue.enqueue({ projectId: target.project.id, resourceId: target.first.id, kind: 'deployment.create' })

    await Bun.sleep(30)
    expect(handled).toBe(1)
    worker.stop()
    await worker.settled()
    queue.enqueue({ projectId: target.project.id, resourceId: target.second.id, kind: 'deployment.create' })
    await Bun.sleep(15)
    expect(handled).toBe(1)
  })

  it('wakes immediately for in-process work while retaining a long fallback poll', async () => {
    const target = setup()
    const queue = new DurableOperationQueue(target.store)
    let handledAt = 0
    const worker = new DurableQueueWorker(
      queue,
      {
        'deployment.create': async () => {
          handledAt = performance.now()
        },
      },
      { parallelism: 1, pollIntervalMs: 60_000 },
    ).start()

    await Bun.sleep(10)
    const queuedAt = performance.now()
    queue.enqueue({ projectId: target.project.id, resourceId: target.first.id, kind: 'deployment.create' })
    while (!handledAt && performance.now() - queuedAt < 500) await Bun.sleep(5)

    expect(handledAt).toBeGreaterThan(0)
    expect(handledAt - queuedAt).toBeLessThan(250)
    worker.stop()
    await worker.settled()
  })

  it('uses one fallback polling coordinator regardless of parallelism', async () => {
    const target = setup()
    const queue = new DurableOperationQueue(target.store)
    const runOne = queue.runOne.bind(queue)
    let calls = 0
    queue.runOne = async (...args) => {
      calls++
      return runOne(...args)
    }
    const worker = new DurableQueueWorker(
      queue,
      { 'deployment.create': async () => {} },
      { parallelism: 8, pollIntervalMs: 10 },
    ).start()

    await Bun.sleep(55)
    worker.stop()
    await worker.settled()

    // Eight initial lane checks plus roughly five coordinator polls. The old
    // lane-per-timer model performed about 48 checks over the same interval.
    expect(calls).toBeGreaterThanOrEqual(11)
    expect(calls).toBeLessThanOrEqual(16)
  })

  it('wakes workers opened through another SQLite handle to the same file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ts-cloud-queue-wake-'))
    const path = join(root, 'control-plane.sqlite')
    const workerStore = new ControlPlaneStore({ path })
    const writerStore = new ControlPlaneStore({ path })
    stores.push(workerStore, writerStore)
    const organization = workerStore.createOrganization({ slug: 'shared', name: 'Shared' })
    const project = workerStore.createProject({ organizationId: organization.id, slug: 'shared', name: 'Shared' })
    const workerQueue = new DurableOperationQueue(workerStore)
    const writerQueue = new DurableOperationQueue(writerStore)
    let handledAt = 0
    const worker = new DurableQueueWorker(
      workerQueue,
      { 'deployment.create': async () => { handledAt = performance.now() } },
      { parallelism: 1, pollIntervalMs: 60_000 },
    ).start()

    try {
      await Bun.sleep(10)
      const queuedAt = performance.now()
      writerQueue.enqueue({ projectId: project.id, kind: 'deployment.create' })
      while (!handledAt && performance.now() - queuedAt < 500) await Bun.sleep(5)
      expect(handledAt).toBeGreaterThan(0)
      expect(handledAt - queuedAt).toBeLessThan(250)
    }
    finally {
      worker.stop()
      await worker.settled()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
