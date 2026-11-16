/**
 * DNS Provider Module
 * Unified DNS management for Route53, Porkbun, and GoDaddy
 */

export * from './types'
export { PorkbunProvider } from './porkbun'
export { GoDaddyProvider } from './godaddy'
export { CloudflareProvider } from './cloudflare'
export type {
  DeclaredRecord,
  DeclaredRecordInput,
  DeclaredRecordOutcome,
  DeclaredRecordsReport,
} from './declared-records'
export {
  policyTag,
  qualifyName,
  reconcileDeclaredRecords,
  resolveDeclaredRecords,
} from './declared-records'
export type {
  DelegationOptions,
  DelegationRecordOutcome,
  DelegationReport,
  DelegationStatus,
  NameserverRegistrar,
  ZoneHost,
} from './delegation'
export {
  delegateZone,
  isNameserverRegistrar,
  isZoneHost,
  sameNameservers,
} from './delegation'
export type {
  DelegationConfig,
  DelegationCredentials,
  DelegationSkipped,
  ZoneSettingsConfig,
  ZoneSettingsReport,
} from './delegate-from-config'
export {
  applyDeclaredZoneSettings,
  delegateZoneFromConfig,
  describeDelegation,
  describeZoneSettings,
} from './delegate-from-config'
export { Route53Provider } from './route53-adapter'
export type {
  MigratedRecord,
  SkippedRecord,
  ZoneMigrationPlan,
  ZoneMigrationReport,
  ZoneParityReport,
} from './zone-migration'
export {
  applyZoneMigration,
  exportRoute53Zone,
  planZoneMigration,
  verifyZoneParity,
} from './zone-migration'
export {
  UnifiedDnsValidator,
  createPorkbunValidator,
  createGoDaddyValidator,
  createRoute53Validator,
} from './validator'

import type { DnsProvider, DnsProviderConfig } from './types'
import { CloudflareProvider } from './cloudflare'
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

    case 'cloudflare':
      return new CloudflareProvider(config.apiToken, { zoneId: config.zoneId, accountId: config.accountId })

    default:
      throw new Error(`Unknown DNS provider: ${(config as any).provider}`)
  }
}

/** Which provider a nameserver belongs to, by the name it is served under. */
const NAMESERVER_OWNERS: Array<{ provider: DnsProvider['name'], pattern: RegExp }> = [
  { provider: 'cloudflare', pattern: /\.ns\.cloudflare\.com$/ },
  { provider: 'route53', pattern: /\.awsdns-\d+\./ },
  { provider: 'porkbun', pattern: /\.porkbun\.com$/ },
  { provider: 'godaddy', pattern: /\.domaincontrol\.com$/ },
]

/** The provider whose nameservers these are, or undefined when they are nobody's we know. */
export function providerOfNameservers(nameservers: readonly string[]): string | undefined {
  const names = nameservers.map(name => name.replace(/\.$/, '').toLowerCase())
  return NAMESERVER_OWNERS.find(owner => names.some(name => owner.pattern.test(name)))?.provider
}

/** Looks a domain's nameservers up. Injectable, so a test needs no network. */
export type NameserverLookup = (domain: string) => Promise<string[]>

const lookupNameservers: NameserverLookup = async (domain) => {
  const { resolveNs } = await import('node:dns/promises')
  return resolveNs(domain)
}

/**
 * Find the provider that serves a domain's zone, among the configured ones.
 *
 * Two things this must not get wrong, and used to:
 *
 * - One provider that cannot answer is not the end of the search. Credentials
 *   for a provider the project does not use (an AWS profile on the machine, a
 *   revoked token) made the first probe throw, and the throw ended the lookup
 *   with "no provider" although the next one in line held the zone.
 * - More than one provider can say yes. A registrar still manages a domain
 *   whose zone has moved elsewhere, and a record written to its copy is
 *   written where nothing looks. So when several claim the domain, the one
 *   its nameservers actually point at wins.
 */
export async function detectDnsProvider(
  domain: string,
  configs: DnsProviderConfig[],
  options: { nameservers?: NameserverLookup } = {},
): Promise<DnsProvider | null> {
  const candidates: DnsProvider[] = []
  for (const config of configs) {
    try {
      candidates.push(createDnsProvider(config))
    } catch {
      // Credentials that cannot even build a provider are not a candidate.
    }
  }
  return servingProvider(domain, candidates, options)
}

/** {@link detectDnsProvider}, over providers already built. */
export async function servingProvider(
  domain: string,
  candidates: readonly DnsProvider[],
  options: { nameservers?: NameserverLookup } = {},
): Promise<DnsProvider | null> {
  const claims: DnsProvider[] = []
  for (const provider of candidates) {
    try {
      if (await provider.canManageDomain(domain)) claims.push(provider)
    } catch {
      // Cannot answer: not this one.
    }
  }

  if (claims.length <= 1) return claims[0] ?? null

  try {
    const zone = domain.replace(/\.$/, '').split('.').slice(-2).join('.')
    const serving = providerOfNameservers(await (options.nameservers ?? lookupNameservers)(zone))
    return claims.find(provider => provider.name === serving) ?? claims[0]
  } catch {
    return claims[0]
  }
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
   * Add Cloudflare provider
   */
  addCloudflare(apiToken: string, options: { zoneId?: string, accountId?: string } = {}): this {
    this.configs.push({
      provider: 'cloudflare',
      apiToken,
      zoneId: options.zoneId,
      accountId: options.accountId,
    })
    return this
  }

  /**
   * Load providers from environment variables
   */
  loadFromEnv(): this {
    // Route53 (uses AWS credentials from environment)
    // A profile counts too: --profile clears the environment keys in its favor.
    if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_REGION) {
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

    // Cloudflare. The zone id is optional but is what allows a token scoped to
    // a single zone — without it the provider has to list zones by name, which
    // needs account-wide Zone:Read.
    const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN
    if (cloudflareApiToken) {
      this.addCloudflare(cloudflareApiToken, {
        zoneId: process.env.CLOUDFLARE_ZONE_ID,
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      })
    }

    return this
  }

  /**
   * Get a provider by name
   */
  getProvider(name: 'route53' | 'porkbun' | 'godaddy' | 'cloudflare'): DnsProvider | null {
    // Check cache
    const cached = this.providers.get(name)
    if (cached) {
      return cached
    }

    // Find config
    const config = this.configs.find((c) => c.provider === name)
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
  async getProviderForDomain(domain: string, options: { nameservers?: NameserverLookup } = {}): Promise<DnsProvider | null> {
    return detectDnsProvider(domain, this.configs, options)
  }

  /**
   * Get all configured providers
   */
  getAllProviders(): DnsProvider[] {
    return this.configs.map((config) => createDnsProvider(config))
  }
}

/**
 * Default factory instance (can be configured globally)
 */
export const dnsProviders: DnsProviderFactory = new DnsProviderFactory()
