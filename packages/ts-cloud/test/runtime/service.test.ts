import { describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CloudConfig, CloudDriver } from '@ts-cloud/core'
import {
  createRuntimeAdapters,
  discoverRuntimeInventory,
  EcsRuntimeAdapter,
  LambdaRuntimeAdapter,
} from '../../src/runtime'

const context = { project: 'acme', environment: 'production', now: new Date('2026-07-21T12:00:00Z') }

describe('AWS runtime adapters', () => {
  it('paginates and filters Lambda functions to the project environment', async () => {
    const calls: any[] = []
    const adapter = new LambdaRuntimeAdapter(
      {
        async listFunctions(input) {
          calls.push(input)
          return input?.Marker
            ? { Functions: [{ FunctionName: 'other-production-http' }] }
            : { Functions: [{ FunctionName: 'acme-production-http', State: 'Active' }], NextMarker: 'next' }
        },
      },
      'acme-production',
    )
    const workloads = await adapter.discover(context)
    expect(calls).toHaveLength(2)
    expect(workloads.map((item) => item.name)).toEqual(['acme-production-http'])
  })

  it('paginates ECS and batches service/task descriptions', async () => {
    const adapter = new EcsRuntimeAdapter(
      {
        async listClusters(input) {
          return input?.nextToken ? { clusterArns: ['cluster-b'] } : { clusterArns: ['cluster-a'], nextToken: 'next' }
        },
        async listServices(cluster) {
          return { serviceArns: [`arn/service/${cluster}/acme-production-api`, `arn/service/${cluster}/foreign-api`] }
        },
        async describeServices({ cluster, services }) {
          return {
            services: services.map((serviceArn) => ({
              serviceArn,
              serviceName: serviceArn.split('/').at(-1),
              clusterArn: cluster,
              status: 'ACTIVE',
              desiredCount: 1,
              runningCount: 1,
            })),
          }
        },
        async listTasks(cluster, service) {
          return { taskArns: [`arn/task/${cluster}/${service}`] }
        },
        async describeTasks(cluster, tasks) {
          return { tasks: tasks.map((taskArn) => ({ taskArn, clusterArn: cluster, lastStatus: 'RUNNING' })) }
        },
      },
      'acme-production',
    )
    const workloads = await adapter.discover(context)
    expect(workloads).toHaveLength(2)
    expect(workloads.every((item) => item.replicas.length === 1)).toBeTrue()
  })
})

describe('live server runtime discovery', () => {
  it('creates isolated systemd and Docker sources per compute target', async () => {
    const driver = {
      name: 'aws',
      usesCloudFormation: false,
      async findComputeTargets() {
        return [{ id: 'i-one' }, { id: 'i-two' }]
      },
      async runRemoteDeploy(options: any) {
        const docker = options.comment.endsWith('docker')
        return {
          success: true,
          instanceCount: 1,
          perInstance: [
            {
              instanceId: options.targets[0].id,
              status: 'Success',
              output: docker
                ? '[]'
                : `TSCLOUD_SYSTEMD\tapi.service\tloaded\tactive\trunning\tAPI\tenabled\t1\t10\t0\t2026-07-21T11:00:00Z\t/etc/api.service`,
            },
          ],
        }
      },
    } as unknown as CloudDriver
    const config = {
      project: { name: 'Acme', slug: 'acme', region: 'us-east-1' },
      cloud: { provider: 'hetzner' },
      mode: 'server',
      environments: { production: { type: 'production' } },
    } as CloudConfig
    const adapters = await createRuntimeAdapters(config, 'production', { driver })
    expect(adapters.map((item) => item.id)).toEqual(['systemd:i-one', 'docker:i-one', 'systemd:i-two', 'docker:i-two'])
    const inventory = await discoverRuntimeInventory(adapters, context)
    expect(inventory.workloads).toHaveLength(2)
    expect(inventory.sources.every((item) => item.status === 'fresh')).toBeTrue()
  })
})

/** Execute the real remote script against a systemctl read boundary, not a copied parser. */
async function discoverSystemdFixture(records: Array<Record<string, string>>, unavailable = false) {
  const root = mkdtempSync(join(tmpdir(), 'ts-cloud-systemd-inventory-'))
  const calls = join(root, 'calls.jsonl')
  try {
    const backend = join(root, 'systemctl')
    writeFileSync(backend, `#!${process.execPath} --no-env-file
const { appendFileSync, readFileSync } = await import('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.TSCLOUD_SYSTEMD_CALLS, JSON.stringify(args) + '\\n')
const records = JSON.parse(readFileSync(process.env.TSCLOUD_SYSTEMD_RECORDS, 'utf8'))
if (process.env.TSCLOUD_SYSTEMD_UNAVAILABLE === '1') {
  console.error('systemd fixture is unavailable')
  process.exit(1)
}
if (args[0] === 'list-units') {
  for (const record of records) console.log(record.Id + ' loaded active running fixture')
} else if (args[0] === 'is-enabled') {
  console.log(records.find(record => record.Id === args[1])?.UnitFileState || 'disabled')
} else if (args[0] === 'show') {
  const names = args.filter(arg => arg.endsWith('.service') && !arg.includes('*'))
  const selected = names.length ? records.filter(record => names.includes(record.Id)) : records
  const property = args.find(arg => arg.startsWith('--property='))?.slice('--property='.length)
    || (args.includes('-p') ? args[args.indexOf('-p') + 1] : '')
  for (const record of selected) {
    const fields = property ? property.split(',') : Object.keys(record)
    console.log(fields.map(key => args.includes('--value') ? record[key] || '' : key + '=' + (record[key] || '')).join('\\n'))
    if (!args.includes('--value')) console.log('')
  }
} else process.exit(2)
`)
    chmodSync(backend, 0o755)
    writeFileSync(join(root, 'records.json'), JSON.stringify(records))
    writeFileSync(calls, '')
    const driver = {
      name: 'hetzner',
      usesCloudFormation: false,
      async findComputeTargets() { return [{ id: 'systemd-fixture' }] },
      async runRemoteDeploy(options: any) {
        const child = Bun.spawnSync(['bash', '-s'], {
          stdin: Buffer.from(options.commands.join('\n')),
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 5000,
          env: {
            PATH: `${root}:${process.env.PATH || ''}`,
            TSCLOUD_SYSTEMD_CALLS: calls,
            TSCLOUD_SYSTEMD_RECORDS: join(root, 'records.json'),
            TSCLOUD_SYSTEMD_UNAVAILABLE: unavailable ? '1' : '0',
          },
        })
        const output = child.stdout.toString()
        const error = child.stderr.toString()
        return {
          success: child.exitCode === 0,
          instanceCount: 1,
          perInstance: [{ instanceId: 'systemd-fixture', status: child.exitCode === 0 ? 'Success' : 'Failed', output, error }],
        }
      },
    } as unknown as CloudDriver
    const config = { project: { name: 'Acme', slug: 'acme' }, cloud: { provider: 'hetzner' }, mode: 'server' } as CloudConfig
    const adapters = await createRuntimeAdapters(config, 'production', { driver })
    const inventory = await discoverRuntimeInventory(adapters.filter(adapter => adapter.provider === 'systemd'), context)
    return {
      inventory,
      calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe.skipIf(process.platform === 'win32')('systemd property snapshot shell contract', () => {
  it('reads all services coherently with one backend call and preserves runtime metadata', async () => {
    const { inventory, calls } = await discoverSystemdFixture([
      {
        Id: 'acme-api.service', LoadState: 'loaded', ActiveState: 'active', SubState: 'running',
        Description: 'API = v2\tready', UnitFileState: 'enabled', MainPID: '42', MemoryCurrent: '4096',
        NRestarts: '3', ActiveEnterTimestamp: '2026-07-21T11:00:00Z',
        FragmentPath: '/etc/systemd/system/acme-api.service', WorkingDirectory: '/var/www/acme api/current', User: 'deploy',
      },
      {
        Id: 'acme-worker.service', LoadState: 'loaded', ActiveState: 'failed', SubState: 'failed',
        Description: 'Worker', UnitFileState: 'disabled', MainPID: '0', MemoryCurrent: '8192', NRestarts: '5',
        ActiveEnterTimestamp: '', FragmentPath: '/etc/systemd/system/acme-worker.service', WorkingDirectory: '', User: '',
      },
    ])
    expect(inventory.degraded).toBeFalse()
    expect(inventory.workloads.map(workload => workload.name)).toEqual(['acme-api', 'acme-worker'])
    const [api, worker] = inventory.workloads
    expect(api).toMatchObject({ displayName: 'API = v2 ready', status: 'running', health: 'healthy', restartCount: 3, ageSeconds: 3600, tags: { enabled: 'enabled' }, resources: { memoryBytes: 4096 } })
    expect(api.replicas[0].pid).toBe(42)
    expect(api.mounts[0].target).toBe('/var/www/acme api/current')
    expect(api.config).toMatchObject({ fragmentPath: '/etc/systemd/system/acme-api.service', user: 'deploy' })
    expect(worker).toMatchObject({ status: 'failed', health: 'unhealthy', restartCount: 5, tags: { enabled: 'disabled' }, resources: { memoryBytes: 8192 } })
    expect(worker.mounts).toEqual([])
    expect(worker.replicas[0].pid).toBeUndefined()
    // This is the externally observed read budget; per-property reads exhausted
    // the real inventory deadline before any service could be returned.
    expect(calls).toHaveLength(1)
  })

  it('reports an empty successful service snapshot without fabricating workloads', async () => {
    const { inventory, calls } = await discoverSystemdFixture([])
    expect(inventory.degraded).toBeFalse()
    expect(inventory.workloads).toEqual([])
    expect(inventory.sources[0].status).toBe('fresh')
    expect(calls).toHaveLength(1)
  })

  it('keeps backend failures degraded instead of reporting an empty healthy host', async () => {
    const { inventory } = await discoverSystemdFixture([], true)
    expect(inventory.degraded).toBeTrue()
    expect(inventory.workloads).toEqual([])
    expect(inventory.sources[0].status).not.toBe('fresh')
    expect(inventory.sources[0].message).toContain('systemd fixture is unavailable')
  })
})
