/**
 * GoDaddy DNS Provider
 * API documentation: https://developer.godaddy.com/doc/endpoint/domains
 */

import type {
  CreateRecordResult,
  DeleteRecordResult,
  DnsProvider,
  DnsRecord,
  DnsRecordResult,
  DnsRecordType,
  ListRecordsResult,
} from './types'

const GODADDY_API_URL = 'https://api.godaddy.com'
const GODADDY_OTE_API_URL = 'https://api.ote-godaddy.com' // Test environment

interface GoDaddyRecord {
  type: string
  name: string
  data: string
  ttl: number
  priority?: number
}

export class GoDaddyProvider implements DnsProvider {
  readonly name = 'godaddy'
  private apiKey: string
  private apiSecret: string
  private baseUrl: string

  constructor(
    apiKey: string,
    apiSecret: string,
    environment: 'production' | 'ote' = 'production',
  ) {
    this.apiKey = apiKey
    this.apiSecret = apiSecret
    this.baseUrl = environment === 'ote' ? GODADDY_OTE_API_URL : GODADDY_API_URL
  }

  /**
   * Make an authenticated API request to GoDaddy
   */
  private async request<T>(
    method: string,
    endpoint: string,
    body?: any,
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`

    const headers: Record<string, string> = {
      'Authorization': `sso-key ${this.apiKey}:${this.apiSecret}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    }

    const options: RequestInit = {
      method,
      headers,
    }

    if (body) {
      options.body = JSON.stringify(body)
    }

    const response = await fetch(url, options)

    // GoDaddy returns 204 for successful DELETE operations
    if (response.status === 204) {
      return {} as T
    }

    // For successful requests with content
    if (response.ok) {
      const text = await response.text()
      if (text) {
        return JSON.parse(text) as T
      }
      return {} as T
    }

    // Handle errors
    let errorMessage = `GoDaddy API error: ${response.status} ${response.statusText}`
    try {
      const errorData = await response.json()
      if (errorData.message) {
        errorMessage = `GoDaddy API error: ${errorData.message}`
      }
      if (errorData.fields) {
        errorMessage += ` - Fields: ${JSON.stringify(errorData.fields)}`
      }
    }
    catch {
      // Ignore JSON parse errors for error response
    }

    throw new Error(errorMessage)
  }

  /**
   * Extract the subdomain from a full record name
   * GoDaddy uses @ for root domain
   */
  private getSubdomain(recordName: string, domain: string): string {
    // Remove trailing dots
    const cleanName = recordName.replace(/\.$/, '')
    const cleanDomain = domain.replace(/\.$/, '')

    // If the record name equals the domain, return @ (root)
    if (cleanName === cleanDomain) {
      return '@'
    }

    // Remove the domain suffix to get the subdomain
    if (cleanName.endsWith(`.${cleanDomain}`)) {
      return cleanName.slice(0, -(cleanDomain.length + 1))
    }

    // If no match, return the full name as subdomain
    return cleanName
  }

  /**
   * Get the root domain from a full domain name
   */
  private getRootDomain(domain: string): string {
    const parts = domain.replace(/\.$/, '').split('.')
    if (parts.length >= 2) {
      return parts.slice(-2).join('.')
    }
    return domain
  }

  /**
   * Convert DnsRecord to GoDaddy record format
   */
  private toGoDaddyRecord(record: DnsRecord, domain: string): GoDaddyRecord {
    const rootDomain = this.getRootDomain(domain)
    const subdomain = this.getSubdomain(record.name, rootDomain)

    const gdRecord: GoDaddyRecord = {
      type: record.type,
      name: subdomain,
      data: record.content,
      ttl: record.ttl || 600,
    }

    if (record.type === 'MX' && record.priority !== undefined) {
      gdRecord.priority = record.priority
    }

    return gdRecord
  }

  /**
   * Convert GoDaddy record to DnsRecordResult format
   */
  private fromGoDaddyRecord(record: GoDaddyRecord, domain: string): DnsRecordResult {
    const rootDomain = this.getRootDomain(domain)
    let name = record.name

    // Convert @ to domain name and subdomain to full name
    if (name === '@') {
      name = rootDomain
    }
    else if (!name.endsWith(rootDomain)) {
      name = `${name}.${rootDomain}`
    }

    return {
      name,
      type: record.type as DnsRecordType,
      content: record.data,
      ttl: record.ttl,
      priority: record.priority,
    }
  }

  async createRecord(domain: string, record: DnsRecord): Promise<CreateRecordResult> {
    try {
      const rootDomain = this.getRootDomain(domain)
      const gdRecord = this.toGoDaddyRecord(record, domain)

      // GoDaddy's PATCH endpoint adds records
      await this.request(
        'PATCH',
        `/v1/domains/${rootDomain}/records`,
        [gdRecord],
      )

      return {
        success: true,
        message: 'Record created successfully',
      }
    }
    catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  async upsertRecord(domain: string, record: DnsRecord): Promise<CreateRecordResult> {
    try {
      const rootDomain = this.getRootDomain(domain)
      const gdRecord = this.toGoDaddyRecord(record, domain)

      // GoDaddy's PUT replaces all records of a specific type/name
      await this.request(
        'PUT',
        `/v1/domains/${rootDomain}/records/${record.type}/${gdRecord.name}`,
        [gdRecord],
      )

      return {
        success: true,
        message: 'Record upserted successfully',
      }
    }
    catch (error) {
      // If PUT fails (record doesn't exist), try PATCH
      return this.createRecord(domain, record)
    }
  }

  async deleteRecord(domain: string, record: DnsRecord): Promise<DeleteRecordResult> {
    try {
      const rootDomain = this.getRootDomain(domain)
      const subdomain = this.getSubdomain(record.name, rootDomain)

      // GoDaddy doesn't have a direct delete endpoint
      // We need to get all records of this type/name and PUT back without the target

      const existingRecords = await this.request<GoDaddyRecord[]>(
        'GET',
        `/v1/domains/${rootDomain}/records/${record.type}/${subdomain}`,
      )

      // Filter out the record to delete
      const remainingRecords = existingRecords.filter(
        r => r.data !== record.content,
      )

      if (remainingRecords.length === existingRecords.length) {
        // Record not found
        return {
          success: false,
          message: 'Record not found',
        }
      }

      if (remainingRecords.length === 0) {
        // GoDaddy doesn't allow empty record sets for some types
        // Use DELETE endpoint if available, otherwise PUT an empty array
        try {
          await this.request(
            'DELETE',
            `/v1/domains/${rootDomain}/records/${record.type}/${subdomain}`,
          )
        }
        catch {
          // Some record types can't be fully deleted, that's OK
        }
      }
      else {
        // Replace with remaining records
        await this.request(
          'PUT',
          `/v1/domains/${rootDomain}/records/${record.type}/${subdomain}`,
          remainingRecords,
        )
      }

      return {
        success: true,
        message: 'Record deleted successfully',
      }
    }
    catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  async listRecords(domain: string, type?: DnsRecordType): Promise<ListRecordsResult> {
    try {
      const rootDomain = this.getRootDomain(domain)

      let endpoint = `/v1/domains/${rootDomain}/records`
      if (type) {
        endpoint = `/v1/domains/${rootDomain}/records/${type}`
      }

      const records = await this.request<GoDaddyRecord[]>('GET', endpoint)

      return {
        success: true,
        records: records.map(r => this.fromGoDaddyRecord(r, domain)),
      }
    }
    catch (error) {
      return {
        success: false,
        records: [],
        message: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  async canManageDomain(domain: string): Promise<boolean> {
    try {
      const rootDomain = this.getRootDomain(domain)
      // Try to get domain details
      await this.request('GET', `/v1/domains/${rootDomain}`)
      return true
    }
    catch {
      return false
    }
  }

  /**
   * Get domain details (GoDaddy-specific)
   */
  async getDomainDetails(domain: string): Promise<{
    domain: string
    status: string
    nameServers?: string[]
    expires?: string
  } | null> {
    try {
      const rootDomain = this.getRootDomain(domain)
      const details = await this.request<any>('GET', `/v1/domains/${rootDomain}`)

      return {
        domain: details.domain,
        status: details.status,
        nameServers: details.nameServers,
        expires: details.expires,
      }
    }
    catch {
      return null
    }
  }

  /**
   * Update nameservers for a domain (GoDaddy-specific)
   */
  async updateNameServers(domain: string, nameservers: string[]): Promise<boolean> {
    try {
      const rootDomain = this.getRootDomain(domain)
      await this.request(
        'PUT',
        `/v1/domains/${rootDomain}/records/NS`,
        nameservers.map(ns => ({
          type: 'NS',
          name: '@',
          data: ns,
          ttl: 3600,
        })),
      )
      return true
    }
    catch {
      return false
    }
  }

  /**
   * Check domain availability (GoDaddy-specific)
   */
  async checkDomainAvailability(domain: string): Promise<{
    available: boolean
    price?: number
    currency?: string
  }> {
    try {
      const result = await this.request<any>(
        'GET',
        `/v1/domains/available?domain=${encodeURIComponent(domain)}`,
      )

      return {
        available: result.available,
        price: result.price,
        currency: result.currency,
      }
    }
    catch {
      return { available: false }
    }
  }
}
