/**
 * Route53 DNS Provider Adapter
 * Wraps the existing Route53Client to implement the DnsProvider interface
 */
import type { CreateRecordResult, DeleteRecordResult, DnsProvider, DnsRecord, DnsRecordResult, DnsRecordType, ListRecordsResult } from './types'
import { Route53Client } from '../aws/route53'

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
  private normalizeName(domain: string, name: string): string {
    const zone = domain.replace(/\.$/, '')
    const record = name.replace(/\.$/, '')
    if (!record || record === '@') return `${zone}.`
    if (record === zone || record.endsWith(`.${zone}`)) return `${record}.`
    return `${record}.${zone}.`
  }

  /** A record's value as Route53 stores it: TXT quoted, MX with its priority. */
  private formatValue(record: DnsRecord): string {
    let value = record.content
    if (record.type === 'TXT' && !value.startsWith('"'))
      value = `"${value}"`
    if (record.type === 'MX' && record.priority !== undefined)
      value = `${record.priority} ${value}`
    return value
  }

  /**
   * The record set currently at `name`/`type`, or null.
   *
   * Route53 holds one SET per name and type, and its three actions all act on
   * the whole set: CREATE fails if any value is already there, UPSERT replaces
   * every value, DELETE must name the set exactly. Every other provider here
   * treats a record as one value among possibly several, and so does the
   * DnsProvider contract. Reading the set first is what lets create add one
   * value and delete remove one, the way callers (an ACME challenge for a
   * domain and its wildcard, a zone migration) rely on.
   */
  private async currentSet(hostedZoneId: string, name: string, type: string): Promise<{ ttl: number, values: string[] } | null> {
    const page = await this.client.listResourceRecordSets({
      HostedZoneId: hostedZoneId,
      StartRecordName: name,
      StartRecordType: type,
      MaxItems: '1',
    })
    const set = page.ResourceRecordSets?.[0]
    if (!set || set.Name.toLowerCase() !== name.toLowerCase() || set.Type !== type || set.AliasTarget || set.SetIdentifier)
      return null
    return { ttl: set.TTL ?? 300, values: (set.ResourceRecords ?? []).map(r => r.Value) }
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

      const recordName = this.normalizeName(domain, record.name)
      const recordValue = this.formatValue(record)

      // Add the value to whatever set is already at this name, rather than
      // CREATE, which Route53 refuses once the name holds any value.
      const current = await this.currentSet(hostedZoneId, recordName, record.type)
      if (current?.values.includes(recordValue))
        return { success: true, message: 'Record already present' }

      const values = [...(current?.values ?? []), recordValue]
      const result = await this.client.changeResourceRecordSets({
        HostedZoneId: hostedZoneId,
        ChangeBatch: {
          Comment: `Created by ts-cloud DNS provider`,
          Changes: [
            {
              Action: current ? 'UPSERT' : 'CREATE',
              ResourceRecordSet: {
                Name: recordName,
                Type: record.type,
                TTL: current?.ttl ?? record.ttl ?? 300,
                ResourceRecords: values.map(Value => ({ Value })),
              },
            },
          ],
        },
      })

      return {
        success: true,
        id: result.ChangeInfo?.Id,
        message: 'Record created successfully',
      }
    } catch (error) {
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

      const recordName = this.normalizeName(domain, record.name)
      const recordValue = this.formatValue(record)

      const result = await this.client.changeResourceRecordSets({
        HostedZoneId: hostedZoneId,
        ChangeBatch: {
          Comment: `Upserted by ts-cloud DNS provider`,
          Changes: [
            {
              Action: 'UPSERT',
              ResourceRecordSet: {
                Name: recordName,
                Type: record.type,
                TTL: record.ttl || 300,
                ResourceRecords: [{ Value: recordValue }],
              },
            },
          ],
        },
      })

      return {
        success: true,
        id: result.ChangeInfo?.Id,
        message: 'Record upserted successfully',
      }
    } catch (error) {
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

      const recordName = this.normalizeName(domain, record.name)
      const recordValue = this.formatValue(record)

      // Remove this value and keep the rest. A DELETE naming one value of a
      // two-value set is rejected outright, so cleaning up one ACME challenge
      // used to fail while the other was still in place.
      const current = await this.currentSet(hostedZoneId, recordName, record.type)
      if (!current || !current.values.includes(recordValue))
        return { success: true, message: 'Record already absent' }

      const remaining = current.values.filter(value => value !== recordValue)
      await this.client.changeResourceRecordSets({
        HostedZoneId: hostedZoneId,
        ChangeBatch: {
          Comment: `Deleted by ts-cloud DNS provider`,
          Changes: [
            {
              Action: remaining.length > 0 ? 'UPSERT' : 'DELETE',
              ResourceRecordSet: {
                Name: recordName,
                Type: record.type,
                TTL: current.ttl,
                ResourceRecords: (remaining.length > 0 ? remaining : current.values).map(Value => ({ Value })),
              },
            },
          ],
        },
      })

      return {
        success: true,
        message: 'Record deleted successfully',
      }
    } catch (error) {
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
    } catch (error) {
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
      return result.HostedZones.map((z) => z.Name.replace(/\.$/, ''))
    } catch {
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
        Name: this.normalizeName(params.domain, params.name),
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
    } catch (error) {
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
