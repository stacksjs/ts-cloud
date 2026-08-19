import { afterEach, describe, expect, test } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { ConfigurationService } from './service'
import { ConfigurationStore } from './store'
import { synchronizeConfiguredConfiguration } from './migrate'

const stores: ControlPlaneStore[] = []
function setup() {
  const store = new ControlPlaneStore({ path: ':memory:' })
  stores.push(store)
  const organization = store.createOrganization({ slug: 'acme', name: 'Acme' }),
    project = store.createProject({ organizationId: organization.id, slug: 'app', name: 'App' }),
    environment = store.createEnvironment({
      projectId: project.id,
      slug: 'production',
      name: 'Production',
      kind: 'production',
    }),
    resource = store.createResource({
      projectId: project.id,
      environmentId: environment.id,
      kind: 'application',
      slug: 'web',
      name: 'Web',
    }),
    fn = store.createResource({
      projectId: project.id,
      environmentId: environment.id,
      kind: 'function',
      slug: 'worker',
      name: 'Worker',
    })
  const controlPlane = {
      store,
      organization,
      project,
      environments: new Map([['production', environment]]),
      reconciliation: { requeued: 0, failed: 0 },
    },
    service = new ConfigurationService(new ConfigurationStore(store), { encryptionKey: 'migration-fixture' })
  return { store, organization, project, environment, resource, fn, controlPlane, service }
}
afterEach(() => {
  while (stores.length) stores.pop()!.close()
})

describe('configured configuration migration', () => {
  test('reconciles environment and service variables and removes deleted config keys', async () => {
    const { project, environment, resource, fn, controlPlane, service } = setup()
    const first = await synchronizeConfiguredConfiguration(service, controlPlane, {
      project: { name: 'App', slug: 'app' },
      environments: { production: { type: 'production', variables: { SHARED: 'one', REMOVED: 'old' } } },
      sites: { web: { env: { SERVICE_ONLY: 'yes' } } },
      infrastructure: { functions: { worker: { environment: { FUNCTION_ONLY: 'yes' } } } },
    } as any)
    const second = await synchronizeConfiguredConfiguration(service, controlPlane, {
      project: { name: 'App', slug: 'app' },
      environments: { production: { type: 'production', variables: { SHARED: 'two' } } },
      sites: { web: { env: { SERVICE_ONLY: 'yes' } } },
      infrastructure: { functions: { worker: { environment: { FUNCTION_ONLY: 'yes' } } } },
    } as any)
    expect(first).toEqual({ added: 4, changed: 0, removed: 0, overridden: 0 })
    expect(second).toEqual({ added: 0, changed: 1, removed: 1, overridden: 0 })
    expect(
      (await service.resolve({ projectId: project.id, environmentId: environment.id, resourceId: resource.id })).values,
    ).toEqual({ SHARED: 'two', SERVICE_ONLY: 'yes' })
    expect(
      (await service.resolve({ projectId: project.id, environmentId: environment.id, functionId: fn.id })).values,
    ).toEqual({ SHARED: 'two', FUNCTION_ONLY: 'yes' })
  })

  test('preserves a managed override over config-defined values', async () => {
    const { organization, project, environment, controlPlane, service } = setup(),
      scope = { type: 'environment' as const, id: environment.id, environmentId: environment.id }
    await service.set({
      organizationId: organization.id,
      projectId: project.id,
      scope,
      key: 'SHARED',
      kind: 'variable',
      value: 'managed',
    })
    const result = await synchronizeConfiguredConfiguration(service, controlPlane, {
      project: { name: 'App', slug: 'app' },
      environments: { production: { type: 'production', variables: { SHARED: 'config' } } },
    } as any)
    expect(result.overridden).toBe(1)
    expect(service.store.find(project.id, scope, 'SHARED')?.value).toBe('managed')
  })
})
