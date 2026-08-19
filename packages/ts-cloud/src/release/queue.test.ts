import { describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { DurableOperationQueue, DurableQueueWorker } from '../queue'
import type { ReleaseActivationDriver } from './runtime'
import { createReleaseQueueHandlers } from './queue'
import { ReleaseService } from './service'
import type { ReleaseDeployableKind, ReleaseHealthGate, ReleaseStrategy } from './types'

function setup() {
  const store = new ControlPlaneStore({ path: ':memory:' })
  const organization = store.createOrganization({ slug: 'acme', name: 'Acme' })
  const project = store.createProject({ organizationId: organization.id, slug: 'web', name: 'Web' })
  const environment = store.createEnvironment({
    projectId: project.id,
    slug: 'production',
    name: 'Production',
    kind: 'production',
  })
  const resource = store.createResource({
    projectId: project.id,
    environmentId: environment.id,
    kind: 'application',
    slug: 'web',
    name: 'Web',
    provider: 'fixture',
  })
  const releases = new ReleaseService(store)
  const artifact = releases.releases.registerArtifact({
    organizationId: organization.id,
    digest: `sha256:${'a'.repeat(64)}`,
    kind: 'container',
    uri: 'oci:acme/web@sha256:one',
    size: 10,
  })
  const create = (
    strategy: ReleaseStrategy = 'canary',
    healthGate: ReleaseHealthGate = {
      protocol: 'http',
      path: '/health',
      timeoutSeconds: 10,
      intervalSeconds: 1,
      healthyThreshold: 1,
      unhealthyThreshold: 1,
    },
  ) =>
    releases.releases.create({
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
      resourceId: resource.id,
      artifactId: artifact.id,
      kind: 'container' as ReleaseDeployableKind,
      config: {},
      manifest: { replicas: 2 },
      strategy,
      healthGate,
    })
  return { store, releases, create }
}

function driver(healthy = true): ReleaseActivationDriver {
  return {
    name: 'fixture',
    capability: (context) => ({
      strategy: context.release.strategy,
      supported: true,
      explanation: 'fixture',
      capacityMultiplier: 1,
      costImpact: 'none',
      rollback: 'fixture',
    }),
    activate: async (context) => ({
      activated: healthy,
      healthy,
      providerVersion: 'v2',
      resourceVersions: { primary: 'v2' },
      transitions: context.transitions.map((step) => ({
        trafficPercent: step.trafficPercent,
        healthy,
        observed: { step: step.step },
      })),
      ...(!healthy ? { error: 'health probe failed' } : {}),
    }),
    rollback: async () => ({
      activated: true,
      healthy: true,
      providerVersion: 'v1',
      resourceVersions: { primary: 'v1' },
      transitions: [{ trafficPercent: 0, healthy: true, observed: { restored: true } }],
    }),
  }
}

describe('release queue handlers', () => {
  it('activates an immutable artifact through every traffic and health step', async () => {
    const target = setup()
    const release = target.create()
    target.releases.enqueueActivation(release)
    const queue = new DurableOperationQueue(target.store)
    const worker = new DurableQueueWorker(
      queue,
      createReleaseQueueHandlers({ store: target.store, resolveDriver: () => driver() }),
    )
    const results = await worker.drain()
    expect(results).toMatchObject([{ terminalState: 'succeeded' }])
    expect(target.releases.releases.get(release.id)).toMatchObject({ status: 'active' })
    expect(
      target.releases.releases
        .transitions(release.id)
        .map((value) => value.trafficPercent)
        .filter((value) => value != null),
    ).toEqual([0, 5, 25, 50, 100, 100])
    target.store.close()
  })
  it('fails an unhealthy activation and restores the preserved release once', async () => {
    const target = setup()
    const previous = target.create()
    target.releases.releases.transition(previous.id, 'activating', { message: 'activate' })
    target.releases.releases.transition(previous.id, 'active', { message: 'healthy' })
    const next = target.create()
    target.releases.enqueueActivation(next)
    const queue = new DurableOperationQueue(target.store)
    const handlers = createReleaseQueueHandlers({
      store: target.store,
      resolveDriver: (release) => driver(release.id === previous.id),
    })
    const worker = new DurableQueueWorker(queue, handlers)
    expect((await worker.drain()).map((value) => value.terminalState)).toEqual(['failed', 'succeeded'])
    expect(target.releases.releases.get(next.id)).toMatchObject({ status: 'rolled_back', rollbackAttempts: 1 })
    expect(target.releases.releases.get(previous.id)).toMatchObject({ status: 'active' })
    expect(
      target.store.listOperations({ projectId: next.projectId }).filter((value) => value.kind === 'release.rollback'),
    ).toHaveLength(1)
    target.store.close()
  })
  it('previews an exact manual rollback target and restores it durably', async () => {
    const target = setup()
    const previous = target.create()
    target.releases.releases.transition(previous.id, 'activating', { message: 'activate' })
    target.releases.releases.transition(previous.id, 'active', { message: 'healthy' })
    const current = target.create()
    target.releases.releases.transition(current.id, 'activating', { message: 'activate' })
    target.releases.releases.transition(current.id, 'active', { message: 'healthy' })
    const operation = target.releases.enqueueRollback(current)
    expect(operation).toMatchObject({
      kind: 'release.rollback',
      input: { releaseId: current.id, targetReleaseId: previous.id, automatic: false },
    })
    const worker = new DurableQueueWorker(
      new DurableOperationQueue(target.store),
      createReleaseQueueHandlers({ store: target.store, resolveDriver: () => driver() }),
    )
    expect(await worker.drain()).toMatchObject([{ terminalState: 'succeeded' }])
    expect(target.releases.releases.get(current.id)).toMatchObject({ status: 'rolled_back' })
    expect(target.releases.releases.get(previous.id)).toMatchObject({ status: 'active' })
    target.store.close()
  })
  it('requires a named health check after provider health before activation', async () => {
    const target = setup()
    const release = target.create('canary', {
      name: 'api-smoke',
      protocol: 'http',
      timeoutSeconds: 10,
      intervalSeconds: 1,
      healthyThreshold: 1,
      unhealthyThreshold: 1,
    })
    target.releases.enqueueActivation(release)
    let observed = ''
    const worker = new DurableQueueWorker(
      new DurableOperationQueue(target.store),
      createReleaseQueueHandlers({
        store: target.store,
        resolveDriver: () => driver(),
        resolveHealthGate: async (name) => {
          observed = name
          return { healthy: true, evidence: { check: name } }
        },
      }),
    )
    expect(await worker.drain()).toMatchObject([{ terminalState: 'succeeded' }])
    expect(observed).toBe('api-smoke')
    expect(target.releases.releases.get(release.id)).toMatchObject({ status: 'active' })
    target.store.close()
  })
  it('automatically rolls back when a named health check fails', async () => {
    const target = setup()
    const previous = target.create()
    target.releases.releases.transition(previous.id, 'activating', { message: 'activate' })
    target.releases.releases.transition(previous.id, 'active', { message: 'healthy' })
    const release = target.create('canary', {
      name: 'api-smoke',
      protocol: 'http',
      timeoutSeconds: 10,
      intervalSeconds: 1,
      healthyThreshold: 1,
      unhealthyThreshold: 1,
    })
    target.releases.enqueueActivation(release)
    const worker = new DurableQueueWorker(
      new DurableOperationQueue(target.store),
      createReleaseQueueHandlers({
        store: target.store,
        resolveDriver: () => driver(),
        resolveHealthGate: async () => ({
          healthy: false,
          evidence: { status: 503 },
          message: 'Smoke check returned 503.',
        }),
      }),
    )
    expect((await worker.drain()).map((value) => value.terminalState)).toEqual(['failed', 'succeeded'])
    expect(target.releases.releases.get(release.id)).toMatchObject({ status: 'rolled_back', rollbackAttempts: 1 })
    expect(target.releases.releases.get(previous.id)).toMatchObject({ status: 'active' })
    target.store.close()
  })
})
