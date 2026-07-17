import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import type {
  CloudDriver,
  ComputeStackOutputs,
  ComputeTarget,
  FindComputeTargetsOptions,
  ProvisionComputeOptions,
  RemoteDeployResult,
  RunRemoteDeployOptions,
  UploadReleaseOptions,
  UploadReleaseResult,
} from '@ts-cloud/core'
import { resolveDeployBucketName, resolveProjectStackName } from '@ts-cloud/core'
import type { HetznerFirewall, HetznerFirewallRule, HetznerServer } from './client'
import { HetznerClient, normalizeSshPublicKey, resolveHetznerApiToken } from './client'
import { resolveHetznerImage, resolveHetznerSettings } from './config'
import { generateUbuntuAppCloudInit, wrapCloudInitUserData } from './cloud-init'
import type { RpxLbAppBox } from '../shared/rpx-gateway'
import { buildRpxConfig, buildRpxLbConfig, buildRpxProvisionScript, usesRpxProxy } from '../shared/rpx-gateway'
import { buildComputeProvisionScripts } from '../shared/compute-provision'
import { resolveFleetTopology } from '../shared/fleet'
import { buildPhpProvisionScript } from '../shared/php-provision'
import { buildServicesProvisionScript, buildDatabaseSetupScript } from '../shared/db-provision'
import { buildUfwScript } from '../shared/ufw'
import { buildAutoUpdatesScript } from '../shared/maintenance'
import { buildMonitoringScript } from '../shared/monitoring'
import { buildAuthorizedKeysScript } from '../shared/ssh-keys'
import { buildNotifierScript } from '../shared/notifications'
import { buildHetznerFirewallRules } from './firewall-rules'
import { matchesTsCloudLabels, resolveHetznerServerType, TS_CLOUD_LABEL_PREFIX, tsCloudLabels } from './instance-sizes'
import { readDriverState, writeDriverState, type HetznerDriverState } from './state'

/** Output cap for SCP/SSH children — large enough for verbose tar extraction. */
const SSH_MAX_BUFFER = 1024 * 1024 * 256
const SSH_ERROR_OUTPUT_LIMIT = 8_000

function sshErrorOutput(value: unknown): string {
  const output = Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'string' ? value : ''

  return output
    // Remote deploy scripts contain a here-document with the complete runtime
    // environment. Never allow assignment values from command output into CI
    // logs, even when a shell or child process happens to echo the script.
    .replace(/(^|\n)([A-Z][A-Z0-9_]*=).*$/gm, '$1$2[redacted]')
    .replace(/encrypted:[A-Za-z0-9+/=]+/g, 'encrypted:[redacted]')
    .trim()
    .slice(-SSH_ERROR_OUTPUT_LIMIT)
}

export function formatSshFailure(error: unknown): string {
  const childError = error as { status?: number | null, signal?: string | null, stdout?: unknown, stderr?: unknown }
  const status = typeof childError?.status === 'number' ? ` (exit ${childError.status})` : ''
  const signal = childError?.signal ? ` (signal ${childError.signal})` : ''
  const output = [sshErrorOutput(childError?.stderr), sshErrorOutput(childError?.stdout)]
    .filter(Boolean)
    .join('\n')

  return `Remote SSH command failed${status}${signal}${output ? `\n${output}` : ''}`
}

export interface HetznerDriverOptions {
  apiToken?: string
  sshPrivateKeyPath?: string
  sshPublicKeyPath?: string
  sshUser?: string
  location?: string
  client?: HetznerClient
  /**
   * After the server reports `running`, block until SSH is reachable and
   * cloud-init has finished before returning from provisioning. Disable in
   * tests (or fast-path provisioning) to avoid real network waits.
   * @default true
   */
  waitForBoot?: boolean
  /**
   * Tunables for the SSH-readiness / cloud-init wait loops. Overridable so
   * tests can use tiny intervals.
   */
  bootWait?: {
    /** Delay between SSH probe attempts (ms). @default 5000 */
    sshIntervalMs?: number
    /** Max time to wait for SSH to accept connections (ms). @default 300000 */
    sshTimeoutMs?: number
    /** Delay between `cloud-init status` polls (ms). @default 5000 */
    cloudInitIntervalMs?: number
    /** Max time to wait for cloud-init to finish (ms). @default 600000 */
    cloudInitTimeoutMs?: number
  }
}

export class HetznerDriver implements CloudDriver {
  readonly name = 'hetzner' as const
  readonly usesCloudFormation = false

  private client: HetznerClient
  private sshPrivateKeyPath: string
  private sshPublicKeyPath: string
  private sshUser: string
  private location: string
  private waitForBoot: boolean
  private bootWait: Required<NonNullable<HetznerDriverOptions['bootWait']>>

  constructor(options: HetznerDriverOptions = {}) {
    this.client = options.client ?? new HetznerClient({
      apiToken: resolveHetznerApiToken(options.apiToken),
    })
    // Every Hetzner setting resolves through one chain (see ./config), so the
    // driver, the API client and the dashboard cannot disagree about where a
    // box lives or which key reaches it.
    const settings = resolveHetznerSettings(undefined, {
      sshPrivateKeyPath: options.sshPrivateKeyPath,
      sshPublicKeyPath: options.sshPublicKeyPath,
      sshUser: options.sshUser,
      location: options.location,
    })
    this.sshPrivateKeyPath = settings.sshPrivateKeyPath
    this.sshPublicKeyPath = settings.sshPublicKeyPath
    this.sshUser = settings.sshUser
    this.location = settings.location
    this.waitForBoot = options.waitForBoot ?? true
    this.bootWait = {
      sshIntervalMs: options.bootWait?.sshIntervalMs ?? 5000,
      sshTimeoutMs: options.bootWait?.sshTimeoutMs ?? 300000,
      cloudInitIntervalMs: options.bootWait?.cloudInitIntervalMs ?? 5000,
      cloudInitTimeoutMs: options.bootWait?.cloudInitTimeoutMs ?? 600000,
    }
  }

  async provisionComputeInfrastructure(options: ProvisionComputeOptions): Promise<ComputeStackOutputs> {
    const { config, environment } = options
    const slug = config.project.slug
    const compute = config.infrastructure?.compute
    if (!compute) {
      throw new Error('infrastructure.compute is required to provision Hetzner compute')
    }

    const stackName = resolveProjectStackName(config, environment)
    const serverName = `${slug}-${environment}-app`

    // Fleet topology: a load-balanced multi-app deployment takes a separate
    // provisioning path. Which path depends on the runtime:
    //  - PHP (Forge-style): `provisionFleet` — nginx/php-fpm app boxes fronted
    //    by Hetzner's own native Load Balancer product.
    //  - bun/node/deno: `provisionBunFleet` — app boxes running the runtime
    //    directly, fronted by a dedicated box running the rpx gateway in
    //    load-balancing mode (rpx v0.11.24+ multi-upstream routes).
    // A bun app with an explicit `servicesServer` (dedicated DB/cache box, no
    // multi-app-server requirement) is a secondary edge case: it still wants a
    // dedicated services box (provider/runtime-agnostic infra), so we route it
    // through the same bun-fleet path, which handles `dedicatedServices` too —
    // see provisionBunFleet's services-box step.
    const phpBox = compute.runtime === 'php' || !!compute.php
    const topology = resolveFleetTopology(compute)
    if (topology.dedicatedServices || topology.appServers > 1) {
      return phpBox
        ? this.provisionFleet(options, topology)
        : this.provisionBunFleet(options, topology)
    }

    // Desired-access resources are reconciled on EVERY provision — `deploy`
    // calls this each run, so a firewall rule change (new/removed site port,
    // allowSsh flipped) or a rotated SSH key must apply to a reused box, not
    // just a freshly created one. `ensureFirewall` syncs rules in place and
    // `ensureSshKey` is find-or-create, so this is idempotent.
    const labels = tsCloudLabels(slug, environment, 'app')
    const sites = config.sites || {}

    // ts-cloud does not run a reverse proxy on the box by default — the operator
    // runs their own. Open the upstream app/site ports so the operator's proxy
    // (or direct access) can reach each app. When `compute.proxy.engine` is set,
    // ts-cloud provisions that gateway (rpx) on the box from the sites model.
    const sitePorts = this.collectUpstreamPorts(sites)
    const firewallName = `${slug}-${environment}-app-fw`
    const { firewall } = await this.ensureFirewall(firewallName, labels, buildHetznerFirewallRules({
      // ts-cloud deploys over SSH (SCP + remote systemd setup), so SSH must be
      // reachable. Only close it when the caller explicitly opts out.
      allowSsh: compute.allowSsh !== false,
      sitePorts,
    }))
    const sshKeyId = await this.ensureSshKey(slug, environment, labels)

    const existing = await readDriverState(stackName)
    if (existing?.serverId) {
      const server = await this.tryGetServer(existing.serverId)
      if (server && server.status !== 'off') {
        return this.outputsFromState(existing, server)
      }
    }

    // Idempotency: even without local state (e.g. CI ran on a fresh checkout),
    // a server may already exist from a prior deploy. Look it up by ts-cloud
    // labels before creating a duplicate, and rehydrate local state from it.
    const alreadyRunning = await this.findExistingServer(slug, environment, serverName)
    if (alreadyRunning && alreadyRunning.status !== 'off') {
      const rehydrated: HetznerDriverState = {
        provider: 'hetzner',
        stackName,
        serverId: alreadyRunning.id,
        serverName: alreadyRunning.name,
        publicIp: alreadyRunning.public_net.ipv4?.ip,
        deployStoragePath: '/var/ts-cloud/staging',
        sshUser: this.sshUser,
      }
      await writeDriverState(stackName, rehydrated)
      return this.outputsFromState(rehydrated, alreadyRunning)
    }

    // Opt-in rpx gateway: generate the route config from the sites model and
    // install + start it on :80/:443 at first boot. Off by default.
    const rpxProvision = compute.proxy?.engine === 'rpx'
      ? buildRpxProvisionScript({
          proxy: compute.proxy,
          config: buildRpxConfig(sites, { proxy: compute.proxy, slug: config.project.slug }),
          slug: config.project.slug,
          bunBin: compute.runtime === 'node' || compute.runtime === 'deno' ? undefined : '/usr/local/bin/bun',
        })
      : undefined

    // Machine provisioning (PHP/nginx + services + db + firewall + updates +
    // monitoring + ssh keys + notifier + backups). Composed by the shared
    // builder so a cold boot and a golden-image bake install the same stack.
    const provision = buildComputeProvisionScripts(config)

    // When booting a pre-baked golden image, the stack is already installed —
    // skip the install-heavy steps for a near-instant boot.
    const baked = compute.bakedImage === true

    const bootstrap = generateUbuntuAppCloudInit({
      runtime: provision.runtime,
      runtimeVersion: provision.runtimeVersion,
      systemPackages: compute.systemPackages,
      database: config.infrastructure?.database,
      phpProvision: provision.phpProvision,
      servicesProvision: provision.servicesProvision,
      rpxProvision,
      baked,
    })
    const userData = wrapCloudInitUserData(bootstrap)

    const serverType = resolveHetznerServerType(compute.size)
    const image = resolveHetznerImage(config)

    const { server, action } = await this.client.createServer({
      name: serverName,
      serverType,
      image,
      location: config.hetzner?.location || this.location,
      userData,
      labels,
      sshKeys: sshKeyId ? [sshKeyId] : undefined,
      firewalls: [{ firewall: firewall.id }],
    })

    await this.client.waitForAction(action.id)
    const running = await this.client.waitForServerRunning(server.id)

    const state: HetznerDriverState = {
      provider: 'hetzner',
      stackName,
      serverId: running.id,
      serverName: running.name,
      firewallId: firewall.id,
      publicIp: running.public_net.ipv4?.ip,
      deployStoragePath: '/var/ts-cloud/staging',
      sshUser: this.sshUser,
    }
    await writeDriverState(stackName, state)

    // The server reports `running` the moment the VM powers on, but cloud-init
    // (apt, runtime install) is still going. Deploying now races the
    // bootstrap — SSH may be refused or `bun` may be missing. Wait for SSH to
    // come up, then for cloud-init to finish, before handing back outputs.
    const ip = running.public_net.ipv4?.ip
    if (ip && this.waitForBoot) {
      await this.waitForSshReady(ip)
      await this.waitForCloudInit(ip)
    }

    return this.outputsFromState(state, running)
  }

  /**
   * Provision a load-balanced fleet: a private network, a dedicated services
   * box (DB/cache/search), N app servers (nginx + php-fpm), and a load
   * balancer fronting the app servers. App servers connect to the services box
   * over the private network (wired into their `.env` at deploy time).
   */
  private async provisionFleet(
    options: ProvisionComputeOptions,
    topology: ReturnType<typeof resolveFleetTopology>,
  ): Promise<ComputeStackOutputs> {
    const { config, environment } = options
    const slug = config.project.slug
    const compute = config.infrastructure!.compute!
    const stackName = resolveProjectStackName(config, environment)
    const serverType = resolveHetznerServerType(compute.size)
    const image = resolveHetznerImage(config)
    const location = config.hetzner?.location || this.location
    const baked = compute.bakedImage === true

    // Idempotency: a prior fleet (by LB label) → return its outputs.
    const existingState = await readDriverState(stackName)
    if (existingState?.loadBalancerId) {
      const lbs = await this.client.listLoadBalancers().catch(() => [])
      const lb = lbs.find(l => l.id === existingState.loadBalancerId)
      if (lb) {
        return {
          appPublicIp: lb.public_net?.ipv4?.ip,
          loadBalancerIp: lb.public_net?.ipv4?.ip,
          servicesPrivateIp: existingState.servicesPrivateIp,
          deployStoragePath: '/var/ts-cloud/staging',
          sshUser: this.sshUser,
        }
      }
    }

    const sshKeyId = await this.ensureSshKey(slug, environment, tsCloudLabels(slug, environment, 'app'))

    // 1. Private network connecting the whole fleet.
    const netName = `${slug}-${environment}-net`
    const networks = await this.client.listNetworks().catch(() => [])
    const network = networks.find(n => n.name === netName)
      ?? await this.client.createNetwork({ name: netName, labels: tsCloudLabels(slug, environment, 'app') })

    // 2. Firewalls. App servers: SSH + 80/443. Services box: SSH + DB/cache/
    //    search reachable only from the private network range.
    const { firewall: appFw } = await this.ensureFirewall(
      `${slug}-${environment}-app-fw`,
      tsCloudLabels(slug, environment, 'app'),
      buildHetznerFirewallRules({ allowSsh: true, sitePorts: [] }),
    )
    const { firewall: svcFw } = await this.ensureFirewall(
      `${slug}-${environment}-services-fw`,
      tsCloudLabels(slug, environment, 'services'),
      [
        { direction: 'in', protocol: 'tcp', port: '22', source_ips: ['0.0.0.0/0', '::/0'] },
        { direction: 'in', protocol: 'tcp', port: '3306', source_ips: [network.ip_range] },
        { direction: 'in', protocol: 'tcp', port: '5432', source_ips: [network.ip_range] },
        { direction: 'in', protocol: 'tcp', port: '6379', source_ips: [network.ip_range] },
        { direction: 'in', protocol: 'tcp', port: '7700', source_ips: [network.ip_range] },
      ],
    )

    // 3. Services box — DB/cache/search only (no php/nginx).
    const servicesProvision = [
      ...buildServicesProvisionScript(compute.managedServices ?? { mysql: true, redis: true }, { bindPrivate: true }),
      ...buildDatabaseSetupScript(config.infrastructure?.appDatabase, compute.managedServices ?? { mysql: true }),
      ...buildAutoUpdatesScript(true),
      ...buildMonitoringScript(true),
      ...buildAuthorizedKeysScript(compute.sshKeys),
    ]
    const servicesUserData = wrapCloudInitUserData(generateUbuntuAppCloudInit({ runtime: 'php', servicesProvision, baked }))
    // Idempotent: reuse an existing services box (by role label) rather than
    // creating a duplicate on re-run.
    const all = await this.client.listServers().catch(() => [])
    const newServerIds: number[] = []
    let svcServer = all.find(s => matchesTsCloudLabels(s.labels, slug, environment, 'services'))
    if (!svcServer) {
      const { server, action } = await this.client.createServer({
        name: `${slug}-${environment}-services`,
        serverType: resolveHetznerServerType(typeof compute.servicesServer === 'object' ? compute.servicesServer.size : compute.size),
        image,
        location,
        userData: servicesUserData,
        labels: tsCloudLabels(slug, environment, 'services'),
        sshKeys: sshKeyId ? [sshKeyId] : undefined,
        firewalls: [{ firewall: svcFw.id }],
        networks: [network.id],
      })
      await this.client.waitForAction(action.id)
      svcServer = await this.client.waitForServerRunning(server.id)
      newServerIds.push(server.id)
    }
    const servicesServerId = svcServer.id
    const servicesPrivateIp = svcServer.private_net?.[0]?.ip
      ?? (await this.client.getServer(servicesServerId)).private_net?.[0]?.ip

    // 4. App servers — php + nginx, services installed remotely (not here).
    const appProvision = [
      ...buildAutoUpdatesScript(true),
      ...buildMonitoringScript(true),
      ...buildAuthorizedKeysScript(compute.sshKeys),
      ...buildNotifierScript(config.notifications),
    ]
    const appPhp = buildPhpProvisionScript({
      versions: compute.php?.versions,
      default: compute.php?.default,
      extensions: compute.php?.extensions,
      installNginx: !usesRpxProxy(compute),
      optimizeForProduction: compute.php?.optimizeForProduction,
      ini: compute.php?.ini,
    })
    const appUserData = wrapCloudInitUserData(generateUbuntuAppCloudInit({ runtime: 'php', phpProvision: appPhp, servicesProvision: appProvision, baked }))

    // Reconcile the app-server set to the desired count: reuse existing ones,
    // create only the delta, and destroy extras on scale-down (so stale boxes
    // don't keep serving traffic via the LB's label selector).
    const existingApp = all.filter(s => matchesTsCloudLabels(s.labels, slug, environment, 'app'))
    const appServerIds: number[] = existingApp.map(s => s.id)
    if (existingApp.length > topology.appServers) {
      for (const extra of existingApp.slice(topology.appServers)) {
        await this.client.deleteServer(extra.id).catch(() => {})
        appServerIds.splice(appServerIds.indexOf(extra.id), 1)
      }
    }
    for (let i = existingApp.length; i < topology.appServers; i++) {
      const { server, action } = await this.client.createServer({
        name: `${slug}-${environment}-app-${i + 1}`,
        serverType,
        image,
        location,
        userData: appUserData,
        labels: tsCloudLabels(slug, environment, 'app'),
        sshKeys: sshKeyId ? [sshKeyId] : undefined,
        firewalls: [{ firewall: appFw.id }],
        networks: [network.id],
      })
      await this.client.waitForAction(action.id)
      appServerIds.push(server.id)
      newServerIds.push(server.id)
    }

    // Wait for SSH + cloud-init on freshly-created boxes before returning, so
    // the deploy doesn't race the bootstrap (php/nginx/services installs).
    if (this.waitForBoot && newServerIds.length > 0) {
      await Promise.all(newServerIds.map(async (id) => {
        const running = await this.client.waitForServerRunning(id)
        const ip = running.public_net.ipv4?.ip
        if (ip) {
          await this.waitForSshReady(ip)
          await this.waitForCloudInit(ip)
        }
      }))
    }

    // 5. Load balancer fronting the app servers — only when the topology calls
    // for one (a single app server + dedicated services box needs no LB).
    const lbName = `${slug}-${environment}-lb`
    let lbIp: string | undefined
    let lbId: number | undefined
    if (topology.loadBalancer) {
      const lbs = await this.client.listLoadBalancers().catch(() => [])
      const lb = lbs.find(l => l.name === lbName) ?? await this.client.createLoadBalancer({
        name: lbName,
        location,
        network: network.id,
        labels: tsCloudLabels(slug, environment, 'lb'),
        labelSelector: `ts-cloud/project=${slug},ts-cloud/environment=${environment},ts-cloud/role=app`,
        services: [
          { listenPort: 80, destinationPort: 80 },
          { listenPort: 443, destinationPort: 443 },
        ],
      })
      lbId = lb.id
      lbIp = lb.public_net?.ipv4?.ip
    }

    // Public endpoint: the LB if present, else the (single) app server's IP.
    const appPublicIp = lbIp
      ?? (await this.client.getServer(appServerIds[0]).catch(() => undefined))?.public_net.ipv4?.ip

    const state: HetznerDriverState = {
      provider: 'hetzner',
      stackName,
      networkId: network.id,
      loadBalancerId: lbId,
      servicesServerId,
      servicesPrivateIp,
      publicIp: appPublicIp,
      deployStoragePath: '/var/ts-cloud/staging',
      sshUser: this.sshUser,
    }
    await writeDriverState(stackName, state)

    return {
      appPublicIp,
      loadBalancerIp: lbIp,
      servicesPrivateIp,
      deployStoragePath: '/var/ts-cloud/staging',
      sshUser: this.sshUser,
    }
  }

  /**
   * Provision a load-balanced **bun/node/deno** fleet: a private network, N
   * app servers running the runtime directly (no local rpx gateway — the LB
   * box reaches them over the private network), and ONE dedicated box running
   * only the rpx gateway in load-balancing mode, fronting every `server-app`
   * site's port across all app boxes (rpx v0.11.24+ multi-upstream routes with
   * health-check failover — see {@link buildRpxLbConfig}).
   *
   * Mirrors {@link provisionFleet}'s idempotency/reconciliation/teardown
   * patterns (reuse-by-label, create only the delta, destroy extras on
   * scale-down), but fronts the app boxes with rpx instead of Hetzner's native
   * Load Balancer product — this is the bun/rpx analogue of that PHP path.
   *
   * Edge case: a bun app that sets `compute.servicesServer` explicitly (wants
   * a dedicated DB/cache box) but only ever runs one app server still lands
   * here (see the `topology.dedicatedServices` dispatch condition) — in that
   * case we still provision the dedicated services box (provider/runtime
   * -agnostic infra, reusing the same PHP-fleet services-box mechanism is
   * unnecessary since bun app servers need no PHP/nginx either way) but only
   * stand up the rpx LB box when `topology.loadBalancer` is actually true
   * (i.e. more than one app server, or `compute.server?.loadBalancer`).
   */
  private async provisionBunFleet(
    options: ProvisionComputeOptions,
    topology: ReturnType<typeof resolveFleetTopology>,
  ): Promise<ComputeStackOutputs> {
    const { config, environment } = options
    const slug = config.project.slug
    const compute = config.infrastructure!.compute!
    const stackName = resolveProjectStackName(config, environment)
    const serverType = resolveHetznerServerType(compute.size)
    const image = resolveHetznerImage(config)
    const location = config.hetzner?.location || this.location
    const baked = compute.bakedImage === true
    const sites = config.sites || {}

    // Idempotency: a prior bun fleet (by LB server label) → return its outputs.
    const existingState = await readDriverState(stackName)
    if (existingState?.lbServerId) {
      const lb = await this.tryGetServer(existingState.lbServerId)
      if (lb && lb.status !== 'off') {
        return {
          appPublicIp: lb.public_net.ipv4?.ip ?? existingState.publicIp,
          loadBalancerIp: lb.public_net.ipv4?.ip ?? existingState.publicIp,
          servicesPrivateIp: existingState.servicesPrivateIp,
          deployStoragePath: '/var/ts-cloud/staging',
          sshUser: this.sshUser,
        }
      }
    }

    const sshKeyId = await this.ensureSshKey(slug, environment, tsCloudLabels(slug, environment, 'app'))

    // 1. Private network connecting the whole fleet.
    const netName = `${slug}-${environment}-net`
    const networks = await this.client.listNetworks().catch(() => [])
    const network = networks.find(n => n.name === netName)
      ?? await this.client.createNetwork({ name: netName, labels: tsCloudLabels(slug, environment, 'app') })

    // 2. Firewalls. App servers: SSH + each site's app port, reachable only
    //    from the private network (the LB reaches them privately) plus SSH
    //    from anywhere (ts-cloud deploys over SSH). LB box: SSH + 80/443 from
    //    anywhere (it's the public entry point). Services box (edge case):
    //    SSH + DB/cache/search reachable only from the private network.
    const sitePorts = this.collectUpstreamPorts(sites)
    const { firewall: appFw } = await this.ensureFirewall(
      `${slug}-${environment}-app-fw`,
      tsCloudLabels(slug, environment, 'app'),
      [
        { direction: 'in', protocol: 'tcp', port: '22', source_ips: ['0.0.0.0/0', '::/0'] },
        ...sitePorts.map(port => ({
          direction: 'in' as const,
          protocol: 'tcp' as const,
          port: String(port),
          source_ips: [network.ip_range],
          description: `ts-cloud port ${port} (private, LB-only)`,
        })),
      ],
    )
    const { firewall: lbFw } = await this.ensureFirewall(
      `${slug}-${environment}-lb-fw`,
      tsCloudLabels(slug, environment, 'lb'),
      buildHetznerFirewallRules({ allowSsh: true, sitePorts: [] }),
    )

    // 3. Dedicated services box — edge case for a bun app that wants a shared
    //    DB/cache off the app boxes. Reuses the same services-box mechanism as
    //    the PHP fleet path (it's provider/runtime-agnostic infra: just MySQL/
    //    Redis/Meilisearch on a box), since bun app servers need no PHP/nginx
    //    either way.
    const all = await this.client.listServers().catch(() => [])
    const newServerIds: number[] = []
    let servicesServerId: number | undefined
    let servicesPrivateIp: string | undefined
    // Unlike the PHP fleet path (which always needs a shared DB for multiple
    // php-fpm boxes to point at), a bun/node/deno fleet has no such inherent
    // requirement — plenty of bun apps are stateless or use an external
    // managed database. Only stand up the dedicated services box when the
    // caller actually asked for on-box services (`servicesServer` or
    // `managedServices` explicitly set), not merely because `appServers > 1`.
    const wantsServicesBox = !!compute.servicesServer || !!compute.managedServices
    if (topology.dedicatedServices && wantsServicesBox) {
      const { firewall: svcFw } = await this.ensureFirewall(
        `${slug}-${environment}-services-fw`,
        tsCloudLabels(slug, environment, 'services'),
        [
          { direction: 'in', protocol: 'tcp', port: '22', source_ips: ['0.0.0.0/0', '::/0'] },
          { direction: 'in', protocol: 'tcp', port: '3306', source_ips: [network.ip_range] },
          { direction: 'in', protocol: 'tcp', port: '5432', source_ips: [network.ip_range] },
          { direction: 'in', protocol: 'tcp', port: '6379', source_ips: [network.ip_range] },
          { direction: 'in', protocol: 'tcp', port: '7700', source_ips: [network.ip_range] },
        ],
      )
      const servicesProvision = [
        ...buildServicesProvisionScript(compute.managedServices ?? { mysql: true, redis: true }, { bindPrivate: true }),
        ...buildDatabaseSetupScript(config.infrastructure?.appDatabase, compute.managedServices ?? { mysql: true }),
        ...buildAutoUpdatesScript(true),
        ...buildMonitoringScript(true),
        ...buildAuthorizedKeysScript(compute.sshKeys),
      ]
      const servicesUserData = wrapCloudInitUserData(generateUbuntuAppCloudInit({ runtime: 'bun', servicesProvision, baked }))
      let svcServer = all.find(s => matchesTsCloudLabels(s.labels, slug, environment, 'services'))
      if (!svcServer) {
        const { server, action } = await this.client.createServer({
          name: `${slug}-${environment}-services`,
          serverType: resolveHetznerServerType(typeof compute.servicesServer === 'object' ? compute.servicesServer.size : compute.size),
          image,
          location,
          userData: servicesUserData,
          labels: tsCloudLabels(slug, environment, 'services'),
          sshKeys: sshKeyId ? [sshKeyId] : undefined,
          firewalls: [{ firewall: svcFw.id }],
          networks: [network.id],
        })
        await this.client.waitForAction(action.id)
        svcServer = await this.client.waitForServerRunning(server.id)
        newServerIds.push(server.id)
      }
      servicesServerId = svcServer.id
      servicesPrivateIp = svcServer.private_net?.[0]?.ip
        ?? (await this.client.getServer(servicesServerId)).private_net?.[0]?.ip
    }

    // 4. App servers — the runtime directly, NO local rpx gateway (the LB box
    //    reaches them directly over the private network).
    const appProvisionScripts = buildComputeProvisionScripts(config)
    const appUserData = wrapCloudInitUserData(generateUbuntuAppCloudInit({
      runtime: appProvisionScripts.runtime,
      runtimeVersion: appProvisionScripts.runtimeVersion,
      systemPackages: compute.systemPackages,
      database: config.infrastructure?.database,
      servicesProvision: appProvisionScripts.servicesProvision,
      baked,
      // No rpxProvision: app boxes in fleet mode do not run their own gateway.
    }))

    // Reconcile the app-server set to the desired count: reuse existing ones,
    // create only the delta, and destroy extras on scale-down (so stale boxes
    // never end up in the LB's upstream list).
    const existingApp = all.filter(s => matchesTsCloudLabels(s.labels, slug, environment, 'app'))
    const appServerIds: number[] = existingApp.map(s => s.id)
    if (existingApp.length > topology.appServers) {
      for (const extra of existingApp.slice(topology.appServers)) {
        await this.client.deleteServer(extra.id).catch(() => {})
        appServerIds.splice(appServerIds.indexOf(extra.id), 1)
      }
    }
    for (let i = existingApp.length; i < topology.appServers; i++) {
      const { server, action } = await this.client.createServer({
        name: `${slug}-${environment}-app-${i + 1}`,
        serverType,
        image,
        location,
        userData: appUserData,
        labels: tsCloudLabels(slug, environment, 'app'),
        sshKeys: sshKeyId ? [sshKeyId] : undefined,
        firewalls: [{ firewall: appFw.id }],
        networks: [network.id],
      })
      await this.client.waitForAction(action.id)
      appServerIds.push(server.id)
      newServerIds.push(server.id)
    }

    // Wait for SSH + cloud-init on freshly-created app/services boxes before
    // continuing, so neither the LB provisioning below nor a subsequent deploy
    // races the bootstrap.
    if (this.waitForBoot && newServerIds.length > 0) {
      await Promise.all(newServerIds.map(async (id) => {
        const running = await this.client.waitForServerRunning(id)
        const ip = running.public_net.ipv4?.ip
        if (ip) {
          await this.waitForSshReady(ip)
          await this.waitForCloudInit(ip)
        }
      }))
    }

    // Resolve every app box's private (preferred) or public IP for the LB's
    // rpx config — re-fetch a reused box that wasn't already in `all` (or whose
    // cached snapshot predates its network attachment, so `private_net` is
    // still empty there) so the LB always gets a real, current address.
    const appBoxes: RpxLbAppBox[] = []
    for (const id of appServerIds) {
      let server = all.find(s => s.id === id)
      if (!server || !server.private_net?.[0]?.ip)
        server = await this.client.getServer(id).catch(() => server)
      appBoxes.push({ privateIp: server?.private_net?.[0]?.ip, publicIp: server?.public_net.ipv4?.ip })
    }

    // 5. Dedicated rpx load-balancer box — only when the topology calls for
    //    one (a single app server needs no LB in front of it).
    const lbName = `${slug}-${environment}-lb`
    let lbId: number | undefined
    let lbIp: string | undefined
    if (topology.loadBalancer) {
      let lbServer = all.find(s => matchesTsCloudLabels(s.labels, slug, environment, 'lb'))
      if (!lbServer) {
        const rpxProxy = compute.proxy?.engine === 'rpx' ? compute.proxy : { engine: 'rpx' as const }
        const lbRpxProvision = buildRpxProvisionScript({
          proxy: rpxProxy,
          config: buildRpxLbConfig(sites, appBoxes, { proxy: rpxProxy, slug }),
          slug,
          bunBin: appProvisionScripts.runtime === 'node' || appProvisionScripts.runtime === 'deno' ? undefined : '/usr/local/bin/bun',
        })
        const lbUserData = wrapCloudInitUserData(generateUbuntuAppCloudInit({
          runtime: 'bun',
          rpxProvision: lbRpxProvision,
          baked: false, // the LB box is gateway-only; it always needs the runtime + rpx installed fresh.
        }))
        const lbSize = typeof compute.loadBalancer === 'object' ? compute.loadBalancer.size : undefined
        const { server, action } = await this.client.createServer({
          name: lbName,
          serverType: resolveHetznerServerType(lbSize ?? 'micro'),
          image,
          location,
          userData: lbUserData,
          labels: tsCloudLabels(slug, environment, 'lb'),
          sshKeys: sshKeyId ? [sshKeyId] : undefined,
          firewalls: [{ firewall: lbFw.id }],
          networks: [network.id],
        })
        await this.client.waitForAction(action.id)
        lbServer = await this.client.waitForServerRunning(server.id)
        if (this.waitForBoot) {
          const ip = lbServer.public_net.ipv4?.ip
          if (ip) {
            await this.waitForSshReady(ip)
            await this.waitForCloudInit(ip)
          }
        }
      }
      lbId = lbServer.id
      lbIp = lbServer.public_net.ipv4?.ip
    }

    // Public endpoint: the LB if present, else the (single) app server's IP.
    // Set BOTH appPublicIp and loadBalancerIp to the LB's IP so callers that
    // only read appPublicIp (single-IP-reading call sites) keep working.
    const appPublicIp = lbIp
      ?? (await this.client.getServer(appServerIds[0]).catch(() => undefined))?.public_net.ipv4?.ip

    const state: HetznerDriverState = {
      provider: 'hetzner',
      stackName,
      networkId: network.id,
      lbServerId: lbId,
      appServerIds,
      servicesServerId,
      servicesPrivateIp,
      publicIp: appPublicIp,
      deployStoragePath: '/var/ts-cloud/staging',
      sshUser: this.sshUser,
    }
    await writeDriverState(stackName, state)

    return {
      appPublicIp,
      loadBalancerIp: lbIp,
      servicesPrivateIp,
      deployStoragePath: '/var/ts-cloud/staging',
      sshUser: this.sshUser,
    }
  }

  /**
   * Tear down the compute — single server or full fleet (load balancer, all
   * app + services servers, firewalls, and the private network) — and clear
   * local state.
   */
  async destroyCompute(options: ProvisionComputeOptions): Promise<{ destroyed: string[] }> {
    const { config, environment } = options
    const slug = config.project.slug
    const stackName = resolveProjectStackName(config, environment)
    const state = await readDriverState(stackName)
    const destroyed: string[] = []

    // 1. Load balancer first (so it stops referencing the network).
    const lbName = `${slug}-${environment}-lb`
    const lbs = await this.client.listLoadBalancers().catch(() => [])
    const lb = lbs.find(l => l.name === lbName)
    if (lb) {
      // Only report what was actually removed — don't claim success on failure.
      try {
        await this.client.deleteLoadBalancer(lb.id)
        destroyed.push(`load balancer ${lbName}`)
      }
      catch { /* surfaced by the leftover resource on the next run */ }
    }

    // 2. All servers for this project/env (app + services + lb roles), via
    //    state + labels, deduped. `lb` here is the bun-fleet's dedicated rpx
    //    box (a real server) — distinct from the PHP fleet's native Hetzner
    //    Load Balancer resource already torn down in step 1.
    const allServers = await this.client.listServers().catch(() => [])
    const serverIds = new Set<number>()
    for (const s of allServers) {
      if (
        matchesTsCloudLabels(s.labels, slug, environment, 'app')
        || matchesTsCloudLabels(s.labels, slug, environment, 'services')
        || matchesTsCloudLabels(s.labels, slug, environment, 'lb')
      )
        serverIds.add(s.id)
    }
    if (state?.serverId) serverIds.add(state.serverId)
    if (state?.servicesServerId) serverIds.add(state.servicesServerId)
    if (state?.lbServerId) serverIds.add(state.lbServerId)
    for (const id of state?.appServerIds ?? []) serverIds.add(id)
    for (const id of serverIds) {
      try {
        await this.client.deleteServer(id)
        destroyed.push(`server ${id}`)
      }
      catch { /* leftover surfaces on the next teardown */ }
    }

    // 3. Firewalls (retry — can't delete until detached from deleting servers).
    const firewalls = await this.client.listFirewalls().catch(() => [])
    for (const name of [`${slug}-${environment}-app-fw`, `${slug}-${environment}-services-fw`, `${slug}-${environment}-lb-fw`]) {
      const fw = firewalls.find(f => f.name === name)
      if (!fw) continue
      for (let i = 0; i < 12; i++) {
        try {
          await this.client.deleteFirewall(fw.id)
          destroyed.push(`firewall ${name}`)
          break
        }
        catch {
          await this.sleep(3000)
        }
      }
    }

    // 4. Private network (after servers detach).
    const netName = `${slug}-${environment}-net`
    const networks = await this.client.listNetworks().catch(() => [])
    const net = networks.find(n => n.name === netName)
    if (net) {
      for (let i = 0; i < 12; i++) {
        try {
          await this.client.deleteNetwork(net.id)
          destroyed.push(`network ${netName}`)
          break
        }
        catch {
          await this.sleep(3000)
        }
      }
    }

    await writeDriverState(stackName, { provider: 'hetzner', stackName }).catch(() => {})
    return { destroyed }
  }

  async getComputeOutputs(options: ProvisionComputeOptions): Promise<ComputeStackOutputs> {
    const stackName = resolveProjectStackName(options.config, options.environment)
    const state = await readDriverState(stackName)
    if (state?.serverId) {
      // Tolerate a stale pin: a box deleted out-of-band makes getServer throw
      // (404), which crashed every deploy instead of falling through to the
      // label/state re-discovery below.
      const server = await this.tryGetServer(state.serverId)
      if (server)
        return this.outputsFromState(state, server)
    }
    // Bun+rpx fleet: no single serverId, but a dedicated rpx LB server — refresh
    // its public IP (state.publicIp may be stale) and surface it as both
    // appPublicIp and loadBalancerIp.
    if (state?.lbServerId) {
      const lb = await this.tryGetServer(state.lbServerId)
      const lbIp = lb?.public_net.ipv4?.ip ?? state.publicIp
      return {
        ...this.outputsFromState(state),
        appPublicIp: lbIp,
        loadBalancerIp: lbIp,
      }
    }
    // PHP fleet: no single serverId, but state carries the LB IP + services IP.
    if (state?.loadBalancerId || state?.servicesPrivateIp) {
      return this.outputsFromState(state)
    }

    const targets = await this.findComputeTargets({
      slug: options.config.project.slug,
      environment: options.environment,
      role: 'app',
      stackName: resolveProjectStackName(options.config, options.environment),
    })
    const first = targets[0]
    return {
      deployStoragePath: '/var/ts-cloud/staging',
      appInstanceId: first?.id,
      appPublicIp: first?.publicIp,
      sshUser: this.sshUser,
    }
  }

  async uploadRelease(options: UploadReleaseOptions): Promise<UploadReleaseResult> {
    const targets = options.targets?.length
      ? options.targets
      : await this.findComputeTargets({
          slug: options.config.project.slug,
          environment: options.environment,
          role: 'app',
          stackName: resolveProjectStackName(options.config, options.environment),
        })

    if (targets.length === 0) {
      throw new Error('No Hetzner compute targets found for release upload')
    }

    // Keep the site in the staging filename. `remoteKey` is
    // `releases/<siteName>/<sha>.tar.gz`; collapsing it to just `<sha>.tar.gz`
    // made every site sharing a commit SHA (i.e. all of them, every deploy)
    // upload to ONE staging file — a later site's upload clobbered an earlier
    // site's tarball before its extract ran, cross-contaminating releases.
    const stagingName = options.remoteKey.replace(/^releases\//, '').replace(/\//g, '-')
    const remotePath = `/var/ts-cloud/staging/${stagingName}`
    for (const target of targets) {
      if (!target.publicIp) {
        throw new Error(`Target ${target.id} has no public IP for SCP upload`)
      }
      this.scpToHost(target.publicIp, options.localPath, remotePath)
    }

    return { artifactRef: remotePath }
  }

  async findComputeTargets(options: FindComputeTargetsOptions): Promise<ComputeTarget[]> {
    const servers = await this.client.listServers()
    const role = options.role || 'app'
    const toTarget = (server: HetznerServer): ComputeTarget => ({
      id: String(server.id),
      name: server.name,
      publicIp: server.public_net.ipv4?.ip,
      privateIp: server.private_net?.[0]?.ip,
      status: server.status,
    })

    // 1) Exact match by this project's labels.
    const exact = servers.filter(server =>
      matchesTsCloudLabels(server.labels, options.slug, options.environment, role),
    )
    if (exact.length > 0)
      return exact.map(toTarget)

    // 2) State pinning: a project that rides a shared box records its server
    //    in `storage/cloud/state/<stack>.json`, but the box's labels belong to the
    //    project that provisioned it (`ts-cloud/project` holds one value), so
    //    the label scan above can't see it. Trust the state file's ids —
    //    re-resolved via the API so a deleted server is never targeted and the
    //    IP is always fresh. Without this, the moment a SECOND managed app
    //    server appears in the account, step 3's uniqueness requirement fails
    //    and shared-box projects lose their deploy target entirely.
    if (role === 'app') {
      const state = await readDriverState(options.stackName ?? `${options.slug}-${options.environment}`)
      const pinnedIds = [state?.serverId, ...(state?.appServerIds ?? [])]
        .filter((id): id is number => typeof id === 'number')
      if (pinnedIds.length > 0) {
        const pinned: HetznerServer[] = []
        for (const id of pinnedIds) {
          const server = servers.find(candidate => candidate.id === id) ?? await this.tryGetServer(id)
          if (server && server.status !== 'off')
            pinned.push(server)
        }
        if (pinned.length > 0)
          return pinned.map(toTarget)
      }
    }

    // 3) Adopt-on-rename (mirrors findExistingServer): when a project's slug
    //    changed but the same box still serves it, target the unique ts-cloud
    //    app server for this environment rather than reporting none — only when
    //    unambiguous, so a release never ships to another project's server.
    if (role === 'app') {
      const candidates = servers.filter(server =>
        server.status !== 'off'
        && server.labels?.[`${TS_CLOUD_LABEL_PREFIX}/managed-by`] === 'ts-cloud'
        && server.labels?.[`${TS_CLOUD_LABEL_PREFIX}/environment`] === options.environment
        && server.labels?.[`${TS_CLOUD_LABEL_PREFIX}/role`] === 'app',
      )
      if (candidates.length === 1)
        return candidates.map(toTarget)
    }

    return []
  }

  async runRemoteDeploy(options: RunRemoteDeployOptions): Promise<RemoteDeployResult> {
    if (options.targets.length === 0) {
      return { success: false, instanceCount: 0, perInstance: [], error: 'No targets provided' }
    }

    const script = options.commands.join('\n')
    const perInstance = []

    for (const target of options.targets) {
      if (!target.publicIp) {
        perInstance.push({
          instanceId: target.id,
          status: 'Failed',
          error: 'Missing public IP',
        })
        continue
      }

      try {
        const output = this.sshExec(target.publicIp, script)
        perInstance.push({
          instanceId: target.id,
          status: 'Success',
          output,
        })
      }
      catch (err: any) {
        perInstance.push({
          instanceId: target.id,
          status: 'Failed',
          error: err.message,
        })
      }
    }

    const success = perInstance.every(r => r.status === 'Success')
    return {
      success,
      instanceCount: options.targets.length,
      perInstance,
      error: success ? undefined : 'One or more SSH deploy commands failed',
    }
  }

  /**
   * Ensure the local SSH public key is registered in the Hetzner project and
   * return its id, so the freshly created server authorizes the same key the
   * deploy step (SCP/SSH) uses. Without this, deploys fail with "Permission
   * denied (publickey)" because the server has no authorized keys.
   */
  private async ensureSshKey(slug: string, environment: string, labels: Record<string, string>): Promise<number | undefined> {
    if (!existsSync(this.sshPublicKeyPath)) {
      throw new Error(
        `SSH public key not found at ${this.sshPublicKeyPath}. ts-cloud deploys to Hetzner over SSH and needs a public key to authorize on the server. `
        + `Generate one (\`ssh-keygen -t ed25519\`) or set hetzner.sshPrivateKeyPath / HCLOUD_SSH_PUBLIC_KEY.`,
      )
    }

    const publicKey = readFileSync(this.sshPublicKeyPath, 'utf8').trim()
    const normalized = normalizeSshPublicKey(publicKey)

    const existing = await this.client.listSshKeys()
    const match = existing.find(key => normalizeSshPublicKey(key.public_key) === normalized)
    if (match)
      return match.id

    const created = await this.client.createSshKey({
      name: `${slug}-${environment}-deploy`,
      publicKey,
      labels,
    })
    return created.id
  }

  /** getServer that returns null instead of throwing when the server is gone. */
  private async tryGetServer(id: number): Promise<HetznerServer | null> {
    try {
      return await this.client.getServer(id)
    }
    catch {
      // Stale state pointing at a deleted server — fall through to recreate.
      return null
    }
  }

  /**
   * Look up an existing ts-cloud server for this project/environment by labels
   * (falling back to name match). Used for idempotency when local state is
   * missing, so re-running deploy doesn't spin up a duplicate server.
   */
  private async findExistingServer(slug: string, environment: string, serverName: string): Promise<HetznerServer | undefined> {
    const servers = await this.client.listServers()

    // 1) Exact match: this project's labels, or the derived server name.
    const exact = servers.find(server =>
      matchesTsCloudLabels(server.labels, slug, environment, 'app') || server.name === serverName,
    )
    if (exact)
      return exact

    // 2) Adopt-on-rename: a project's slug can change (e.g. `stacks` → `reveal`)
    //    while the same box keeps serving it. Rather than provision a duplicate,
    //    reuse an existing ts-cloud-managed *app* server for the SAME environment,
    //    regardless of its `project` label — but only when it is unambiguous
    //    (exactly one live candidate), so we never adopt another project's server.
    const candidates = servers.filter(server =>
      server.status !== 'off'
      && server.labels?.[`${TS_CLOUD_LABEL_PREFIX}/managed-by`] === 'ts-cloud'
      && server.labels?.[`${TS_CLOUD_LABEL_PREFIX}/environment`] === environment
      && server.labels?.[`${TS_CLOUD_LABEL_PREFIX}/role`] === 'app',
    )
    if (candidates.length === 1) {
      const adopted = candidates[0]
      const adoptedProject = adopted.labels?.[`${TS_CLOUD_LABEL_PREFIX}/project`] ?? 'unknown'
      // eslint-disable-next-line no-console
      console.warn(
        `[ts-cloud] No server named '${serverName}' found; adopting existing ts-cloud app server `
        + `'${adopted.name}' (project label '${adoptedProject}') for project '${slug}' — `
        + `updating it in place instead of provisioning a new server.`,
      )
      return adopted
    }

    return undefined
  }

  /**
   * Idempotent firewall: reuse an existing firewall with the same name rather
   * than creating a duplicate on every deploy. When found, its rules are
   * updated to the desired set so config changes (new ports) still apply.
   */
  private async ensureFirewall(
    name: string,
    labels: Record<string, string>,
    rules: HetznerFirewallRule[],
  ): Promise<{ firewall: HetznerFirewall }> {
    const existing = await this.client.listFirewalls()
    const match = existing.find(fw => fw.name === name)
    if (match) {
      await this.client.setFirewallRules(match.id, rules)
      return { firewall: match }
    }
    const { firewall } = await this.client.createFirewall({ name, labels, rules })
    return { firewall }
  }

  /**
   * Collect the upstream app ports that must be reachable on the box. ts-cloud
   * does not front traffic with its own proxy, so each site's app port is
   * opened directly. Drops 80/443 (always handled by the firewall base rules).
   */
  private collectUpstreamPorts(
    sites: Record<string, { port?: number }>,
  ): number[] {
    const ports = new Set<number>()
    for (const site of Object.values(sites)) {
      if (typeof site.port === 'number')
        ports.add(site.port)
    }
    return [...ports].filter(port => ![80, 443].includes(port))
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Probe SSH (a trivial `true` over the connection) with backoff until the box
   * accepts connections. A freshly booted server refuses SSH for a few seconds
   * while sshd starts; without this, the very next deploy command races it and
   * fails with "Connection refused".
   */
  private async waitForSshReady(host: string): Promise<void> {
    const { sshIntervalMs, sshTimeoutMs } = this.bootWait
    const start = Date.now()
    let lastErr: unknown
    while (Date.now() - start < sshTimeoutMs) {
      try {
        execSync(`ssh ${this.sshBaseArgs(host, ['-o', 'ConnectTimeout=5']).map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ')} true`, {
          stdio: 'pipe',
          maxBuffer: SSH_MAX_BUFFER,
        })
        return
      }
      catch (err) {
        lastErr = err
        await this.sleep(sshIntervalMs)
      }
    }
    throw new Error(`Timed out waiting for SSH on ${host} after ${sshTimeoutMs}ms: ${(lastErr as Error)?.message ?? 'unknown error'}`)
  }

  /**
   * Block until cloud-init finishes (`cloud-init status --wait`). cloud-init is
   * what installs the runtime; deploying before it completes leaves the
   * release pointing at a half-provisioned box (missing `bun`).
   */
  private async waitForCloudInit(host: string): Promise<void> {
    const { cloudInitIntervalMs, cloudInitTimeoutMs } = this.bootWait
    const start = Date.now()
    while (Date.now() - start < cloudInitTimeoutMs) {
      try {
        // `cloud-init status` exits non-zero on error/degraded, so an `|| echo`
        // fallback would print "done" right after the real status and mask a
        // FAILED bootstrap as success. Probe once, tolerate the exit code, and
        // only treat a missing cloud-init binary (baked image) as done.
        const out = this.sshExec(host, `if command -v cloud-init >/dev/null 2>&1; then cloud-init status --long 2>/dev/null || true; else echo 'status: done'; fi`)
        if (/status:\s*error/.test(out))
          throw new Error(`cloud-init reported an error on ${host}:\n${out}`)
        if (/status:\s*(?:done|degraded)/.test(out))
          return
      }
      catch (err) {
        // SSH hiccup mid-boot — keep polling until the overall timeout.
        if (err instanceof Error && /cloud-init reported an error/.test(err.message))
          throw err
      }
      await this.sleep(cloudInitIntervalMs)
    }
    throw new Error(`Timed out waiting for cloud-init to finish on ${host} after ${cloudInitTimeoutMs}ms`)
  }

  private outputsFromState(state: HetznerDriverState, server?: { public_net: { ipv4?: { ip: string } } }): ComputeStackOutputs {
    return {
      deployStoragePath: state.deployStoragePath || '/var/ts-cloud/staging',
      appInstanceId: state.serverId ? String(state.serverId) : undefined,
      appPublicIp: server?.public_net.ipv4?.ip || state.publicIp,
      sshUser: state.sshUser || this.sshUser,
      // Fleet: surface the services box private IP so the deploy wires the
      // app .env at it (DB/Redis/Meilisearch).
      servicesPrivateIp: state.servicesPrivateIp,
    }
  }

  /**
   * SSH options for connecting to freshly-created cloud servers. Host-key
   * pinning is disabled (`StrictHostKeyChecking=no` + `UserKnownHostsFile`
   * `/dev/null`): the box is identified + trusted via the Hetzner API, and
   * providers recycle public IPs, so a stale `known_hosts` entry from a prior
   * (now-deleted) server would otherwise abort the deploy with
   * `REMOTE HOST IDENTIFICATION HAS CHANGED`.
   */
  private static readonly SSH_HOST_KEY_OPTS = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
  ]

  /**
   * Keepalive + connect timeout for every ssh/scp. Without these a connection
   * that stalls mid-transfer (a flaky network, an sshd hiccup) hangs the deploy
   * FOREVER — execSync has no timeout, so a dead socket blocks the whole run.
   * ServerAlive probes abort a silent connection after ~60s (15s × 4) so the
   * transfer fails loudly (and, for scp, is retried) instead of wedging.
   */
  private static readonly SSH_KEEPALIVE_OPTS = [
    '-o', 'ConnectTimeout=30',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
  ]

  private sshBaseArgs(host: string, extra: string[] = []): string[] {
    return [
      '-i', this.sshPrivateKeyPath,
      ...HetznerDriver.SSH_HOST_KEY_OPTS,
      ...HetznerDriver.SSH_KEEPALIVE_OPTS,
      '-o', 'BatchMode=yes',
      ...extra,
      `${this.sshUser}@${host}`,
    ]
  }

  private scpToHost(host: string, localPath: string, remotePath: string): void {
    const cmd = [
      'scp',
      '-i', this.sshPrivateKeyPath,
      ...HetznerDriver.SSH_HOST_KEY_OPTS,
      ...HetznerDriver.SSH_KEEPALIVE_OPTS,
      '-o', 'BatchMode=yes',
      localPath,
      `${this.sshUser}@${host}:${remotePath}`,
    ].map(arg => `"${arg.replace(/"/g, '\\"')}"`).join(' ')
    // Retry the transfer: scp overwrites its destination, so a re-upload is
    // idempotent, and a single dropped connection shouldn't fail a whole deploy.
    const attempts = 3
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        execSync(cmd, { stdio: 'pipe', maxBuffer: SSH_MAX_BUFFER })
        return
      }
      catch (error) {
        if (attempt === attempts)
          throw new Error(formatSshFailure(error))
      }
    }
  }

  private sshExec(host: string, script: string): string {
    const escaped = script.replace(/'/g, `'\\''`)
    // A release deploy extracts the full app tarball (often tens of thousands
    // of files), and `tar` happily emits a warning line per oddity. With the
    // default 1MB maxBuffer, execSync kills the SSH child mid-deploy with
    // ENOBUFS, so give the remote command plenty of headroom.
    try {
      return execSync(`ssh ${this.sshBaseArgs(host).map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ')} '${escaped}'`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: SSH_MAX_BUFFER,
      })
    }
    catch (error) {
      // Node's child-process error message embeds the complete command. The
      // command includes the runtime environment here-document, so forwarding
      // error.message would publish every deployment secret to CI logs.
      throw new Error(formatSshFailure(error))
    }
  }
}

export function resolveHetznerDeployBucketName(slug: string, environment: string): string {
  return resolveDeployBucketName(slug, environment as 'production' | 'staging' | 'development')
}
