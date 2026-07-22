import { afterEach, describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { ComposeApplicationService } from './service'
import { ComposeApplicationStore } from './store'

const stores: ControlPlaneStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function setup() {
  const controlPlane = new ControlPlaneStore({ path: ':memory:', now: () => new Date('2026-07-21T12:00:00.000Z') })
  stores.push(controlPlane)
  const organization = controlPlane.createOrganization({ slug: 'compose-org', name: 'Compose Org' })
  const project = controlPlane.createProject({ organizationId: organization.id, slug: 'commerce', name: 'Commerce' })
  const environment = controlPlane.createEnvironment({
    projectId: project.id,
    slug: 'production',
    name: 'Production',
    kind: 'production',
  })
  return { controlPlane, project, environment, applications: new ComposeApplicationStore(controlPlane) }
}
const source = `services:\n  web:\n    image: acme/web:1.0.0\n    environment:\n      API_TOKEN: \${API_TOKEN}\n    ports: [3000]\n  worker:\n    image: acme/worker:1.0.0\n    depends_on: [web]\nvolumes: {}\n`

describe('persistent Compose applications', () => {
  it('imports, reconfigures, and stores only redacted source plus service state', () => {
    const target = setup()
    const created = target.applications.import(source, {
      name: 'Commerce Stack',
      projectId: target.project.id,
      environmentId: target.environment.id,
    }).application
    expect(created).toMatchObject({
      status: 'ready',
      sourceKind: 'compose',
      resourceId: expect.any(String),
      manifest: { spec: { services: { web: { environment: { API_TOKEN: { secretRef: 'API_TOKEN' } } } } } },
    })
    expect(created.redactedSource).not.toContain('literal-token')
    expect(target.applications.services(created.id).map((item) => item.serviceName)).toEqual(['web', 'worker'])
    const updated = target.applications.import(source.replace('acme/web:1.0.0', 'acme/web:1.1.0'), {
      name: 'Commerce Stack',
      projectId: target.project.id,
      environmentId: target.environment.id,
    }).application
    expect(updated).toMatchObject({
      id: created.id,
      version: 2,
      manifest: { spec: { services: { web: { image: 'acme/web:1.1.0' } } } },
    })
  })

  it('materializes templates as ordinary manifests and queues scoped lifecycle work', () => {
    const target = setup()
    const created = target.applications.fromTemplate(
      'wordpress',
      { domain: 'cms.example.com' },
      { name: 'CMS', projectId: target.project.id, environmentId: target.environment.id },
    ).application
    expect(created).toMatchObject({ sourceKind: 'template', templateId: 'wordpress', templateVersion: '1.0.0' })
    const service = new ComposeApplicationService(target.controlPlane)
    expect(service.enqueue(created, 'deploy')).toMatchObject({ kind: 'compose.deploy', resourceId: created.resourceId })
    expect(() => service.enqueue(created, 'delete', { confirmation: created.slug, removeVolumes: true })).toThrow(
      'delete volumes',
    )
    expect(
      service.enqueue(created, 'delete', { confirmation: `${created.slug} delete volumes`, removeVolumes: true }),
    ).toMatchObject({ kind: 'compose.delete', input: { removeVolumes: true } })
  })

  it('requires valid manifests before creating provider-visible resources', () => {
    const target = setup()
    expect(() =>
      target.applications.import(`services:\n  bad:\n    image: bad:latest\n    privileged: true\n`, {
        name: 'Bad',
        projectId: target.project.id,
        environmentId: target.environment.id,
      }),
    ).toThrow('blocking diagnostic')
    expect(target.controlPlane.listResources(target.project.id)).toHaveLength(0)
  })
})
