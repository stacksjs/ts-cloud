/**
 * ACM (AWS Certificate Manager) Client
 * For requesting and managing SSL/TLS certificates
*/

import { AWSClient } from './client'

export interface CertificateDetail {
  CertificateArn: string
  DomainName: string
  SubjectAlternativeNames?: string[]
  Status: 'PENDING_VALIDATION' | 'ISSUED' | 'INACTIVE' | 'EXPIRED' | 'VALIDATION_TIMED_OUT' | 'REVOKED' | 'FAILED'
  Type?: 'IMPORTED' | 'AMAZON_ISSUED' | 'PRIVATE'
  DomainValidationOptions?: {
    DomainName: string
    ValidationDomain?: string
    ValidationStatus?: 'PENDING_VALIDATION' | 'SUCCESS' | 'FAILED'
    ResourceRecord?: {
      Name: string
      Type: string
      Value: string
    }
    ValidationMethod?: 'EMAIL' | 'DNS'
  }[]
  CreatedAt?: string
  IssuedAt?: string
  NotBefore?: string
  NotAfter?: string
}

export class ACMClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.client = new AWSClient()
    this.region = region
  }

  /**
   * Request a new certificate
  */
  async requestCertificate(params: {
    DomainName: string
    SubjectAlternativeNames?: string[]
    ValidationMethod?: 'EMAIL' | 'DNS'
  }): Promise<{
    CertificateArn: string
  }> {
    const requestBody: Record<string, any> = {
      DomainName: params.DomainName,
      ValidationMethod: params.ValidationMethod || 'DNS',
    }

    if (params.SubjectAlternativeNames) {
      requestBody.SubjectAlternativeNames = params.SubjectAlternativeNames
    }

    const result = await this.client.request({
      service: 'acm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'CertificateManager.RequestCertificate',
      },
      body: JSON.stringify(requestBody),
    })

    return {
      CertificateArn: result.CertificateArn || '',
    }
  }

  /**
   * Describe a certificate to get its details and validation options
  */
  async describeCertificate(params: {
    CertificateArn: string
  }): Promise<CertificateDetail> {
    const result = await this.client.request({
      service: 'acm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'CertificateManager.DescribeCertificate',
      },
      body: JSON.stringify({
        CertificateArn: params.CertificateArn,
      }),
    })

    const cert = result.Certificate || {}
    return {
      CertificateArn: cert.CertificateArn || '',
      DomainName: cert.DomainName || '',
      SubjectAlternativeNames: cert.SubjectAlternativeNames,
      Status: cert.Status || 'PENDING_VALIDATION',
      Type: cert.Type,
      DomainValidationOptions: cert.DomainValidationOptions?.map((opt: any) => ({
        DomainName: opt.DomainName,
        ValidationDomain: opt.ValidationDomain,
        ValidationStatus: opt.ValidationStatus,
        ResourceRecord: opt.ResourceRecord ? {
          Name: opt.ResourceRecord.Name,
          Type: opt.ResourceRecord.Type,
          Value: opt.ResourceRecord.Value,
        } : undefined,
        ValidationMethod: opt.ValidationMethod,
      })),
      CreatedAt: cert.CreatedAt,
      IssuedAt: cert.IssuedAt,
      NotBefore: cert.NotBefore,
      NotAfter: cert.NotAfter,
    }
  }

  /**
   * List certificates
  */
  async listCertificates(params?: {
    CertificateStatuses?: ('PENDING_VALIDATION' | 'ISSUED' | 'INACTIVE' | 'EXPIRED' | 'VALIDATION_TIMED_OUT' | 'REVOKED' | 'FAILED')[]
    MaxItems?: number
    NextToken?: string
  }): Promise<{
    CertificateSummaryList: { CertificateArn: string, DomainName: string }[]
    NextToken?: string
  }> {
    const requestBody: Record<string, any> = {}

    if (params?.CertificateStatuses) {
      requestBody.CertificateStatuses = params.CertificateStatuses
    }
    if (params?.MaxItems) {
      requestBody.MaxItems = params.MaxItems
    }
    if (params?.NextToken) {
      requestBody.NextToken = params.NextToken
    }

    const result = await this.client.request({
      service: 'acm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'CertificateManager.ListCertificates',
      },
      body: JSON.stringify(requestBody),
    })

    return {
      CertificateSummaryList: (result.CertificateSummaryList || []).map((cert: any) => ({
        CertificateArn: cert.CertificateArn,
        DomainName: cert.DomainName,
      })),
      NextToken: result.NextToken,
    }
  }

  /**
   * Delete a certificate
  */
  async deleteCertificate(params: {
    CertificateArn: string
  }): Promise<void> {
    await this.client.request({
      service: 'acm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'CertificateManager.DeleteCertificate',
      },
      body: JSON.stringify({
        CertificateArn: params.CertificateArn,
      }),
    })
  }

  /**
   * Get certificate tags
  */
  async listTagsForCertificate(params: {
    CertificateArn: string
  }): Promise<{ Tags: Array<{ Key: string, Value?: string }> }> {
    const result = await this.client.request({
      service: 'acm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'CertificateManager.ListTagsForCertificate',
      },
      body: JSON.stringify({
        CertificateArn: params.CertificateArn,
      }),
    })

    return {
      Tags: result.Tags || [],
    }
  }

  /**
   * Add tags to a certificate
  */
  async addTagsToCertificate(params: {
    CertificateArn: string
    Tags: Array<{ Key: string, Value?: string }>
  }): Promise<void> {
    await this.client.request({
      service: 'acm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'CertificateManager.AddTagsToCertificate',
      },
      body: JSON.stringify({
        CertificateArn: params.CertificateArn,
        Tags: params.Tags,
      }),
    })
  }

  /**
   * Resend validation email
  */
  async resendValidationEmail(params: {
    CertificateArn: string
    Domain: string
    ValidationDomain: string
  }): Promise<void> {
    await this.client.request({
      service: 'acm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'CertificateManager.ResendValidationEmail',
      },
      body: JSON.stringify({
        CertificateArn: params.CertificateArn,
        Domain: params.Domain,
        ValidationDomain: params.ValidationDomain,
      }),
    })
  }

  // Helper methods

  /**
   * Find certificate by domain name
  */
  async findCertificateByDomain(domainName: string): Promise<CertificateDetail | null> {
    // List all issued certificates
    const result = await this.listCertificates({
      CertificateStatuses: ['ISSUED'],
    })

    // Find certificate matching domain
    const summary = result.CertificateSummaryList.find(c =>
      c.DomainName === domainName ||
      c.DomainName === `*.${domainName.split('.').slice(1).join('.')}`,
    )

    if (!summary) {
      return null
    }

    // Get full details
    return this.describeCertificate({ CertificateArn: summary.CertificateArn })
  }

  /**
   * Wait for certificate to be issued
  */
  async waitForCertificateValidation(
    certificateArn: string,
    maxAttempts = 60,
    delayMs = 30000,
  ): Promise<CertificateDetail | null> {
    for (let i = 0; i < maxAttempts; i++) {
      const cert = await this.describeCertificate({ CertificateArn: certificateArn })

      if (cert.Status === 'ISSUED') {
        return cert
      }

      if (cert.Status === 'FAILED' || cert.Status === 'VALIDATION_TIMED_OUT') {
        return null
      }

      await new Promise(resolve => setTimeout(resolve, delayMs))
    }

    return null
  }

  /**
   * Get DNS validation records for a certificate
  */
  async getDnsValidationRecords(certificateArn: string): Promise<Array<{
    domainName: string
    recordName: string
    recordType: string
    recordValue: string
  }>> {
    const cert = await this.describeCertificate({ CertificateArn: certificateArn })

    if (!cert.DomainValidationOptions) {
      return []
    }

    return cert.DomainValidationOptions
      .filter(opt => opt.ResourceRecord && opt.ValidationMethod === 'DNS')
      .map(opt => ({
        domainName: opt.DomainName,
        recordName: opt.ResourceRecord!.Name,
        recordType: opt.ResourceRecord!.Type,
        recordValue: opt.ResourceRecord!.Value,
      }))
  }

  /**
   * Request certificate for a domain with common SANs
   * Automatically includes www and wildcard
  */
  async requestCertificateWithSans(params: {
    DomainName: string
    IncludeWww?: boolean
    IncludeWildcard?: boolean
    AdditionalSans?: string[]
  }): Promise<{ CertificateArn: string }> {
    const sans = new Set<string>()

    // Always include the main domain
    sans.add(params.DomainName)

    // Add www subdomain
    if (params.IncludeWww !== false) {
      sans.add(`www.${params.DomainName}`)
    }

    // Add wildcard
    if (params.IncludeWildcard) {
      sans.add(`*.${params.DomainName}`)
    }

    // Add additional SANs
    if (params.AdditionalSans) {
      for (const san of params.AdditionalSans) {
        sans.add(san)
      }
    }

    return this.requestCertificate({
      DomainName: params.DomainName,
      SubjectAlternativeNames: Array.from(sans),
      ValidationMethod: 'DNS',
    })
  }

  /**
   * Check if certificate is valid for a given domain
  */
  async isCertificateValidForDomain(
    certificateArn: string,
    domainName: string,
  ): Promise<boolean> {
    const cert = await this.describeCertificate({ CertificateArn: certificateArn })

    if (cert.Status !== 'ISSUED') {
      return false
    }

    // Check if domain matches
    if (cert.DomainName === domainName) {
      return true
    }

    // Check wildcard match
    if (cert.DomainName?.startsWith('*.')) {
      const baseDomain = cert.DomainName.slice(2)
      const domainParts = domainName.split('.')
      const baseParts = baseDomain.split('.')

      if (domainParts.slice(-baseParts.length).join('.') === baseDomain) {
        return true
      }
    }

    // Check SANs
    if (cert.SubjectAlternativeNames) {
      for (const san of cert.SubjectAlternativeNames) {
        if (san === domainName) {
          return true
        }

        if (san.startsWith('*.')) {
          const baseDomain = san.slice(2)
          const domainParts = domainName.split('.')
          const baseParts = baseDomain.split('.')

          if (domainParts.slice(-baseParts.length).join('.') === baseDomain) {
            return true
          }
        }
      }
    }

    return false
  }
}

import { Route53Client } from './route53'
import type { DnsProvider, DnsProviderConfig } from '../dns/types'
import { createDnsProvider } from '../dns'

/**
 * Helper class for ACM DNS validation with Route53 integration
 * @deprecated Use UnifiedDnsValidator from 'ts-cloud/dns' for multi-provider support (Route53, Porkbun, GoDaddy)
*/
export class ACMDnsValidator {
  private acm: ACMClient
  private route53: Route53Client
  private dnsProvider?: DnsProvider

  /**
   * Create ACM DNS validator
   * @param region - AWS region for ACM (default: us-east-1)
   * @param dnsProviderConfig - Optional external DNS provider config (Porkbun, GoDaddy)
  */
  constructor(region: string = 'us-east-1', dnsProviderConfig?: DnsProviderConfig) {
    this.acm = new ACMClient(region)
    this.route53 = new Route53Client()

    // Initialize external DNS provider if config provided
    if (dnsProviderConfig && dnsProviderConfig.provider !== 'route53') {
      this.dnsProvider = createDnsProvider(dnsProviderConfig)
    }
  }

  /**
   * Request certificate and automatically create DNS validation records
   * @param params.domainName - Primary domain name for the certificate
   * @param params.hostedZoneId - Route53 hosted zone ID (required if no external DNS provider configured)
   * @param params.subjectAlternativeNames - Additional domain names (SANs)
   * @param params.waitForValidation - Wait for certificate to be issued
   * @param params.maxWaitMinutes - Maximum wait time in minutes
  */
  async requestAndValidate(params: {
    domainName: string
    hostedZoneId?: string
    subjectAlternativeNames?: string[]
    waitForValidation?: boolean
    maxWaitMinutes?: number
  }): Promise<{
    certificateArn: string
    validationRecords: Array<{
      domainName: string
      recordName: string
      recordValue: string
    }>
  }> {
    const {
      domainName,
      hostedZoneId,
      subjectAlternativeNames = [],
      waitForValidation = false,
      maxWaitMinutes = 30,
    } = params

    // Validate that we have a DNS provider
    if (!this.dnsProvider && !hostedZoneId) {
      throw new Error('Either hostedZoneId or external DNS provider configuration is required')
    }

    // Request certificate
    const { CertificateArn } = await this.acm.requestCertificate({
      DomainName: domainName,
      SubjectAlternativeNames: subjectAlternativeNames.length > 0
        ? [domainName, ...subjectAlternativeNames]
        : undefined,
      ValidationMethod: 'DNS',
    })

    // Wait for DNS validation options to be available
    await this.waitForValidationOptions(CertificateArn)

    // Get validation records
    const validationRecords = await this.acm.getDnsValidationRecords(CertificateArn)

    // Create DNS records using the appropriate provider
    if (this.dnsProvider) {
      // Use external DNS provider (Porkbun, GoDaddy, etc.)
      for (const record of validationRecords) {
        const result = await this.dnsProvider.upsertRecord(domainName, {
          name: record.recordName,
          type: record.recordType as any,
          content: record.recordValue,
          ttl: 300,
        })

        if (!result.success) {
          console.warn(`Failed to create validation record for ${record.domainName}: ${result.message}`)
        }
      }
    }
    else if (hostedZoneId) {
      // Use Route53
      for (const record of validationRecords) {
        await this.route53.changeResourceRecordSets({
          HostedZoneId: hostedZoneId,
          ChangeBatch: {
            Comment: `ACM DNS validation for ${record.domainName}`,
            Changes: [{
              Action: 'UPSERT',
              ResourceRecordSet: {
                Name: record.recordName,
                Type: record.recordType as any,
                TTL: 300,
                ResourceRecords: [{ Value: record.recordValue }],
              },
            }],
          },
        })
      }
    }

    // Wait for validation if requested
    if (waitForValidation) {
      const cert = await this.acm.waitForCertificateValidation(
        CertificateArn,
        maxWaitMinutes * 2, // attempts (every 30 seconds)
        30000, // 30 seconds between checks
      )

      if (!cert) {
        throw new Error(`Certificate validation timed out after ${maxWaitMinutes} minutes`)
      }
    }

    return {
      certificateArn: CertificateArn,
      validationRecords,
    }
  }

  /**
   * Wait for validation options to become available
  */
  private async waitForValidationOptions(certificateArn: string, maxAttempts = 30): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      const cert = await this.acm.describeCertificate({ CertificateArn: certificateArn })

      if (cert.DomainValidationOptions &&
          cert.DomainValidationOptions.length > 0 &&
          cert.DomainValidationOptions[0].ResourceRecord) {
        return
      }

      await new Promise(resolve => setTimeout(resolve, 2000))
    }

    throw new Error('Timeout waiting for DNS validation options')
  }

  /**
   * Create validation records for an existing certificate
   * Uses external DNS provider if configured, otherwise Route53
  */
  async createValidationRecords(params: {
    certificateArn: string
    hostedZoneId?: string
    domain?: string
  }): Promise<Array<{
    domainName: string
    recordName: string
    recordValue: string
    changeId?: string
  }>> {
    const { certificateArn, hostedZoneId, domain } = params

    // Validate DNS provider availability
    if (!this.dnsProvider && !hostedZoneId) {
      throw new Error('Either hostedZoneId or external DNS provider configuration is required')
    }

    // Get validation records
    const validationRecords = await this.acm.getDnsValidationRecords(certificateArn)
    const results: Array<{
      domainName: string
      recordName: string
      recordValue: string
      changeId?: string
    }> = []

    if (this.dnsProvider) {
      // Use external DNS provider
      const targetDomain = domain || validationRecords[0]?.domainName
      for (const record of validationRecords) {
        const result = await this.dnsProvider.upsertRecord(targetDomain, {
          name: record.recordName,
          type: record.recordType as any,
          content: record.recordValue,
          ttl: 300,
        })

        results.push({
          ...record,
          changeId: result.success ? result.id : undefined,
        })
      }
    }
    else if (hostedZoneId) {
      // Use Route53
      for (const record of validationRecords) {
        const result = await this.route53.changeResourceRecordSets({
          HostedZoneId: hostedZoneId,
          ChangeBatch: {
            Comment: `ACM DNS validation for ${record.domainName}`,
            Changes: [{
              Action: 'UPSERT',
              ResourceRecordSet: {
                Name: record.recordName,
                Type: record.recordType as any,
                TTL: 300,
                ResourceRecords: [{ Value: record.recordValue }],
              },
            }],
          },
        })

        results.push({
          ...record,
          changeId: result.ChangeInfo?.Id,
        })
      }
    }

    return results
  }

  /**
   * Delete validation records after certificate is issued
   * Uses external DNS provider if configured, otherwise Route53
  */
  async deleteValidationRecords(params: {
    certificateArn: string
    hostedZoneId?: string
    domain?: string
  }): Promise<void> {
    const { certificateArn, hostedZoneId, domain } = params

    // Get validation records
    const validationRecords = await this.acm.getDnsValidationRecords(certificateArn)

    if (this.dnsProvider) {
      // Use external DNS provider
      const targetDomain = domain || validationRecords[0]?.domainName
      for (const record of validationRecords) {
        try {
          await this.dnsProvider.deleteRecord(targetDomain, {
            name: record.recordName,
            type: record.recordType as any,
            content: record.recordValue,
          })
        }
        catch {
          // Ignore errors if record doesn't exist
        }
      }
    }
    else if (hostedZoneId) {
      // Use Route53
      for (const record of validationRecords) {
        try {
          await this.route53.changeResourceRecordSets({
            HostedZoneId: hostedZoneId,
            ChangeBatch: {
              Comment: `Cleanup ACM DNS validation for ${record.domainName}`,
              Changes: [{
                Action: 'DELETE',
                ResourceRecordSet: {
                  Name: record.recordName,
                  Type: record.recordType as any,
                  TTL: 300,
                  ResourceRecords: [{ Value: record.recordValue }],
                },
              }],
            },
          })
        }
        catch {
          // Ignore errors if record doesn't exist
        }
      }
    }
  }

  /**
   * Find or create a certificate for a domain
   * Uses external DNS provider if configured, otherwise Route53
  */
  async findOrCreateCertificate(params: {
    domainName: string
    hostedZoneId?: string
    subjectAlternativeNames?: string[]
    waitForValidation?: boolean
  }): Promise<{
    certificateArn: string
    isNew: boolean
  }> {
    const { domainName, hostedZoneId, subjectAlternativeNames, waitForValidation = true } = params

    // Validate DNS provider availability
    if (!this.dnsProvider && !hostedZoneId) {
      throw new Error('Either hostedZoneId or external DNS provider configuration is required')
    }

    // Try to find existing certificate
    const existing = await this.acm.findCertificateByDomain(domainName)

    if (existing && existing.Status === 'ISSUED') {
      return {
        certificateArn: existing.CertificateArn,
        isNew: false,
      }
    }

    // Request new certificate
    const { certificateArn } = await this.requestAndValidate({
      domainName,
      hostedZoneId,
      subjectAlternativeNames,
      waitForValidation,
    })

    return {
      certificateArn,
      isNew: true,
    }
  }

  /**
   * Check if using external DNS provider
  */
  hasExternalDnsProvider(): boolean {
    return this.dnsProvider !== undefined
  }

  /**
   * Get the DNS provider name if using external provider
  */
  getDnsProviderName(): string {
    return this.dnsProvider?.name || 'route53'
  }
}
