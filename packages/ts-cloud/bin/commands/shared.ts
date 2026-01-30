import { existsSync } from 'node:fs'
import type { CloudConfig } from '@ts-cloud/types'
import { loadCloudConfig } from '../../src/config'
import { createDnsProvider, DnsProviderFactory } from '../../src/dns'
import type { DnsProviderConfig, DnsProvider } from '../../src/dns/types'

/**
 * Load and validate the cloud config, ensuring project config exists.
 * Returns the config with project guaranteed to exist.
 */
export async function loadValidatedConfig(): Promise<CloudConfig> {
  const cloudConfig = await loadCloudConfig()
  if (!cloudConfig.project) {
    throw new Error('Missing required project configuration in cloud.config.ts')
  }
  return cloudConfig as CloudConfig
}

/**
 * Resolve DNS provider configuration from CLI options and environment variables
 */
export function resolveDnsProviderConfig(providerName?: string): DnsProviderConfig | null {
  // Explicit provider from CLI option
  if (providerName) {
    switch (providerName.toLowerCase()) {
      case 'porkbun': {
        const apiKey = process.env.PORKBUN_API_KEY
        const secretKey = process.env.PORKBUN_SECRET_KEY
        if (!apiKey || !secretKey) {
          throw new Error('PORKBUN_API_KEY and PORKBUN_SECRET_KEY environment variables are required for Porkbun provider')
        }
        return { provider: 'porkbun', apiKey, secretKey }
      }
      case 'godaddy': {
        const apiKey = process.env.GODADDY_API_KEY
        const apiSecret = process.env.GODADDY_API_SECRET
        if (!apiKey || !apiSecret) {
          throw new Error('GODADDY_API_KEY and GODADDY_API_SECRET environment variables are required for GoDaddy provider')
        }
        const environment = (process.env.GODADDY_ENVIRONMENT as 'production' | 'ote') || 'production'
        return { provider: 'godaddy', apiKey, apiSecret, environment }
      }
      case 'route53': {
        const region = process.env.AWS_REGION || 'us-east-1'
        const hostedZoneId = process.env.AWS_HOSTED_ZONE_ID
        return { provider: 'route53', region, hostedZoneId }
      }
      default:
        throw new Error(`Unknown DNS provider: ${providerName}. Supported: porkbun, godaddy, route53`)
    }
  }

  // Auto-detect from environment
  const factory = new DnsProviderFactory().loadFromEnv()
  const providers = factory.getAllProviders()

  if (providers.length === 0) {
    return null
  }

  // Return the first configured provider's config
  if (process.env.PORKBUN_API_KEY && process.env.PORKBUN_SECRET_KEY) {
    return {
      provider: 'porkbun',
      apiKey: process.env.PORKBUN_API_KEY,
      secretKey: process.env.PORKBUN_SECRET_KEY,
    }
  }
  if (process.env.GODADDY_API_KEY && process.env.GODADDY_API_SECRET) {
    return {
      provider: 'godaddy',
      apiKey: process.env.GODADDY_API_KEY,
      apiSecret: process.env.GODADDY_API_SECRET,
      environment: (process.env.GODADDY_ENVIRONMENT as 'production' | 'ote') || 'production',
    }
  }
  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_REGION) {
    return {
      provider: 'route53',
      region: process.env.AWS_REGION || 'us-east-1',
      hostedZoneId: process.env.AWS_HOSTED_ZONE_ID,
    }
  }

  return null
}

/**
 * Get a DNS provider instance from configuration
 */
export function getDnsProvider(providerName?: string): DnsProvider {
  const config = resolveDnsProviderConfig(providerName)
  if (!config) {
    throw new Error('No DNS provider configured. Set environment variables for Porkbun (PORKBUN_API_KEY, PORKBUN_SECRET_KEY), GoDaddy (GODADDY_API_KEY, GODADDY_API_SECRET), or Route53 (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)')
  }
  return createDnsProvider(config)
}
