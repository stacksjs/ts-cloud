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

/**
 * Helper class for ACM DNS validation with Route53 integration
 */
export class ACMDnsValidator {
  private acm: ACMClient
  private route53: Route53Client

  constructor(region: string = 'us-east-1') {
    this.acm = new ACMClient(region)
    this.route53 = new Route53Client()
  }

  /**
   * Request certificate and automatically create DNS validation records
   */
  async requestAndValidate(params: {
    domainName: string
    hostedZoneId: string
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

    // Create Route53 records for each validation record
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
   */
  async createValidationRecords(params: {
    certificateArn: string
    hostedZoneId: string
  }): Promise<Array<{
    domainName: string
    recordName: string
    recordValue: string
    changeId?: string
  }>> {
    const { certificateArn, hostedZoneId } = params

    // Get validation records
    const validationRecords = await this.acm.getDnsValidationRecords(certificateArn)
    const results: Array<{
      domainName: string
      recordName: string
      recordValue: string
      changeId?: string
    }> = []

    // Create Route53 records for each validation record
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

    return results
  }

  /**
   * Delete validation records after certificate is issued
   */
  async deleteValidationRecords(params: {
    certificateArn: string
    hostedZoneId: string
  }): Promise<void> {
    const { certificateArn, hostedZoneId } = params

    // Get validation records
    const validationRecords = await this.acm.getDnsValidationRecords(certificateArn)

    // Delete Route53 records
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

  /**
   * Find or create a certificate for a domain
   */
  async findOrCreateCertificate(params: {
    domainName: string
    hostedZoneId: string
    subjectAlternativeNames?: string[]
    waitForValidation?: boolean
  }): Promise<{
    certificateArn: string
    isNew: boolean
  }> {
    const { domainName, hostedZoneId, subjectAlternativeNames, waitForValidation = true } = params

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
}
