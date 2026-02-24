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

export type ContactType = 'PERSON' | 'COMPANY' | 'ASSOCIATION' | 'PUBLIC_BODY' | 'RESELLER'

export type CountryCode =
  | 'AC' | 'AD' | 'AE' | 'AF' | 'AG' | 'AI' | 'AL' | 'AM' | 'AN' | 'AO' | 'AQ' | 'AR' | 'AS' | 'AT' | 'AU'
  | 'AW' | 'AX' | 'AZ' | 'BA' | 'BB' | 'BD' | 'BE' | 'BF' | 'BG' | 'BH' | 'BI' | 'BJ' | 'BL' | 'BM' | 'BN'
  | 'BO' | 'BQ' | 'BR' | 'BS' | 'BT' | 'BV' | 'BW' | 'BY' | 'BZ' | 'CA' | 'CC' | 'CD' | 'CF' | 'CG' | 'CH'
  | 'CI' | 'CK' | 'CL' | 'CM' | 'CN' | 'CO' | 'CR' | 'CU' | 'CV' | 'CW' | 'CX' | 'CY' | 'CZ' | 'DE' | 'DJ'
  | 'DK' | 'DM' | 'DO' | 'DZ' | 'EC' | 'EE' | 'EG' | 'EH' | 'ER' | 'ES' | 'ET' | 'FI' | 'FJ' | 'FK' | 'FM'
  | 'FO' | 'FR' | 'GA' | 'GB' | 'GD' | 'GE' | 'GF' | 'GG' | 'GH' | 'GI' | 'GL' | 'GM' | 'GN' | 'GP' | 'GQ'
  | 'GR' | 'GS' | 'GT' | 'GU' | 'GW' | 'GY' | 'HK' | 'HM' | 'HN' | 'HR' | 'HT' | 'HU' | 'ID' | 'IE' | 'IL'
  | 'IM' | 'IN' | 'IO' | 'IQ' | 'IR' | 'IS' | 'IT' | 'JE' | 'JM' | 'JO' | 'JP' | 'KE' | 'KG' | 'KH' | 'KI'
  | 'KM' | 'KN' | 'KP' | 'KR' | 'KW' | 'KY' | 'KZ' | 'LA' | 'LB' | 'LC' | 'LI' | 'LK' | 'LR' | 'LS' | 'LT'
  | 'LU' | 'LV' | 'LY' | 'MA' | 'MC' | 'MD' | 'ME' | 'MF' | 'MG' | 'MH' | 'MK' | 'ML' | 'MM' | 'MN' | 'MO'
  | 'MP' | 'MQ' | 'MR' | 'MS' | 'MT' | 'MU' | 'MV' | 'MW' | 'MX' | 'MY' | 'MZ' | 'NA' | 'NC' | 'NE' | 'NF'
  | 'NG' | 'NI' | 'NL' | 'NO' | 'NP' | 'NR' | 'NU' | 'NZ' | 'OM' | 'PA' | 'PE' | 'PF' | 'PG' | 'PH' | 'PK'
  | 'PL' | 'PM' | 'PN' | 'PR' | 'PS' | 'PT' | 'PW' | 'PY' | 'QA' | 'RE' | 'RO' | 'RS' | 'RU' | 'RW' | 'SA'
  | 'SB' | 'SC' | 'SD' | 'SE' | 'SG' | 'SH' | 'SI' | 'SJ' | 'SK' | 'SL' | 'SM' | 'SN' | 'SO' | 'SR' | 'SS'
  | 'ST' | 'SV' | 'SX' | 'SY' | 'SZ' | 'TC' | 'TD' | 'TF' | 'TG' | 'TH' | 'TJ' | 'TK' | 'TL' | 'TM' | 'TN'
  | 'TO' | 'TP' | 'TR' | 'TT' | 'TV' | 'TW' | 'TZ' | 'UA' | 'UG' | 'US' | 'UY' | 'UZ' | 'VA' | 'VC' | 'VE'
  | 'VG' | 'VI' | 'VN' | 'VU' | 'WF' | 'WS' | 'YE' | 'YT' | 'ZA' | 'ZM' | 'ZW'

export interface ContactDetail {
  FirstName?: string
  LastName?: string
  ContactType?: ContactType
  OrganizationName?: string
  AddressLine1?: string
  AddressLine2?: string
  City?: string
  State?: string
  CountryCode?: CountryCode
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
   * Get domain pricing information
   */
  async getDomainPrice(params: {
    DomainName: string
  }): Promise<{
    RegistrationPrice?: { Price: number, Currency: string }
    RenewalPrice?: { Price: number, Currency: string }
    TransferPrice?: { Price: number, Currency: string }
  }> {
    // Extract TLD from domain name
    const tld = params.DomainName.split('.').slice(1).join('.')

    const body = JSON.stringify({
      Tld: tld,
    })

    const result = await this.client.request({
      service: 'route53domains',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'Route53Domains_v20140515.ListPrices',
      },
      body,
    })

    const prices = result.Prices?.[0] || {}
    return {
      RegistrationPrice: prices.RegistrationPrice ? {
        Price: prices.RegistrationPrice.Price,
        Currency: prices.RegistrationPrice.Currency,
      } : undefined,
      RenewalPrice: prices.RenewalPrice ? {
        Price: prices.RenewalPrice.Price,
        Currency: prices.RenewalPrice.Currency,
      } : undefined,
      TransferPrice: prices.TransferPrice ? {
        Price: prices.TransferPrice.Price,
        Currency: prices.TransferPrice.Currency,
      } : undefined,
    }
  }

  /**
   * Register a new domain
   */
  async registerDomain(params: {
    DomainName: string
    DurationInYears: number
    AutoRenew?: boolean
    AdminContact: ContactDetail
    RegistrantContact: ContactDetail
    TechContact: ContactDetail
    PrivacyProtectAdminContact?: boolean
    PrivacyProtectRegistrantContact?: boolean
    PrivacyProtectTechContact?: boolean
  }): Promise<{
    OperationId: string
  }> {
    const body = JSON.stringify({
      DomainName: params.DomainName,
      DurationInYears: params.DurationInYears,
      AutoRenew: params.AutoRenew ?? true,
      AdminContact: params.AdminContact,
      RegistrantContact: params.RegistrantContact,
      TechContact: params.TechContact,
      PrivacyProtectAdminContact: params.PrivacyProtectAdminContact ?? true,
      PrivacyProtectRegistrantContact: params.PrivacyProtectRegistrantContact ?? true,
      PrivacyProtectTechContact: params.PrivacyProtectTechContact ?? true,
    })

    const result = await this.client.request({
      service: 'route53domains',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'Route53Domains_v20140515.RegisterDomain',
      },
      body,
    })

    return {
      OperationId: result.OperationId || '',
    }
  }

  /**
   * Get operation details (for tracking domain registration status)
   */
  async getOperationDetail(params: {
    OperationId: string
  }): Promise<{
    OperationId: string
    Status: 'SUBMITTED' | 'IN_PROGRESS' | 'ERROR' | 'SUCCESSFUL' | 'FAILED'
    Message?: string
    DomainName?: string
    Type?: string
    SubmittedDate?: string
  }> {
    const body = JSON.stringify({
      OperationId: params.OperationId,
    })

    const result = await this.client.request({
      service: 'route53domains',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'Route53Domains_v20140515.GetOperationDetail',
      },
      body,
    })

    return {
      OperationId: result.OperationId || '',
      Status: result.Status || 'SUBMITTED',
      Message: result.Message,
      DomainName: result.DomainName,
      Type: result.Type,
      SubmittedDate: result.SubmittedDate,
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
