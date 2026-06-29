import type { CloudConfig, CloudDriver, CloudProviderName } from '@ts-cloud/core'
import { resolveCloudProvider } from '@ts-cloud/core'
import { AwsDriver } from './aws/driver'
import { HetznerDriver } from './hetzner/driver'
import { isBoxMode, LocalBoxDriver } from './local-box/driver'

export interface CreateCloudDriverOptions {
  config: CloudConfig
  provider?: CloudProviderName
}

/**
 * Create a cloud infrastructure driver from configuration.
 *
 * In box mode (`TS_CLOUD_DASHBOARD_BOX`), every driver resolves to the
 * {@link LocalBoxDriver} so the on-box management dashboard runs its metrics
 * scripts and operations against localhost instead of reaching out over SSH/SSM.
 */
export function createCloudDriver(options: CreateCloudDriverOptions): CloudDriver {
  if (isBoxMode())
    return new LocalBoxDriver()

  const provider = options.provider ?? resolveCloudProvider(options.config)

  switch (provider) {
    case 'aws':
      return new AwsDriver({ region: options.config.project.region })
    case 'hetzner':
      return new HetznerDriver({
        apiToken: options.config.hetzner?.apiToken,
        sshPrivateKeyPath: options.config.hetzner?.sshPrivateKeyPath,
        sshUser: options.config.hetzner?.sshUser,
        location: options.config.hetzner?.location,
      })
    default:
      throw new Error(`Unknown cloud provider: ${(options.provider ?? resolveCloudProvider(options.config)) as string}`)
  }
}

/**
 * Factory with caching — mirrors DnsProviderFactory.
 */
export class CloudDriverFactory {
  private drivers = new Map<string, CloudDriver>()

  getDriver(config: CloudConfig, provider?: CloudProviderName): CloudDriver {
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
