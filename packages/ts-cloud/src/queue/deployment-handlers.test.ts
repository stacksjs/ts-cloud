import { afterEach, describe, expect, it } from 'bun:test'
import type { QueueExecutionContext } from './types'
import { ControlPlaneStore } from '../control-plane'
import { DurableOperationQueue } from './queue'
import { createDeploymentQueueHandlers, resolveQueuedDeploymentCommand } from './deployment-handlers'

const stores: ControlPlaneStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function setup() {
  const store = new ControlPlaneStore({ path: ':memory:' }); stores.push(store)
  const organization = store.createOrganization({ slug: 'deploy-org', name: 'Deploy Org' })
  const project = store.createProject({ organizationId: organization.id, slug: 'deploy', name: 'Deploy' })
  const environment = store.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' })
  const resource = store.createResource({ projectId: project.id, environmentId: environment.id, kind: 'application', slug: 'web', name: 'Web' })
  return { store, project, environment, resource }
}

describe('deployment queue handlers', () => {
  it('resolves scoped deploy and revision rollback commands without prompts', () => {
    const target = setup()
    const queue = new DurableOperationQueue(target.store)
    const deploy = queue.enqueue({ projectId: target.project.id, environmentId: target.environment.id, resourceId: target.resource.id, kind: 'deployment.create' })
    const rollback = queue.enqueue({ projectId: target.project.id, environmentId: target.environment.id, resourceId: target.resource.id, kind: 'deployment.rollback', input: { revision: 'release-42' } })
    expect(resolveQueuedDeploymentCommand(target.store, deploy.operation).command).toEqual(['deploy', '--env', 'production', '--yes', '--site', 'web'])
    expect(resolveQueuedDeploymentCommand(target.store, rollback.operation).command).toEqual(['deploy:rollback', 'web', '--env', 'production', '--to', 'release-42'])
  })

  it('records checkpoints and classifies transient process failures for queue retry', async () => {
    const target = setup()
    const queue = new DurableOperationQueue(target.store)
    const queued = queue.enqueue({ projectId: target.project.id, environmentId: target.environment.id, resourceId: target.resource.id, kind: 'deployment.create', maxAttempts: 2, retryClasses: ['provider_throttled'] })
    const handlers = createDeploymentQueueHandlers({ store: target.store, execute: async (_command, context: QueueExecutionContext) => { context.log('provider returned 429', { stream: 'stderr' }); return { ok: false, exitCode: 1, stderr: 'provider returned 429: rate limit' } } })
    expect(await queue.runOne(handlers)).toMatchObject({ handled: true, requeued: true, operation: { id: queued.operation.id, state: 'queued' } })
    expect(queue.logs(queued.operation.id).map(entry => entry.step).filter(Boolean)).toEqual(['prepare', 'execute'])
  })

  it('persists the successful command result through the generic worker contract', async () => {
    const target = setup()
    const queue = new DurableOperationQueue(target.store)
    const queued = queue.enqueue({ projectId: target.project.id, environmentId: target.environment.id, resourceId: target.resource.id, kind: 'deploy.source' })
    const handlers = createDeploymentQueueHandlers({ store: target.store, execute: async command => ({ ok: true, exitCode: 0, command: `cloud ${command.command.join(' ')}` }) })
    const result = await queue.runOne(handlers)
    expect(result).toMatchObject({ terminalState: 'succeeded', operation: { id: queued.operation.id, output: { exitCode: 0, environment: 'production', resource: 'web' } } })
    expect(queue.view(queued.operation.id)?.job.currentStep).toBe('finalize')
  })
})
