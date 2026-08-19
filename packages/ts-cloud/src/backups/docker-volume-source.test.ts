import { describe, expect, it } from 'bun:test'
import type { BackupPolicy, RecoveryPoint } from './model'
import type { DockerVolumeRuntime } from './docker-volume-source'
import { DockerVolumeBackupSource } from './docker-volume-source'

class Runtime implements DockerVolumeRuntime {
  volumes = new Map<string, Uint8Array>([['orders-data', new Uint8Array([1, 2, 3])]])
  imports: Array<{ name: string; replace: boolean }> = []
  async exists(name: string) {
    return this.volumes.has(name)
  }
  async export(name: string) {
    return Bun.gzipSync(Uint8Array.from(this.volumes.get(name)!))
  }
  async import(name: string, archive: Uint8Array, replace = false) {
    this.imports.push({ name, replace })
    this.volumes.set(name, Bun.gunzipSync(Uint8Array.from(archive)))
  }
  async remove(name: string) {
    this.volumes.delete(name)
  }
  async probe(name: string) {
    return { entries: 2, bytes: this.volumes.get(name)?.byteLength ?? 0 }
  }
}

const policy = {
  projectId: 'project-1',
  resourceId: 'orders-data',
} as BackupPolicy

describe('Docker volume backup source', () => {
  it('archives, restores, probes, and cleans an isolated volume', async () => {
    const runtime = new Runtime(),
      source = new DockerVolumeBackupSource(runtime),
      backup = await source.create(policy, {} as any)
    expect(backup).toMatchObject({
      mode: 'object',
      contentType: 'application/gzip',
      manifest: { sourceVolume: 'orders-data' },
    })
    const restored = await source.restore(
      {
        resourceId: 'orders-data',
        manifest: { sourceVolume: 'orders-data' },
      } as unknown as RecoveryPoint,
      backup.mode === 'object' ? backup.body : undefined,
      { volumeName: 'orders-drill' },
      {} as any,
    )
    expect(restored).toEqual({
      volumeName: 'orders-drill',
      healthy: true,
      entries: 2,
      bytes: 3,
    })
    await source.cleanup({ volumeName: 'orders-drill' }, {} as any)
    expect(runtime.volumes.has('orders-drill')).toBe(false)
  })

  it('only replaces an existing volume through an explicit in-place target', async () => {
    const runtime = new Runtime(),
      source = new DockerVolumeBackupSource(runtime),
      point = {
        resourceId: 'orders-data',
        manifest: { sourceVolume: 'orders-data' },
      } as unknown as RecoveryPoint
    await expect(
      source.restore(point, Bun.gzipSync(new Uint8Array([4])), { volumeName: 'orders-data' }, {} as any),
    ).rejects.toThrow('distinct target')
    await source.restore(
      point,
      Bun.gzipSync(new Uint8Array([4])),
      { volumeName: 'orders-data', inPlace: true },
      {} as any,
    )
    expect(runtime.imports).toEqual([{ name: 'orders-data', replace: true }])
  })
})
