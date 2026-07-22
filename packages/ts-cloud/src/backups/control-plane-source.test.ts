import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { ControlPlaneStore } from '../control-plane'
import { ControlPlaneBackupSource } from './control-plane-source'

const roots: string[] = [], controls: ControlPlaneStore[] = []
afterEach(async () => {
  for (const control of controls.splice(0)) control.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('control-plane backup source', () => {
  it('serializes a consistent database and config into an isolated verified target', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'ts-cloud-control-backup-'))
    roots.push(root)
    await Bun.write(resolve(root, 'cloud.config.ts'), 'export default { project: { name: "Acme" } }')
    const control = new ControlPlaneStore({ path: ':memory:' })
    controls.push(control)
    control.createOrganization({ slug: 'acme', name: 'Acme' })
    const source = new ControlPlaneBackupSource(control, root), created = await source.create({ projectId: 'project', includePatterns: [], compression: 'gzip' } as any, { operation: { id: 'control-operation' } } as any)
    expect(created).toMatchObject({ mode: 'object', key: 'project/control-plane/controloperation.json.gz', manifest: { sensitive: true, configFiles: ['cloud.config.ts'], compression: 'gzip' } })
    if (created.mode !== 'object') throw new Error('Expected an object backup.')
    const restored = await source.restore({ manifest: created.manifest } as any, created.body, { targetId: 'drill-one', restoreMode: 'isolated' }, {} as any)
    expect(await source.verify({ manifest: created.manifest } as any, created.body, {} as any)).toMatchObject({ integrity: 'ok', configFiles: 1 })
    expect(await readFile(resolve(String(restored.path), 'cloud.config.ts'), 'utf8')).toContain('Acme')
    expect(await source.validateHealth(restored, {} as any)).toMatchObject({ healthy: true, integrity: 'ok' })
    await source.cleanup({ targetId: 'drill-one' }, {} as any)
  })

  it('refuses to replace the running control-plane database in place', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'ts-cloud-control-backup-'))
    roots.push(root)
    const control = new ControlPlaneStore({ path: ':memory:' })
    controls.push(control)
    const source = new ControlPlaneBackupSource(control, root), created = await source.create({ projectId: 'project', includePatterns: [] } as any, {} as any)
    if (created.mode !== 'object') throw new Error('Expected an object backup.')
    await expect(source.restore({} as any, created.body, { targetId: 'live-one', restoreMode: 'in_place' }, {} as any)).rejects.toThrow('live control plane')
  })
})
