/**
 * Porkbun DNS Provider
 * API documentation: https://porkbun.com/api/json/v3/documentation
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

const PORKBUN_API_URL = 'https://api.porkbun.com/api/json/v3'

interface PorkbunApiResponse {
  status: 'SUCCESS' | 'ERROR'
  message?: string
}

interface PorkbunRecord {
  id: string
  name: string
  type: string
  content: string
  ttl: string
  prio?: string
  notes?: string
}

interface PorkbunListRecordsResponse extends PorkbunApiResponse {
  records?: PorkbunRecord[]
}

interface PorkbunCreateRecordResponse extends PorkbunApiResponse {
  id?: number
}

export class PorkbunProvider implements DnsProvider {
  readonly name = 'porkbun'
  private apiKey: string
  private secretKey: string

  constructor(apiKey: string, secretKey: string) {
    this.apiKey = apiKey
    this.secretKey = secretKey
  }

  /**
   * Make an authenticated API request to Porkbun
  */
  private async request<T extends PorkbunApiResponse>(
    endpoint: string,
    additionalBody: Record<string, any> = {},
  ): Promise<T> {
    const response = await fetch(`${PORKBUN_API_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        apikey: this.apiKey,
        secretapikey: this.secretKey,
        ...additionalBody,
      }),
    })

    if (!response.ok) {
      throw new Error(`Porkbun API error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json() as T

    if (data.status === 'ERROR') {
      throw new Error(`Porkbun API error: ${data.message || 'Unknown error'}`)
    }

    return data
  }

  /**
   * Extract the subdomain from a full record name
   * e.g., "_acme-challenge.example.com" -> "_acme-challenge"
  */
  private getSubdomain(recordName: string, domain: string): string {
    // Remove trailing dots
    const cleanName = recordName.replace(/\.$/, '')
    const cleanDomain = domain.replace(/\.$/, '')

    // If the record name equals the domain, return empty string (root)
    if (cleanName === cleanDomain) {
      return ''
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
   * e.g., "api.example.com" -> "example.com"
  */
  private getRootDomain(domain: string): string {
    const parts = domain.replace(/\.$/, '').split('.')
    // Handle common TLDs
    if (parts.length >= 2) {
      return parts.slice(-2).join('.')
    }
    return domain
  }

  async createRecord(domain: string, record: DnsRecord): Promise<CreateRecordResult> {
    try {
      const rootDomain = this.getRootDomain(domain)
      const subdomain = this.getSubdomain(record.name, rootDomain)

      const body: Record<string, any> = {
        type: record.type,
        content: record.content,
        ttl: String(record.ttl || 600),
      }

      // For subdomain records
      if (subdomain) {
        body.name = subdomain
      }

      // MX and SRV records require priority
      if ((record.type === 'MX' || record.type === 'SRV') && record.priority !== undefined) {
        body.prio = String(record.priority)
      }

      // SRV records: Porkbun expects content as "WEIGHT PORT TARGET"
      // Override content format if weight and port are provided separately
      if (record.type === 'SRV' && record.weight !== undefined && record.port !== undefined) {
        body.content = `${record.weight} ${record.port} ${record.content}`
      }

      const response = await this.request<PorkbunCreateRecordResponse>(
        `/dns/create/${rootDomain}`,
        body,
      )

      return {
        success: true,
        id: response.id?.toString(),
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
      const subdomain = this.getSubdomain(record.name, rootDomain)

      // First, try to find existing record
      const existing = await this.listRecords(domain, record.type)

      if (existing.success) {
        // Find matching record by name and type
        const matchingRecord = existing.records.find((r) => {
          const existingSubdomain = this.getSubdomain(r.name, rootDomain)
          return existingSubdomain === subdomain && r.type === record.type
        })

        if (matchingRecord?.id) {
          // Update existing record
          const body: Record<string, any> = {
            type: record.type,
            content: record.content,
            ttl: String(record.ttl || 600),
          }

          if (subdomain) {
            body.name = subdomain
          }

          if ((record.type === 'MX' || record.type === 'SRV') && record.priority !== undefined) {
            body.prio = String(record.priority)
          }

          // SRV records: Porkbun expects content as "WEIGHT PORT TARGET"
          if (record.type === 'SRV' && record.weight !== undefined && record.port !== undefined) {
            body.content = `${record.weight} ${record.port} ${record.content}`
          }

          await this.request(
            `/dns/edit/${rootDomain}/${matchingRecord.id}`,
            body,
          )

          return {
            success: true,
            id: matchingRecord.id,
            message: 'Record updated successfully',
          }
        }
      }

      // No existing record found, create new one
      return this.createRecord(domain, record)
    }
    catch (error) {
      // If update fails, try create
      return this.createRecord(domain, record)
    }
  }

  async deleteRecord(domain: string, record: DnsRecord): Promise<DeleteRecordResult> {
    try {
      const rootDomain = this.getRootDomain(domain)
      const subdomain = this.getSubdomain(record.name, rootDomain)

      // Find the record to delete
      const existing = await this.listRecords(domain, record.type)

      if (!existing.success) {
        return {
          success: false,
          message: 'Failed to list records',
        }
      }

      // Find matching record
      const matchingRecord = existing.records.find((r) => {
        const existingSubdomain = this.getSubdomain(r.name, rootDomain)
        return existingSubdomain === subdomain
          && r.type === record.type
          && r.content === record.content
      })

      if (!matchingRecord?.id) {
        return {
          success: false,
          message: 'Record not found',
        }
      }

      await this.request(`/dns/delete/${rootDomain}/${matchingRecord.id}`)

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

      let endpoint = `/dns/retrieve/${rootDomain}`
      if (type) {
        endpoint = `/dns/retrieveByNameType/${rootDomain}/${type}`
      }

      const response = await this.request<PorkbunListRecordsResponse>(endpoint)

      const records: DnsRecordResult[] = (response.records || []).map(r => ({
        id: r.id,
        name: r.name || rootDomain,
        type: r.type as DnsRecordType,
        content: r.content,
        ttl: Number.parseInt(r.ttl, 10),
        priority: r.prio ? Number.parseInt(r.prio, 10) : undefined,
      }))

      return {
        success: true,
        records,
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
      // Ping API to check if we can access this domain
      await this.request(`/dns/retrieve/${rootDomain}`)
      return true
    }
    catch {
      return false
    }
  }

  /**
   * List all domains managed by this Porkbun account
   * Uses the domain list API endpoint
  */
  async listDomains(): Promise<string[]> {
    try {
      // Porkbun's /domain/listAll endpoint returns domains with API access enabled
      const response = await this.request<PorkbunApiResponse & { domains?: Array<{ domain: string }> }>(
        '/domain/listAll',
      )
      return (response.domains || []).map(d => d.domain)
    }
    catch {
      return []
    }
  }

  /**
   * Get nameservers for a domain (Porkbun-specific)
  */
  async getNameServers(domain: string): Promise<string[]> {
    try {
      const rootDomain = this.getRootDomain(domain)
      const response = await this.request<PorkbunApiResponse & { ns?: string[] }>(
        `/dns/getNS/${rootDomain}`,
      )
      return response.ns || []
    }
    catch {
      return []
    }
  }

  /**
   * Update nameservers for a domain (Porkbun-specific)
  */
  async updateNameServers(domain: string, nameservers: string[]): Promise<boolean> {
    try {
      const rootDomain = this.getRootDomain(domain)
      await this.request(`/dns/updateNS/${rootDomain}`, {
        ns: nameservers,
      })
      return true
    }
    catch {
      return false
    }
  }
}
