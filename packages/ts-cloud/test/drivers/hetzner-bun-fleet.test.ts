import type { CloudConfig } from '@ts-cloud/core'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { HetznerClient } from '../../src/drivers/hetzner/client'
import { HetznerDriver } from '../../src/drivers/hetzner/driver'
import { driverStatePath } from '../../src/drivers/hetzner/state'

const TEST_PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTKEYBODY test@ts-cloud'

const baseConfig: CloudConfig = {
  project: { name: 'My App', slug: 'my-app', region: 'fsn1' },
  environments: { production: { type: 'production' } },
  cloud: { provider: 'hetzner' },
  hetzner: { apiToken: 'test-token', location: 'fsn1' },
  sites: {
    web: {
      domain: 'my-app.example.com',
      port: 3000,
      root: '.output',
      build: 'bun run build',
      start: 'bun run server.ts',
    },
  },
  infrastructure: {
    compute: {
      size: 'small',
      runtime: 'bun',
      appServers: 2,
    },
  },
}

/**
 * A stateful fake Hetzner client: `createServer` actually appends to an
 * in-memory server list (with a fabricated private IP), so `listServers`
 * reflects prior creations within the same test — needed to exercise the bun
 * fleet's reconcile-by-label logic (reuse existing / create the delta /
 * destroy extras) the way the real API would.
 */
function fakeHetznerClient(initialServers: any[] = []): { client: HetznerClient, servers: any[], deletedServerIds: number[], deletedFirewallNames: string[], deletedNetworkNames: string[] } {
  const servers: any[] = [...initialServers]
  let nextId = (initialServers.reduce((m, s) => Math.max(m, s.id), 0) || 100) + 1
  const firewalls: any[] = []
  let nextFwId = 1000
  const networks: any[] = []
  let nextNetId = 2000
  const deletedServerIds: number[] = []
  const deletedFirewallNames: string[] = []
  const deletedNetworkNames: string[] = []

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
    deleteFirewall: mock(async (id: number) => {
      const fw = firewalls.find(f => f.id === id)
      if (fw) deletedFirewallNames.push(fw.name)
      const idx = firewalls.findIndex(f => f.id === id)
      if (idx >= 0) firewalls.splice(idx, 1)
    }),
    listNetworks: mock(async () => networks),
    createNetwork: mock(async (opts: any) => {
      const net = { id: nextNetId++, name: opts.name, ip_range: '10.0.0.0/16' }
      networks.push(net)
      return net
    }),
    deleteNetwork: mock(async (id: number) => {
      const net = networks.find(n => n.id === id)
      if (net) deletedNetworkNames.push(net.name)
      const idx = networks.findIndex(n => n.id === id)
      if (idx >= 0) networks.splice(idx, 1)
    }),
    listLoadBalancers: mock(async () => []),
    createServer: mock(async (opts: any) => {
      const id = nextId++
      const role = opts.labels?.['ts-cloud/role'] ?? 'app'
      const server = {
        id,
        name: opts.name,
        status: 'running',
        public_net: { ipv4: { ip: `203.0.113.${id}` } },
        private_net: opts.networks?.length ? [{ ip: `10.0.0.${id}` }] : [],
        labels: opts.labels ?? {},
        server_type: { name: opts.serverType },
        datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } },
        _role: role,
      }
      servers.push(server)
      return { server, action: { id: id + 5000, status: 'running' as const } }
    }),
    deleteServer: mock(async (id: number) => {
      deletedServerIds.push(id)
      const idx = servers.findIndex(s => s.id === id)
      if (idx >= 0) servers.splice(idx, 1)
      return { id: id + 9000, status: 'success' as const }
    }),
    waitForAction: mock(async (id: number) => ({ id, status: 'success' as const })),
    waitForServerRunning: mock(async (id: number) => {
      const s = servers.find(s => s.id === id)
      if (!s) throw new Error(`server ${id} not found`)
      return s
    }),
  } as unknown as HetznerClient

  return { client, servers, deletedServerIds, deletedFirewallNames, deletedNetworkNames }
}

async function mkdtempSafe(): Promise<string> {
  const dir = `${process.cwd()}/.tmp-hetzner-bun-fleet-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await mkdir(dir, { recursive: true })
  return dir
}

describe('HetznerDriver bun+rpx fleet', () => {
  const stackName = 'my-app-production'
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

  it('provisions N app servers + exactly 1 dedicated rpx LB server (bun runtime, appServers > 1)', async () => {
    const { client, servers } = fakeHetznerClient()
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    const outputs = await driver.provisionComputeInfrastructure!({ config: baseConfig, environment: 'production' })

    const appServers = servers.filter(s => s.labels?.['ts-cloud/role'] === 'app')
    const lbServers = servers.filter(s => s.labels?.['ts-cloud/role'] === 'lb')
    expect(appServers).toHaveLength(2)
    expect(lbServers).toHaveLength(1)

    // Labels carry the standard ts-cloud identity for both roles.
    for (const s of [...appServers, ...lbServers]) {
      expect(s.labels['ts-cloud/project']).toBe('my-app')
      expect(s.labels['ts-cloud/environment']).toBe('production')
      expect(s.labels['ts-cloud/managed-by']).toBe('ts-cloud')
    }

    // Public endpoint is the LB's IP, surfaced on both fields for backward compat.
    expect(outputs.loadBalancerIp).toBe(lbServers[0].public_net.ipv4.ip)
    expect(outputs.appPublicIp).toBe(lbServers[0].public_net.ipv4.ip)
  })

  it("the LB's rpx config references the app boxes' private IPs, not localhost", async () => {
    const { client, servers } = fakeHetznerClient()
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    await driver.provisionComputeInfrastructure!({ config: baseConfig, environment: 'production' })

    const lbServer = servers.find(s => s.labels?.['ts-cloud/role'] === 'lb')!
    const appServers = servers.filter(s => s.labels?.['ts-cloud/role'] === 'app')

    const createServerCalls = (client.createServer as any).mock.calls as Array<[any]>
    const lbCreateCall = createServerCalls.find(([opts]) => opts.labels?.['ts-cloud/role'] === 'lb')!
    const lbUserData: string = lbCreateCall[0].userData

    expect(lbUserData).toContain('rpx-gateway.service')
    // The private IPs of both app boxes must be baked into the LB's launcher.
    for (const app of appServers) {
      const privateIp = app.private_net[0].ip
      expect(lbUserData).toContain(`${privateIp}:3000`)
    }
    expect(lbUserData).not.toContain('localhost:3000')
    // Sanity: the LB box itself is a real server we found.
    expect(lbServer).toBeTruthy()
  })

  it('app boxes do NOT run their own rpx gateway (LB-only gateway)', async () => {
    const { client, servers } = fakeHetznerClient()
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    await driver.provisionComputeInfrastructure!({ config: baseConfig, environment: 'production' })

    const createServerCalls = (client.createServer as any).mock.calls as Array<[any]>
    const appCreateCalls = createServerCalls.filter(([opts]) => opts.labels?.['ts-cloud/role'] === 'app')
    expect(appCreateCalls).toHaveLength(2)
    for (const [opts] of appCreateCalls) {
      expect(opts.userData).not.toContain('rpx-gateway.service')
    }
  })

  it('scale-down destroys extra app servers and keeps exactly the desired count', async () => {
    // Simulate a prior fleet of 3 app servers + 1 LB already existing.
    const existing = [
      { id: 201, name: 'my-app-production-app-1', status: 'running', public_net: { ipv4: { ip: '203.0.113.201' } }, private_net: [{ ip: '10.0.0.201' }], labels: { 'ts-cloud/project': 'my-app', 'ts-cloud/environment': 'production', 'ts-cloud/role': 'app', 'ts-cloud/managed-by': 'ts-cloud' }, server_type: { name: 'cx23' }, datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } } },
      { id: 202, name: 'my-app-production-app-2', status: 'running', public_net: { ipv4: { ip: '203.0.113.202' } }, private_net: [{ ip: '10.0.0.202' }], labels: { 'ts-cloud/project': 'my-app', 'ts-cloud/environment': 'production', 'ts-cloud/role': 'app', 'ts-cloud/managed-by': 'ts-cloud' }, server_type: { name: 'cx23' }, datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } } },
      { id: 203, name: 'my-app-production-app-3', status: 'running', public_net: { ipv4: { ip: '203.0.113.203' } }, private_net: [{ ip: '10.0.0.203' }], labels: { 'ts-cloud/project': 'my-app', 'ts-cloud/environment': 'production', 'ts-cloud/role': 'app', 'ts-cloud/managed-by': 'ts-cloud' }, server_type: { name: 'cx23' }, datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } } },
      { id: 204, name: 'my-app-production-lb', status: 'running', public_net: { ipv4: { ip: '203.0.113.204' } }, private_net: [{ ip: '10.0.0.204' }], labels: { 'ts-cloud/project': 'my-app', 'ts-cloud/environment': 'production', 'ts-cloud/role': 'lb', 'ts-cloud/managed-by': 'ts-cloud' }, server_type: { name: 'cpx11' }, datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } } },
    ]
    const { client, servers, deletedServerIds } = fakeHetznerClient(existing)
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    // Desired count is 2 (baseConfig.appServers) — one existing app server must be destroyed.
    await driver.provisionComputeInfrastructure!({ config: baseConfig, environment: 'production' })

    const remainingAppServers = servers.filter(s => s.labels?.['ts-cloud/role'] === 'app')
    expect(remainingAppServers).toHaveLength(2)
    expect(deletedServerIds).toContain(203)
    // The existing (reused) LB server is not recreated.
    const lbServers = servers.filter(s => s.labels?.['ts-cloud/role'] === 'lb')
    expect(lbServers).toHaveLength(1)
    expect(lbServers[0].id).toBe(204)
  })

  it('a single app server (appServers=1, no dedicatedServices) never provisions an LB box', async () => {
    const singleConfig: CloudConfig = {
      ...baseConfig,
      infrastructure: { compute: { size: 'small', runtime: 'bun' } },
    }
    const { client, servers } = fakeHetznerClient()
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    await driver.provisionComputeInfrastructure!({ config: singleConfig, environment: 'production' })

    // Falls through to the plain single-box path — no fleet-role labels at all.
    const lbServers = servers.filter(s => s.labels?.['ts-cloud/role'] === 'lb')
    expect(lbServers).toHaveLength(0)
  })

  it('destroyCompute tears down the LB box, all app boxes, the network, and firewalls', async () => {
    const { client, servers } = fakeHetznerClient()
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    await driver.provisionComputeInfrastructure!({ config: baseConfig, environment: 'production' })
    expect(servers.length).toBeGreaterThan(0)

    const result = await driver.destroyCompute!({ config: baseConfig, environment: 'production' })

    expect(servers).toHaveLength(0)
    expect(result.destroyed.some(d => d.startsWith('firewall'))).toBe(true)
    expect(result.destroyed.some(d => d.startsWith('network'))).toBe(true)
    expect(result.destroyed.filter(d => d.startsWith('server')).length).toBeGreaterThanOrEqual(3) // 2 app + 1 lb
  })

  it('does not create a PHP fleet (Hetzner-native LB) for a bun app — provisions the rpx LB box instead', async () => {
    const createLoadBalancer = mock(async () => { throw new Error('should not use Hetzner-native Load Balancer for a bun fleet') })
    const { client, servers } = fakeHetznerClient()
    ;(client as any).createLoadBalancer = createLoadBalancer
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    await driver.provisionComputeInfrastructure!({ config: baseConfig, environment: 'production' })

    expect(createLoadBalancer).not.toHaveBeenCalled()
    expect(servers.some(s => s.labels?.['ts-cloud/role'] === 'lb')).toBe(true)
  })

  it('persists lbServerId + appServerIds in local state for idempotent re-runs', async () => {
    const { client } = fakeHetznerClient()
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    await driver.provisionComputeInfrastructure!({ config: baseConfig, environment: 'production' })

    const state = JSON.parse(await Bun.file(driverStatePath(stackName)).text())
    expect(state.lbServerId).toBeTruthy()
    expect(state.appServerIds).toHaveLength(2)
  })

  it('re-running provision is idempotent (reuses the existing fleet, does not recreate)', async () => {
    const { client, servers } = fakeHetznerClient()
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    await driver.provisionComputeInfrastructure!({ config: baseConfig, environment: 'production' })
    const countAfterFirst = servers.length

    await driver.provisionComputeInfrastructure!({ config: baseConfig, environment: 'production' })
    expect(servers.length).toBe(countAfterFirst)
  })
})
