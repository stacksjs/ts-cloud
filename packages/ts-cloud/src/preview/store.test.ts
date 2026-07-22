import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlPlaneStore } from '../control-plane'
import { PreviewEnvironmentStore } from './store'

const roots: string[] = []
const stores: ControlPlaneStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function setup(path = ':memory:', now = new Date('2026-07-01T00:00:00.000Z')) {
  const controlPlane = new ControlPlaneStore({ path, now: () => now }); stores.push(controlPlane)
  const organization = controlPlane.createOrganization({ slug: 'preview-org', name: 'Preview Org' })
  const project = controlPlane.createProject({ organizationId: organization.id, slug: 'preview-app', name: 'Preview App' })
  const environment = controlPlane.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' })
  const resource = controlPlane.createResource({ projectId: project.id, environmentId: environment.id, kind: 'application', slug: 'web', name: 'Web' })
  return { controlPlane, project, environment, resource, previews: new PreviewEnvironmentStore(controlPlane, { now: () => now }) }
}

describe('preview environment persistence and policy', () => {
  it('persists definitions and deterministic preview identity across restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'ts-cloud-preview-')); roots.push(root); const path = join(root, 'control-plane.sqlite')
    const target = setup(path)
    const policy = target.previews.createDefinition({ projectId: target.project.id, resourceId: target.resource.id, baseEnvironmentId: target.environment.id, domainPattern: 'https://{name}.preview.example.com', inheritedSecrets: ['PREVIEW_API_KEY'] })
    const created = target.previews.upsert({ definitionId: policy.id, sourceProvider: 'github', repository: 'acme/web', branch: 'feature/search', pullRequestNumber: 42, commitSha: 'a'.repeat(40) })
    target.controlPlane.close(); stores.splice(stores.indexOf(target.controlPlane), 1)

    const restarted = new ControlPlaneStore({ path }); stores.push(restarted); const previews = new PreviewEnvironmentStore(restarted)
    expect(previews.getInstance(created.preview.id)).toMatchObject({ name: expect.stringMatching(/^pr-42-[a-f0-9]{8}$/), url: expect.stringMatching(/^https:\/\/pr-42-/), commitSha: 'a'.repeat(40), status: 'queued' })
    const update = previews.upsert({ definitionId: policy.id, sourceProvider: 'github', repository: 'acme/web', branch: 'feature/search', pullRequestNumber: 42, commitSha: 'b'.repeat(40) })
    expect(update).toMatchObject({ created: false, changed: true, preview: { id: created.preview.id, commitSha: 'b'.repeat(40) } })
  })

  it('reconfigures an existing resource policy and extends from the injected clock', () => {
    const target = setup(':memory:', new Date('2026-07-21T12:00:00.000Z'))
    const original = target.previews.createDefinition({ projectId: target.project.id, resourceId: target.resource.id, baseEnvironmentId: target.environment.id, domainPattern: 'https://{name}.preview.example.com', ttlHours: 1 })
    const updated = target.previews.createDefinition({ projectId: target.project.id, resourceId: target.resource.id, baseEnvironmentId: target.environment.id, domainPattern: 'https://{name}.staging.example.com', ttlHours: 12, allowForks: true })
    expect(updated).toMatchObject({ id: original.id, version: 2, ttlHours: 12, allowForks: true })
    expect(target.previews.listDefinitions(target.project.id)).toHaveLength(1)
    const preview = target.previews.upsert({ definitionId: updated.id, repository: 'acme/web', branch: 'feature/policy', commitSha: 'a'.repeat(40) }).preview
    expect(target.previews.extend(preview.id, 3).expiresAt).toBe('2026-07-22T03:00:00.000Z')
  })

  it('uses collision-safe branch names and never inherits secrets into fork previews', () => {
    const target = setup()
    const policy = target.previews.createDefinition({ projectId: target.project.id, resourceId: target.resource.id, baseEnvironmentId: target.environment.id, domainPattern: 'https://{name}.example.com', allowForks: true, inheritedSecrets: ['PREVIEW_TOKEN'] })
    const first = target.previews.upsert({ definitionId: policy.id, branch: 'feature/a/b', commitSha: 'a'.repeat(40) })
    const second = target.previews.upsert({ definitionId: policy.id, branch: 'feature-a-b', commitSha: 'b'.repeat(40) })
    const fork = target.previews.upsert({ definitionId: policy.id, repository: 'fork/web', branch: 'patch', pullRequestNumber: 9, fork: true, commitSha: 'c'.repeat(40) })
    expect(first.preview.name).not.toBe(second.preview.name)
    expect(fork.inheritedSecrets).toEqual([])
    expect((fork.preview.desiredState as any).inheritedSecretNames).toEqual([])
  })

  it('enforces domain, authentication, immutable SHA, scope, and tagged resource safety', () => {
    const target = setup()
    expect(() => target.previews.createDefinition({ projectId: target.project.id, resourceId: target.resource.id, baseEnvironmentId: target.environment.id, domainPattern: 'http://{name}.test', publicAccess: true, authenticationRequired: false })).toThrow()
    const policy = target.previews.createDefinition({ projectId: target.project.id, resourceId: target.resource.id, baseEnvironmentId: target.environment.id, domainPattern: 'https://{name}.example.com' })
    expect(() => target.previews.upsert({ definitionId: policy.id, branch: 'main', commitSha: 'moving-ref' })).toThrow('immutable')
    const preview = target.previews.upsert({ definitionId: policy.id, branch: 'main', commitSha: 'd'.repeat(40) }).preview
    expect(() => target.previews.recordResource({ previewId: preview.id, provider: 'aws', providerResourceId: 'stack-1', kind: 'stack', tags: {} })).toThrow('immutable tag')
    expect(target.previews.recordResource({ previewId: preview.id, provider: 'aws', providerResourceId: 'stack-1', kind: 'stack', tags: { 'ts-cloud:preview': preview.id, 'ts-cloud:project': preview.projectId, 'ts-cloud:expires-at': preview.expiresAt } })).toMatchObject({ providerResourceId: 'stack-1' })
  })

  it('finds expired previews and keeps failed cleanup visible with reconciliation data', () => {
    const target = setup()
    const policy = target.previews.createDefinition({ projectId: target.project.id, resourceId: target.resource.id, baseEnvironmentId: target.environment.id, domainPattern: 'https://{name}.example.com', ttlHours: 1 })
    const preview = target.previews.upsert({ definitionId: policy.id, branch: 'old', commitSha: 'e'.repeat(40) }).preview
    expect(target.previews.expired(new Date('2026-07-01T02:00:00.000Z')).map(item => item.id)).toEqual([preview.id])
    const failed = target.previews.transition(preview.id, 'cleanup_failed', { teardownError: 'stack delete failed', observedState: { leakedResourceIds: ['stack-1'] } })
    expect(failed).toMatchObject({ status: 'cleanup_failed', teardownError: 'stack delete failed', observedState: { leakedResourceIds: ['stack-1'] } })
  })
})
