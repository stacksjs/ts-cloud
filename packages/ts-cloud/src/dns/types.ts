/**
 * DNS Provider Types
 * Common interfaces for DNS provider abstraction
 */

/**
 * `ALIAS` is a provider-specific CNAME-like record permitted at a zone apex
 * (Porkbun, DNSimple, Route53's ALIAS). It is included because ts-cloud has to
 * *see* one to manage a zone correctly, not because it writes them: Porkbun
 * puts a parking `ALIAS` on the apex of every new domain, and an apex `A`
 * written while that exists is accepted and then silently discarded.
 */
export type DnsRecordType = 'A' | 'AAAA' | 'ALIAS' | 'CNAME' | 'TXT' | 'MX' | 'NS' | 'SRV' | 'CAA'

export interface DnsRecord {
  name: string
  type: DnsRecordType
  content: string
  /** Alias for content - some providers use 'value' instead */
  value?: string
  ttl?: number
  priority?: number // For MX and SRV records
  weight?: number // For SRV records
  port?: number // For SRV records
}

export interface DnsRecordResult extends DnsRecord {
  id?: string
}

export interface CreateRecordResult {
  success: boolean
  id?: string
  message?: string
}

export interface DeleteRecordResult {
  success: boolean
  message?: string
}

export interface ListRecordsResult {
  success: boolean
  records: DnsRecordResult[]
  message?: string
}

/**
 * Common DNS Provider interface
 * All DNS providers (Route53, Porkbun, GoDaddy, etc.) implement this
 */
export interface DnsProvider {
  /**
   * Provider name for logging/identification
   */
  readonly name: string

  /**
   * Create a DNS record
   */
  createRecord(domain: string, record: DnsRecord): Promise<CreateRecordResult>

  /**
   * Update an existing DNS record (upsert behavior)
   */
  upsertRecord(domain: string, record: DnsRecord): Promise<CreateRecordResult>

  /**
   * Delete a DNS record
   */
  deleteRecord(domain: string, record: DnsRecord): Promise<DeleteRecordResult>

  /**
   * List all DNS records for a domain
   */
  listRecords(domain: string, type?: DnsRecordType): Promise<ListRecordsResult>

  /**
   * Check if the provider can manage this domain
   */
  canManageDomain(domain: string): Promise<boolean>

  /**
   * List all domains managed by this provider
   * Returns an array of domain names (e.g., ['example.com', 'mysite.org'])
   */
  listDomains(): Promise<string[]>
}

/**
 * DNS Provider configuration types
 */
export interface Route53ProviderConfig {
  provider: 'route53'
  region?: string
  hostedZoneId?: string // Optional - will be auto-discovered if not provided
}

export interface PorkbunProviderConfig {
  provider: 'porkbun'
  apiKey: string
  secretKey: string
}

export interface GoDaddyProviderConfig {
  provider: 'godaddy'
  apiKey: string
  apiSecret: string
  environment?: 'production' | 'ote' // OTE = test environment
}

export interface CloudflareProviderConfig {
  provider: 'cloudflare'
  apiToken: string // API Token (recommended) - create at https://dash.cloudflare.com/profile/api-tokens
}

export type DnsProviderConfig =
  Route53ProviderConfig | PorkbunProviderConfig | GoDaddyProviderConfig | CloudflareProviderConfig

/**
 * Extended configuration for certificate validation
 */
export interface CertificateValidationConfig {
  provider: DnsProviderConfig
  waitForValidation?: boolean
  maxWaitMinutes?: number
}
