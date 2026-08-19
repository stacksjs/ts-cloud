import { describe, expect, it } from 'bun:test'
import { CloudBlockVolumeDriver, DockerNamedVolumeDriver, ServerPathVolumeDriver } from './drivers'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('persistent volume drivers', () => {
  it('creates, discovers, and deletes namespace-safe Docker named volumes', async () => {
    const calls: string[][] = [],
      volumes = new Set<string>(),
      driver = new DockerNamedVolumeDriver(async (args) => {
        calls.push(args)
        if (args[0] === 'volume' && args[1] === 'create') {
          volumes.add(args.at(-1)!)
          return { code: 0, stdout: args.at(-1)! + '\n', stderr: '' }
        }
        if (args[0] === 'volume' && args[1] === 'ls') return { code: 0, stdout: [...volumes].join('\n'), stderr: '' }
        if (args[0] === 'volume' && args[1] === 'inspect') {
          const name = args[2]!
          return volumes.has(name)
            ? {
                code: 0,
                stdout: JSON.stringify([{ Name: name, Driver: 'local', Labels: { managed: 'true' } }]),
                stderr: '',
              }
            : { code: 1, stdout: '', stderr: 'missing' }
        }
        if (args[0] === 'volume' && args[1] === 'rm') {
          volumes.delete(args[2]!)
          return { code: 0, stdout: '', stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      }),
      base = {
        id: 'volume-1',
        organizationId: 'org',
        projectId: 'project',
        name: 'uploads',
        provider: 'docker',
        type: 'docker' as const,
        status: 'pending' as const,
        encrypted: false,
        capabilities: driver.capabilities(),
        desiredState: {},
        observedState: {},
        version: 1,
        createdAt: 'now',
        updatedAt: 'now',
      }
    const created = await driver.create(base)
    expect(created.providerId).toBe('uploads')
    expect(await driver.discover('project')).toHaveLength(1)
    await driver.delete({ ...base, providerId: 'uploads' })
    expect(volumes.size).toBe(0)
    expect(calls.flat().join(' ')).not.toContain('volume-1 uploads project')
  })
  it('adapts a cloud block provider without assuming unsupported semantics', async () => {
    const calls: any[] = [],
      transport = {
        list: async () => [],
        create: async (input: any) => {
          calls.push(['create', input])
          return { providerId: 'vol-1', capacityBytes: input.capacityBytes }
        },
        attach: async (...input: any[]) => {
          calls.push(['attach', ...input])
        },
        detach: async (...input: any[]) => {
          calls.push(['detach', ...input])
        },
        resize: async (_id: string, size: number) => ({ providerId: 'vol-1', capacityBytes: size }),
        snapshot: async () => ({ providerId: 'snap-1' }),
        restore: async () => ({ providerId: 'vol-2' }),
        delete: async () => {},
        usage: async () => ({ usedBytes: 1, capacityBytes: 2 }),
      },
      driver = new CloudBlockVolumeDriver('aws', transport),
      volume: any = {
        id: 'id',
        projectId: 'project',
        name: 'data',
        capacityBytes: 1024 ** 3,
        encrypted: true,
        providerId: 'vol-1',
        observedState: {},
        capabilities: driver.capabilities(),
      },
      attachment: any = { targetPath: '/data', readOnly: false, driverOptions: { resourceProviderId: 'i-1' } }
    expect((await driver.create(volume)).providerId).toBe('vol-1')
    await driver.attach(volume, attachment)
    expect(calls[1]).toEqual(['attach', 'vol-1', 'i-1', '/data', false])
    expect(driver.capabilities().resize.online).toBe(true)
  })
  it('constrains server paths to a dedicated managed root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ts-cloud-volume-driver-')),
      driver = new ServerPathVolumeDriver(join(root, 'managed')),
      volume: any = { name: 'shared', desiredState: {}, providerId: 'shared' }
    try {
      expect((await driver.create(volume)).raw?.path).toBe(join(root, 'managed', 'shared'))
      expect(await driver.discover('project')).toHaveLength(1)
      await expect(driver.create({ ...volume, name: '../escape' })).rejects.toThrow()
      await driver.delete(volume)
      expect(await driver.discover('project')).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
