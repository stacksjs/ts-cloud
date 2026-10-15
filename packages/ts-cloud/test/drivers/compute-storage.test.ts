import type { CloudConfig } from '@ts-cloud/core'
import type { HetznerServer, HetznerVolume } from '../../src/drivers/hetzner/client'
import { describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HetznerClient } from '../../src/drivers/hetzner/client'
import { HetznerDriver } from '../../src/drivers/hetzner/driver'
import { applyHetznerVolumes, planHetznerVolumes } from '../../src/drivers/hetzner/volumes'
import { computeStorageAgent } from '../../src/drivers/shared/compute-storage-agent'
import { buildComputeStorageInstallScript, buildComputeStorageSiteScript, resolveComputeVolumes } from '../../src/drivers/shared/compute-storage'

const config: CloudConfig = {
  project: { name: 'Test', slug: 'test', region: 'fsn1' },
  environments: { production: { type: 'production' } },
  infrastructure: { compute: { size: 'xlarge', resize: { whenUnavailable: 'keep-current' },
    monitoring: false,
    volumes: { deployments: { size: 250, mountPath: '/var/lib/test-deployments' } },
    deploymentStorage: { volume: 'deployments', migrateExisting: true } } },
}
const server: HetznerServer = { id: 42, name: 'test-production-app', status: 'running', public_net: { ipv4: { ip: '203.0.113.1' } },
  location: { name: 'fsn1' }, server_type: { name: 'cx43', cores: 8, memory: 16, disk: 160, architecture: 'x86' } }
const volume: HetznerVolume = { id: 99, name: 'test-production-deployments', size: 250, server: 42, location: { name: 'fsn1' },
  status: 'available', protection: { delete: true }, linux_device: '/dev/disk/by-id/scsi-0HC_Volume_99' }

describe('configured compute volumes', () => {
  it('rejects system paths, overlapping mounts and missing placement references', () => {
    for (const mountPath of ['/', '/var/www/releases', '/etc/data', '/var/lib', '/run/cloud', '/mnt/../../etc']) {
      const invalid = structuredClone(config)
      invalid.infrastructure!.compute!.volumes!.deployments.mountPath = mountPath
      expect(() => resolveComputeVolumes(invalid, 'production')).toThrow()
    }
    const invalid = structuredClone(config)
    invalid.infrastructure!.compute!.deploymentStorage!.volume = 'missing'
    expect(() => resolveComputeVolumes(invalid, 'production')).toThrow('undeclared')
  })

  it('adopts the exact existing volume without creating or authorizing a format', async () => {
    const declarations = resolveComputeVolumes(config, 'production')
    const plan = await planHetznerVolumes({ listVolumes: async () => [volume] }, server, declarations)
    const client = { listVolumes: async () => [volume] } as unknown as HetznerClient
    expect(plan[0].actions).toEqual(['mount'])
    const result = await applyHetznerVolumes(client, server, plan)
    expect(result[0].id).toBe(99)
    expect(result[0].allowFormat).toBe(false)
  })

  it('refuses foreign, cross-region, ambiguous and shrinking volumes', async () => {
    const declarations = resolveComputeVolumes(config, 'production')
    for (const existing of [[{ ...volume, server: 43 }], [{ ...volume, location: { name: 'hel1' } }],
      [{ ...volume, size: 300 }], [volume, volume]]) {
      await expect(planHetznerVolumes({ listVolumes: async () => existing }, server, declarations)).rejects.toThrow()
    }
  })

  it('waits for create and attach actions before accepting a new device', async () => {
    const calls: string[] = []
    const client = {
      createVolume: async () => { calls.push('create'); return { volume, action: { id: 1 }, next_actions: [{ id: 2 }] } },
      waitForAction: async (id: number) => { calls.push(`wait:${id}`) },
      getVolume: async () => { calls.push('get'); return volume },
    } as unknown as HetznerClient
    const declaration = resolveComputeVolumes(config, 'production')[0]
    const result = await applyHetznerVolumes(client, server, [{ declaration, actions: ['create', 'protect', 'mount'] }])
    expect(calls).toEqual(['create', 'wait:1', 'wait:2', 'get'])
    expect(result[0].allowFormat).toBe(true)
  })

  it('sends manual attachment requests and never requests provider formatting', async () => {
    const calls: Array<{ url: string, body: any }> = []
    const client = new HetznerClient({ apiToken: 'test', fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return Response.json({ volume, action: { id: 1, status: 'success' }, next_actions: [] })
    } })
    await client.createVolume({ name: volume.name, size: 250, server: 42 })
    await client.attachVolume(99, 42)
    expect(calls[0].body.automount).toBe(false)
    expect(calls[0].body.format).toBeUndefined()
    expect(calls[1].body).toEqual({ server: 42, automount: false })
  })
})

describe('compute apply', () => {
  it('dry-run only reads and leaves an unavailable resize pending during storage apply', async () => {
    const client = {
      getServer: async () => server,
      listVolumes: async () => [volume],
      getServerType: async () => ({ ...server.server_type, name: 'cx53', cores: 16, memory: 32, disk: 320,
        locations: [{ name: 'fsn1', available: false }] }),
    } as unknown as HetznerClient
    const driver = new HetznerDriver({ client })
    driver.getComputeOutputs = async () => ({ appInstanceId: '42' })
    driver.runRemoteDeploy = mock(async () => ({ success: true, instanceCount: 1, perInstance: [] }))
    const plan = await driver.applyComputeChanges({ config, environment: 'production', dryRun: true })
    expect(plan.waitingForCapacity).toContain('cx53 unavailable')
    expect(driver.runRemoteDeploy).not.toHaveBeenCalled()
    await driver.applyComputeChanges({ config, environment: 'production' })
    expect(driver.runRemoteDeploy).toHaveBeenCalledTimes(1)
    await expect(driver.applyComputeChanges({ config: { ...config, cloud: { attachTo: 'owner' } }, environment: 'production' })).rejects.toThrow('owner')
  })
})

describe('native storage agent delivery', () => {
  it('runs a read-only plan from a minified serialized program with no source dependencies', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ts-cloud-storage-'))
    try {
      const webRoot = join(directory, 'www'); mkdirSync(join(webRoot, 'demo-main', 'releases'), { recursive: true })
      const policy = { volumes: [{ ...resolveComputeVolumes(config, 'production')[0], id: 99, device: volume.linux_device, allowFormat: false }],
        webRoot, deploymentStorage: config.infrastructure!.compute!.deploymentStorage }
      const entry = join(directory, 'entry.ts')
      writeFileSync(entry, `import { computeStorageAgent } from ${JSON.stringify(join(import.meta.dir, '../../src/drivers/shared/compute-storage-agent.ts'))}; console.log(computeStorageAgent.toString())`)
      const build = await Bun.build({ entrypoints: [entry], target: 'bun', minify: true })
      expect(build.success).toBe(true)
      const bundle = join(directory, 'bundle.mjs'); await Bun.write(bundle, build.outputs[0])
      const serialized = Bun.spawnSync(['bun', bundle]).stdout.toString().trim()
      const script = join(directory, 'agent.mjs')
      writeFileSync(script, `await (${serialized})(${JSON.stringify(policy)}, ['plan'])`)
      const result = Bun.spawnSync(['bun', script], { stdout: 'pipe', stderr: 'pipe' })
      expect(result.stderr.toString()).toBe('')
      expect(result.exitCode).toBe(0)
      const plan = JSON.parse(result.stdout.toString())
      expect(plan.entries[0].source).toBe(join(webRoot, 'demo-main', 'releases'))
      const before = computeStorageAgent.toString()
      expect(before).not.toContain('python')
      expect(buildComputeStorageInstallScript(policy).join('\n')).toContain('ts-cloud-storage-check.timer')
      expect(buildComputeStorageSiteScript('/var/www/demo-main', 'demo')[0]).toContain('ensure-site')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
