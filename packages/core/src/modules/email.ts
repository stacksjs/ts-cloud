import type {
  Route53RecordSet,
  SESConfigurationSet,
  SESEmailIdentity,
  SESReceiptRule,
  SESReceiptRuleSet,
} from '@ts-cloud/aws-types'
import type { EnvironmentType } from '@ts-cloud/types'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface EmailIdentityOptions {
  domain: string
  slug: string
  environment: EnvironmentType
  enableDkim?: boolean
  dkimKeyLength?: 'RSA_1024_BIT' | 'RSA_2048_BIT'
}

export interface ConfigurationSetOptions {
  slug: string
  environment: EnvironmentType
  name?: string
  reputationMetrics?: boolean
  sendingEnabled?: boolean
  suppressBounces?: boolean
  suppressComplaints?: boolean
}

export interface ReceiptRuleSetOptions {
  slug: string
  environment: EnvironmentType
  name?: string
}

export interface ReceiptRuleOptions {
  slug: string
  environment: EnvironmentType
  ruleSetName: string
  recipients?: string[]
  enabled?: boolean
  scanEnabled?: boolean
  tlsPolicy?: 'Optional' | 'Require'
  s3Action?: {
    bucketName: string
    prefix?: string
    kmsKeyArn?: string
  }
  lambdaAction?: {
    functionArn: string
    invocationType?: 'Event' | 'RequestResponse'
  }
  snsAction?: {
    topicArn: string
    encoding?: 'UTF-8' | 'Base64'
  }
}

/**
 * Email Module - SES (Simple Email Service)
 * Provides clean API for email sending, receiving, and domain verification
 */
export class Email {
  /**
   * Verify a domain for sending emails
   */
  static verifyDomain(options: EmailIdentityOptions): {
    emailIdentity: SESEmailIdentity
    logicalId: string
  } {
    const {
      domain,
      slug,
      environment,
      enableDkim = true,
      dkimKeyLength = 'RSA_2048_BIT',
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'ses-identity',
    })

    const logicalId = generateLogicalId(`${resourceName}-${domain.replace(/\./g, '')}`)

    const emailIdentity: SESEmailIdentity = {
      Type: 'AWS::SES::EmailIdentity',
      Properties: {
        EmailIdentity: domain,
        FeedbackAttributes: {
          EmailForwardingEnabled: true,
        },
      },
    }

    if (enableDkim) {
      emailIdentity.Properties.DkimSigningAttributes = {
        NextSigningKeyLength: dkimKeyLength,
      }
    }

    return { emailIdentity, logicalId }
  }

  /**
   * Create DNS records for DKIM verification
   * Returns Route53 RecordSets for DKIM tokens
   */
  static createDkimRecords(
    domain: string,
    dkimTokens: string[],
    hostedZoneId: string,
  ): Array<{ record: Route53RecordSet, logicalId: string }> {
    const records: Array<{ record: Route53RecordSet, logicalId: string }> = []

    for (let i = 0; i < dkimTokens.length; i++) {
      const token = dkimTokens[i]
      const logicalId = generateLogicalId(`dkim-${domain.replace(/\./g, '')}-${i + 1}`)

      const record: Route53RecordSet = {
        Type: 'AWS::Route53::RecordSet',
        Properties: {
          HostedZoneId: hostedZoneId,
          Name: `${token}._domainkey.${domain}`,
          Type: 'CNAME',
          TTL: 1800,
          ResourceRecords: [`${token}.dkim.amazonses.com`],
        },
      }

      records.push({ record, logicalId })
    }

    return records
  }

  /**
   * Create SES Configuration Set
   */
  static createConfigurationSet(options: ConfigurationSetOptions): {
    configurationSet: SESConfigurationSet
    logicalId: string
  } {
    const {
      slug,
      environment,
      name,
      reputationMetrics = true,
      sendingEnabled = true,
      suppressBounces = true,
      suppressComplaints = true,
    } = options

    const resourceName = name || generateResourceName({
      slug,
      environment,
      resourceType: 'ses-config',
    })

    const logicalId = generateLogicalId(resourceName)

    const suppressedReasons: ('BOUNCE' | 'COMPLAINT')[] = []
    if (suppressBounces)
      suppressedReasons.push('BOUNCE')
    if (suppressComplaints)
      suppressedReasons.push('COMPLAINT')

    const configurationSet: SESConfigurationSet = {
      Type: 'AWS::SES::ConfigurationSet',
      Properties: {
        Name: resourceName,
        ReputationOptions: {
          ReputationMetricsEnabled: reputationMetrics,
        },
        SendingOptions: {
          SendingEnabled: sendingEnabled,
        },
        SuppressionOptions: {
          SuppressedReasons: suppressedReasons,
        },
      },
    }

    return { configurationSet, logicalId }
  }

  /**
   * Create Receipt Rule Set for inbound email
   */
  static createReceiptRuleSet(options: ReceiptRuleSetOptions): {
    ruleSet: SESReceiptRuleSet
    logicalId: string
  } {
    const { slug, environment, name } = options

    const resourceName = name || generateResourceName({
      slug,
      environment,
      resourceType: 'ses-ruleset',
    })

    const logicalId = generateLogicalId(resourceName)

    const ruleSet: SESReceiptRuleSet = {
      Type: 'AWS::SES::ReceiptRuleSet',
      Properties: {
        RuleSetName: resourceName,
      },
    }

    return { ruleSet, logicalId }
  }

  /**
   * Create Receipt Rule for processing inbound emails
   */
  static createReceiptRule(
    ruleSetLogicalId: string,
    options: ReceiptRuleOptions,
  ): {
      receiptRule: SESReceiptRule
      logicalId: string
    } {
    const {
      slug,
      environment,
      ruleSetName,
      recipients,
      enabled = true,
      scanEnabled = true,
      tlsPolicy = 'Require',
      s3Action,
      lambdaAction,
      snsAction,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'ses-rule',
    })

    const logicalId = generateLogicalId(resourceName)

    const actions: SESReceiptRule['Properties']['Rule']['Actions'] = []

    if (s3Action) {
      actions.push({
        S3Action: {
          BucketName: s3Action.bucketName,
          ObjectKeyPrefix: s3Action.prefix,
          KmsKeyArn: s3Action.kmsKeyArn,
        },
      })
    }

    if (lambdaAction) {
      actions.push({
        LambdaAction: {
          FunctionArn: lambdaAction.functionArn,
          InvocationType: lambdaAction.invocationType || 'Event',
        },
      })
    }

    if (snsAction) {
      actions.push({
        SNSAction: {
          TopicArn: snsAction.topicArn,
          Encoding: snsAction.encoding || 'UTF-8',
        },
      })
    }

    const receiptRule: SESReceiptRule = {
      Type: 'AWS::SES::ReceiptRule',
      Properties: {
        RuleSetName: ruleSetName,
        Rule: {
          Name: resourceName,
          Enabled: enabled,
          ScanEnabled: scanEnabled,
          TlsPolicy: tlsPolicy,
          Recipients: recipients,
          Actions: actions.length > 0 ? actions : undefined,
        },
      },
    }

    return { receiptRule, logicalId }
  }

  /**
   * Create MX record for receiving emails
   */
  static createMxRecord(
    domain: string,
    hostedZoneId: string,
    region: string,
  ): {
      record: Route53RecordSet
      logicalId: string
    } {
    const logicalId = generateLogicalId(`mx-${domain.replace(/\./g, '')}`)

    const record: Route53RecordSet = {
      Type: 'AWS::Route53::RecordSet',
      Properties: {
        HostedZoneId: hostedZoneId,
        Name: domain,
        Type: 'MX',
        TTL: 300,
        ResourceRecords: [`10 inbound-smtp.${region}.amazonaws.com`],
      },
    }

    return { record, logicalId }
  }

  /**
   * Create verification TXT record
   */
  static createVerificationRecord(
    domain: string,
    verificationToken: string,
    hostedZoneId: string,
  ): {
      record: Route53RecordSet
      logicalId: string
    } {
    const logicalId = generateLogicalId(`verification-${domain.replace(/\./g, '')}`)

    const record: Route53RecordSet = {
      Type: 'AWS::Route53::RecordSet',
      Properties: {
        HostedZoneId: hostedZoneId,
        Name: `_amazonses.${domain}`,
        Type: 'TXT',
        TTL: 1800,
        ResourceRecords: [`"${verificationToken}"`],
      },
    }

    return { record, logicalId }
  }

  /**
   * Get SES SMTP credentials information
   */
  static getSmtpEndpoint(region: string): string {
    return `email-smtp.${region}.amazonaws.com`
  }

  /**
   * Get SES SMTP port options
   */
  static readonly SmtpPorts = {
    TLS: 587, // STARTTLS
    SSL: 465, // SSL/TLS
    Unencrypted: 25, // Not recommended
  } as const
}
