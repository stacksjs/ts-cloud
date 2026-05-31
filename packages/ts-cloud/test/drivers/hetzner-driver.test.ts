import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test'
import type { CloudConfig } from '@ts-cloud/core'
import { HetznerDriver } from '../../src/drivers/hetzner/driver'
import { HetznerClient } from '../../src/drivers/hetzner/client'
import { createCloudDriver } from '../../src/drivers/factory'
import { driverStatePath } from '../../src/drivers/hetzner/state'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

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
    },
  },
}

const TEST_PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTKEYBODY test@ts-cloud'

function mockHetznerClient(overrides: Partial<HetznerClient> = {}): HetznerClient {
  const client = {
    listServers: mock(async () => []),
    listSshKeys: mock(async () => []),
    createSshKey: mock(async () => ({
      id: 99,
      name: 'my-app-production-deploy',
      fingerprint: 'aa:bb:cc',
      public_key: TEST_PUBLIC_KEY,
    })),
    getServer: mock(async (id: number) => ({
      id,
      name: 'my-app-production-app',
      status: 'running',
      public_net: { ipv4: { ip: '203.0.113.10' } },
      labels: {
        'ts-cloud/project': 'my-app',
        'ts-cloud/environment': 'production',
        'ts-cloud/role': 'app',
      },
      server_type: { name: 'cx22' },
      datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } },
    })),
    listFirewalls: mock(async () => []),
    setFirewallRules: mock(async () => []),
    createFirewall: mock(async () => ({
      firewall: { id: 10, name: 'fw', rules: [] },
      actions: [{ id: 2, status: 'success' as const }],
    })),
    createServer: mock(async () => ({
      server: {
        id: 42,
        name: 'my-app-production-app',
        status: 'initializing',
        public_net: { ipv4: { ip: '203.0.113.10' } },
        labels: {},
        server_type: { name: 'cx22' },
        datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } },
      },
      action: { id: 1, status: 'running' as const },
    })),
    waitForAction: mock(async (id: number) => ({ id, status: 'success' as const })),
    waitForServerRunning: mock(async (id: number) => ({
      id,
      name: 'my-app-production-app',
      status: 'running',
      public_net: { ipv4: { ip: '203.0.113.10' } },
      labels: {},
      server_type: { name: 'cx22' },
      datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } },
    })),
    ...overrides,
  } as unknown as HetznerClient

  return client
}

async function mkdtempSafe(): Promise<string> {
  const dir = `${process.cwd()}/.tmp-hetzner-driver-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await mkdir(dir, { recursive: true })
  return dir
}

describe('createCloudDriver', () => {
  it('returns AwsDriver by default', () => {
    const driver = createCloudDriver({
      config: {
        project: { name: 'App', slug: 'app', region: 'us-east-1' },
        environments: { production: { type: 'production' } },
        cloud: { provider: 'aws' },
      },
    })
    expect(driver.name).toBe('aws')
    expect(driver.usesCloudFormation).toBe(true)
  })

  it('returns HetznerDriver when configured', () => {
    const driver = createCloudDriver({ config: baseConfig })
    expect(driver.name).toBe('hetzner')
    expect(driver.usesCloudFormation).toBe(false)
  })
})

describe('HetznerDriver', () => {
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

  it('provisions server + firewall and writes local state', async () => {
    const client = mockHetznerClient()
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    const outputs = await driver.provisionComputeInfrastructure!({
      config: baseConfig,
      environment: 'production',
    })

    expect(outputs.appInstanceId).toBe('42')
    expect(outputs.appPublicIp).toBe('203.0.113.10')
    expect(outputs.deployStoragePath).toBe('/var/ts-cloud/staging')

    const stateRaw = await Bun.file(driverStatePath(stackName)).text()
    const state = JSON.parse(stateRaw)
    expect(state.serverId).toBe(42)
    expect(state.firewallId).toBe(10)
  })

  it('does not provision a gateway by default (no proxy configured)', async () => {
    const createServer = mock(async () => ({
      server: {
        id: 42,
        name: 'my-app-production-app',
        status: 'initializing',
        public_net: { ipv4: { ip: '203.0.113.10' } },
        labels: {},
        server_type: { name: 'cx22' },
        datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } },
      },
      action: { id: 1, status: 'running' as const },
    }))
    const client = mockHetznerClient({ createServer })
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    await driver.provisionComputeInfrastructure!({ config: baseConfig, environment: 'production' })

    const userData = (createServer.mock.calls[0] as unknown as [{ userData: string }])[0].userData
    expect(userData).not.toContain('rpx-gateway.service')
    expect(userData).not.toContain('@stacksjs/rpx')
  })

  it('provisions the rpx gateway in cloud-init when proxy.engine is rpx', async () => {
    const createServer = mock(async () => ({
      server: {
        id: 42,
        name: 'my-app-production-app',
        status: 'initializing',
        public_net: { ipv4: { ip: '203.0.113.10' } },
        labels: {},
        server_type: { name: 'cx22' },
        datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } },
      },
      action: { id: 1, status: 'running' as const },
    }))
    const client = mockHetznerClient({ createServer })
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    const config: CloudConfig = {
      ...baseConfig,
      infrastructure: {
        compute: {
          ...baseConfig.infrastructure!.compute!,
          proxy: { engine: 'rpx' },
        },
      },
    }
    await driver.provisionComputeInfrastructure!({ config, environment: 'production' })

    const userData = (createServer.mock.calls[0] as unknown as [{ userData: string }])[0].userData
    expect(userData).toContain('bun add -g @stacksjs/rpx@latest')
    expect(userData).toContain('rpx-gateway.service')
    expect(userData).toContain('/etc/rpx/gateway.ts')
    // The route for the web app (port 3000) is baked into the launcher config.
    expect(userData).toContain('localhost:3000')
    expect(userData).toContain('my-app.example.com')
  })

  it('registers the local SSH key and attaches it to the new server', async () => {
    const createSshKey = mock(async () => ({
      id: 99,
      name: 'my-app-production-deploy',
      fingerprint: 'aa:bb:cc',
      public_key: TEST_PUBLIC_KEY,
    }))
    const createServer = mock(async () => ({
      server: {
        id: 42,
        name: 'my-app-production-app',
        status: 'initializing',
        public_net: { ipv4: { ip: '203.0.113.10' } },
        labels: {},
        server_type: { name: 'cx22' },
        datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } },
      },
      action: { id: 1, status: 'running' as const },
    }))
    const client = mockHetznerClient({ createSshKey, createServer })
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    await driver.provisionComputeInfrastructure!({ config: baseConfig, environment: 'production' })

    expect(createSshKey).toHaveBeenCalledTimes(1)
    expect(createServer).toHaveBeenCalledTimes(1)
    const createServerArg = (createServer.mock.calls[0] as unknown as [{ sshKeys?: number[] }])[0]
    expect(createServerArg.sshKeys).toEqual([99])
  })

  it('reuses an already-registered SSH key instead of creating a duplicate', async () => {
    const createSshKey = mock(async () => { throw new Error('should not create a new SSH key') })
    const listSshKeys = mock(async () => [{
      id: 7,
      name: 'existing',
      fingerprint: 'aa:bb:cc',
      public_key: `${TEST_PUBLIC_KEY} a-different-comment`,
    }])
    const createServer = mock(async () => ({
      server: {
        id: 42,
        name: 'my-app-production-app',
        status: 'initializing',
        public_net: { ipv4: { ip: '203.0.113.10' } },
        labels: {},
        server_type: { name: 'cx22' },
        datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } },
      },
      action: { id: 1, status: 'running' as const },
    }))
    const client = mockHetznerClient({ createSshKey, listSshKeys, createServer })
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    await driver.provisionComputeInfrastructure!({ config: baseConfig, environment: 'production' })

    expect(createSshKey).not.toHaveBeenCalled()
    const reusedServerArg = (createServer.mock.calls[0] as unknown as [{ sshKeys?: number[] }])[0]
    expect(reusedServerArg.sshKeys).toEqual([7])
  })

  it('throws a helpful error when no SSH public key exists', async () => {
    const client = mockHetznerClient()
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: `${tempCwd}/missing.pub` })

    await expect(driver.provisionComputeInfrastructure!({ config: baseConfig, environment: 'production' }))
      .rejects
      .toThrow(/SSH public key not found/)
  })

  it('finds compute targets by ts-cloud labels', async () => {
    const client = mockHetznerClient({
      listServers: mock(async () => [{
        id: 7,
        name: 'my-app-production-app',
        status: 'running',
        public_net: { ipv4: { ip: '203.0.113.7' } },
        labels: {
          'ts-cloud/project': 'my-app',
          'ts-cloud/environment': 'production',
          'ts-cloud/role': 'app',
        },
        server_type: { name: 'cx22' },
        datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } },
      }]),
    })

    const driver = new HetznerDriver({ client, apiToken: 'test-token' })
    const targets = await driver.findComputeTargets({
      slug: 'my-app',
      environment: 'production',
      role: 'app',
    })

    expect(targets).toEqual([{
      id: '7',
      name: 'my-app-production-app',
      publicIp: '203.0.113.7',
      privateIp: undefined,
      status: 'running',
    }])
  })

  it('reuses existing state instead of creating duplicate servers', async () => {
    await mkdir(dirname(driverStatePath(stackName)), { recursive: true })
    await writeFile(driverStatePath(stackName), JSON.stringify({
      provider: 'hetzner',
      stackName,
      serverId: 42,
      serverName: 'my-app-production-app',
      firewallId: 10,
      publicIp: '203.0.113.10',
      deployStoragePath: '/var/ts-cloud/staging',
    }))

    const createServer = mock(async () => { throw new Error('should not create server') })
    const client = mockHetznerClient({ createServer })
    const driver = new HetznerDriver({ client, apiToken: 'test-token' })

    const outputs = await driver.getComputeOutputs({
      config: baseConfig,
      environment: 'production',
    })

    expect(outputs.appInstanceId).toBe('42')
    expect(createServer).not.toHaveBeenCalled()
  })

  it('does not create a duplicate server when one already exists (no local state)', async () => {
    // Simulate CI on a fresh checkout: no .ts-cloud/state, but a server with
    // matching ts-cloud labels already exists in the Hetzner project.
    const createServer = mock(async () => { throw new Error('should not create server') })
    const client = mockHetznerClient({
      createServer,
      listServers: mock(async () => [{
        id: 77,
        name: 'my-app-production-app',
        status: 'running',
        public_net: { ipv4: { ip: '203.0.113.77' } },
        labels: {
          'ts-cloud/project': 'my-app',
          'ts-cloud/environment': 'production',
          'ts-cloud/role': 'app',
        },
        server_type: { name: 'cx22' },
        datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } },
      }]),
    })
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    const outputs = await driver.provisionComputeInfrastructure!({ config: baseConfig, environment: 'production' })

    expect(createServer).not.toHaveBeenCalled()
    expect(outputs.appInstanceId).toBe('77')
    expect(outputs.appPublicIp).toBe('203.0.113.77')

    // Local state should have been rehydrated from the discovered server.
    const state = JSON.parse(await Bun.file(driverStatePath(stackName)).text())
    expect(state.serverId).toBe(77)
  })

  it('reuses an existing firewall (updating its rules) instead of creating one', async () => {
    const createFirewall = mock(async () => { throw new Error('should not create firewall') })
    const setFirewallRules = mock(async () => [])
    const client = mockHetznerClient({
      createFirewall,
      setFirewallRules,
      listFirewalls: mock(async () => [{ id: 55, name: 'my-app-production-app-fw', rules: [] }]),
    })
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    await driver.provisionComputeInfrastructure!({ config: baseConfig, environment: 'production' })

    expect(createFirewall).not.toHaveBeenCalled()
    expect(setFirewallRules).toHaveBeenCalledTimes(1)
    const ruleArgs = (setFirewallRules.mock.calls[0] as unknown as [number, Array<{ port: string }>])
    expect(ruleArgs[0]).toBe(55)
    const ports = ruleArgs[1].map(r => r.port).sort()
    // ts-cloud runs no reverse proxy — the site's app port is opened directly
    // alongside the base 80/443 + SSH rules.
    expect(ports).toEqual(['22', '3000', '443', '80'])
  })

  it('opens raw upstream ports for sites with an app port', async () => {
    const setFirewallRules = mock(async () => [])
    let createdRules: Array<{ port: string }> = []
    const client = mockHetznerClient({
      setFirewallRules,
      createFirewall: mock(async (opts: any) => {
        createdRules = opts.rules
        return { firewall: { id: 10, name: opts.name, rules: opts.rules }, actions: [] }
      }),
    })
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    const config: CloudConfig = {
      ...baseConfig,
      sites: { api: { root: '.', port: 4000, start: 'bun run server.ts' } },
    }
    await driver.provisionComputeInfrastructure!({ config, environment: 'production' })

    const ports = createdRules.map(r => r.port).sort()
    expect(ports).toContain('4000')
  })

  it('does not install or configure a reverse proxy on the box', async () => {
    let capturedUserData = ''
    const client = mockHetznerClient({
      createServer: mock(async (opts: any) => {
        capturedUserData = opts.userData
        return {
          server: {
            id: 42,
            name: 'my-app-production-app',
            status: 'initializing',
            public_net: { ipv4: { ip: '203.0.113.10' } },
            labels: {},
            server_type: { name: 'cx22' },
            datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } },
          },
          action: { id: 1, status: 'running' as const },
        }
      }),
    })
    const driver = new HetznerDriver({ client, apiToken: 'test-token', sshPublicKeyPath: await writeTestPublicKey(), waitForBoot: false })

    await driver.provisionComputeInfrastructure!({ config: baseConfig, environment: 'production' })

    // Proxying/TLS are handled by the operator's own tooling (rpx + tlsx), so
    // cloud-init must not install Caddy or write any Caddyfile.
    expect(capturedUserData).not.toContain('caddy')
    expect(capturedUserData).not.toContain('reverse_proxy')
    expect(capturedUserData).not.toContain('on_demand_tls')
  })
})
