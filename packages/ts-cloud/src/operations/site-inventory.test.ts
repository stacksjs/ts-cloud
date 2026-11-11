import type { CloudConfig } from '@ts-cloud/core'
import type { ProviderServerPayload } from './inventory'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { siteInstallBase } from '../deploy/site-target'
import { buildSiteDeployScript } from '../drivers/shared/deploy-script'
import { readDriverState } from '../drivers/shared/driver-state'
import { buildRpxConfig } from '../drivers/shared/rpx-gateway'
import { sshKnownHostsPath } from '../drivers/shared/ssh-transport'
import { buildSshCommand } from '../runtime/process-stream'
import { toInventoryServer } from './inventory'
import { buildAppPathProbeScript, deployedSiteSshVia, deriveDeployedSites, listDeployedSites, parseAppPathProbe } from './site-inventory'

/**
 * The claim under test is not "these strings look right". It is "these are
 * the strings the deploy produces", so the assertions that matter compare
 * against the deploy's own builders: a rename there has to fail here.
 */

const project = join(import.meta.dir, 'fixtures', 'site-inventory')
const listing = JSON.parse(readFileSync(join(project, 'servers.json'), 'utf8')) as ProviderServerPayload[]

const ENV_KEYS = ['HCLOUD_TOKEN', 'HETZNER_API_TOKEN', 'HCLOUD_SSH_USER', 'HETZNER_SSH_USER', 'HCLOUD_SSH_KEY', 'HETZNER_SSH_KEY', 'TS_CLOUD_SSH_USER', 'TS_CLOUD_SSH_PORT', 'TS_CLOUD_SSH_KEY', 'TS_CLOUD_STATE_DIR']
const savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

const acme = {
  project: { name: 'Acme', slug: 'acme', region: 'us-east-1' },
  cloud: { provider: 'hetzner' },
  hetzner: { sshPrivateKeyPath: '~/.ssh/acme_deploy', sshUser: 'root' },
  infrastructure: { compute: { proxy: { engine: 'rpx' } } },
  sites: {
    api: { start: 'bun run server.ts', port: 3010, domain: 'api.acme.test', aliases: ['API2.acme.test', 'api.acme.test'] },
    worker: { start: 'bun run worker.ts' },
    legacy: { start: 'bun run old.ts', port: 3011, zeroDowntime: false, domain: 'old.acme.test' },
    docs: { deploy: 'server', root: 'dist', domain: 'docs.acme.test' },
    shop: { type: 'laravel', repository: { url: 'https://example.test/shop.git' }, domain: 'shop.acme.test' },
    marketing: { root: 'dist', domain: 'www.acme.test' },
    go: { redirect: 'https://acme.test', domain: 'go.acme.test' },
    upstream: { proxyTo: '127.0.0.1:9000', domain: 'up.acme.test' },
  },
} as unknown as CloudConfig

const tenant = {
  project: { name: 'Tenant', slug: 'tenant', region: 'us-east-1' },
  cloud: { provider: 'hetzner', attachTo: 'acme' },
  sites: { main: { start: 'bun run server.ts', port: 3140, domain: 'tenant.test' } },
} as unknown as CloudConfig

const pi = {
  project: { name: 'Pi', slug: 'pi', region: 'us-east-1' },
  cloud: { provider: 'ssh' },
  ssh: { hosts: [{ host: 'pi.lan', user: 'someone-else', port: 22, privateKeyPath: '~/.ssh/pi' }], hostKey: 'pin' },
  sites: { main: { start: 'bun run server.ts', port: 3000, domain: 'pi.local' } },
} as unknown as CloudConfig

const servers = listing.map(toInventoryServer)

describe('deriveDeployedSites', () => {
  it('reads the pinned state file the deploy wrote', async () => {
    const state = await readDriverState('acme-production', project)
    expect(state).toMatchObject({ provider: 'hetzner', serverId: 4201, sshUser: 'deploy' })
  })

  it('addresses every server-deployed site and says why the others are skipped', async () => {
    const state = await readDriverState('acme-production', project)
    const inventory = deriveDeployedSites({ config: acme, environment: 'production', state, servers, cwd: project })

    expect(inventory).toMatchObject({ slug: 'acme', environment: 'production', stackName: 'acme-production', provider: 'hetzner', warnings: [] })
    expect(inventory.attachedTo).toBeUndefined()
    expect(inventory.sites.map((site) => [site.name, site.kind])).toEqual([
      ['api', 'server-app'],
      ['worker', 'server-app'],
      ['legacy', 'server-app'],
      ['docs', 'server-static'],
      ['shop', 'server-php'],
    ])
    expect(inventory.skipped.map((site) => [site.name, site.kind])).toEqual([
      ['marketing', 'bucket'],
      ['go', 'redirect'],
      ['upstream', 'proxy'],
    ])
  })

  it('derives the paths from siteInstallBase, like the deploy', async () => {
    const state = await readDriverState('acme-production', project)
    const api = deriveDeployedSites({ config: acme, environment: 'production', state, servers, cwd: project }).sites[0]!

    expect(api.installBase).toBe(siteInstallBase('acme', 'api'))
    expect(api.appPath).toBe('/var/www/acme-api/current')
    expect(api.envFile).toBe('/var/www/acme-api/shared/.env')
    // The pre-namespacing location, offered as a candidate and never as the answer.
    expect(api.legacyAppPath).toBe('/var/www/api/current')
    expect(api.appPathCandidates).toEqual(['/var/www/acme-api/current', '/var/www/api/current'])
    expect(api.port).toBe(3010)
  })

  it('names the units and the env file the deploy script actually writes', async () => {
    const state = await readDriverState('acme-production', project)
    const { sites } = deriveDeployedSites({ config: acme, environment: 'production', state, servers, cwd: project })
    const byName = Object.fromEntries(sites.map((site) => [site.name, site]))

    expect(byName.api!.runtime).toEqual({ kind: 'systemd', unit: 'acme-api.service', instancePattern: 'acme-api@*.service' })
    // No port: nothing to overlap, so one plain unit.
    expect(byName.worker!.runtime).toEqual({ kind: 'systemd', unit: 'acme-worker.service' })
    // A port, but the overlapping cutover is switched off.
    expect(byName.legacy!.runtime).toEqual({ kind: 'systemd', unit: 'acme-legacy.service' })
    expect(byName.docs!.runtime).toEqual({ kind: 'static' })
    expect(byName.docs!.envFile).toBeUndefined()
    expect(byName.shop!.runtime).toEqual({ kind: 'php-fpm' })
    expect(byName.shop!.envFile).toBe('/var/www/acme-shop/shared/.env')

    const script = (name: 'api' | 'worker', port?: number) =>
      buildSiteDeployScript({
        siteName: name,
        slug: 'acme',
        appDir: siteInstallBase('acme', name),
        artifactFetch: [],
        releaseId: 'abc123',
        execStart: 'bun run server.ts',
        envEntries: {},
        port,
        zeroDowntime: true,
      } as never).join('\n')

    const zero = script('api', 3010)
    expect(zero).toContain('/etc/systemd/system/acme-api@.service')
    expect(zero).toContain(`cat > ${byName.api!.envFile} <<`)
    const plain = script('worker')
    expect(plain).toContain('/etc/systemd/system/acme-worker.service')
    expect(plain).not.toContain('acme-worker@')
  })

  it('takes the host from the live listing, matched by the pinned id', async () => {
    const state = await readDriverState('acme-production', project)
    const api = deriveDeployedSites({ config: acme, environment: 'production', state, servers, cwd: project }).sites[0]!

    // The listing's address, not the stale one in the state file.
    expect(api.hosts).toEqual([
      {
        id: '4201',
        name: 'acme-production-app',
        ipv4: '203.0.113.99',
        // The routed /64 narrowed to the address the interface holds.
        ipv6: '2001:db8:1234:5678::1',
        address: '203.0.113.99',
        status: 'running',
        source: 'state-pin',
      },
    ])
  })

  it('answers from the state file alone when there is no listing', async () => {
    const state = await readDriverState('acme-production', project)
    const inventory = deriveDeployedSites({ config: acme, environment: 'production', state, cwd: project })

    expect(inventory.warnings).toEqual([])
    expect(inventory.sites[0]!.hosts).toEqual([
      { id: '4201', name: 'acme-production-app', ipv4: '203.0.113.10', ipv6: '2001:db8:1234:5678::1', address: '203.0.113.10', status: 'unknown', source: 'state-file' },
    ])
  })

  it('prefers the user the deploy connected as over the config default', async () => {
    const state = await readDriverState('acme-production', project)
    const { ssh } = deriveDeployedSites({ config: acme, environment: 'production', state, servers, cwd: project }).sites[0]!

    expect(ssh.user).toBe('deploy')
    expect(ssh.port).toBe(22)
    expect(ssh.identityFile).toBe(join(homedir(), '.ssh', 'acme_deploy'))
  })

  it('checks the host key by default and lets the caller choose', async () => {
    const state = await readDriverState('acme-production', project)
    const pick = (hostKeyPolicy?: 'pin' | 'accept-new' | 'insecure') =>
      deriveDeployedSites({ config: acme, environment: 'production', state, servers, cwd: project, hostKeyPolicy }).sites[0]!.ssh.hostKey

    expect(pick()).toEqual({ policy: 'accept-new', knownHostsFile: sshKnownHostsPath(project) })
    expect(pick('pin')).toEqual({ policy: 'pin', knownHostsFile: sshKnownHostsPath(project) })
    expect(pick('insecure')).toBe('insecure')
  })

  it('lists the hostnames the deploy writes to the rpx fragment', async () => {
    const state = await readDriverState('acme-production', project)
    const { sites } = deriveDeployedSites({ config: acme, environment: 'production', state, servers, cwd: project })
    const byName = Object.fromEntries(sites.map((site) => [site.name, site]))

    expect(byName.api!.hostnames).toEqual(['api.acme.test', 'api2.acme.test'])
    expect(byName.worker!.hostnames).toEqual([])
    expect(byName.docs!.hostnames).toEqual(['docs.acme.test'])

    const fragment = buildRpxConfig({ api: acme.sites!.api }, { proxy: { engine: 'rpx' }, slug: 'acme' })
    expect(byName.api!.hostnames).toEqual([...new Set(fragment.proxies.map((route) => route.to))])
    expect(byName.api!.routedHostnames).toBeUndefined()
  })

  it('reports what the box routes when its fragments are supplied', async () => {
    const state = await readDriverState('acme-production', project)
    const fragments = [
      {
        slug: 'acme',
        proxies: [
          { to: 'api.acme.test', from: 'localhost:3010' },
          { to: 'docs.acme.test', static: { dir: '/var/www/acme-docs/current' } },
          { to: 'old.acme.test', from: 'localhost:3011' },
        ],
      },
      // A co-tenant on the same port number is not ours.
      { slug: 'tenant', proxies: [{ to: 'tenant.test', from: 'localhost:3010' }] },
    ]
    const { sites } = deriveDeployedSites({ config: acme, environment: 'production', state, servers, cwd: project, fragments })
    const byName = Object.fromEntries(sites.map((site) => [site.name, site]))

    // Declared with an alias; the box routes only the domain.
    expect(byName.api!.routedHostnames).toEqual(['api.acme.test'])
    expect(byName.docs!.routedHostnames).toEqual(['docs.acme.test'])
    expect(byName.worker!.routedHostnames).toEqual([])
  })

  it('resolves an attached tenant to the owner\'s box through its own pin', async () => {
    const state = await readDriverState('tenant-production', project)
    const inventory = deriveDeployedSites({ config: tenant, environment: 'production', state, servers, cwd: project })
    const main = inventory.sites[0]!

    expect(inventory.attachedTo).toBe('acme')
    expect(inventory.warnings).toEqual([])
    // The box is labelled for 'acme'; the pin is what finds it.
    expect(main.hosts[0]).toMatchObject({ id: '4201', name: 'acme-production-app', source: 'state-pin' })
    // The tenant's own slug namespaces its directory and unit on the shared box.
    expect(main.appPath).toBe('/var/www/tenant-main/current')
    expect(main.appPathCandidates).toEqual(['/var/www/tenant-main/current', '/var/www/main/current'])
    expect(main.runtime).toEqual({ kind: 'systemd', unit: 'tenant-main.service', instancePattern: 'tenant-main@*.service' })
    expect(main.ssh.user).toBe('root')
  })

  it('falls back to the labels when nothing is pinned', () => {
    const inventory = deriveDeployedSites({ config: acme, environment: 'production', state: null, servers, cwd: project })
    expect(inventory.sites[0]!.hosts.map((host) => [host.name, host.source])).toEqual([['acme-production-app', 'labels']])
    expect(deriveDeployedSites({ config: acme, environment: 'staging', state: null, servers, cwd: project }).sites[0]!.hosts).toEqual([])
  })

  it('refuses a pin whose server was renamed, turned off or deleted, and says so', async () => {
    const state = (await readDriverState('tenant-production', project))!
    const derive = (list: ProviderServerPayload[]) =>
      deriveDeployedSites({ config: tenant, environment: 'production', state: { ...state, publicIp: undefined, publicIpv6: undefined } as never, servers: list.map(toInventoryServer), cwd: project })

    const renamed = derive([{ ...listing[0]!, name: 'someone-elses-box' }])
    expect(renamed.sites[0]!.hosts).toEqual([])
    expect(renamed.warnings[0]).toContain(`named 'someone-elses-box', not 'acme-production-app'`)

    const off = derive([{ ...listing[0]!, status: 'off' }])
    expect(off.sites[0]!.hosts).toEqual([])
    expect(off.warnings[0]).toBe(`Server 'acme-production-app' is off.`)

    const gone = derive([listing[1]!])
    expect(gone.sites[0]!.hosts).toEqual([])
    expect(gone.warnings[0]).toContain('Server 4201 is pinned in the state file but absent from the provider listing')
    expect(gone.warnings.at(-1)).toContain('No reachable server could be resolved')
  })

  it('says a project was never deployed rather than inventing a host', () => {
    const inventory = deriveDeployedSites({ config: acme, environment: 'production', state: null, cwd: project })
    expect(inventory.sites).toHaveLength(5)
    expect(inventory.sites[0]!.hosts).toEqual([])
    expect(inventory.warnings).toEqual([`No state file for this stack, and no labelled server was found: has 'acme' been deployed to production from this checkout?`])
  })

  it('addresses a bring-your-own host from the ssh driver\'s state', async () => {
    const state = await readDriverState('pi-production', project)
    const inventory = deriveDeployedSites({ config: pi, environment: 'production', state, cwd: project })
    const main = inventory.sites[0]!

    expect(inventory.provider).toBe('ssh')
    // Connect to the configured name, exactly as deploys do.
    expect(main.hosts).toEqual([{ name: 'pi.lan', ipv4: '192.168.1.40', address: 'pi.lan', status: 'unknown', source: 'state-file' }])
    expect(main.ssh).toMatchObject({ user: 'chris', port: 2222, identityFile: join(homedir(), '.ssh', 'pi') })
  })

  it('lets a caller override a runtime it discovered some other way', async () => {
    const state = await readDriverState('acme-production', project)
    const inventory = deriveDeployedSites({ config: acme, environment: 'production', state, cwd: project, runtimes: { worker: { kind: 'docker', container: 'acme-worker-1' } } })
    expect(inventory.sites.find((site) => site.name === 'worker')!.runtime).toEqual({ kind: 'docker', container: 'acme-worker-1' })
    expect(inventory.sites.find((site) => site.name === 'api')!.runtime.kind).toBe('systemd')
  })
})

describe('listDeployedSites', () => {
  it('reads the state file from the project and makes exactly one list call', async () => {
    let listed = 0
    const inventory = await listDeployedSites({
      config: acme,
      environment: 'production',
      cwd: project,
      listServers: async () => {
        listed++
        return listing
      },
    })
    expect(listed).toBe(1)
    expect(inventory.sites[0]!.hosts[0]).toMatchObject({ ipv4: '203.0.113.99', source: 'state-pin' })
    expect(inventory.sites[0]!.ssh.user).toBe('deploy')
  })

  it('calls no provider when there is no token: the state file is enough', async () => {
    const inventory = await listDeployedSites({ config: tenant, environment: 'production', cwd: project })
    expect(inventory.warnings).toEqual([])
    expect(inventory.sites[0]!.hosts[0]).toMatchObject({ address: '203.0.113.10', source: 'state-file' })
  })

  it('never lists when told not to', async () => {
    process.env.HCLOUD_TOKEN = 'fixture-token-that-must-not-be-used'
    const inventory = await listDeployedSites({ config: acme, environment: 'production', cwd: project, listServers: false })
    expect(inventory.sites[0]!.hosts[0]!.source).toBe('state-file')
  })

  it('degrades to the state file when the listing fails, without relaying the error body', async () => {
    const inventory = await listDeployedSites({
      config: acme,
      environment: 'production',
      cwd: project,
      listServers: async () => {
        throw new Error('Hetzner API 401\n{"error":{"message":"token abc123 is invalid"}}')
      },
    })
    expect(inventory.warnings).toEqual(['Could not list servers (Hetzner API 401); answering from the state file.'])
    expect(inventory.sites[0]!.hosts[0]!.source).toBe('state-file')
  })

  it('does not list for an ssh-driver host', async () => {
    const inventory = await listDeployedSites({ config: pi, environment: 'production', cwd: project })
    expect(inventory.sites[0]!.hosts[0]!.address).toBe('pi.lan')
  })
})

describe('connecting to a deployed site', () => {
  it('turns a site into an ssh destination with its checked host key', async () => {
    const inventory = await listDeployedSites({ config: acme, environment: 'production', cwd: project, listServers: false })
    const api = inventory.sites[0]!
    const via = deployedSiteSshVia(api)

    expect(via.host).toBe('203.0.113.10')
    const command = buildSshCommand(via, ['bun', 'run', '-'], { cwd: api.appPath })
    expect(command.at(-2)).toBe('deploy@203.0.113.10')
    expect(command.at(-1)).toBe(`cd '/var/www/acme-api/current' && exec 'bun' 'run' '-'`)
    expect(command).toContain('StrictHostKeyChecking=accept-new')
    expect(command).toContain(`UserKnownHostsFile=${sshKnownHostsPath(project)}`)
    expect(command).not.toContain('StrictHostKeyChecking=no')
  })

  it('refuses a site with no host instead of connecting somewhere else', () => {
    const inventory = deriveDeployedSites({ config: acme, environment: 'production', state: null, cwd: project })
    expect(() => deployedSiteSshVia(inventory.sites[0]!)).toThrow(/no resolved host/)
  })

  it('finds which candidate path exists on the box', async () => {
    const script = buildAppPathProbeScript({ appPathCandidates: ['/nonexistent/ts-cloud-fixture', import.meta.dir, '/tmp'] })
    const child = Bun.spawn(['sh', '-c', script], { stdout: 'pipe' })
    expect(parseAppPathProbe(await new Response(child.stdout).text())).toBe(import.meta.dir)
    expect(parseAppPathProbe('__TSCLOUD_APP_PATH__=\n')).toBeUndefined()
    expect(parseAppPathProbe('motd noise\n__TSCLOUD_APP_PATH__=/var/www/acme-api/current\n')).toBe('/var/www/acme-api/current')
  })
})
