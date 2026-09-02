/**
 * The ssh compute driver: deploy to a Linux host you already own.
 *
 * Where the cloud drivers CREATE a box and then deploy to it, this one ADOPTS
 * one. `provisionComputeInfrastructure` therefore means: trust the host key,
 * wait for sshd, run the preflight and refuse a host that cannot work, wait
 * out a cloud-init first boot if one is still going, run the bootstrap (which
 * is idempotent, so a deploy can call this every time), and record what was
 * done. `destroyCompute` forgets the host and touches nothing on it.
 *
 * Everything after adoption is the Hetzner driver's SSH deploy path verbatim
 * (the content-addressed artifact cache, the nonce-scoped staging upload, the
 * per-target deploy with redacted failures), on an injectable transport.
 */
import type {
  CloudConfig,
  CloudDriver,
  ComputeStackOutputs,
  ComputeTarget,
  FindComputeTargetsOptions,
  ProvisionComputeOptions,
  RemoteDeployInstanceResult,
  RemoteDeployResult,
  RunRemoteDeployOptions,
  SshHostConfig,
  UploadReleaseOptions,
  UploadReleaseResult,
} from '@ts-cloud/core'
import type { ValidationFinding } from '../../fleet'
import type { SshDriverState } from '../shared/driver-state'
import type { SshTransport } from '../shared/ssh-transport'
import type { ResolvedSshHost, ResolvedSshSettings, SshLanConfig } from './config'
import type { SshPreflightFacts } from './preflight'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { isIP } from 'node:net'
import { resolveProjectStackName } from '@ts-cloud/core'
import { readDriverState, writeDriverState } from '../shared/driver-state'
import { lanTlsMode, localCaCertPath, usesRpxProxy } from '../shared/rpx-gateway'
import { summarizeRemoteFailures, surfaceRemoteNotices } from '../shared/remote-failure'
import { sshKnownHostsPath, SystemSshTransport } from '../shared/ssh-transport'
import { enabled as vitessEnabled } from '../shared/vitess-provision'
import { assertArchSupported, buildSshBootstrapScript, SSH_BOOTSTRAP_VERSION } from './bootstrap'
import { resolveSshSettings } from './config'
import { evaluatePreflight, formatPreflightFindings, parsePreflightFacts, preflightFailed, SSH_PREFLIGHT_SCRIPT } from './preflight'

/** Where releases are staged and cached on the host; the same paths as every other SSH-style driver. */
export const SSH_DEPLOY_STORAGE_PATH = '/var/ts-cloud/staging'
const ARTIFACT_DIR = '/var/ts-cloud/artifacts'

/** Set to `1` to skip the bootstrap when local state says the current version already ran. */
export const SSH_SKIP_BOOTSTRAP_ENV = 'TS_CLOUD_SSH_SKIP_BOOTSTRAP'

/** Compute keys the ssh provider has no use for: it sizes nothing and images nothing. */
const IGNORED_COMPUTE_KEYS = [
  'size',
  'instances',
  'appServers',
  'servicesServer',
  'loadBalancer',
  'fleet',
  'image',
  'bakedImage',
  'allowSsh',
] as const

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export interface SshDriverOptions {
  hosts?: SshHostConfig[]
  user?: string
  port?: number
  privateKeyPath?: string
  hostKey?: string
  sudo?: boolean
  profile?: string
  publicIp?: string
  lan?: SshLanConfig
  /** Injected transport (tests, or a caller with its own SSH stack). */
  transport?: SshTransport
  /** Tunables for the SSH-readiness / cloud-init wait loops; tiny in tests. */
  bootWait?: {
    /** @default 5000 */
    sshIntervalMs?: number
    /** @default 300000 */
    sshTimeoutMs?: number
    /** @default 5000 */
    cloudInitIntervalMs?: number
    /** @default 600000 */
    cloudInitTimeoutMs?: number
  }
  /** Project root: where state and the pinned host keys live. @default process.cwd() */
  cwd?: string
}

/**
 * The config problems the ssh provider refuses, and the keys it merely ignores.
 *
 * Throws for anything that would make the deploy mean something other than
 * what the config says; returns a warning per sizing key that has no effect
 * here, so an operator who copied a Hetzner config learns which lines are
 * inert instead of wondering why the box did not grow.
 */
export function assertSshComputeConfig(config: CloudConfig, settings: Pick<ResolvedSshSettings, 'hosts' | 'profile'>): string[] {
  if (config.cloud?.attachTo)
    throw new Error('cloud.attachTo is not supported by the ssh provider: it deploys to the hosts in ssh.hosts and nothing else.')
  if (settings.hosts.length > 1)
    throw new Error(`ssh.hosts lists ${settings.hosts.length} hosts; multi-host ssh fleets are not supported yet.`)
  if (vitessEnabled(config.infrastructure?.compute?.managedServices?.vitess)) assertArchSupported(config, settings.profile)

  const compute = (config.infrastructure?.compute ?? {}) as Record<string, unknown>
  return IGNORED_COMPUTE_KEYS.filter((key) => compute[key] !== undefined).map(
    (key) => `infrastructure.compute.${key} has no effect with the ssh provider; the host is what it is.`,
  )
}

export class SshDriver implements CloudDriver {
  readonly name = 'ssh' as const
  readonly usesCloudFormation = false

  private readonly settings: ResolvedSshSettings
  private readonly cwd: string
  private readonly bootWait: Required<NonNullable<SshDriverOptions['bootWait']>>
  private transportInstance?: SshTransport

  constructor(options: SshDriverOptions = {}) {
    // Every ssh setting resolves through one chain (see ./config), so the
    // driver, the CLI and the dashboard cannot disagree about which host a
    // deploy goes to or which key reaches it.
    this.settings = resolveSshSettings(undefined, {
      hosts: options.hosts,
      user: options.user,
      port: options.port,
      privateKeyPath: options.privateKeyPath,
      hostKey: options.hostKey,
      sudo: options.sudo,
      profile: options.profile,
      publicIp: options.publicIp,
      lan: options.lan,
    })
    this.cwd = options.cwd ?? process.cwd()
    this.transportInstance = options.transport
    this.bootWait = {
      sshIntervalMs: options.bootWait?.sshIntervalMs ?? 5000,
      sshTimeoutMs: options.bootWait?.sshTimeoutMs ?? 300000,
      cloudInitIntervalMs: options.bootWait?.cloudInitIntervalMs ?? 5000,
      cloudInitTimeoutMs: options.bootWait?.cloudInitTimeoutMs ?? 600000,
    }
  }

  /** The one host this driver deploys to. */
  private get host(): ResolvedSshHost {
    if (this.settings.hosts.length > 1)
      throw new Error(`ssh.hosts lists ${this.settings.hosts.length} hosts; multi-host ssh fleets are not supported yet.`)
    return this.settings.hosts[0]
  }

  private get transport(): SshTransport {
    if (!this.transportInstance) {
      const host = this.host
      this.transportInstance = new SystemSshTransport({
        user: host.user,
        port: host.port,
        identityFile: host.privateKeyPath,
        hostKey:
          this.settings.hostKey === 'insecure'
            ? 'insecure'
            : { policy: this.settings.hostKey, knownHostsFile: sshKnownHostsPath(this.cwd) },
      })
    }
    return this.transportInstance
  }

  /** Run a script on the host as root (through sudo when the user is not root). */
  private exec(host: string, script: string): Promise<string> {
    return this.transport.exec(host, script, { sudo: this.settings.sudo })
  }

  async findComputeTargets(options: FindComputeTargetsOptions): Promise<ComputeTarget[]> {
    // One host plays every role there is; answer only app-role queries so a
    // caller probing for a dedicated lb or services box (the rpx fleet reload,
    // for one) is told there is none rather than handed the app host twice.
    if ((options.role || 'app') !== 'app') return []
    const { host } = this.host
    return [{ id: host, name: host, publicIp: host, status: 'running' }]
  }

  async getComputeOutputs(): Promise<ComputeStackOutputs> {
    const { host, user } = this.host
    return {
      appInstanceId: host,
      appPublicIp: host,
      sshUser: user,
      deployStoragePath: SSH_DEPLOY_STORAGE_PATH,
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

    if (targets.length === 0) throw new Error('No ssh compute targets found for release upload')

    // Keep the site and a per-upload nonce in the staging filename: every site
    // sharing a commit SHA would otherwise upload to ONE staging file and a
    // later site's upload would clobber an earlier site's tarball before its
    // extract ran. The nonce also isolates two deploys of the same site + SHA,
    // whose uploads happen before the per-site deploy lock is acquired.
    const stagingStem = options.remoteKey.replace(/^releases\//, '').replace(/\.tar\.gz$/, '').replace(/\//g, '-')
    const stagingName = `${stagingStem}-${randomUUID()}.tar.gz`
    const remotePath = `${SSH_DEPLOY_STORAGE_PATH}/${stagingName}`
    const digest = await sha256File(options.localPath)
    const cachedPath = `${ARTIFACT_DIR}/${digest}.tar.gz`

    for (const target of targets) {
      if (!target.publicIp) throw new Error(`Target ${target.id} has no address for SCP upload`)

      // One immutable, content-addressed copy on the host; each site is staged
      // from it with a host-local copy. Second and later site uploads of the
      // same tree cost milliseconds instead of a WAN transfer.
      const stageCached = [
        'set -euo pipefail',
        `mkdir -p ${shellQuote(ARTIFACT_DIR)} ${shellQuote(SSH_DEPLOY_STORAGE_PATH)}`,
        `test -s ${shellQuote(cachedPath)}`,
        `cp -- ${shellQuote(cachedPath)} ${shellQuote(remotePath)}`,
      ].join('\n')
      try {
        await this.exec(target.publicIp, stageCached)
        continue
      } catch {
        // Cache miss: upload to a nonce-scoped temporary name, atomically
        // publish it, then copy it to this deployment's unique staging path.
      }

      const uploadPath = `${ARTIFACT_DIR}/.${digest}-${randomUUID()}.tmp`
      await this.transport.scp(target.publicIp, options.localPath, uploadPath)
      await this.exec(
        target.publicIp,
        [
          'set -euo pipefail',
          `chmod 600 ${shellQuote(uploadPath)}`,
          `mv -f -- ${shellQuote(uploadPath)} ${shellQuote(cachedPath)}`,
          `cp -- ${shellQuote(cachedPath)} ${shellQuote(remotePath)}`,
          `find ${shellQuote(ARTIFACT_DIR)} -type f -name '*.tar.gz' -mtime +7 -delete 2>/dev/null || true`,
        ].join('\n'),
      )
    }

    return { artifactRef: remotePath }
  }

  async runRemoteDeploy(options: RunRemoteDeployOptions): Promise<RemoteDeployResult> {
    if (options.targets.length === 0) {
      return { success: false, instanceCount: 0, perInstance: [], error: 'No targets provided' }
    }

    const script = options.commands.join('\n')
    const perInstance: RemoteDeployInstanceResult[] = []

    for (const target of options.targets) {
      if (!target.publicIp) {
        perInstance.push({ instanceId: target.id, status: 'Failed', error: 'Missing address' })
        continue
      }
      try {
        const output = await this.exec(target.publicIp, script)
        surfaceRemoteNotices(output)
        perInstance.push({ instanceId: target.id, status: 'Success', output })
      } catch (error) {
        perInstance.push({ instanceId: target.id, status: 'Failed', error: (error as Error).message })
      }
    }

    const success = perInstance.every((result) => result.status === 'Success')
    return {
      success,
      instanceCount: options.targets.length,
      perInstance,
      // Carry the failing host's remote output into the error itself: callers
      // report `result.error` and nothing else.
      error: success ? undefined : summarizeRemoteFailures(perInstance, 'One or more SSH deploy commands failed'),
    }
  }

  /** The configured host name or address, for a caller that wants to print it. */
  targetHost(): string {
    return this.host.host
  }

  /** Learn (and, when pinning, record) the host key. The adopt does this first; the preflight command too. */
  ensureHostKey(host: string = this.host.host): Promise<{ fingerprint: string; pinnedNow: boolean }> {
    return this.transport.ensureHostKey(host)
  }

  /**
   * Probe the host as the deploy user and judge the result. Public so the
   * `ssh:preflight` command and the adopt share one definition of "ready".
   */
  async preflight(host: string = this.host.host): Promise<{ facts: SshPreflightFacts; findings: ValidationFinding[] }> {
    // WITHOUT sudo: `sudoOk` is one of the questions.
    const output = await this.transport.exec(host, SSH_PREFLIGHT_SCRIPT, { sudo: false })
    const facts = parsePreflightFacts(output)
    return { facts, findings: evaluatePreflight(facts, { user: this.host.user, profile: this.settings.profile }) }
  }

  /**
   * Adopt the host: pin, wait, check, bootstrap, record. Idempotent, and
   * cheap after the first run because the bootstrap guards itself.
   */
  async provisionComputeInfrastructure(options: ProvisionComputeOptions): Promise<ComputeStackOutputs> {
    const { config, environment } = options
    for (const warning of assertSshComputeConfig(config, this.settings)) {
      // eslint-disable-next-line no-console
      console.warn(`[ts-cloud] ${warning}`)
    }

    const target = this.host
    const stackName = resolveProjectStackName(config, environment)
    const existing = await readDriverState<SshDriverState>(stackName, this.cwd)
    const skipBootstrap =
      process.env[SSH_SKIP_BOOTSTRAP_ENV] === '1' &&
      existing?.provider === 'ssh' &&
      existing.host === target.host &&
      existing.bootstrapVersion === SSH_BOOTSTRAP_VERSION

    const hostKey = await this.ensureHostKey(target.host)
    if (hostKey.pinnedNow) {
      // eslint-disable-next-line no-console
      console.warn(`[ts-cloud] pinned ${target.host} host key ${hostKey.fingerprint}`)
    }

    await this.waitForSshReady(target.host)

    const { facts, findings } = await this.preflight(target.host)
    if (preflightFailed(findings)) {
      throw new Error(`Preflight failed for ${target.host}; refusing to bootstrap it.\n${formatPreflightFindings(findings)}`)
    }
    for (const finding of findings) {
      // eslint-disable-next-line no-console
      console.warn(`[ts-cloud] ${finding.severity}: ${finding.message}`)
    }

    // A host still on its cloud-init first boot is mid-install: apt is locked
    // and users may not exist yet. Only wait when cloud-init is actually
    // present AND running; a finished or absent cloud-init needs no wait.
    if (facts.cloudInitPresent && /running/i.test(facts.cloudInitStatus ?? '')) await this.waitForCloudInit(target.host)

    // The address the LAN certificate can carry as an iPAddress SAN. The
    // preflight's `hostname -I` is the box's own answer and so the first
    // choice; a host configured as a bare address is the fallback, because
    // that address is demonstrably one this machine answers on. Nothing else
    // is guessed: no SAN at all beats a wrong one.
    const lanIp = facts.lanIp?.trim() || (isIP(target.host) !== 0 ? target.host : undefined)

    let bootstrappedAt = existing?.provider === 'ssh' ? existing.bootstrappedAt : undefined
    if (!skipBootstrap) {
      const script = buildSshBootstrapScript({
        config,
        environment,
        profile: this.settings.profile,
        facts,
        sudoUser: target.user !== 'root' ? target.user : undefined,
        lan: this.settings.lan,
        lanIp,
      })
      surfaceRemoteNotices(await this.exec(target.host, script))
      bootstrappedAt = new Date().toISOString()
    }

    const state: SshDriverState = {
      provider: 'ssh',
      stackName,
      host: target.host,
      sshUser: target.user,
      sshPort: target.port,
      hostKeyFingerprint: hostKey.fingerprint || undefined,
      publicIp: this.settings.publicIp === 'auto' ? undefined : this.settings.publicIp,
      lanIp: facts.lanIp || undefined,
      deployStoragePath: SSH_DEPLOY_STORAGE_PATH,
      profile: this.settings.profile,
      bootstrapVersion: SSH_BOOTSTRAP_VERSION,
      bootstrappedAt,
    }
    await writeDriverState(stackName, state, this.cwd)

    const outputs = await this.getComputeOutputs()
    // A LAN box's certificate chains to a CA that exists only on that box, so
    // the deploy is not finished for a human until they know where to fetch
    // it. Additive: a caller that ignores the field sees exactly what it saw
    // before, and the path is absent whenever no local CA is configured.
    if (usesRpxProxy(config.infrastructure?.compute) && lanTlsMode(this.settings.lan) === 'local-ca') {
      outputs.lanCaCertPath = localCaCertPath()
      // eslint-disable-next-line no-console
      console.warn(
        `[ts-cloud] LAN certificate authority on ${target.host} at ${outputs.lanCaCertPath}. `
        + `Fetch it with: scp ${target.user}@${target.host}:${outputs.lanCaCertPath} ./rpx-root-ca.crt`,
      )
    }
    return outputs
  }

  /**
   * Forget the host. Nothing on it is removed: it was never ts-cloud's to
   * remove, and a teardown that wiped an operator's Pi would be a much worse
   * surprise than one that left a gateway running.
   */
  async destroyCompute(options: ProvisionComputeOptions): Promise<{ destroyed: string[] }> {
    const stackName = resolveProjectStackName(options.config, options.environment)
    const target = this.host
    // eslint-disable-next-line no-console
    console.warn(
      `[ts-cloud] forgot ${target.host} for ${stackName}; nothing was removed on the host (stop the systemd units and remove /var/ts-cloud and /etc/rpx by hand if you want it clean).`,
    )
    await writeDriverState(
      stackName,
      { provider: 'ssh', stackName, host: target.host, sshUser: target.user, sshPort: target.port },
      this.cwd,
    ).catch(() => {})
    return { destroyed: [`local state for ${stackName}`] }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async waitForSshReady(host: string): Promise<void> {
    const { sshIntervalMs, sshTimeoutMs } = this.bootWait
    const start = Date.now()
    do {
      if (await this.transport.probe(host)) return
      await this.sleep(sshIntervalMs)
    } while (Date.now() - start < sshTimeoutMs)
    throw new Error(`Timed out waiting for SSH on ${host} after ${sshTimeoutMs}ms`)
  }

  private async waitForCloudInit(host: string): Promise<void> {
    const { cloudInitIntervalMs, cloudInitTimeoutMs } = this.bootWait
    const start = Date.now()
    while (Date.now() - start < cloudInitTimeoutMs) {
      try {
        // `cloud-init status` exits non-zero on error/degraded; probe once,
        // tolerate the exit code, and read the status line.
        const out = await this.transport.exec(
          host,
          `if command -v cloud-init >/dev/null 2>&1; then cloud-init status --long 2>/dev/null || true; else echo 'status: done'; fi`,
          { sudo: false },
        )
        if (/status:\s*error/.test(out)) throw new Error(`cloud-init reported an error on ${host}:\n${out}`)
        if (/status:\s*(?:done|degraded)/.test(out)) return
      } catch (error) {
        if (error instanceof Error && /cloud-init reported an error/.test(error.message)) throw error
      }
      await this.sleep(cloudInitIntervalMs)
    }
    throw new Error(`Timed out waiting for cloud-init to finish on ${host} after ${cloudInitTimeoutMs}ms`)
  }
}
