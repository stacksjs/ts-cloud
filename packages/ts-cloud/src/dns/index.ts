/**
 * DNS Provider Module
 * Unified DNS management for Route53, Porkbun, and GoDaddy
 */

export * from './types'
export { PorkbunProvider } from './porkbun'
export { GoDaddyProvider } from './godaddy'
export { Route53Provider } from './route53-adapter'
export { UnifiedDnsValidator } from './validator'

import type { DnsProvider, DnsProviderConfig } from './types'
import { GoDaddyProvider } from './godaddy'
import { PorkbunProvider } from './porkbun'
import { Route53Provider } from './route53-adapter'

/**
 * Create a DNS provider from configuration
 */
export function createDnsProvider(config: DnsProviderConfig): DnsProvider {
  switch (config.provider) {
    case 'route53':
      return new Route53Provider(config.region, config.hostedZoneId)

    case 'porkbun':
      return new PorkbunProvider(config.apiKey, config.secretKey)

    case 'godaddy':
      return new GoDaddyProvider(config.apiKey, config.apiSecret, config.environment)

    default:
      throw new Error(`Unknown DNS provider: ${(config as any).provider}`)
  }
}

/**
 * Auto-detect DNS provider for a domain
 * Tries each provider to see which one can manage the domain
 */
export async function detectDnsProvider(
  domain: string,
  configs: DnsProviderConfig[],
): Promise<DnsProvider | null> {
  for (const config of configs) {
    const provider = createDnsProvider(config)
    if (await provider.canManageDomain(domain)) {
      return provider
    }
  }
  return null
}

/**
 * DNS Provider factory with environment variable support
 */
export class DnsProviderFactory {
  private providers: Map<string, DnsProvider> = new Map()
  private configs: DnsProviderConfig[] = []

  /**
   * Add provider configuration
   */
  addConfig(config: DnsProviderConfig): this {
    this.configs.push(config)
    return this
  }

  /**
   * Add Route53 provider
   */
  addRoute53(region?: string, hostedZoneId?: string): this {
    this.configs.push({
      provider: 'route53',
      region,
      hostedZoneId,
    })
    return this
  }

  /**
   * Add Porkbun provider
   */
  addPorkbun(apiKey: string, secretKey: string): this {
    this.configs.push({
      provider: 'porkbun',
      apiKey,
      secretKey,
    })
    return this
  }

  /**
   * Add GoDaddy provider
   */
  addGoDaddy(apiKey: string, apiSecret: string, environment?: 'production' | 'ote'): this {
    this.configs.push({
      provider: 'godaddy',
      apiKey,
      apiSecret,
      environment,
    })
    return this
  }

  /**
   * Load providers from environment variables
   */
  loadFromEnv(): this {
    // Route53 (uses AWS credentials from environment)
    if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_REGION) {
      this.addRoute53(process.env.AWS_REGION)
    }

    // Porkbun
    const porkbunApiKey = process.env.PORKBUN_API_KEY
    const porkbunSecretKey = process.env.PORKBUN_SECRET_KEY
    if (porkbunApiKey && porkbunSecretKey) {
      this.addPorkbun(porkbunApiKey, porkbunSecretKey)
    }

    // GoDaddy
    const godaddyApiKey = process.env.GODADDY_API_KEY
    const godaddyApiSecret = process.env.GODADDY_API_SECRET
    if (godaddyApiKey && godaddyApiSecret) {
      const env = process.env.GODADDY_ENVIRONMENT as 'production' | 'ote' | undefined
      this.addGoDaddy(godaddyApiKey, godaddyApiSecret, env)
    }

    return this
  }

  /**
   * Get a provider by name
   */
  getProvider(name: 'route53' | 'porkbun' | 'godaddy'): DnsProvider | null {
    // Check cache
    const cached = this.providers.get(name)
    if (cached) {
      return cached
    }

    // Find config
    const config = this.configs.find(c => c.provider === name)
    if (!config) {
      return null
    }

    // Create and cache provider
    const provider = createDnsProvider(config)
    this.providers.set(name, provider)
    return provider
  }

  /**
   * Auto-detect provider for a domain
   */
  async getProviderForDomain(domain: string): Promise<DnsProvider | null> {
    for (const config of this.configs) {
      const provider = createDnsProvider(config)
      if (await provider.canManageDomain(domain)) {
        return provider
      }
    }
    return null
  }

  /**
   * Get all configured providers
   */
  getAllProviders(): DnsProvider[] {
    return this.configs.map(config => createDnsProvider(config))
  }
}

/**
 * Default factory instance (can be configured globally)
 */
export const dnsProviders = new DnsProviderFactory()
