import { afterEach, describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { ComposeApplicationStore } from '../compose'
import { completeComposeVolumeDeletion } from './compose'
import { VolumeStore } from './store'
const controls: ControlPlaneStore[] = []
afterEach(() => {
  while (controls.length) controls.pop()!.close()
})
describe('Compose persistent volume reconciliation', () => {
  it('creates stable inventory and preserves data unless explicit removal succeeds', () => {
    const control = new ControlPlaneStore({ path: ':memory:' })
    controls.push(control)
    const org = control.createOrganization({ slug: 'acme', name: 'Acme' }),
      project = control.createProject({ organizationId: org.id, slug: 'web', name: 'Web' }),
      environment = control.createEnvironment({
        projectId: project.id,
        slug: 'production',
        name: 'Production',
        kind: 'production',
      }),
      compose = new ComposeApplicationStore(control),
      source = `services:\n  api:\n    image: example/api:1.0.0\n    volumes:\n      - uploads:/app/uploads\nvolumes:\n  uploads: {}\n`,
      application = compose.import(source, {
        name: 'Web',
        slug: 'web',
        projectId: project.id,
        environmentId: environment.id,
      }).application,
      volumes = new VolumeStore(control),
      volume = volumes.list({ projectId: project.id })[0]!
    expect(volume).toMatchObject({ name: 'web-uploads', providerId: 'web-uploads', status: 'available' })
    expect(volumes.attachments(volume.id)[0]).toMatchObject({
      resourceId: application.resourceId,
      targetPath: '/app/uploads',
      desiredState: 'attached',
    })
    completeComposeVolumeDeletion(control, application, false)
    expect(volumes.get(volume.id)).toMatchObject({ status: 'available', deletedAt: undefined })
    completeComposeVolumeDeletion(control, application, true)
    expect(volumes.get(volume.id)).toMatchObject({ status: 'deleted' })
    expect(() =>
      compose.import(source, { name: 'Web', slug: 'web', projectId: project.id, environmentId: environment.id }),
    ).toThrow('permanently deleted')
  })
})
