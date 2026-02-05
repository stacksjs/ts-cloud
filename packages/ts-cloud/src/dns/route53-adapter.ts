/**
 * Route53 DNS Provider Adapter
 * Wraps the existing Route53Client to implement the DnsProvider interface
*/

import { Route53Client } from '../aws/route53'
import type {
  CreateRecordResult,
  DeleteRecordResult,
  DnsProvider,
  DnsRecord,
  DnsRecordResult,
  DnsRecordType,
  ListRecordsResult,
} from './types'

export class Route53Provider implements DnsProvider {
  readonly name = 'route53'
  private client: Route53Client
  private hostedZoneCache: Map<string, string> = new Map()
  private providedHostedZoneId?: string

  constructor(region: string = 'us-east-1', hostedZoneId?: string) {
    this.client = new Route53Client(region)
    this.providedHostedZoneId = hostedZoneId
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
   * Get the hosted zone ID for a domain
  */
  private async getHostedZoneId(domain: string): Promise<string | null> {
    // If a hosted zone ID was provided, use it
    if (this.providedHostedZoneId) {
      return this.providedHostedZoneId
    }

    const rootDomain = this.getRootDomain(domain)

    // Check cache
    const cached = this.hostedZoneCache.get(rootDomain)
    if (cached) {
      return cached
    }

    // Find the hosted zone
    const zone = await this.client.findHostedZoneForDomain(domain)
    if (zone) {
      const zoneId = zone.Id.replace('/hostedzone/', '')
      this.hostedZoneCache.set(rootDomain, zoneId)
      return zoneId
    }

    return null
  }

  /**
   * Ensure domain name ends with a dot (Route53 requirement)
  */
  private normalizeName(name: string): string {
    return name.endsWith('.') ? name : `${name}.`
  }

  async createRecord(domain: string, record: DnsRecord): Promise<CreateRecordResult> {
    try {
      const hostedZoneId = await this.getHostedZoneId(domain)
      if (!hostedZoneId) {
        return {
          success: false,
          message: `No hosted zone found for domain: ${domain}`,
        }
      }

      const recordName = this.normalizeName(record.name)
      let recordValue = record.content

      // TXT records need to be quoted
      if (record.type === 'TXT' && !recordValue.startsWith('"')) {
        recordValue = `"${recordValue}"`
      }

      // MX records need priority prefix
      if (record.type === 'MX' && record.priority !== undefined) {
        recordValue = `${record.priority} ${recordValue}`
      }

      const result = await this.client.changeResourceRecordSets({
        HostedZoneId: hostedZoneId,
        ChangeBatch: {
          Comment: `Created by ts-cloud DNS provider`,
          Changes: [{
            Action: 'CREATE',
            ResourceRecordSet: {
              Name: recordName,
              Type: record.type,
              TTL: record.ttl || 300,
              ResourceRecords: [{ Value: recordValue }],
            },
          }],
        },
      })

      return {
        success: true,
        id: result.ChangeInfo?.Id,
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
      const hostedZoneId = await this.getHostedZoneId(domain)
      if (!hostedZoneId) {
        return {
          success: false,
          message: `No hosted zone found for domain: ${domain}`,
        }
      }

      const recordName = this.normalizeName(record.name)
      let recordValue = record.content

      // TXT records need to be quoted
      if (record.type === 'TXT' && !recordValue.startsWith('"')) {
        recordValue = `"${recordValue}"`
      }

      // MX records need priority prefix
      if (record.type === 'MX' && record.priority !== undefined) {
        recordValue = `${record.priority} ${recordValue}`
      }

      const result = await this.client.changeResourceRecordSets({
        HostedZoneId: hostedZoneId,
        ChangeBatch: {
          Comment: `Upserted by ts-cloud DNS provider`,
          Changes: [{
            Action: 'UPSERT',
            ResourceRecordSet: {
              Name: recordName,
              Type: record.type,
              TTL: record.ttl || 300,
              ResourceRecords: [{ Value: recordValue }],
            },
          }],
        },
      })

      return {
        success: true,
        id: result.ChangeInfo?.Id,
        message: 'Record upserted successfully',
      }
    }
    catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  async deleteRecord(domain: string, record: DnsRecord): Promise<DeleteRecordResult> {
    try {
      const hostedZoneId = await this.getHostedZoneId(domain)
      if (!hostedZoneId) {
        return {
          success: false,
          message: `No hosted zone found for domain: ${domain}`,
        }
      }

      const recordName = this.normalizeName(record.name)
      let recordValue = record.content

      // TXT records need to be quoted
      if (record.type === 'TXT' && !recordValue.startsWith('"')) {
        recordValue = `"${recordValue}"`
      }

      // MX records need priority prefix
      if (record.type === 'MX' && record.priority !== undefined) {
        recordValue = `${record.priority} ${recordValue}`
      }

      await this.client.changeResourceRecordSets({
        HostedZoneId: hostedZoneId,
        ChangeBatch: {
          Comment: `Deleted by ts-cloud DNS provider`,
          Changes: [{
            Action: 'DELETE',
            ResourceRecordSet: {
              Name: recordName,
              Type: record.type,
              TTL: record.ttl || 300,
              ResourceRecords: [{ Value: recordValue }],
            },
          }],
        },
      })

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
      const hostedZoneId = await this.getHostedZoneId(domain)
      if (!hostedZoneId) {
        return {
          success: false,
          records: [],
          message: `No hosted zone found for domain: ${domain}`,
        }
      }

      const result = await this.client.listResourceRecordSets({
        HostedZoneId: hostedZoneId,
        StartRecordType: type,
      })

      const records: DnsRecordResult[] = []

      for (const rs of result.ResourceRecordSets) {
        // Filter by type if specified
        if (type && rs.Type !== type) {
          continue
        }

        // Skip alias records for now (they don't have ResourceRecords)
        if (rs.AliasTarget) {
          continue
        }

        for (const rr of rs.ResourceRecords || []) {
          let content = rr.Value
          let priority: number | undefined

          // Extract MX priority
          if (rs.Type === 'MX') {
            const parts = content.split(' ')
            if (parts.length >= 2) {
              priority = Number.parseInt(parts[0], 10)
              content = parts.slice(1).join(' ')
            }
          }

          // Remove TXT record quotes
          if (rs.Type === 'TXT' && content.startsWith('"') && content.endsWith('"')) {
            content = content.slice(1, -1)
          }

          records.push({
            name: rs.Name.replace(/\.$/, ''),
            type: rs.Type as DnsRecordType,
            content,
            ttl: rs.TTL,
            priority,
          })
        }
      }

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
    const hostedZoneId = await this.getHostedZoneId(domain)
    return hostedZoneId !== null
  }

  /**
   * List all domains (hosted zones) managed in Route53
  */
  async listDomains(): Promise<string[]> {
    try {
      const result = await this.client.listHostedZones()
      return result.HostedZones.map(z => z.Name.replace(/\.$/, ''))
    }
    catch {
      return []
    }
  }

  /**
   * Get the underlying Route53Client for advanced operations
  */
  getRoute53Client(): Route53Client {
    return this.client
  }

  /**
   * Create an alias record (Route53-specific feature)
   * Useful for CloudFront, ALB, etc.
  */
  async createAliasRecord(params: {
    domain: string
    name: string
    targetHostedZoneId: string
    targetDnsName: string
    evaluateTargetHealth?: boolean
    type?: 'A' | 'AAAA'
  }): Promise<CreateRecordResult> {
    try {
      const hostedZoneId = await this.getHostedZoneId(params.domain)
      if (!hostedZoneId) {
        return {
          success: false,
          message: `No hosted zone found for domain: ${params.domain}`,
        }
      }

      const result = await this.client.createAliasRecord({
        HostedZoneId: hostedZoneId,
        Name: this.normalizeName(params.name),
        TargetHostedZoneId: params.targetHostedZoneId,
        TargetDNSName: params.targetDnsName,
        EvaluateTargetHealth: params.evaluateTargetHealth,
        Type: params.type,
      })

      return {
        success: true,
        id: result.ChangeInfo?.Id,
        message: 'Alias record created successfully',
      }
    }
    catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Create CloudFront alias record (convenience method)
  */
  async createCloudFrontAlias(params: {
    domain: string
    name: string
    cloudFrontDomainName: string
  }): Promise<CreateRecordResult> {
    return this.createAliasRecord({
      domain: params.domain,
      name: params.name,
      targetHostedZoneId: Route53Client.CloudFrontHostedZoneId,
      targetDnsName: params.cloudFrontDomainName,
      evaluateTargetHealth: false,
    })
  }

  /**
   * Create ALB alias record (convenience method)
  */
  async createAlbAlias(params: {
    domain: string
    name: string
    albDnsName: string
    region: string
  }): Promise<CreateRecordResult> {
    const hostedZoneId = Route53Client.ALBHostedZoneIds[params.region]
    if (!hostedZoneId) {
      return {
        success: false,
        message: `Unknown region for ALB: ${params.region}`,
      }
    }

    return this.createAliasRecord({
      domain: params.domain,
      name: params.name,
      targetHostedZoneId: hostedZoneId,
      targetDnsName: params.albDnsName,
      evaluateTargetHealth: true,
    })
  }
}
