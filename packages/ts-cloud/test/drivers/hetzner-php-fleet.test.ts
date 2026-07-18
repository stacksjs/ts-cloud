import type { CloudConfig } from '@ts-cloud/core'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { HetznerClient } from '../../src/drivers/hetzner/client'
import { HetznerDriver } from '../../src/drivers/hetzner/driver'

const TEST_PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTKEYBODY test@ts-cloud'

const baseConfig: CloudConfig = {
  project: { name: 'My App', slug: 'my-app', region: 'fsn1' },
  environments: { production: { type: 'production' } },
  cloud: { provider: 'hetzner' },
  hetzner: { apiToken: 'test-token', location: 'fsn1' },
  sites: {
    web: {
      domain: 'my-app.example.com',
      root: 'public',
      build: 'bun run build',
    },
  },
  infrastructure: {
    appDatabase: { engine: 'mysql', name: 'appdb', username: 'app', password: 's3cret' },
    compute: {
      size: 'small',
      runtime: 'php',
      appServers: 2,
    },
  },
}

/**
 * A stateful fake Hetzner client, mirroring the bun-fleet suite's: creations
 * append to an in-memory server list so label-based reconcile sees them, plus
 * the native Load Balancer product the PHP fleet fronts its app servers with.
 */
function fakeHetznerClient(initialServers: any[] = []): { client: HetznerClient, servers: any[], loadBalancers: any[] } {
  const servers: any[] = [...initialServers]
  let nextId = (initialServers.reduce((m, s) => Math.max(m, s.id), 0) || 100) + 1
  const firewalls: any[] = []
  let nextFwId = 1000
  const networks: any[] = []
  let nextNetId = 2000
  const loadBalancers: any[] = []
  let nextLbId = 9000

  const client = {
    listServers: mock(async () => servers),
    listSshKeys: mock(async () => []),
    createSshKey: mock(async () => ({
      id: 99,
      name: 'my-app-production-deploy',
      fingerprint: 'aa:bb:cc',
      public_key: TEST_PUBLIC_KEY,
    })),
    getServer: mock(async (id: number) => {
      const s = servers.find(s => s.id === id)
      if (!s) throw new Error(`server ${id} not found`)
      return s
    }),
    listFirewalls: mock(async () => firewalls),
    setFirewallRules: mock(async () => []),
    createFirewall: mock(async (opts: any) => {
      const fw = { id: nextFwId++, name: opts.name, labels: opts.labels, rules: opts.rules }
      firewalls.push(fw)
      return { firewall: fw, actions: [] }
    }),
    listNetworks: mock(async () => networks),
    createNetwork: mock(async (opts: any) => {
      const net = { id: nextNetId++, name: opts.name, ip_range: '10.0.0.0/16' }
      networks.push(net)
      return net
    }),
    listLoadBalancers: mock(async () => loadBalancers),
    createLoadBalancer: mock(async (opts: any) => {
      const lb = { id: nextLbId++, name: opts.name, public_net: { ipv4: { ip: '203.0.113.90' } }, labels: opts.labels ?? {} }
      loadBalancers.push(lb)
      return lb
    }),
    createServer: mock(async (opts: any) => {
      const id = nextId++
      const server = {
        id,
        name: opts.name,
        status: 'running',
        public_net: { ipv4: { ip: `203.0.113.${id}` } },
        private_net: opts.networks?.length ? [{ ip: `10.0.0.${id}` }] : [],
        labels: opts.labels ?? {},
        server_type: { name: opts.serverType },
        datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } },
      }
      servers.push(server)
      return { server, action: { id: id + 5000, status: 'running' as const } }
    }),
    waitForAction: mock(async (id: number) => ({ id, status: 'success' as const })),
    waitForServerRunning: mock(async (id: number) => {
      const s = servers.find(s => s.id === id)
      if (!s) throw new Error(`server ${id} not found`)
      return s
    }),
  } as unknown as HetznerClient

  return { client, servers, loadBalancers }
}

async function mkdtempSafe(): Promise<string> {
  const dir = `${process.cwd()}/.tmp-hetzner-php-fleet-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await mkdir(dir, { recursive: true })
  return dir
}

describe('HetznerDriver PHP fleet', () => {
  let originalCwd: string
  let tempCwd: string

  beforeEach(async () => {
    originalCwd = process.cwd()
    tempCwd = await mkdtempSafe()
    process.chdir(tempCwd)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(tempCwd, { recursive: true, force: true })
  })

  async function writeTestPublicKey(): Promise<string> {
    const path = `${tempCwd}/id_ed25519.pub`
    await writeFile(path, `${TEST_PUBLIC_KEY}\n`)
    return path
  }

  it('provisions N app servers + a services box + the native load balancer', async () => {
    const { client, servers, loadBalancers } = fakeHetznerClient()
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    const outputs = await driver.provisionComputeInfrastructure!({ config: baseConfig, environment: 'production' })

    expect(servers.filter(s => s.labels?.['ts-cloud/role'] === 'app')).toHaveLength(2)
    expect(servers.filter(s => s.labels?.['ts-cloud/role'] === 'services')).toHaveLength(1)
    // The PHP fleet fronts app servers with Hetzner's native LB, never an rpx box.
    expect(loadBalancers).toHaveLength(1)
    expect(servers.filter(s => s.labels?.['ts-cloud/role'] === 'lb')).toHaveLength(0)
    expect(outputs.loadBalancerIp).toBe('203.0.113.90')
  })

  it('the services box runs the engines, the DB setup, and the nightly backup — the app boxes none of them', async () => {
    const configWithBackups: CloudConfig = {
      ...baseConfig,
      infrastructure: {
        ...baseConfig.infrastructure,
        compute: { ...baseConfig.infrastructure!.compute!, backups: { enabled: true } },
      },
    }
    const { client } = fakeHetznerClient()
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    await driver.provisionComputeInfrastructure!({ config: configWithBackups, environment: 'production' })

    const createServerCalls = (client.createServer as any).mock.calls as Array<[any]>
    const appCalls = createServerCalls.filter(([opts]) => opts.labels?.['ts-cloud/role'] === 'app')
    const svcCalls = createServerCalls.filter(([opts]) => opts.labels?.['ts-cloud/role'] === 'services')
    expect(appCalls).toHaveLength(2)
    expect(svcCalls).toHaveLength(1)

    const svcUserData: string = svcCalls[0][0].userData
    expect(svcUserData).toContain('mysql.com')
    expect(svcUserData).toContain('appdb')
    expect(svcUserData).toContain('ts-backups')

    for (const [opts] of appCalls) {
      expect(opts.userData).not.toContain('mysql.com')
      expect(opts.userData).not.toContain('ts-backups')
    }
  })

  it('installs no backup runner anywhere when backups are not enabled', async () => {
    const { client } = fakeHetznerClient()
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    await driver.provisionComputeInfrastructure!({ config: baseConfig, environment: 'production' })

    const createServerCalls = (client.createServer as any).mock.calls as Array<[any]>
    for (const [opts] of createServerCalls) {
      expect(opts.userData).not.toContain('ts-backups')
    }
  })
})
