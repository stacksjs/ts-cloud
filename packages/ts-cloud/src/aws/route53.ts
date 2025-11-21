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
}
