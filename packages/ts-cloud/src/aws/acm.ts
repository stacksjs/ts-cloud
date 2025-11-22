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
}
