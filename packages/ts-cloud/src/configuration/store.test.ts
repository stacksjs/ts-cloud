import { afterEach, describe, expect, test } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { ConfigurationStore } from './store'

const stores: ControlPlaneStore[] = []

function setup() {
  const controlPlane = new ControlPlaneStore({ path: ':memory:', now: () => new Date('2026-07-21T12:00:00.000Z') })
  stores.push(controlPlane)
  const organization = controlPlane.createOrganization({ slug: 'acme', name: 'Acme' })
  const project = controlPlane.createProject({ organizationId: organization.id, slug: 'app', name: 'App' })
  const environment = controlPlane.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' })
  const resource = controlPlane.createResource({ projectId: project.id, environmentId: environment.id, kind: 'application', slug: 'web', name: 'Web' })
  return { controlPlane, organization, project, environment, resource, configuration: new ConfigurationStore(controlPlane) }
}

afterEach(() => { while (stores.length) stores.pop()!.close() })

describe('ConfigurationStore', () => {
  test('persists scoped variables without exposing a secret field', () => {
    const { organization, project, configuration } = setup()
    const value = configuration.create({
      organizationId: organization.id,
      projectId: project.id,
      scope: { type: 'project', id: project.id },
      key: 'PUBLIC_URL',
      kind: 'variable',
      value: 'https://example.test',
      valueFingerprint: 'sha256:value',
      backend: 'plaintext',
      origin: 'managed',
      required: false,
      metadata: {},
    })

    expect(configuration.find(project.id, value.scope, value.key)).toEqual(value)
    expect(value.secretRef).toBeUndefined()
  })

  test('stores secret references and enforces optimistic writes', () => {
    const { organization, project, environment, resource, configuration } = setup()
    const secret = configuration.create({
      organizationId: organization.id,
      projectId: project.id,
      scope: { type: 'service', id: resource.id, environmentId: environment.id, resourceId: resource.id },
      key: 'DATABASE_PASSWORD',
      kind: 'secret',
      valueFingerprint: 'hmac:value',
      secretRef: 'secret://configuration/entry/1',
      backend: 'local_encrypted',
      backendVersion: '1',
      origin: 'managed',
      required: true,
      metadata: {},
    })
    const updated = configuration.update(secret.id, 1, { ...secret, backendVersion: '2', rotatedAt: '2026-07-21T12:00:00.000Z' })

    expect(updated.version).toBe(2)
    expect(() => configuration.update(secret.id, 1, updated)).toThrow('refresh and retry')
  })

  test('tracks dependency redeploy state and cascades it with entries', () => {
    const { controlPlane, organization, project, resource, configuration } = setup()
    const value = configuration.create({ organizationId: organization.id, projectId: project.id, scope: { type: 'project', id: project.id }, key: 'NODE_ENV', kind: 'variable', value: 'production', valueFingerprint: 'sha256:value', backend: 'plaintext', origin: 'managed', required: true, metadata: {} })
    configuration.setDependency({ entryId: value.id, resourceId: resource.id, injectionTarget: 'environment', required: true, requiresRedeploy: true })

    expect(configuration.dependenciesForResource(resource.id)[0]?.entryId).toBe(value.id)
    configuration.remove(value.id, value.version)
    expect(configuration.dependenciesForResource(resource.id)).toEqual([])
    expect(controlPlane.database.query<{ count: number }, []>('SELECT count(*) AS count FROM configuration_entries').get()?.count).toBe(0)
  })

  test('rejects invalid keys, plaintext secrets, and cross-project scopes', () => {
    const first = setup(), second = setup()
    const base = { organizationId: first.organization.id, projectId: first.project.id, valueFingerprint: 'sha256:value', backend: 'plaintext' as const, origin: 'managed' as const, required: false, metadata: {} }

    expect(() => first.configuration.create({ ...base, scope: { type: 'project', id: first.project.id }, key: 'BAD-KEY', kind: 'variable', value: 'x' })).toThrow('Invalid configuration key')
    expect(() => first.configuration.create({ ...base, scope: { type: 'project', id: first.project.id }, key: 'TOKEN', kind: 'secret', value: 'plaintext' })).toThrow('Secrets require')
    expect(() => first.configuration.create({ ...base, scope: { type: 'service', id: second.resource.id }, key: 'VALUE', kind: 'variable', value: 'x' })).toThrow('does not belong')
  })
})
