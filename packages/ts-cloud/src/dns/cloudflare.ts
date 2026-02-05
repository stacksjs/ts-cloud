/**
 * Cloudflare DNS Provider
 * API documentation: https://developers.cloudflare.com/api/resources/dns/subresources/records/
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

const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4'

interface CloudflareApiResponse<T = any> {
  success: boolean
  errors: Array<{ code: number, message: string }>
  messages: string[]
  result: T
  result_info?: {
    page: number
    per_page: number
    total_pages: number
    count: number
    total_count: number
  }
}

interface CloudflareRecord {
  id: string
  zone_id: string
  zone_name: string
  name: string
  type: string
  content: string
  proxiable: boolean
  proxied: boolean
  ttl: number
  locked: boolean
  meta: Record<string, any>
  comment?: string
  tags?: string[]
  created_on: string
  modified_on: string
  priority?: number
}

interface CloudflareZone {
  id: string
  name: string
  status: string
  paused: boolean
  type: string
  development_mode: number
  name_servers: string[]
}

export class CloudflareProvider implements DnsProvider {
  readonly name = 'cloudflare'
  private apiToken: string
  private zoneCache: Map<string, string> = new Map()

  constructor(apiToken: string) {
    this.apiToken = apiToken
  }

  /**
   * Make an authenticated API request to Cloudflare
  */
  private async request<T>(
    method: string,
    endpoint: string,
    body?: any,
  ): Promise<CloudflareApiResponse<T>> {
    const url = `${CLOUDFLARE_API_URL}${endpoint}`

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json',
    }

    const options: RequestInit = {
      method,
      headers,
    }

    if (body) {
      options.body = JSON.stringify(body)
    }

    const response = await fetch(url, options)
    const data = await response.json() as CloudflareApiResponse<T>

    if (!data.success) {
      const errorMessages = data.errors.map(e => e.message).join(', ')
      throw new Error(`Cloudflare API error: ${errorMessages}`)
    }

    return data
  }

  /**
   * Get the root domain from a full domain name
   * e.g., "api.example.com" -> "example.com"
  */
  private getRootDomain(domain: string): string {
    const parts = domain.replace(/\.$/, '').split('.')
    if (parts.length >= 2) {
      return parts.slice(-2).join('.')
    }
    return domain
  }

  /**
   * Get Zone ID for a domain (with caching)
  */
  private async getZoneId(domain: string): Promise<string> {
    const rootDomain = this.getRootDomain(domain)

    // Check cache first
    const cached = this.zoneCache.get(rootDomain)
    if (cached) {
      return cached
    }

    // Look up zone by name
    const response = await this.request<CloudflareZone[]>(
      'GET',
      `/zones?name=${encodeURIComponent(rootDomain)}`,
    )

    if (!response.result || response.result.length === 0) {
      throw new Error(`Zone not found for domain: ${rootDomain}`)
    }

    const zoneId = response.result[0].id
    this.zoneCache.set(rootDomain, zoneId)
    return zoneId
  }

  /**
   * Get the full record name
   * Cloudflare stores records with full domain names
  */
  private getFullRecordName(name: string, domain: string): string {
    const rootDomain = this.getRootDomain(domain)
    const cleanName = name.replace(/\.$/, '')

    // If name is empty or equals root domain, return root domain
    if (!cleanName || cleanName === rootDomain || cleanName === '@') {
      return rootDomain
    }

    // If name already ends with root domain, return as-is
    if (cleanName.endsWith(`.${rootDomain}`)) {
      return cleanName
    }

    // Otherwise, append root domain
    return `${cleanName}.${rootDomain}`
  }

  /**
   * Convert DnsRecord to Cloudflare record format
  */
  private toCloudflareRecord(record: DnsRecord, domain: string): Partial<CloudflareRecord> {
    const cfRecord: Partial<CloudflareRecord> = {
      type: record.type,
      name: this.getFullRecordName(record.name, domain),
      content: record.content || record.value || '',
      ttl: record.ttl || 1, // 1 = automatic in Cloudflare
    }

    // MX records require priority
    if (record.type === 'MX' && record.priority !== undefined) {
      cfRecord.priority = record.priority
    }

    // SRV records have special format
    if (record.type === 'SRV') {
      if (record.priority !== undefined) {
        cfRecord.priority = record.priority
      }
    }

    return cfRecord
  }

  /**
   * Convert Cloudflare record to DnsRecordResult format
  */
  private fromCloudflareRecord(record: CloudflareRecord): DnsRecordResult {
    return {
      id: record.id,
      name: record.name,
      type: record.type as DnsRecordType,
      content: record.content,
      ttl: record.ttl,
      priority: record.priority,
    }
  }

  async createRecord(domain: string, record: DnsRecord): Promise<CreateRecordResult> {
    try {
      const zoneId = await this.getZoneId(domain)
      const cfRecord = this.toCloudflareRecord(record, domain)

      const response = await this.request<CloudflareRecord>(
        'POST',
        `/zones/${zoneId}/dns_records`,
        cfRecord,
      )

      return {
        success: true,
        id: response.result.id,
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
      const zoneId = await this.getZoneId(domain)
      const fullName = this.getFullRecordName(record.name, domain)

      // First, try to find existing record
      const existingResponse = await this.request<CloudflareRecord[]>(
        'GET',
        `/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(fullName)}`,
      )

      const cfRecord = this.toCloudflareRecord(record, domain)

      if (existingResponse.result && existingResponse.result.length > 0) {
        // Update existing record
        const existingId = existingResponse.result[0].id
        const response = await this.request<CloudflareRecord>(
          'PUT',
          `/zones/${zoneId}/dns_records/${existingId}`,
          cfRecord,
        )

        return {
          success: true,
          id: response.result.id,
          message: 'Record updated successfully',
        }
      }

      // Create new record
      const response = await this.request<CloudflareRecord>(
        'POST',
        `/zones/${zoneId}/dns_records`,
        cfRecord,
      )

      return {
        success: true,
        id: response.result.id,
        message: 'Record created successfully',
      }
    }
    catch (error) {
      // If upsert fails, try create
      return this.createRecord(domain, record)
    }
  }

  async deleteRecord(domain: string, record: DnsRecord): Promise<DeleteRecordResult> {
    try {
      const zoneId = await this.getZoneId(domain)
      const fullName = this.getFullRecordName(record.name, domain)

      // Find the record to delete
      const existingResponse = await this.request<CloudflareRecord[]>(
        'GET',
        `/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(fullName)}`,
      )

      if (!existingResponse.result || existingResponse.result.length === 0) {
        return {
          success: false,
          message: 'Record not found',
        }
      }

      // Find matching record by content
      const matchingRecord = existingResponse.result.find(
        r => r.content === record.content,
      )

      if (!matchingRecord) {
        return {
          success: false,
          message: 'Record with matching content not found',
        }
      }

      await this.request(
        'DELETE',
        `/zones/${zoneId}/dns_records/${matchingRecord.id}`,
      )

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
      const zoneId = await this.getZoneId(domain)

      let endpoint = `/zones/${zoneId}/dns_records?per_page=100`
      if (type) {
        endpoint += `&type=${type}`
      }

      const allRecords: CloudflareRecord[] = []
      let page = 1
      let hasMore = true

      // Paginate through all records
      while (hasMore) {
        const response = await this.request<CloudflareRecord[]>(
          'GET',
          `${endpoint}&page=${page}`,
        )

        allRecords.push(...(response.result || []))

        if (response.result_info) {
          hasMore = page < response.result_info.total_pages
          page++
        }
        else {
          hasMore = false
        }
      }

      return {
        success: true,
        records: allRecords.map(r => this.fromCloudflareRecord(r)),
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
      await this.getZoneId(domain)
      return true
    }
    catch {
      return false
    }
  }

  /**
   * List all domains (zones) managed by this Cloudflare account
  */
  async listDomains(): Promise<string[]> {
    try {
      const allZones: CloudflareZone[] = []
      let page = 1
      let hasMore = true

      while (hasMore) {
        const response = await this.request<CloudflareZone[]>(
          'GET',
          `/zones?per_page=50&page=${page}`,
        )

        allZones.push(...(response.result || []))

        if (response.result_info) {
          hasMore = page < response.result_info.total_pages
          page++
        }
        else {
          hasMore = false
        }
      }

      return allZones.map(z => z.name)
    }
    catch {
      return []
    }
  }

  /**
   * Get zone details (Cloudflare-specific)
  */
  async getZoneDetails(domain: string): Promise<{
    id: string
    name: string
    status: string
    nameServers: string[]
    paused: boolean
  } | null> {
    try {
      const zoneId = await this.getZoneId(domain)
      const response = await this.request<CloudflareZone>(
        'GET',
        `/zones/${zoneId}`,
      )

      return {
        id: response.result.id,
        name: response.result.name,
        status: response.result.status,
        nameServers: response.result.name_servers,
        paused: response.result.paused,
      }
    }
    catch {
      return null
    }
  }

  /**
   * Purge cache for a domain (Cloudflare-specific)
  */
  async purgeCache(domain: string, options?: {
    purgeEverything?: boolean
    files?: string[]
    tags?: string[]
    hosts?: string[]
  }): Promise<boolean> {
    try {
      const zoneId = await this.getZoneId(domain)

      const body: Record<string, any> = {}

      if (options?.purgeEverything) {
        body.purge_everything = true
      }
      else {
        if (options?.files) body.files = options.files
        if (options?.tags) body.tags = options.tags
        if (options?.hosts) body.hosts = options.hosts
      }

      // Default to purge everything if no options specified
      if (Object.keys(body).length === 0) {
        body.purge_everything = true
      }

      await this.request(
        'POST',
        `/zones/${zoneId}/purge_cache`,
        body,
      )

      return true
    }
    catch {
      return false
    }
  }

  /**
   * Get proxy status for a record (Cloudflare-specific)
   * Returns whether a record is proxied through Cloudflare
  */
  async getRecordProxyStatus(domain: string, record: DnsRecord): Promise<boolean | null> {
    try {
      const zoneId = await this.getZoneId(domain)
      const fullName = this.getFullRecordName(record.name, domain)

      const response = await this.request<CloudflareRecord[]>(
        'GET',
        `/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(fullName)}`,
      )

      if (response.result && response.result.length > 0) {
        const matchingRecord = response.result.find(r => r.content === record.content)
        return matchingRecord?.proxied ?? null
      }

      return null
    }
    catch {
      return null
    }
  }

  /**
   * Update proxy status for a record (Cloudflare-specific)
  */
  async setRecordProxyStatus(domain: string, record: DnsRecord, proxied: boolean): Promise<boolean> {
    try {
      const zoneId = await this.getZoneId(domain)
      const fullName = this.getFullRecordName(record.name, domain)

      // Find the record
      const response = await this.request<CloudflareRecord[]>(
        'GET',
        `/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(fullName)}`,
      )

      if (!response.result || response.result.length === 0) {
        return false
      }

      const matchingRecord = response.result.find(r => r.content === record.content)
      if (!matchingRecord) {
        return false
      }

      // Update the record with new proxy status
      await this.request(
        'PATCH',
        `/zones/${zoneId}/dns_records/${matchingRecord.id}`,
        { proxied },
      )

      return true
    }
    catch {
      return false
    }
  }
}
