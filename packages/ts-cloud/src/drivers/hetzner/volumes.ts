import type { MountedComputeVolume, ResolvedComputeVolume } from '../shared/compute-storage'
import type { HetznerClient, HetznerServer, HetznerVolume } from './client'

export interface HetznerVolumePlan {
  declaration: ResolvedComputeVolume
  existing?: HetznerVolume
  actions: Array<'create' | 'attach' | 'grow' | 'protect' | 'mount'>
}

export async function planHetznerVolumes(
  client: Pick<HetznerClient, 'listVolumes'>,
  server: HetznerServer,
  declarations: ResolvedComputeVolume[],
): Promise<HetznerVolumePlan[]> {
  const existing = declarations.length ? await client.listVolumes() : []
  return declarations.map(declaration => {
    const matches = existing.filter(volume => volume.name === declaration.name)
    if (matches.length > 1) throw new Error(`Ambiguous volume name: ${declaration.name}`)
    const volume = matches[0]
    if (volume && volume.server !== null && volume.server !== server.id)
      throw new Error(`Volume ${volume.name} belongs to another server; refusing to detach live storage`)
    const location = server.location?.name ?? server.datacenter?.location.name
    if (volume && volume.location.name !== location)
      throw new Error(`Volume ${volume.name} is in ${volume.location.name}, server is in ${location}`)
    if (volume && volume.size > declaration.size)
      throw new Error(`Refusing to shrink volume ${volume.name}: ${volume.size} GB to ${declaration.size} GB`)
    const actions: HetznerVolumePlan['actions'] = []
    if (!volume) actions.push('create')
    else {
      if (volume.server === null) actions.push('attach')
      if (volume.size < declaration.size) actions.push('grow')
    }
    if (!volume || volume.protection.delete !== (declaration.deleteProtection !== false)) actions.push('protect')
    actions.push('mount')
    return { declaration, existing: volume, actions }
  })
}

export async function applyHetznerVolumes(client: HetznerClient, server: HetznerServer, plans: HetznerVolumePlan[]): Promise<MountedComputeVolume[]> {
  const mounted: MountedComputeVolume[] = []
  for (const plan of plans) {
    let volume = plan.existing
    const created = !volume
    if (!volume) {
      const result = await client.createVolume({ name: plan.declaration.name, size: plan.declaration.size,
        server: server.id, labels: { ...server.labels, 'ts-cloud/volume': plan.declaration.key } })
      await client.waitForAction(result.action.id)
      for (const action of result.next_actions ?? []) await client.waitForAction(action.id)
      volume = await client.getVolume(result.volume.id)
    }
    if (volume.server === null) {
      await client.waitForAction((await client.attachVolume(volume.id, server.id)).id)
      volume = await client.getVolume(volume.id)
    }
    if (volume.server !== server.id || volume.location.name !== (server.location?.name ?? server.datacenter?.location.name))
      throw new Error(`Volume attachment verification failed: ${volume.name}`)
    if (volume.linux_device !== `/dev/disk/by-id/scsi-0HC_Volume_${volume.id}`)
      throw new Error(`Unexpected Hetzner volume device: ${volume.name}`)
    if (volume.size < plan.declaration.size)
      await client.waitForAction((await client.resizeVolume(volume.id, plan.declaration.size)).id)
    if (volume.protection.delete !== (plan.declaration.deleteProtection !== false))
      await client.waitForAction((await client.protectVolume(volume.id, plan.declaration.deleteProtection !== false)).id)
    mounted.push({ ...plan.declaration, id: volume.id, device: volume.linux_device, allowFormat: created })
  }
  return mounted
}
