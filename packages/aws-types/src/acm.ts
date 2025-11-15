import type { CloudFormationResource } from './index'

export interface ACMCertificate extends CloudFormationResource {
  Type: 'AWS::CertificateManager::Certificate'
  Properties: {
    DomainName: string
    SubjectAlternativeNames?: string[]
    DomainValidationOptions?: Array<{
      DomainName: string
      HostedZoneId?: string
      ValidationDomain?: string
    }>
    ValidationMethod?: 'DNS' | 'EMAIL'
    CertificateTransparencyLoggingPreference?: 'ENABLED' | 'DISABLED'
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}
