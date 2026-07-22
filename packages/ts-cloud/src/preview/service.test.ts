import { afterEach, describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { PreviewEnvironmentService } from './service'

const stores: ControlPlaneStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function setup(now: Date) {
  const store = new ControlPlaneStore({ path: ':memory:', now: () => now })
  stores.push(store)
  const organization = store.createOrganization({ slug: 'cleanup-org', name: 'Cleanup Org' })
  const project = store.createProject({ organizationId: organization.id, slug: 'cleanup', name: 'Cleanup' })
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
  })
  const service = new PreviewEnvironmentService(store)
  const policy = service.previews.createDefinition({
    projectId: project.id,
    resourceId: resource.id,
    baseEnvironmentId: environment.id,
    domainPattern: 'https://{name}.example.com',
    ttlHours: 1,
    keepCount: 1,
  })
  return { store, project, environment, resource, service, policy }
}

describe('preview cleanup and provider reconciliation', () => {
  it('plans TTL and keep-count cleanup without mutation, then queues idempotent teardown', () => {
    const now = new Date('2026-07-01T00:00:00.000Z')
    const target = setup(now)
    const first = target.service.previews.upsert({
      definitionId: target.policy.id,
      branch: 'one',
      commitSha: 'a'.repeat(40),
      now,
    }).preview
    const second = target.service.previews.upsert({
      definitionId: target.policy.id,
      branch: 'two',
      commitSha: 'b'.repeat(40),
      now: new Date(now.getTime() + 1000),
    }).preview
    const dryRun = target.service.cleanup({ now: new Date(now.getTime() + 2 * 3600000), dryRun: true })
    expect(dryRun.operations).toEqual([])
    expect(dryRun.candidates.map((item) => item.preview.id).sort()).toEqual([first.id, second.id].sort())
    expect(target.store.listOperations()).toEqual([])
    const queued = target.service.cleanup({ now: new Date(now.getTime() + 2 * 3600000) })
    expect(queued.operations.map((operation) => operation.kind)).toEqual(['preview.destroy', 'preview.destroy'])
    expect(
      target.service
        .cleanup({ now: new Date(now.getTime() + 2 * 3600000) })
        .operations.map((operation) => operation.id),
    ).toEqual(queued.operations.map((operation) => operation.id))
  })

  it('matches only exactly tagged resources and reports unknown leaks without deleting them', () => {
    const now = new Date('2026-07-01T00:00:00.000Z')
    const target = setup(now)
    const preview = target.service.previews.upsert({
      definitionId: target.policy.id,
      branch: 'tags',
      commitSha: 'c'.repeat(40),
      now,
    }).preview
    const tags = {
      'ts-cloud:preview': preview.id,
      'ts-cloud:project': preview.projectId,
      'ts-cloud:expires-at': preview.expiresAt,
    }
    const result = target.service.reconcile([
      { provider: 'aws', providerResourceId: 'known-stack', kind: 'stack', tags, estimatedMonthlyCost: 4.25 },
      {
        provider: 'aws',
        providerResourceId: 'orphan-stack',
        kind: 'stack',
        tags: { ...tags, 'ts-cloud:preview': 'missing' },
      },
      { provider: 'aws', providerResourceId: 'shared-stack', kind: 'stack', tags: {} },
    ])
    expect(result).toEqual({
      matched: ['known-stack'],
      unknownPreviewResources: ['orphan-stack'],
      ignoredUntagged: ['shared-stack'],
    })
    expect(target.service.previews.getInstance(preview.id)?.costEstimate).toBe(4.25)
    expect(target.service.previews.listResources(preview.id).map((item) => item.providerResourceId)).toEqual([
      'known-stack',
    ])
  })
})
