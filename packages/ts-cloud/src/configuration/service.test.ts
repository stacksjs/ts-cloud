import { afterEach, describe, expect, test } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { PreviewEnvironmentStore } from '../preview'
import { LocalEncryptedConfigurationBackend } from './backends'
import { ConfigurationService } from './service'
import { ConfigurationStore } from './store'

const stores: ControlPlaneStore[] = []
function setup() {
  const control = new ControlPlaneStore({ path: ':memory:', now: () => new Date('2026-07-21T12:00:00.000Z') }); stores.push(control)
  const organization = control.createOrganization({ slug: 'acme', name: 'Acme' }), project = control.createProject({ organizationId: organization.id, slug: 'app', name: 'App' }), environment = control.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' }), resource = control.createResource({ projectId: project.id, environmentId: environment.id, kind: 'application', slug: 'web', name: 'Web' })
  const store = new ConfigurationStore(control), service = new ConfigurationService(store, { encryptionKey: 'fixture-encryption', fingerprintKey: 'fixture-fingerprint', now: () => new Date('2026-07-21T12:00:00.000Z') })
  return { control, organization, project, environment, resource, store, service }
}
afterEach(() => { while (stores.length) stores.pop()!.close() })

describe('configuration secret backends', () => {
  test('keeps local values out of the database and authenticates ciphertext', async () => {
    const { control } = setup(), backend = new LocalEncryptedConfigurationBackend(control, 'encryption-key'), result = await backend.put({ name: 'project/token', value: 'never-store-plaintext', idempotencyKey: 'one' })
    expect(await backend.resolve(result.reference)).toBe('never-store-plaintext')
    expect(Buffer.from(control.database.serialize()).toString()).not.toContain('never-store-plaintext')
    await expect(new LocalEncryptedConfigurationBackend(control, 'wrong-key').resolve(result.reference)).rejects.toThrow('could not be decrypted')
  })
})

describe('ConfigurationService', () => {
  test('resolves deterministic precedence and exposes masked metadata', async () => {
    const { organization, project, environment, resource, service } = setup()
    await service.set({ organizationId: organization.id, projectId: project.id, scope: { type: 'project', id: project.id }, key: 'ORIGIN', kind: 'variable', value: 'project' })
    await service.set({ organizationId: organization.id, projectId: project.id, scope: { type: 'environment', id: environment.id, environmentId: environment.id }, key: 'ORIGIN', kind: 'variable', value: 'environment' })
    await service.set({ organizationId: organization.id, projectId: project.id, scope: { type: 'service', id: resource.id, environmentId: environment.id, resourceId: resource.id }, key: 'ORIGIN', kind: 'variable', value: 'service' })
    await service.set({ organizationId: organization.id, projectId: project.id, scope: { type: 'project', id: project.id }, key: 'TOKEN', kind: 'secret', value: 'super-secret' })

    const resolved = await service.resolve({ projectId: project.id, environmentId: environment.id, resourceId: resource.id })
    expect(resolved.values).toEqual({ ORIGIN: 'service', TOKEN: 'super-secret' })
    expect(resolved.entries.ORIGIN?.overridden).toBe(true)
    expect(service.list({ projectId: project.id }).find(entry => entry.key === 'TOKEN')).toMatchObject({ key: 'TOKEN', kind: 'secret', backend: undefined, reference: undefined, value: undefined })
  })

  test('previews key-only drift and imports valid dotenv atom names', async () => {
    const { organization, project, resource, service } = setup()
    const scope = { type: 'project' as const, id: project.id }
    const imported = await service.importDotenv({ organizationId: organization.id, projectId: project.id, scope, source: 'PUBLIC_URL=https://example.test\nTOKEN=hidden', secretKeys: ['TOKEN'], idempotencyKey: 'dotenv-1' })
    const plan = service.plan({ projectId: project.id, scope, values: { PUBLIC_URL: 'https://new.test', TOKEN: 'hidden', NEW_KEY: 'value' } })
    expect(imported.mutation).toMatchObject({ added: ['PUBLIC_URL', 'TOKEN'], affectedResourceIds: [resource.id] })
    expect(plan).toMatchObject({ added: ['NEW_KEY'], changed: ['PUBLIC_URL'], unchanged: ['TOKEN'] })
    expect(JSON.stringify(plan)).not.toContain('hidden')
    expect(service.exportVariables({ projectId: project.id, scope })).toBe('PUBLIC_URL="https://example.test"\n')
  })

  test('makes writes idempotent and tracks rotations and dependent redeploys', async () => {
    const { organization, project, resource, store, service } = setup(), scope = { type: 'project' as const, id: project.id }
    const first = await service.set({ organizationId: organization.id, projectId: project.id, scope, key: 'TOKEN', kind: 'secret', value: 'first', idempotencyKey: 'rotate-1' })
    store.setDependency({ entryId: first.entry.id, resourceId: resource.id, injectionTarget: 'environment', required: true, requiresRedeploy: true })
    const duplicate = await service.set({ organizationId: organization.id, projectId: project.id, scope, key: 'TOKEN', kind: 'secret', value: 'first', idempotencyKey: 'rotate-1' })
    const rotated = await service.set({ organizationId: organization.id, projectId: project.id, scope, key: 'TOKEN', kind: 'secret', value: 'second', expectedVersion: first.entry.version, idempotencyKey: 'rotate-2' })
    expect(duplicate.entry.version).toBe(first.entry.version)
    expect(rotated.entry).toMatchObject({ version: 2, backendVersion: '2' })
    expect(rotated.mutation.affectedResourceIds).toEqual([resource.id])
    await expect(service.set({ organizationId: organization.id, projectId: project.id, scope, key: 'TOKEN', kind: 'secret', value: 'different', idempotencyKey: 'rotate-1' })).rejects.toThrow('different configuration mutation')
  })

  test('does not inherit production secrets into previews unless explicitly trusted and allowed', async () => {
    const { control, organization, project, environment, resource, service } = setup(), previews = new PreviewEnvironmentStore(control, { id: (() => { let id = 0; return () => `preview-${++id}` })() })
    const definition = previews.createDefinition({ projectId: project.id, resourceId: resource.id, baseEnvironmentId: environment.id, domainPattern: 'https://{name}.example.test', inheritedSecrets: ['TOKEN'] })
    const preview = previews.upsert({ definitionId: definition.id, branch: 'feature', commitSha: 'a'.repeat(40), repository: 'acme/app' }).preview
    await service.set({ organizationId: organization.id, projectId: project.id, scope: { type: 'environment', id: environment.id, environmentId: environment.id }, key: 'TOKEN', kind: 'secret', value: 'production-secret' })
    await service.set({ organizationId: organization.id, projectId: project.id, scope: { type: 'environment', id: environment.id, environmentId: environment.id }, key: 'PUBLIC_URL', kind: 'variable', value: 'https://example.test' })
    const isolated = await service.resolve({ projectId: project.id, environmentId: environment.id, resourceId: resource.id, previewId: preview.id })
    const trusted = await service.resolve({ projectId: project.id, environmentId: environment.id, resourceId: resource.id, previewId: preview.id, trustedPreview: true, allowedPreviewSecrets: ['TOKEN'] })
    expect(isolated.values).toEqual({ PUBLIC_URL: 'https://example.test' })
    expect(trusted.values.TOKEN).toBe('production-secret')
  })

  test('requires recent authentication to reveal and confirmation to delete production values', async () => {
    const { organization, project, service } = setup(), created = await service.set({ organizationId: organization.id, projectId: project.id, scope: { type: 'project', id: project.id }, key: 'TOKEN', kind: 'secret', value: 'secret' })
    await expect(service.reveal({ entryId: created.entry.id, canRevealSecrets: true, recentlyAuthenticated: false })).rejects.toThrow('Recent authentication')
    expect(await service.reveal({ entryId: created.entry.id, canRevealSecrets: true, recentlyAuthenticated: true })).toBe('secret')
    await expect(service.remove({ entryId: created.entry.id, expectedVersion: created.entry.version })).rejects.toThrow('Confirmation')
    expect(await service.remove({ entryId: created.entry.id, expectedVersion: created.entry.version, confirmed: true })).toMatchObject({ removed: ['TOKEN'] })
  })
})
