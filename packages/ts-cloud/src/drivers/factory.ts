import type { CloudConfig, CloudDriver, DeployProviderName } from '@ts-cloud/core'
import { resolveCloudProvider } from '@ts-cloud/core'
import { AwsDriver } from './aws/driver'
import { HetznerDriver } from './hetzner/driver'
import { isBoxMode, LocalBoxDriver } from './local-box/driver'
import { SshDriver } from './ssh/driver'

export interface CreateCloudDriverOptions {
  config: CloudConfig
  provider?: DeployProviderName
}

/**
 * Create a cloud infrastructure driver from configuration.
 *
 * In box mode (`TS_CLOUD_DASHBOARD_BOX`), every driver resolves to the
 * {@link LocalBoxDriver} so the on-box management dashboard runs its metrics
 * scripts and operations against localhost instead of reaching out over SSH/SSM.
 */
export function createCloudDriver(options: CreateCloudDriverOptions): CloudDriver {
  if (isBoxMode()) return new LocalBoxDriver()

  const provider = options.provider ?? resolveCloudProvider(options.config)

  switch (provider) {
    case 'aws':
      return new AwsDriver({ region: options.config.project.region })
    case 'hetzner':
      // Pass every `hetzner.*` field through: a field the factory forgets is a
      // field the user can set and nothing reads. (`image` is resolved from the
      // config directly, per-call, since compute.image can override it.)
      return new HetznerDriver({
        apiToken: options.config.hetzner?.apiToken,
        allowStateOnly: Boolean(options.config.cloud?.attachTo),
        sshPrivateKeyPath: options.config.hetzner?.sshPrivateKeyPath,
        sshPublicKeyPath: options.config.hetzner?.sshPublicKeyPath,
        sshUser: options.config.hetzner?.sshUser,
        location: options.config.hetzner?.location,
      })
    case 'ssh':
      // Same rule: every `ssh.*` field goes through, or setting it does nothing.
      return new SshDriver({
        hosts: options.config.ssh?.hosts,
        hostKey: options.config.ssh?.hostKey,
        sudo: options.config.ssh?.sudo,
        profile: options.config.ssh?.profile,
        publicIp: options.config.ssh?.publicIp,
        lan: options.config.ssh?.lan,
      })
    case 'fly':
      // A Fly app is a container image on Machines: there is no box to
      // provision, ship a tarball to, or reach over SSH, which is all a
      // CloudDriver does. It deploys through deployToFly() instead.
      throw new Error('Fly.io has no box to provision or reach over SSH: deploy it with deployToFly() from @stacksjs/ts-cloud.')
    default:
      throw new Error(`Unknown cloud provider: ${(options.provider ?? resolveCloudProvider(options.config)) as string}`)
  }
}

/**
 * Factory with caching — mirrors DnsProviderFactory.
 */
export class CloudDriverFactory {
  private drivers = new Map<string, CloudDriver>()

  getDriver(config: CloudConfig, provider?: DeployProviderName): CloudDriver {
    const name = provider ?? resolveCloudProvider(config)
    const cacheKey = `${name}:${config.project.slug}:${config.project.region || 'default'}`
    const cached = this.drivers.get(cacheKey)
    if (cached) return cached

    const driver = createCloudDriver({ config, provider: name })
    this.drivers.set(cacheKey, driver)
    return driver
  }
}

export const cloudDrivers: CloudDriverFactory = new CloudDriverFactory()
