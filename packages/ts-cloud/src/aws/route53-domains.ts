/**
 * Route53 Domains Client - Domain registration management without AWS SDK
 * Uses direct AWS API calls with Signature V4
 */

import { AWSClient } from './client'

export interface Nameserver {
  Name: string
  GlueIps?: string[]
}

export interface DomainDetail {
  DomainName: string
  Nameservers?: Nameserver[]
  AutoRenew?: boolean
  AdminContact?: ContactDetail
  RegistrantContact?: ContactDetail
  TechContact?: ContactDetail
  AdminPrivacy?: boolean
  RegistrantPrivacy?: boolean
  TechPrivacy?: boolean
  RegistrarName?: string
  WhoIsServer?: string
  RegistrarUrl?: string
  AbuseContactEmail?: string
  AbuseContactPhone?: string
  RegistryDomainId?: string
  CreationDate?: string
  UpdatedDate?: string
  ExpirationDate?: string
  Reseller?: string
  DnsSec?: string
  StatusList?: string[]
}

export interface ContactDetail {
  FirstName?: string
  LastName?: string
  ContactType?: string
  OrganizationName?: string
  AddressLine1?: string
  AddressLine2?: string
  City?: string
  State?: string
  CountryCode?: string
  ZipCode?: string
  PhoneNumber?: string
  Email?: string
  Fax?: string
  ExtraParams?: { Name: string, Value: string }[]
}

export interface UpdateDomainNameserversResult {
  OperationId: string
}

export interface GetDomainDetailResult extends DomainDetail {}

/**
 * Route53 Domains Client for domain registration management
 * Note: Route53 Domains API is only available in us-east-1
 */
export class Route53DomainsClient {
  private client: AWSClient
  private region: string = 'us-east-1' // Route53 Domains is always us-east-1

  constructor() {
    this.client = new AWSClient()
  }

  /**
   * Get details about a specific domain
   */
  async getDomainDetail(params: {
    DomainName: string
  }): Promise<GetDomainDetailResult> {
    const body = JSON.stringify({
      DomainName: params.DomainName,
    })

    const result = await this.client.request({
      service: 'route53domains',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'Route53Domains_v20140515.GetDomainDetail',
      },
      body,
    })

    return this.parseDomainDetail(result)
  }

  /**
   * Update the nameservers for a domain
   */
  async updateDomainNameservers(params: {
    DomainName: string
    Nameservers: { Name: string, GlueIps?: string[] }[]
  }): Promise<UpdateDomainNameserversResult> {
    const body = JSON.stringify({
      DomainName: params.DomainName,
      Nameservers: params.Nameservers.map(ns => ({
        Name: ns.Name,
        ...(ns.GlueIps && { GlueIps: ns.GlueIps }),
      })),
    })

    const result = await this.client.request({
      service: 'route53domains',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'Route53Domains_v20140515.UpdateDomainNameservers',
      },
      body,
    })

    return {
      OperationId: result.OperationId || '',
    }
  }

  /**
   * List domains registered with Route53
   */
  async listDomains(params?: {
    Marker?: string
    MaxItems?: number
    SortCondition?: {
      Name: 'DomainName' | 'Expiry'
      SortOrder: 'ASC' | 'DESC'
    }
  }): Promise<{
    Domains: { DomainName: string, AutoRenew?: boolean, TransferLock?: boolean, Expiry?: string }[]
    NextPageMarker?: string
  }> {
    const requestBody: Record<string, any> = {}

    if (params?.Marker) requestBody.Marker = params.Marker
    if (params?.MaxItems) requestBody.MaxItems = params.MaxItems
    if (params?.SortCondition) requestBody.SortCondition = params.SortCondition

    const body = JSON.stringify(requestBody)

    const result = await this.client.request({
      service: 'route53domains',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'Route53Domains_v20140515.ListDomains',
      },
      body,
    })

    return {
      Domains: result.Domains || [],
      NextPageMarker: result.NextPageMarker,
    }
  }

  /**
   * Check domain availability
   */
  async checkDomainAvailability(params: {
    DomainName: string
  }): Promise<{
    Availability: 'AVAILABLE' | 'AVAILABLE_RESERVED' | 'AVAILABLE_PREORDER' | 'UNAVAILABLE' | 'UNAVAILABLE_PREMIUM' | 'UNAVAILABLE_RESTRICTED' | 'RESERVED' | 'DONT_KNOW'
  }> {
    const body = JSON.stringify({
      DomainName: params.DomainName,
    })

    const result = await this.client.request({
      service: 'route53domains',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'Route53Domains_v20140515.CheckDomainAvailability',
      },
      body,
    })

    return {
      Availability: result.Availability || 'DONT_KNOW',
    }
  }

  /**
   * Parse domain detail response
   */
  private parseDomainDetail(result: any): GetDomainDetailResult {
    return {
      DomainName: result.DomainName || '',
      Nameservers: result.Nameservers?.map((ns: any) => ({
        Name: ns.Name,
        GlueIps: ns.GlueIps,
      })),
      AutoRenew: result.AutoRenew,
      AdminContact: result.AdminContact,
      RegistrantContact: result.RegistrantContact,
      TechContact: result.TechContact,
      AdminPrivacy: result.AdminPrivacy,
      RegistrantPrivacy: result.RegistrantPrivacy,
      TechPrivacy: result.TechPrivacy,
      RegistrarName: result.RegistrarName,
      WhoIsServer: result.WhoIsServer,
      RegistrarUrl: result.RegistrarUrl,
      AbuseContactEmail: result.AbuseContactEmail,
      AbuseContactPhone: result.AbuseContactPhone,
      RegistryDomainId: result.RegistryDomainId,
      CreationDate: result.CreationDate,
      UpdatedDate: result.UpdatedDate,
      ExpirationDate: result.ExpirationDate,
      Reseller: result.Reseller,
      DnsSec: result.DnsSec,
      StatusList: result.StatusList,
    }
  }
}
