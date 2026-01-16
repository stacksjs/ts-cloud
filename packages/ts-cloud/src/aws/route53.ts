/**
 * Route53 Client - DNS management without AWS SDK
 * Uses direct AWS API calls with Signature V4
 */

import { AWSClient } from './client'

export interface HostedZone {
  Id: string
  Name: string
  CallerReference?: string
  Config?: {
    Comment?: string
    PrivateZone?: boolean
  }
  ResourceRecordSetCount?: number
}

export interface ResourceRecordSet {
  Name: string
  Type: string
  TTL?: number
  ResourceRecords?: { Value: string }[]
  AliasTarget?: {
    HostedZoneId: string
    DNSName: string
    EvaluateTargetHealth: boolean
  }
  SetIdentifier?: string
  Weight?: number
  Region?: string
  GeoLocation?: {
    ContinentCode?: string
    CountryCode?: string
    SubdivisionCode?: string
  }
  Failover?: 'PRIMARY' | 'SECONDARY'
  HealthCheckId?: string
}

export interface DelegationSet {
  Id?: string
  CallerReference?: string
  NameServers: string[]
}

export interface CreateHostedZoneResult {
  HostedZone: HostedZone
  ChangeInfo: {
    Id: string
    Status: string
    SubmittedAt: string
  }
  DelegationSet: DelegationSet
  Location: string
}

export interface ListHostedZonesResult {
  HostedZones: HostedZone[]
  IsTruncated: boolean
  MaxItems: string
  Marker?: string
  NextMarker?: string
}

export interface GetHostedZoneResult {
  HostedZone: HostedZone
  DelegationSet: DelegationSet
  VPCs?: { VPCId: string, VPCRegion: string }[]
}

export interface ListResourceRecordSetsResult {
  ResourceRecordSets: ResourceRecordSet[]
  IsTruncated: boolean
  MaxItems: string
  NextRecordName?: string
  NextRecordType?: string
  NextRecordIdentifier?: string
}

export interface ChangeResourceRecordSetsResult {
  ChangeInfo: {
    Id: string
    Status: string
    SubmittedAt: string
    Comment?: string
  }
}

export interface Change {
  Action: 'CREATE' | 'DELETE' | 'UPSERT'
  ResourceRecordSet: ResourceRecordSet
}

export interface ChangeBatch {
  Comment?: string
  Changes: Change[]
}

/**
 * Route53 Client for DNS management
 */
export class Route53Client {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Create a new hosted zone
   */
  async createHostedZone(params: {
    Name: string
    CallerReference?: string
    HostedZoneConfig?: {
      Comment?: string
      PrivateZone?: boolean
    }
    VPC?: {
      VPCRegion: string
      VPCId: string
    }
    DelegationSetId?: string
  }): Promise<CreateHostedZoneResult> {
    const callerReference = params.CallerReference || `${Date.now()}-${Math.random().toString(36).slice(2)}`

    // Build XML request body
    let xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<CreateHostedZoneRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
  <Name>${params.Name}</Name>
  <CallerReference>${callerReference}</CallerReference>`

    if (params.HostedZoneConfig) {
      xmlBody += `
  <HostedZoneConfig>`
      if (params.HostedZoneConfig.Comment) {
        xmlBody += `
    <Comment>${params.HostedZoneConfig.Comment}</Comment>`
      }
      if (params.HostedZoneConfig.PrivateZone !== undefined) {
        xmlBody += `
    <PrivateZone>${params.HostedZoneConfig.PrivateZone}</PrivateZone>`
      }
      xmlBody += `
  </HostedZoneConfig>`
    }

    if (params.VPC) {
      xmlBody += `
  <VPC>
    <VPCRegion>${params.VPC.VPCRegion}</VPCRegion>
    <VPCId>${params.VPC.VPCId}</VPCId>
  </VPC>`
    }

    if (params.DelegationSetId) {
      xmlBody += `
  <DelegationSetId>${params.DelegationSetId}</DelegationSetId>`
    }

    xmlBody += `
</CreateHostedZoneRequest>`

    const result = await this.client.request({
      service: 'route53',
      region: this.region,
      method: 'POST',
      path: '/2013-04-01/hostedzone',
      headers: {
        'content-type': 'application/xml',
      },
      body: xmlBody,
    })

    return this.parseCreateHostedZoneResponse(result)
  }

  /**
   * List hosted zones
   */
  async listHostedZones(params?: {
    Marker?: string
    MaxItems?: string
  }): Promise<ListHostedZonesResult> {
    const queryParams: Record<string, string> = {}

    if (params?.Marker) queryParams.marker = params.Marker
    if (params?.MaxItems) queryParams.maxitems = params.MaxItems

    const result = await this.client.request({
      service: 'route53',
      region: this.region,
      method: 'GET',
      path: '/2013-04-01/hostedzone',
      queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    })

    return this.parseListHostedZonesResponse(result)
  }

  /**
   * List hosted zones by name (more efficient for finding specific zone)
   */
  async listHostedZonesByName(params?: {
    DNSName?: string
    HostedZoneId?: string
    MaxItems?: string
  }): Promise<ListHostedZonesResult> {
    const queryParams: Record<string, string> = {}

    if (params?.DNSName) queryParams.dnsname = params.DNSName
    if (params?.HostedZoneId) queryParams.hostedzoneid = params.HostedZoneId
    if (params?.MaxItems) queryParams.maxitems = params.MaxItems

    const result = await this.client.request({
      service: 'route53',
      region: this.region,
      method: 'GET',
      path: '/2013-04-01/hostedzonesbyname',
      queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    })

    return this.parseListHostedZonesResponse(result)
  }

  /**
   * Get a hosted zone
   */
  async getHostedZone(params: {
    Id: string
  }): Promise<GetHostedZoneResult> {
    // Strip /hostedzone/ prefix if present
    const hostedZoneId = params.Id.replace('/hostedzone/', '')

    const result = await this.client.request({
      service: 'route53',
      region: this.region,
      method: 'GET',
      path: `/2013-04-01/hostedzone/${hostedZoneId}`,
    })

    return this.parseGetHostedZoneResponse(result)
  }

  /**
   * Delete a hosted zone
   */
  async deleteHostedZone(params: {
    Id: string
  }): Promise<void> {
    // Strip /hostedzone/ prefix if present
    const hostedZoneId = params.Id.replace('/hostedzone/', '')

    await this.client.request({
      service: 'route53',
      region: this.region,
      method: 'DELETE',
      path: `/2013-04-01/hostedzone/${hostedZoneId}`,
    })
  }

  /**
   * List resource record sets in a hosted zone
   */
  async listResourceRecordSets(params: {
    HostedZoneId: string
    StartRecordName?: string
    StartRecordType?: string
    StartRecordIdentifier?: string
    MaxItems?: string
  }): Promise<ListResourceRecordSetsResult> {
    // Strip /hostedzone/ prefix if present
    const hostedZoneId = params.HostedZoneId.replace('/hostedzone/', '')

    const queryParams: Record<string, string> = {}

    if (params.StartRecordName) queryParams.name = params.StartRecordName
    if (params.StartRecordType) queryParams.type = params.StartRecordType
    if (params.StartRecordIdentifier) queryParams.identifier = params.StartRecordIdentifier
    if (params.MaxItems) queryParams.maxitems = params.MaxItems

    const result = await this.client.request({
      service: 'route53',
      region: this.region,
      method: 'GET',
      path: `/2013-04-01/hostedzone/${hostedZoneId}/rrset`,
      queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    })

    return this.parseListResourceRecordSetsResponse(result)
  }

  /**
   * Change resource record sets (create, delete, or upsert)
   */
  async changeResourceRecordSets(params: {
    HostedZoneId: string
    ChangeBatch: ChangeBatch
  }): Promise<ChangeResourceRecordSetsResult> {
    // Strip /hostedzone/ prefix if present
    const hostedZoneId = params.HostedZoneId.replace('/hostedzone/', '')

    // Build XML request body
    let xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
  <ChangeBatch>`

    if (params.ChangeBatch.Comment) {
      xmlBody += `
    <Comment>${this.escapeXml(params.ChangeBatch.Comment)}</Comment>`
    }

    xmlBody += `
    <Changes>`

    for (const change of params.ChangeBatch.Changes) {
      xmlBody += `
      <Change>
        <Action>${change.Action}</Action>
        <ResourceRecordSet>
          <Name>${change.ResourceRecordSet.Name}</Name>
          <Type>${change.ResourceRecordSet.Type}</Type>`

      if (change.ResourceRecordSet.TTL !== undefined) {
        xmlBody += `
          <TTL>${change.ResourceRecordSet.TTL}</TTL>`
      }

      if (change.ResourceRecordSet.SetIdentifier) {
        xmlBody += `
          <SetIdentifier>${change.ResourceRecordSet.SetIdentifier}</SetIdentifier>`
      }

      if (change.ResourceRecordSet.Weight !== undefined) {
        xmlBody += `
          <Weight>${change.ResourceRecordSet.Weight}</Weight>`
      }

      if (change.ResourceRecordSet.Region) {
        xmlBody += `
          <Region>${change.ResourceRecordSet.Region}</Region>`
      }

      if (change.ResourceRecordSet.Failover) {
        xmlBody += `
          <Failover>${change.ResourceRecordSet.Failover}</Failover>`
      }

      if (change.ResourceRecordSet.HealthCheckId) {
        xmlBody += `
          <HealthCheckId>${change.ResourceRecordSet.HealthCheckId}</HealthCheckId>`
      }

      if (change.ResourceRecordSet.ResourceRecords && change.ResourceRecordSet.ResourceRecords.length > 0) {
        xmlBody += `
          <ResourceRecords>`
        for (const record of change.ResourceRecordSet.ResourceRecords) {
          xmlBody += `
            <ResourceRecord>
              <Value>${this.escapeXml(record.Value)}</Value>
            </ResourceRecord>`
        }
        xmlBody += `
          </ResourceRecords>`
      }

      if (change.ResourceRecordSet.AliasTarget) {
        xmlBody += `
          <AliasTarget>
            <HostedZoneId>${change.ResourceRecordSet.AliasTarget.HostedZoneId}</HostedZoneId>
            <DNSName>${change.ResourceRecordSet.AliasTarget.DNSName}</DNSName>
            <EvaluateTargetHealth>${change.ResourceRecordSet.AliasTarget.EvaluateTargetHealth}</EvaluateTargetHealth>
          </AliasTarget>`
      }

      if (change.ResourceRecordSet.GeoLocation) {
        xmlBody += `
          <GeoLocation>`
        if (change.ResourceRecordSet.GeoLocation.ContinentCode) {
          xmlBody += `
            <ContinentCode>${change.ResourceRecordSet.GeoLocation.ContinentCode}</ContinentCode>`
        }
        if (change.ResourceRecordSet.GeoLocation.CountryCode) {
          xmlBody += `
            <CountryCode>${change.ResourceRecordSet.GeoLocation.CountryCode}</CountryCode>`
        }
        if (change.ResourceRecordSet.GeoLocation.SubdivisionCode) {
          xmlBody += `
            <SubdivisionCode>${change.ResourceRecordSet.GeoLocation.SubdivisionCode}</SubdivisionCode>`
        }
        xmlBody += `
          </GeoLocation>`
      }

      xmlBody += `
        </ResourceRecordSet>
      </Change>`
    }

    xmlBody += `
    </Changes>
  </ChangeBatch>
</ChangeResourceRecordSetsRequest>`

    const result = await this.client.request({
      service: 'route53',
      region: this.region,
      method: 'POST',
      path: `/2013-04-01/hostedzone/${hostedZoneId}/rrset`,
      headers: {
        'content-type': 'application/xml',
      },
      body: xmlBody,
    })

    return this.parseChangeResourceRecordSetsResponse(result)
  }

  /**
   * Escape XML special characters
   */
  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  }

  /**
   * Parse CreateHostedZone response
   */
  private parseCreateHostedZoneResponse(result: any): CreateHostedZoneResult {
    const response = result.CreateHostedZoneResponse || result

    return {
      HostedZone: this.parseHostedZone(response.HostedZone),
      ChangeInfo: {
        Id: response.ChangeInfo?.Id || '',
        Status: response.ChangeInfo?.Status || '',
        SubmittedAt: response.ChangeInfo?.SubmittedAt || '',
      },
      DelegationSet: this.parseDelegationSet(response.DelegationSet),
      Location: response.Location || '',
    }
  }

  /**
   * Parse ListHostedZones response
   */
  private parseListHostedZonesResponse(result: any): ListHostedZonesResult {
    const response = result.ListHostedZonesResponse || result.ListHostedZonesByNameResponse || result

    let hostedZones = response.HostedZones?.HostedZone || response.HostedZones || []

    // Ensure it's an array
    if (!Array.isArray(hostedZones)) {
      hostedZones = hostedZones ? [hostedZones] : []
    }

    return {
      HostedZones: hostedZones.map((hz: any) => this.parseHostedZone(hz)),
      IsTruncated: response.IsTruncated === 'true' || response.IsTruncated === true,
      MaxItems: response.MaxItems || '100',
      Marker: response.Marker,
      NextMarker: response.NextMarker,
    }
  }

  /**
   * Parse GetHostedZone response
   */
  private parseGetHostedZoneResponse(result: any): GetHostedZoneResult {
    const response = result.GetHostedZoneResponse || result

    return {
      HostedZone: this.parseHostedZone(response.HostedZone),
      DelegationSet: this.parseDelegationSet(response.DelegationSet),
      VPCs: response.VPCs?.VPC ? (Array.isArray(response.VPCs.VPC) ? response.VPCs.VPC : [response.VPCs.VPC]) : undefined,
    }
  }

  /**
   * Parse ListResourceRecordSets response
   */
  private parseListResourceRecordSetsResponse(result: any): ListResourceRecordSetsResult {
    const response = result.ListResourceRecordSetsResponse || result

    let recordSets = response.ResourceRecordSets?.ResourceRecordSet || response.ResourceRecordSets || []

    // Ensure it's an array
    if (!Array.isArray(recordSets)) {
      recordSets = recordSets ? [recordSets] : []
    }

    return {
      ResourceRecordSets: recordSets.map((rs: any) => this.parseResourceRecordSet(rs)),
      IsTruncated: response.IsTruncated === 'true' || response.IsTruncated === true,
      MaxItems: response.MaxItems || '100',
      NextRecordName: response.NextRecordName,
      NextRecordType: response.NextRecordType,
      NextRecordIdentifier: response.NextRecordIdentifier,
    }
  }

  /**
   * Parse ChangeResourceRecordSets response
   */
  private parseChangeResourceRecordSetsResponse(result: any): ChangeResourceRecordSetsResult {
    const response = result.ChangeResourceRecordSetsResponse || result

    return {
      ChangeInfo: {
        Id: response.ChangeInfo?.Id || '',
        Status: response.ChangeInfo?.Status || '',
        SubmittedAt: response.ChangeInfo?.SubmittedAt || '',
        Comment: response.ChangeInfo?.Comment,
      },
    }
  }

  /**
   * Parse a hosted zone object
   */
  private parseHostedZone(hz: any): HostedZone {
    if (!hz) return { Id: '', Name: '' }

    return {
      Id: hz.Id || '',
      Name: hz.Name || '',
      CallerReference: hz.CallerReference,
      Config: hz.Config ? {
        Comment: hz.Config.Comment,
        PrivateZone: hz.Config.PrivateZone === 'true' || hz.Config.PrivateZone === true,
      } : undefined,
      ResourceRecordSetCount: hz.ResourceRecordSetCount ? Number(hz.ResourceRecordSetCount) : undefined,
    }
  }

  /**
   * Parse a delegation set object
   */
  private parseDelegationSet(ds: any): DelegationSet {
    if (!ds) return { NameServers: [] }

    let nameServers = ds.NameServers?.NameServer || ds.NameServers || []

    // Ensure it's an array
    if (!Array.isArray(nameServers)) {
      nameServers = nameServers ? [nameServers] : []
    }

    return {
      Id: ds.Id,
      CallerReference: ds.CallerReference,
      NameServers: nameServers,
    }
  }

  /**
   * Parse a resource record set object
   */
  private parseResourceRecordSet(rs: any): ResourceRecordSet {
    if (!rs) return { Name: '', Type: '' }

    let resourceRecords = rs.ResourceRecords?.ResourceRecord || rs.ResourceRecords || []

    // Ensure it's an array
    if (!Array.isArray(resourceRecords)) {
      resourceRecords = resourceRecords ? [resourceRecords] : []
    }

    return {
      Name: rs.Name || '',
      Type: rs.Type || '',
      TTL: rs.TTL ? Number(rs.TTL) : undefined,
      ResourceRecords: resourceRecords.map((rr: any) => ({
        Value: rr.Value || rr,
      })),
      AliasTarget: rs.AliasTarget ? {
        HostedZoneId: rs.AliasTarget.HostedZoneId,
        DNSName: rs.AliasTarget.DNSName,
        EvaluateTargetHealth: rs.AliasTarget.EvaluateTargetHealth === 'true' || rs.AliasTarget.EvaluateTargetHealth === true,
      } : undefined,
      SetIdentifier: rs.SetIdentifier,
      Weight: rs.Weight ? Number(rs.Weight) : undefined,
      Region: rs.Region,
      GeoLocation: rs.GeoLocation,
      Failover: rs.Failover,
      HealthCheckId: rs.HealthCheckId,
    }
  }

  // Helper methods for common operations

  /**
   * Find hosted zone by domain name
   */
  async findHostedZoneByName(domainName: string): Promise<HostedZone | null> {
    // Ensure domain ends with a dot
    const normalizedDomain = domainName.endsWith('.') ? domainName : `${domainName}.`

    const result = await this.listHostedZonesByName({ DNSName: normalizedDomain })
    const zone = result.HostedZones.find(z => z.Name === normalizedDomain)

    return zone || null
  }

  /**
   * Create an A record
   */
  async createARecord(params: {
    HostedZoneId: string
    Name: string
    Value: string | string[]
    TTL?: number
  }): Promise<ChangeResourceRecordSetsResult> {
    const values = Array.isArray(params.Value) ? params.Value : [params.Value]

    return this.changeResourceRecordSets({
      HostedZoneId: params.HostedZoneId,
      ChangeBatch: {
        Changes: [{
          Action: 'UPSERT',
          ResourceRecordSet: {
            Name: params.Name,
            Type: 'A',
            TTL: params.TTL || 300,
            ResourceRecords: values.map(v => ({ Value: v })),
          },
        }],
      },
    })
  }

  /**
   * Create a CNAME record
   */
  async createCnameRecord(params: {
    HostedZoneId: string
    Name: string
    Value: string
    TTL?: number
  }): Promise<ChangeResourceRecordSetsResult> {
    return this.changeResourceRecordSets({
      HostedZoneId: params.HostedZoneId,
      ChangeBatch: {
        Changes: [{
          Action: 'UPSERT',
          ResourceRecordSet: {
            Name: params.Name,
            Type: 'CNAME',
            TTL: params.TTL || 300,
            ResourceRecords: [{ Value: params.Value }],
          },
        }],
      },
    })
  }

  /**
   * Create an alias record (for CloudFront, ALB, etc.)
   */
  async createAliasRecord(params: {
    HostedZoneId: string
    Name: string
    TargetHostedZoneId: string
    TargetDNSName: string
    EvaluateTargetHealth?: boolean
    Type?: 'A' | 'AAAA'
  }): Promise<ChangeResourceRecordSetsResult> {
    return this.changeResourceRecordSets({
      HostedZoneId: params.HostedZoneId,
      ChangeBatch: {
        Changes: [{
          Action: 'UPSERT',
          ResourceRecordSet: {
            Name: params.Name,
            Type: params.Type || 'A',
            AliasTarget: {
              HostedZoneId: params.TargetHostedZoneId,
              DNSName: params.TargetDNSName,
              EvaluateTargetHealth: params.EvaluateTargetHealth ?? false,
            },
          },
        }],
      },
    })
  }

  /**
   * Create a TXT record
   */
  async createTxtRecord(params: {
    HostedZoneId: string
    Name: string
    Value: string | string[]
    TTL?: number
  }): Promise<ChangeResourceRecordSetsResult> {
    const values = Array.isArray(params.Value) ? params.Value : [params.Value]
    // TXT records need to be quoted
    const quotedValues = values.map((v) => {
      if (!v.startsWith('"')) {
        return `"${v}"`
      }
      return v
    })

    return this.changeResourceRecordSets({
      HostedZoneId: params.HostedZoneId,
      ChangeBatch: {
        Changes: [{
          Action: 'UPSERT',
          ResourceRecordSet: {
            Name: params.Name,
            Type: 'TXT',
            TTL: params.TTL || 300,
            ResourceRecords: quotedValues.map(v => ({ Value: v })),
          },
        }],
      },
    })
  }

  /**
   * Create an MX record
   */
  async createMxRecord(params: {
    HostedZoneId: string
    Name: string
    Values: Array<{ priority: number, mailServer: string }>
    TTL?: number
  }): Promise<ChangeResourceRecordSetsResult> {
    return this.changeResourceRecordSets({
      HostedZoneId: params.HostedZoneId,
      ChangeBatch: {
        Changes: [{
          Action: 'UPSERT',
          ResourceRecordSet: {
            Name: params.Name,
            Type: 'MX',
            TTL: params.TTL || 300,
            ResourceRecords: params.Values.map(v => ({
              Value: `${v.priority} ${v.mailServer}`,
            })),
          },
        }],
      },
    })
  }

  /**
   * Delete a record
   */
  async deleteRecord(params: {
    HostedZoneId: string
    RecordSet: ResourceRecordSet
  }): Promise<ChangeResourceRecordSetsResult> {
    return this.changeResourceRecordSets({
      HostedZoneId: params.HostedZoneId,
      ChangeBatch: {
        Changes: [{
          Action: 'DELETE',
          ResourceRecordSet: params.RecordSet,
        }],
      },
    })
  }

  /**
   * Wait for a change to become INSYNC
   */
  async waitForChange(changeId: string, maxAttempts = 60, delayMs = 5000): Promise<boolean> {
    const id = changeId.replace('/change/', '')

    for (let i = 0; i < maxAttempts; i++) {
      const result = await this.client.request({
        service: 'route53',
        region: this.region,
        method: 'GET',
        path: `/2013-04-01/change/${id}`,
      })

      const status = result.GetChangeResponse?.ChangeInfo?.Status || result.ChangeInfo?.Status
      if (status === 'INSYNC') {
        return true
      }

      await new Promise(resolve => setTimeout(resolve, delayMs))
    }

    return false
  }

  /**
   * Find or create a hosted zone for a domain
   * Automatically creates the zone if it doesn't exist
   */
  async findOrCreateHostedZone(params: {
    domainName: string
    comment?: string
    privateZone?: boolean
    vpc?: {
      VPCRegion: string
      VPCId: string
    }
  }): Promise<{
    hostedZone: HostedZone
    nameServers: string[]
    isNew: boolean
  }> {
    // Normalize domain (ensure it ends with a dot)
    const normalizedDomain = params.domainName.endsWith('.')
      ? params.domainName
      : `${params.domainName}.`

    // First, try to find existing hosted zone
    const existing = await this.findHostedZoneByName(normalizedDomain)

    if (existing) {
      // Get the delegation set for name servers
      const zoneDetails = await this.getHostedZone({ Id: existing.Id })
      return {
        hostedZone: existing,
        nameServers: zoneDetails.DelegationSet.NameServers,
        isNew: false,
      }
    }

    // Create new hosted zone
    const result = await this.createHostedZone({
      Name: normalizedDomain,
      HostedZoneConfig: {
        Comment: params.comment || `Hosted zone for ${params.domainName}`,
        PrivateZone: params.privateZone,
      },
      VPC: params.vpc,
    })

    return {
      hostedZone: result.HostedZone,
      nameServers: result.DelegationSet.NameServers,
      isNew: true,
    }
  }

  /**
   * Get the root domain from a subdomain
   * e.g., "api.example.com" -> "example.com"
   */
  static getRootDomain(domain: string): string {
    const parts = domain.replace(/\.$/, '').split('.')
    if (parts.length <= 2) {
      return domain
    }
    // Return last two parts (handles most TLDs)
    return parts.slice(-2).join('.')
  }

  /**
   * Find the hosted zone for a domain or its parent domain
   * Useful when you have a subdomain and need to find the zone
   */
  async findHostedZoneForDomain(domain: string): Promise<HostedZone | null> {
    const normalizedDomain = domain.replace(/\.$/, '')
    const parts = normalizedDomain.split('.')

    // Try from most specific to least specific
    for (let i = 0; i < parts.length - 1; i++) {
      const testDomain = parts.slice(i).join('.')
      const zone = await this.findHostedZoneByName(testDomain)
      if (zone) {
        return zone
      }
    }

    return null
  }

  /**
   * Ensure a hosted zone exists for a domain, creating it if necessary
   * Returns the hosted zone ID suitable for use in CloudFormation
   */
  async ensureHostedZone(params: {
    domainName: string
    comment?: string
  }): Promise<{
    hostedZoneId: string
    nameServers: string[]
    isNew: boolean
    action: 'found' | 'created'
  }> {
    const result = await this.findOrCreateHostedZone({
      domainName: params.domainName,
      comment: params.comment,
    })

    // Strip /hostedzone/ prefix for compatibility
    const hostedZoneId = result.hostedZone.Id.replace('/hostedzone/', '')

    return {
      hostedZoneId,
      nameServers: result.nameServers,
      isNew: result.isNew,
      action: result.isNew ? 'created' : 'found',
    }
  }

  /**
   * Setup DNS for a domain with automatic hosted zone creation
   * Creates the hosted zone if needed and returns setup information
   */
  async setupDomainDns(params: {
    domain: string
    createIfNotExists?: boolean
  }): Promise<{
    success: boolean
    hostedZoneId: string | null
    nameServers: string[]
    isNew: boolean
    message: string
  }> {
    const { domain, createIfNotExists = true } = params

    // Try to find existing zone
    const existing = await this.findHostedZoneByName(domain)

    if (existing) {
      const zoneDetails = await this.getHostedZone({ Id: existing.Id })
      return {
        success: true,
        hostedZoneId: existing.Id.replace('/hostedzone/', ''),
        nameServers: zoneDetails.DelegationSet.NameServers,
        isNew: false,
        message: `Found existing hosted zone for ${domain}`,
      }
    }

    if (!createIfNotExists) {
      return {
        success: false,
        hostedZoneId: null,
        nameServers: [],
        isNew: false,
        message: `No hosted zone found for ${domain} and createIfNotExists is false`,
      }
    }

    // Create the hosted zone
    const result = await this.createHostedZone({
      Name: domain,
      HostedZoneConfig: {
        Comment: `Created automatically by ts-cloud for ${domain}`,
      },
    })

    return {
      success: true,
      hostedZoneId: result.HostedZone.Id.replace('/hostedzone/', ''),
      nameServers: result.DelegationSet.NameServers,
      isNew: true,
      message: `Created new hosted zone for ${domain}. Please update your domain registrar with these name servers: ${result.DelegationSet.NameServers.join(', ')}`,
    }
  }

  /**
   * CloudFront hosted zone ID (global)
   */
  static readonly CloudFrontHostedZoneId = 'Z2FDTNDATAQYW2'

  /**
   * S3 website hosting hosted zone IDs by region
   */
  static readonly S3WebsiteHostedZoneIds: Record<string, string> = {
    'us-east-1': 'Z3AQBSTGFYJSTF',
    'us-east-2': 'Z2O1EMRO9K5GLX',
    'us-west-1': 'Z2F56UZL2M1ACD',
    'us-west-2': 'Z3BJ6K6RIION7M',
    'ap-east-1': 'ZNB98KWMFR0R6',
    'ap-south-1': 'Z11RGJOFQNVJUP',
    'ap-northeast-1': 'Z2M4EHUR26P7ZW',
    'ap-northeast-2': 'Z3W03O7B5YMIYP',
    'ap-northeast-3': 'Z2YQB5RD63NC85',
    'ap-southeast-1': 'Z3O0J2DXBE1FTB',
    'ap-southeast-2': 'Z1WCIGYICN2BYD',
    'ca-central-1': 'Z1QDHH18159H29',
    'eu-central-1': 'Z21DNDUVLTQW6Q',
    'eu-west-1': 'Z1BKCTXD74EZPE',
    'eu-west-2': 'Z3GKZC51ZF0DB4',
    'eu-west-3': 'Z3R1K369G5AVDG',
    'eu-north-1': 'Z3BAZG2TWCNX0D',
    'sa-east-1': 'Z7KQH4QJS55SO',
  }

  /**
   * ALB hosted zone IDs by region
   */
  static readonly ALBHostedZoneIds: Record<string, string> = {
    'us-east-1': 'Z35SXDOTRQ7X7K',
    'us-east-2': 'Z3AADJGX6KTTL2',
    'us-west-1': 'Z368ELLRRE2KJ0',
    'us-west-2': 'Z1H1FL5HABSF5',
    'ap-east-1': 'Z3DQVH9N71FHZ0',
    'ap-south-1': 'ZP97RAFLXTNZK',
    'ap-northeast-1': 'Z14GRHDCWA56QT',
    'ap-northeast-2': 'ZWKZPGTI48KDX',
    'ap-northeast-3': 'Z5LXEBD8Y73MNV',
    'ap-southeast-1': 'Z1LMS91P8CMLE5',
    'ap-southeast-2': 'Z1GM3OXH4ZPM65',
    'ca-central-1': 'ZQSVJUPU6J1EY',
    'eu-central-1': 'Z215JYRZR1TBD5',
    'eu-west-1': 'Z32O12XQLNTSW2',
    'eu-west-2': 'ZHURV8PSTC4K8',
    'eu-west-3': 'Z3Q77PNBQS71R4',
    'eu-north-1': 'Z23TAZ6LKFMNIO',
    'sa-east-1': 'Z2P70J7HTTTPLU',
  }

  /**
   * API Gateway hosted zone IDs by region
   */
  static readonly APIGatewayHostedZoneIds: Record<string, string> = {
    'us-east-1': 'Z1UJRXOUMOOFQ8',
    'us-east-2': 'ZOJJZC49E0EPZ',
    'us-west-1': 'Z2MUQ32089INYE',
    'us-west-2': 'Z2OJLYMUO9EFXC',
    'ap-east-1': 'Z3FD1VL90ND7K5',
    'ap-south-1': 'Z3VO1THU9YC4UR',
    'ap-northeast-1': 'Z1YSHQZHG15GKL',
    'ap-northeast-2': 'Z20JF4UZKIW1U8',
    'ap-northeast-3': 'Z2YQB5RD63NC85',
    'ap-southeast-1': 'ZL327KTPIQFUL',
    'ap-southeast-2': 'Z2RPCDW04V8134',
    'ca-central-1': 'Z19DQILCV0OWEC',
    'eu-central-1': 'Z1U9ULNL0V5AJ3',
    'eu-west-1': 'ZLY8HYME6SFDD',
    'eu-west-2': 'ZJ5UAJN8Y3Z2Q',
    'eu-west-3': 'Z3KY65QIEKYHQQ',
    'eu-north-1': 'Z3UWIKFBOOGXPP',
    'sa-east-1': 'ZCMLWB8V5SYIT',
  }
}
