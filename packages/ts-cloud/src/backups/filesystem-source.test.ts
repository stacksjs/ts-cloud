import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { FilesystemBackupSource } from './filesystem-source'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'ts-cloud-files-backup-'))
  roots.push(root)
  await Bun.write(resolve(root, 'shared', 'avatar.txt'), 'original avatar')
  await Bun.write(resolve(root, 'shared', 'ignored.tmp'), 'temporary')
  const policy = {
    projectId: 'project',
    includePatterns: ['shared'],
    excludePatterns: ['*.tmp'],
    compression: 'zstd',
  } as any
  return { root, policy, source: new FilesystemBackupSource(root) }
}

describe('filesystem backup source', () => {
  it('archives scoped files, restores an isolated target, validates it, and cleans it', async () => {
    const target = await fixture(),
      created = await target.source.create(target.policy, { operation: { id: 'operation-1' } } as any)
    expect(created).toMatchObject({
      mode: 'object',
      key: 'project/files/operation1.tar.zst',
      manifest: { sourcePaths: ['shared'], entries: 2, compression: 'zstd' },
    })
    if (created.mode !== 'object') throw new Error('Expected an object backup.')
    const restored = await target.source.restore(
      { manifest: created.manifest } as any,
      created.body,
      { targetId: 'recovery-one', restoreMode: 'isolated' },
      {} as any,
    )
    expect(await readFile(resolve(String(restored.path), 'shared', 'avatar.txt'), 'utf8')).toBe('original avatar')
    expect(await target.source.validateHealth(restored, {} as any)).toMatchObject({ healthy: true, topLevelEntries: 1 })
    await target.source.cleanup({ targetId: 'recovery-one' }, {} as any)
    await expect(readFile(resolve(String(restored.path), 'shared', 'avatar.txt'))).rejects.toThrow()
  })

  it('atomically replaces declared paths for an explicitly in-place restore', async () => {
    const target = await fixture(),
      created = await target.source.create(target.policy, { operation: { id: 'operation-2' } } as any)
    if (created.mode !== 'object') throw new Error('Expected an object backup.')
    await writeFile(resolve(target.root, 'shared', 'avatar.txt'), 'changed')
    await target.source.restore(
      { manifest: created.manifest } as any,
      created.body,
      { targetId: 'replace-one', restoreMode: 'in_place' },
      {} as any,
    )
    expect(await readFile(resolve(target.root, 'shared', 'avatar.txt'), 'utf8')).toBe('original avatar')
  })

  it('refuses source paths outside the project root', async () => {
    const target = await fixture()
    await expect(
      target.source.create({ ...target.policy, includePatterns: ['../secrets'] }, {} as any),
    ).rejects.toThrow('outside')
  })
})
