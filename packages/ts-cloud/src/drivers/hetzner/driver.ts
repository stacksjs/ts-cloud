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
import { generateUbuntuAppCloudInit, wrapCloudInitUserData } from './cloud-init'
import { buildRpxConfig, buildRpxProvisionScript } from '../shared/rpx-gateway'
import { buildPhpProvisionScript } from '../shared/php-provision'
import { buildDatabaseSetupScript, buildServicesProvisionScript } from '../shared/db-provision'
import { buildUfwScript } from '../shared/ufw'
import { buildAutoUpdatesScript } from '../shared/maintenance'
import { buildBackupProvisionScript } from '../shared/backups'
import { buildMonitoringScript } from '../shared/monitoring'
import { buildNotifierScript } from '../shared/notifications'
import { buildHetznerFirewallRules } from './firewall-rules'
import { matchesTsCloudLabels, resolveHetznerServerType, tsCloudLabels } from './instance-sizes'
import { readDriverState, writeDriverState, type HetznerDriverState } from './state'

/** Output cap for SCP/SSH children — large enough for verbose tar extraction. */
const SSH_MAX_BUFFER = 1024 * 1024 * 256

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

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
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
    this.sshPrivateKeyPath = expandHome(options.sshPrivateKeyPath || process.env.HCLOUD_SSH_KEY || '~/.ssh/id_ed25519')
    this.sshPublicKeyPath = expandHome(options.sshPublicKeyPath || process.env.HCLOUD_SSH_PUBLIC_KEY || `${this.sshPrivateKeyPath}.pub`)
    this.sshUser = options.sshUser || process.env.HCLOUD_SSH_USER || 'root'
    this.location = options.location || process.env.HCLOUD_LOCATION || 'fsn1'
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
    const labels = tsCloudLabels(slug, environment, 'app')
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

    const sites = config.sites || {}

    // ts-cloud does not run a reverse proxy on the box by default — the operator
    // runs their own. Open the upstream app/site ports so the operator's proxy
    // (or direct access) can reach each app. When `compute.proxy.engine` is set,
    // ts-cloud provisions that gateway (rpx) on the box from the sites model.
    const sitePorts = this.collectUpstreamPorts(sites)

    // Opt-in rpx gateway: generate the route config from the sites model and
    // install + start it on :80/:443 at first boot. Off by default.
    const rpxProvision = compute.proxy?.engine === 'rpx'
      ? buildRpxProvisionScript({
          proxy: compute.proxy,
          config: buildRpxConfig(sites, { proxy: compute.proxy }),
          bunBin: compute.runtime === 'node' || compute.runtime === 'deno' ? undefined : '/usr/local/bin/bun',
        })
      : undefined

    // PHP box: install nginx + php-fpm + Composer at first boot when the
    // runtime is `php` or `compute.php` is configured. Built from the same
    // generator nginx vhosts later fastcgi_pass against.
    const wantsPhp = compute.runtime === 'php' || !!compute.php
    const phpProvision = wantsPhp
      ? buildPhpProvisionScript({
          versions: compute.php?.versions,
          default: compute.php?.default,
          extensions: compute.php?.extensions,
          installNginx: compute.webServer !== 'rpx',
        })
      : undefined

    // On-box services (database engine, redis, memcached, meilisearch) + the
    // app database/user, host firewall (UFW), automatic system updates, and
    // scheduled backups. PHP boxes default UFW + auto-updates on (Forge-style).
    const phpBox = wantsPhp
    const provisionExtras: string[] = []
    // On-box notifier first, so cron-driven jobs (backups) can call it.
    provisionExtras.push(...buildNotifierScript(config.notifications))
    if (compute.services) {
      provisionExtras.push(
        ...buildServicesProvisionScript(compute.services),
        ...buildDatabaseSetupScript(config.infrastructure?.database, compute.services),
      )
    }
    provisionExtras.push(...buildUfwScript(compute.firewall ?? (phpBox ? { enabled: true } : { enabled: false })))
    provisionExtras.push(...buildAutoUpdatesScript(compute.autoUpdates ?? phpBox))
    provisionExtras.push(...buildMonitoringScript(compute.monitoring ?? phpBox))
    if (compute.backups?.enabled) {
      provisionExtras.push(...buildBackupProvisionScript({
        database: config.infrastructure?.database,
        backups: compute.backups,
      }))
    }
    const servicesProvision = provisionExtras.length > 0 ? provisionExtras : undefined

    const bootstrap = generateUbuntuAppCloudInit({
      runtime: compute.runtime || 'bun',
      runtimeVersion: compute.runtimeVersion || 'latest',
      systemPackages: compute.systemPackages,
      database: config.infrastructure?.database,
      phpProvision,
      servicesProvision,
      rpxProvision,
    })
    const userData = wrapCloudInitUserData(bootstrap)

    const serverType = resolveHetznerServerType(compute.size)
    const image = compute.image || config.hetzner?.image || 'ubuntu-24.04'

    const firewallName = `${slug}-${environment}-app-fw`
    const { firewall } = await this.ensureFirewall(firewallName, labels, buildHetznerFirewallRules({
      // ts-cloud deploys over SSH (SCP + remote systemd setup), so SSH must be
      // reachable. Only close it when the caller explicitly opts out.
      allowSsh: compute.allowSsh !== false,
      sitePorts,
    }))

    const sshKeyId = await this.ensureSshKey(slug, environment, labels)

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

  async getComputeOutputs(options: ProvisionComputeOptions): Promise<ComputeStackOutputs> {
    const stackName = resolveProjectStackName(options.config, options.environment)
    const state = await readDriverState(stackName)
    if (state?.serverId) {
      const server = await this.client.getServer(state.serverId)
      return this.outputsFromState(state, server)
    }

    const targets = await this.findComputeTargets({
      slug: options.config.project.slug,
      environment: options.environment,
      role: 'app',
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
        })

    if (targets.length === 0) {
      throw new Error('No Hetzner compute targets found for release upload')
    }

    const remotePath = `/var/ts-cloud/staging/${options.remoteKey.split('/').pop()}`
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
    return servers
      .filter(server => matchesTsCloudLabels(server.labels, options.slug, options.environment, options.role || 'app'))
      .map(server => ({
        id: String(server.id),
        name: server.name,
        publicIp: server.public_net.ipv4?.ip,
        privateIp: server.private_net?.[0]?.ip,
        status: server.status,
      }))
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
    return servers.find(server =>
      matchesTsCloudLabels(server.labels, slug, environment, 'app') || server.name === serverName,
    )
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
        const out = this.sshExec(host, 'cloud-init status --long 2>/dev/null || cloud-init status 2>/dev/null || echo status:\\ done')
        if (/status:\s*done/.test(out))
          return
        if (/status:\s*error/.test(out))
          throw new Error(`cloud-init reported an error on ${host}:\n${out}`)
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
      appInstanceId: String(state.serverId),
      appPublicIp: server?.public_net.ipv4?.ip || state.publicIp,
      sshUser: state.sshUser || this.sshUser,
    }
  }

  private sshBaseArgs(host: string, extra: string[] = []): string[] {
    return [
      '-i', this.sshPrivateKeyPath,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=yes',
      ...extra,
      `${this.sshUser}@${host}`,
    ]
  }

  private scpToHost(host: string, localPath: string, remotePath: string): void {
    execSync([
      'scp',
      '-i', this.sshPrivateKeyPath,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=yes',
      localPath,
      `${this.sshUser}@${host}:${remotePath}`,
    ].map(arg => `"${arg.replace(/"/g, '\\"')}"`).join(' '), { stdio: 'pipe', maxBuffer: SSH_MAX_BUFFER })
  }

  private sshExec(host: string, script: string): string {
    const escaped = script.replace(/'/g, `'\\''`)
    // A release deploy extracts the full app tarball (often tens of thousands
    // of files), and `tar` happily emits a warning line per oddity. With the
    // default 1MB maxBuffer, execSync kills the SSH child mid-deploy with
    // ENOBUFS, so give the remote command plenty of headroom.
    return execSync(`ssh ${this.sshBaseArgs(host).map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ')} '${escaped}'`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: SSH_MAX_BUFFER,
    })
  }
}

export function resolveHetznerDeployBucketName(slug: string, environment: string): string {
  return resolveDeployBucketName(slug, environment as 'production' | 'staging' | 'development')
}
