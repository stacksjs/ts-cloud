/**
 * Unified DNS Validator for ACM Certificates
 * Works with any DNS provider (Route53, Porkbun, GoDaddy, etc.)
 */

import { ACMClient } from '../aws/acm'
import type { DnsProvider, DnsProviderConfig } from './types'
import { createDnsProvider } from './index'

export interface ValidationRecord {
  domainName: string
  recordName: string
  recordType: string
  recordValue: string
}

export interface CertificateValidationResult {
  certificateArn: string
  validationRecords: ValidationRecord[]
  isNew: boolean
  status: 'pending' | 'issued' | 'failed'
}

/**
 * Unified DNS Validator
 * Handles ACM certificate validation with any DNS provider
 */
export class UnifiedDnsValidator {
  private acm: ACMClient
  private dnsProvider: DnsProvider

  constructor(
    dnsProvider: DnsProvider | DnsProviderConfig,
    acmRegion: string = 'us-east-1',
  ) {
    this.acm = new ACMClient(acmRegion)

    if ('provider' in dnsProvider) {
      this.dnsProvider = createDnsProvider(dnsProvider)
    }
    else {
      this.dnsProvider = dnsProvider
    }
  }

  /**
   * Get the DNS provider being used
   */
  getProvider(): DnsProvider {
    return this.dnsProvider
  }

  /**
   * Request a certificate and create DNS validation records
   */
  async requestAndValidate(params: {
    domainName: string
    subjectAlternativeNames?: string[]
    waitForValidation?: boolean
    maxWaitMinutes?: number
  }): Promise<CertificateValidationResult> {
    const {
      domainName,
      subjectAlternativeNames = [],
      waitForValidation = false,
      maxWaitMinutes = 30,
    } = params

    // Request certificate from ACM
    const { CertificateArn } = await this.acm.requestCertificate({
      DomainName: domainName,
      SubjectAlternativeNames: subjectAlternativeNames.length > 0
        ? [domainName, ...subjectAlternativeNames]
        : undefined,
      ValidationMethod: 'DNS',
    })

    // Wait for validation options to be available
    await this.waitForValidationOptions(CertificateArn)

    // Get DNS validation records
    const validationRecords = await this.acm.getDnsValidationRecords(CertificateArn)

    // Create DNS records using the configured provider
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

    // Wait for certificate validation if requested
    let status: 'pending' | 'issued' | 'failed' = 'pending'

    if (waitForValidation) {
      const cert = await this.acm.waitForCertificateValidation(
        CertificateArn,
        maxWaitMinutes * 2,
        30000,
      )

      status = cert?.Status === 'ISSUED' ? 'issued' : 'failed'
    }

    return {
      certificateArn: CertificateArn,
      validationRecords: validationRecords.map(r => ({
        domainName: r.domainName,
        recordName: r.recordName,
        recordType: r.recordType,
        recordValue: r.recordValue,
      })),
      isNew: true,
      status,
    }
  }

  /**
   * Create validation records for an existing certificate
   */
  async createValidationRecords(params: {
    certificateArn: string
    domain: string
  }): Promise<{
    success: boolean
    records: ValidationRecord[]
    errors: string[]
  }> {
    const { certificateArn, domain } = params
    const errors: string[] = []

    // Get validation records from ACM
    const validationRecords = await this.acm.getDnsValidationRecords(certificateArn)

    // Create DNS records
    for (const record of validationRecords) {
      const result = await this.dnsProvider.upsertRecord(domain, {
        name: record.recordName,
        type: record.recordType as any,
        content: record.recordValue,
        ttl: 300,
      })

      if (!result.success) {
        errors.push(`Failed to create record for ${record.domainName}: ${result.message}`)
      }
    }

    return {
      success: errors.length === 0,
      records: validationRecords.map(r => ({
        domainName: r.domainName,
        recordName: r.recordName,
        recordType: r.recordType,
        recordValue: r.recordValue,
      })),
      errors,
    }
  }

  /**
   * Delete validation records (cleanup after certificate is issued)
   */
  async deleteValidationRecords(params: {
    certificateArn: string
    domain: string
  }): Promise<{
    success: boolean
    errors: string[]
  }> {
    const { certificateArn, domain } = params
    const errors: string[] = []

    // Get validation records from ACM
    const validationRecords = await this.acm.getDnsValidationRecords(certificateArn)

    // Delete DNS records
    for (const record of validationRecords) {
      const result = await this.dnsProvider.deleteRecord(domain, {
        name: record.recordName,
        type: record.recordType as any,
        content: record.recordValue,
      })

      if (!result.success) {
        errors.push(`Failed to delete record for ${record.domainName}: ${result.message}`)
      }
    }

    return {
      success: errors.length === 0,
      errors,
    }
  }

  /**
   * Find or create a certificate for a domain
   */
  async findOrCreateCertificate(params: {
    domainName: string
    subjectAlternativeNames?: string[]
    waitForValidation?: boolean
    maxWaitMinutes?: number
  }): Promise<CertificateValidationResult> {
    const { domainName, subjectAlternativeNames, waitForValidation = true, maxWaitMinutes } = params

    // Try to find existing certificate
    const existing = await this.acm.findCertificateByDomain(domainName)

    if (existing && existing.Status === 'ISSUED') {
      return {
        certificateArn: existing.CertificateArn,
        validationRecords: [],
        isNew: false,
        status: 'issued',
      }
    }

    // Request new certificate
    return this.requestAndValidate({
      domainName,
      subjectAlternativeNames,
      waitForValidation,
      maxWaitMinutes,
    })
  }

  /**
   * Request certificate with common SANs (www and wildcard)
   */
  async requestCertificateWithCommonSans(params: {
    domainName: string
    includeWww?: boolean
    includeWildcard?: boolean
    additionalSans?: string[]
    waitForValidation?: boolean
  }): Promise<CertificateValidationResult> {
    const {
      domainName,
      includeWww = true,
      includeWildcard = false,
      additionalSans = [],
      waitForValidation = false,
    } = params

    const sans: string[] = []

    if (includeWww) {
      sans.push(`www.${domainName}`)
    }

    if (includeWildcard) {
      sans.push(`*.${domainName}`)
    }

    sans.push(...additionalSans)

    return this.requestAndValidate({
      domainName,
      subjectAlternativeNames: sans,
      waitForValidation,
    })
  }

  /**
   * Wait for validation options to become available
   */
  private async waitForValidationOptions(
    certificateArn: string,
    maxAttempts = 30,
  ): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      const cert = await this.acm.describeCertificate({ CertificateArn: certificateArn })

      if (
        cert.DomainValidationOptions
        && cert.DomainValidationOptions.length > 0
        && cert.DomainValidationOptions[0].ResourceRecord
      ) {
        return
      }

      await new Promise(resolve => setTimeout(resolve, 2000))
    }

    throw new Error('Timeout waiting for DNS validation options')
  }

  /**
   * Get the status of a certificate
   */
  async getCertificateStatus(certificateArn: string): Promise<{
    status: string
    domainValidations: Array<{
      domain: string
      status: string
    }>
  }> {
    const cert = await this.acm.describeCertificate({ CertificateArn: certificateArn })

    return {
      status: cert.Status,
      domainValidations: (cert.DomainValidationOptions || []).map(opt => ({
        domain: opt.DomainName,
        status: opt.ValidationStatus || 'UNKNOWN',
      })),
    }
  }
}

/**
 * Helper function to create a validator with Porkbun
 */
export function createPorkbunValidator(
  apiKey: string,
  secretKey: string,
  acmRegion?: string,
): UnifiedDnsValidator {
  return new UnifiedDnsValidator(
    { provider: 'porkbun', apiKey, secretKey },
    acmRegion,
  )
}

/**
 * Helper function to create a validator with GoDaddy
 */
export function createGoDaddyValidator(
  apiKey: string,
  apiSecret: string,
  acmRegion?: string,
  environment?: 'production' | 'ote',
): UnifiedDnsValidator {
  return new UnifiedDnsValidator(
    { provider: 'godaddy', apiKey, apiSecret, environment },
    acmRegion,
  )
}

/**
 * Helper function to create a validator with Route53
 */
export function createRoute53Validator(
  region?: string,
  hostedZoneId?: string,
  acmRegion?: string,
): UnifiedDnsValidator {
  return new UnifiedDnsValidator(
    { provider: 'route53', region, hostedZoneId },
    acmRegion || region,
  )
}
