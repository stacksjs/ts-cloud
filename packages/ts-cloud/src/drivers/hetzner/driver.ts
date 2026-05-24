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
import { buildCaddyfile } from '../shared/caddyfile'
import { HetznerClient, resolveHetznerApiToken } from './client'
import { generateUbuntuAppCloudInit, wrapCloudInitUserData } from './cloud-init'
import { buildHetznerFirewallRules } from './firewall-rules'
import { matchesTsCloudLabels, resolveHetznerServerType, tsCloudLabels } from './instance-sizes'
import { readDriverState, writeDriverState, type HetznerDriverState } from './state'

export interface HetznerDriverOptions {
  apiToken?: string
  sshPrivateKeyPath?: string
  sshUser?: string
  location?: string
  client?: HetznerClient
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

export class HetznerDriver implements CloudDriver {
  readonly name = 'hetzner' as const
  readonly usesCloudFormation = false

  private client: HetznerClient
  private sshPrivateKeyPath: string
  private sshUser: string
  private location: string

  constructor(options: HetznerDriverOptions = {}) {
    this.client = options.client ?? new HetznerClient({
      apiToken: resolveHetznerApiToken(options.apiToken),
    })
    this.sshPrivateKeyPath = expandHome(options.sshPrivateKeyPath || process.env.HCLOUD_SSH_KEY || '~/.ssh/id_ed25519')
    this.sshUser = options.sshUser || process.env.HCLOUD_SSH_USER || 'root'
    this.location = options.location || process.env.HCLOUD_LOCATION || 'fsn1'
  }

  async provisionComputeInfrastructure(options: ProvisionComputeOptions): Promise<ComputeStackOutputs> {
    const { config, environment } = options
    const slug = config.project.slug
    const compute = config.infrastructure?.compute
    if (!compute) {
      throw new Error('infrastructure.compute is required to provision Hetzner compute')
    }

    const stackName = resolveProjectStackName(config, environment)
    const existing = await readDriverState(stackName)
    if (existing?.serverId) {
      const server = await this.client.getServer(existing.serverId)
      if (server.status !== 'off') {
        return this.outputsFromState(existing, server)
      }
    }

    const sites = config.sites || {}
    const sitePorts = Object.values(sites)
      .map(site => site.port)
      .filter((port): port is number => typeof port === 'number' && ![80, 443].includes(port))

    const caddyfile = buildCaddyfile(sites)
    const bootstrap = generateUbuntuAppCloudInit({
      runtime: compute.runtime || 'bun',
      runtimeVersion: compute.runtimeVersion || 'latest',
      systemPackages: compute.systemPackages,
      database: config.infrastructure?.database,
      caddyfile,
    })
    const userData = wrapCloudInitUserData(bootstrap)

    const serverName = `${slug}-${environment}-app`
    const serverType = resolveHetznerServerType(compute.size)
    const image = compute.image || config.hetzner?.image || 'ubuntu-24.04'
    const labels = tsCloudLabels(slug, environment, 'app')

    const firewallName = `${slug}-${environment}-app-fw`
    const { firewall } = await this.client.createFirewall({
      name: firewallName,
      labels,
      rules: buildHetznerFirewallRules({
        allowSsh: compute.allowSsh,
        sitePorts,
      }),
    })

    const { server, action } = await this.client.createServer({
      name: serverName,
      serverType,
      image,
      location: config.hetzner?.location || this.location,
      userData,
      labels,
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

  private outputsFromState(state: HetznerDriverState, server?: { public_net: { ipv4?: { ip: string } } }): ComputeStackOutputs {
    return {
      deployStoragePath: state.deployStoragePath || '/var/ts-cloud/staging',
      appInstanceId: String(state.serverId),
      appPublicIp: server?.public_net.ipv4?.ip || state.publicIp,
      sshUser: state.sshUser || this.sshUser,
    }
  }

  private sshBaseArgs(host: string): string[] {
    return [
      '-i', this.sshPrivateKeyPath,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=yes',
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
    ].map(arg => `"${arg.replace(/"/g, '\\"')}"`).join(' '), { stdio: 'pipe' })
  }

  private sshExec(host: string, script: string): string {
    const escaped = script.replace(/'/g, `'\\''`)
    return execSync(`ssh ${this.sshBaseArgs(host).map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ')} '${escaped}'`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  }
}

export function resolveHetznerDeployBucketName(slug: string, environment: string): string {
  return resolveDeployBucketName(slug, environment as 'production' | 'staging' | 'development')
}
