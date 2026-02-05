import type {
  IAMPolicy,
  IAMRole,
  LambdaFunction,
  LambdaPermission,
  Route53RecordSet,
  S3Bucket,
  SESConfigurationSet,
  SESEmailIdentity,
  SESReceiptRule,
  SESReceiptRuleSet,
} from '@stacksjs/ts-cloud-aws-types'
import type { EnvironmentType } from '@stacksjs/ts-cloud-types'
import { Fn } from '../intrinsic-functions'
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

  /**
   * Create SPF record for email authentication
   */
  static createSpfRecord(
    domain: string,
    hostedZoneId: string,
    options?: {
      includeDomains?: string[]
      softFail?: boolean
    },
  ): {
      record: Route53RecordSet
      logicalId: string
    } {
    const { includeDomains = [], softFail = false } = options || {}
    const logicalId = generateLogicalId(`spf-${domain.replace(/\./g, '')}`)

    // Build SPF record
    let spfValue = 'v=spf1 include:amazonses.com'

    for (const include of includeDomains) {
      spfValue += ` include:${include}`
    }

    spfValue += softFail ? ' ~all' : ' -all'

    const record: Route53RecordSet = {
      Type: 'AWS::Route53::RecordSet',
      Properties: {
        HostedZoneId: hostedZoneId,
        Name: domain,
        Type: 'TXT',
        TTL: 300,
        ResourceRecords: [`"${spfValue}"`],
      },
    }

    return { record, logicalId }
  }

  /**
   * Create DMARC record for email authentication
   */
  static createDmarcRecord(
    domain: string,
    hostedZoneId: string,
    options?: {
      policy?: 'none' | 'quarantine' | 'reject'
      subdomainPolicy?: 'none' | 'quarantine' | 'reject'
      percentage?: number
      reportingEmail?: string
      forensicEmail?: string
    },
  ): {
      record: Route53RecordSet
      logicalId: string
    } {
    const {
      policy = 'none',
      subdomainPolicy,
      percentage = 100,
      reportingEmail,
      forensicEmail,
    } = options || {}

    const logicalId = generateLogicalId(`dmarc-${domain.replace(/\./g, '')}`)

    // Build DMARC record
    let dmarcValue = `v=DMARC1; p=${policy}; pct=${percentage}`

    if (subdomainPolicy) {
      dmarcValue += `; sp=${subdomainPolicy}`
    }

    if (reportingEmail) {
      dmarcValue += `; rua=mailto:${reportingEmail}`
    }

    if (forensicEmail) {
      dmarcValue += `; ruf=mailto:${forensicEmail}`
    }

    const record: Route53RecordSet = {
      Type: 'AWS::Route53::RecordSet',
      Properties: {
        HostedZoneId: hostedZoneId,
        Name: `_dmarc.${domain}`,
        Type: 'TXT',
        TTL: 300,
        ResourceRecords: [`"${dmarcValue}"`],
      },
    }

    return { record, logicalId }
  }

  /**
   * Create complete inbound email setup
   * Includes receipt rule set, rule, and S3 storage
   */
  static createInboundEmailSetup(options: {
    slug: string
    environment: EnvironmentType
    domain: string
    s3BucketName: string
    s3KeyPrefix?: string
    region: string
    hostedZoneId: string
    lambdaFunctionArn?: string
    snsTopicArn?: string
  }): {
    resources: Record<string, any>
    outputs: {
      ruleSetLogicalId: string
      ruleLogicalId: string
      mxRecordLogicalId: string
    }
  } {
    const {
      slug,
      environment,
      domain,
      s3BucketName,
      s3KeyPrefix = 'inbound/',
      region,
      hostedZoneId,
      lambdaFunctionArn,
      snsTopicArn,
    } = options

    const resources: Record<string, any> = {}

    // Create receipt rule set
    const { ruleSet, logicalId: ruleSetLogicalId } = Email.createReceiptRuleSet({
      slug,
      environment,
    })
    resources[ruleSetLogicalId] = ruleSet

    // Create receipt rule
    const { receiptRule, logicalId: ruleLogicalId } = Email.createReceiptRule(
      ruleSetLogicalId,
      {
        slug,
        environment,
        ruleSetName: ruleSet.Properties!.RuleSetName || `${slug}-${environment}-receipt-rule-set`,
        recipients: [domain, `@${domain}`],
        s3Action: {
          bucketName: s3BucketName,
          prefix: s3KeyPrefix,
        },
        lambdaAction: lambdaFunctionArn ? {
          functionArn: lambdaFunctionArn,
          invocationType: 'Event',
        } : undefined,
        snsAction: snsTopicArn ? {
          topicArn: snsTopicArn,
        } : undefined,
      },
    )
    resources[ruleLogicalId] = receiptRule

    // Create MX record
    const { record: mxRecord, logicalId: mxRecordLogicalId } = Email.createMxRecord(
      domain,
      hostedZoneId,
      region,
    )
    resources[mxRecordLogicalId] = mxRecord

    return {
      resources,
      outputs: {
        ruleSetLogicalId,
        ruleLogicalId,
        mxRecordLogicalId,
      },
    }
  }

  /**
   * Create complete email domain setup
   * Includes domain verification, DKIM, SPF, DMARC, and optionally inbound email
   */
  static createCompleteDomainSetup(options: {
    slug: string
    environment: EnvironmentType
    domain: string
    hostedZoneId: string
    region: string
    enableInbound?: boolean
    inboundS3Bucket?: string
    dmarcReportingEmail?: string
  }): {
    resources: Record<string, any>
    outputs: {
      identityLogicalId: string
      configSetLogicalId: string
    }
  } {
    const {
      slug,
      environment,
      domain,
      hostedZoneId,
      region,
      enableInbound = false,
      inboundS3Bucket,
      dmarcReportingEmail,
    } = options

    const resources: Record<string, any> = {}

    // Create email identity (domain verification)
    const { emailIdentity, logicalId: identityLogicalId } = Email.verifyDomain({
      domain,
      slug,
      environment,
    })
    resources[identityLogicalId] = emailIdentity

    // Create configuration set
    const { configurationSet, logicalId: configSetLogicalId } = Email.createConfigurationSet({
      slug,
      environment,
    })
    resources[configSetLogicalId] = configurationSet

    // Create SPF record
    const { record: spfRecord, logicalId: spfLogicalId } = Email.createSpfRecord(
      domain,
      hostedZoneId,
    )
    resources[spfLogicalId] = spfRecord

    // Create DMARC record
    const { record: dmarcRecord, logicalId: dmarcLogicalId } = Email.createDmarcRecord(
      domain,
      hostedZoneId,
      {
        policy: 'none', // Start with monitoring
        reportingEmail: dmarcReportingEmail || `dmarc-reports@${domain}`,
      },
    )
    resources[dmarcLogicalId] = dmarcRecord

    // Create inbound email setup if enabled
    if (enableInbound && inboundS3Bucket) {
      const inboundSetup = Email.createInboundEmailSetup({
        slug,
        environment,
        domain,
        s3BucketName: inboundS3Bucket,
        region,
        hostedZoneId,
      })

      Object.assign(resources, inboundSetup.resources)
    }

    return {
      resources,
      outputs: {
        identityLogicalId,
        configSetLogicalId,
      },
    }
  }

  /**
   * SES inbound SMTP endpoints by region
   */
  static readonly InboundSmtpEndpoints: Record<string, string> = {
    'us-east-1': 'inbound-smtp.us-east-1.amazonaws.com',
    'us-west-2': 'inbound-smtp.us-west-2.amazonaws.com',
    'eu-west-1': 'inbound-smtp.eu-west-1.amazonaws.com',
  }

  /**
   * Check if region supports SES inbound email
   */
  static supportsInboundEmail(region: string): boolean {
    return region in Email.InboundSmtpEndpoints
  }

  /**
   * Create IAM role for email Lambda functions
   */
  static createEmailLambdaRole(options: {
    slug: string
    environment: EnvironmentType
    s3BucketArn: string
    sesIdentityArn?: string
  }): {
    role: IAMRole
    policy: IAMPolicy
    roleLogicalId: string
    policyLogicalId: string
  } {
    const { slug, environment, s3BucketArn, sesIdentityArn } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'email-lambda-role',
    })

    const roleLogicalId = generateLogicalId(resourceName)
    const policyLogicalId = generateLogicalId(`${resourceName}-policy`)

    const role: IAMRole = {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: resourceName,
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: {
                Service: 'lambda.amazonaws.com',
              },
              Action: 'sts:AssumeRole',
            },
          ],
        },
        ManagedPolicyArns: [
          'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        ],
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    const policyStatements: any[] = [
      // S3 permissions for reading/writing emails
      {
        Effect: 'Allow',
        Action: [
          's3:GetObject',
          's3:PutObject',
          's3:DeleteObject',
          's3:ListBucket',
        ],
        Resource: [
          s3BucketArn,
          `${s3BucketArn}/*`,
        ],
      },
    ]

    // SES permissions for sending emails
    if (sesIdentityArn) {
      policyStatements.push({
        Effect: 'Allow',
        Action: [
          'ses:SendEmail',
          'ses:SendRawEmail',
        ],
        Resource: sesIdentityArn,
      })
    }

    const policy: IAMPolicy = {
      Type: 'AWS::IAM::Policy',
      Properties: {
        PolicyName: `${resourceName}-policy`,
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: policyStatements,
        },
        Roles: [Fn.Ref(roleLogicalId) as unknown as string],
      },
    }

    return {
      role,
      policy,
      roleLogicalId,
      policyLogicalId,
    }
  }

  /**
   * Create Lambda function for outbound email (JSON to raw email conversion)
   * Converts JSON email payloads to raw MIME format and sends via SES
   */
  static createOutboundEmailLambda(options: {
    slug: string
    environment: EnvironmentType
    roleArn: string
    domain: string
    configurationSetName?: string
    timeout?: number
    memorySize?: number
  }): {
    function: LambdaFunction
    logicalId: string
  } {
    const {
      slug,
      environment,
      roleArn,
      domain,
      configurationSetName,
      timeout = 30,
      memorySize = 256,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'outbound-email',
    })

    const logicalId = generateLogicalId(resourceName)

    const lambdaFunction: LambdaFunction = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: resourceName,
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Role: roleArn,
        Timeout: timeout,
        MemorySize: memorySize,
        Environment: {
          Variables: {
            DOMAIN: domain,
            CONFIGURATION_SET: configurationSetName || '',
          },
        },
        Code: {
          ZipFile: Email.LambdaCode.outboundEmail,
        },
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
          { Key: 'Purpose', Value: 'OutboundEmail' },
        ],
      },
    }

    return { function: lambdaFunction, logicalId }
  }

  /**
   * Create Lambda function for inbound email processing
   * Organizes emails by From/To addresses and extracts metadata
   */
  static createInboundEmailLambda(options: {
    slug: string
    environment: EnvironmentType
    roleArn: string
    s3BucketName: string
    organizedPrefix?: string
    timeout?: number
    memorySize?: number
  }): {
    function: LambdaFunction
    permission: LambdaPermission
    logicalId: string
    permissionLogicalId: string
  } {
    const {
      slug,
      environment,
      roleArn,
      s3BucketName,
      organizedPrefix = 'organized/',
      timeout = 60,
      memorySize = 512,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'inbound-email',
    })

    const logicalId = generateLogicalId(resourceName)
    const permissionLogicalId = generateLogicalId(`${resourceName}-permission`)

    const lambdaFunction: LambdaFunction = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: resourceName,
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Role: roleArn,
        Timeout: timeout,
        MemorySize: memorySize,
        Environment: {
          Variables: {
            S3_BUCKET: s3BucketName,
            ORGANIZED_PREFIX: organizedPrefix,
          },
        },
        Code: {
          ZipFile: Email.LambdaCode.inboundEmail,
        },
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
          { Key: 'Purpose', Value: 'InboundEmail' },
        ],
      },
    }

    // Permission for SES to invoke Lambda
    const permission: LambdaPermission = {
      Type: 'AWS::Lambda::Permission',
      Properties: {
        FunctionName: Fn.Ref(logicalId) as unknown as string,
        Action: 'lambda:InvokeFunction',
        Principal: 'ses.amazonaws.com',
        SourceAccount: Fn.Ref('AWS::AccountId') as unknown as string,
      },
    }

    return {
      function: lambdaFunction,
      permission,
      logicalId,
      permissionLogicalId,
    }
  }

  /**
   * Create Lambda function for email conversion
   * Converts raw MIME emails to HTML/text format
   */
  static createEmailConversionLambda(options: {
    slug: string
    environment: EnvironmentType
    roleArn: string
    s3BucketName: string
    convertedPrefix?: string
    timeout?: number
    memorySize?: number
  }): {
    function: LambdaFunction
    logicalId: string
  } {
    const {
      slug,
      environment,
      roleArn,
      s3BucketName,
      convertedPrefix = 'converted/',
      timeout = 60,
      memorySize = 512,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'email-conversion',
    })

    const logicalId = generateLogicalId(resourceName)

    const lambdaFunction: LambdaFunction = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: resourceName,
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Role: roleArn,
        Timeout: timeout,
        MemorySize: memorySize,
        Environment: {
          Variables: {
            S3_BUCKET: s3BucketName,
            CONVERTED_PREFIX: convertedPrefix,
          },
        },
        Code: {
          ZipFile: Email.LambdaCode.emailConversion,
        },
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
          { Key: 'Purpose', Value: 'EmailConversion' },
        ],
      },
    }

    return { function: lambdaFunction, logicalId }
  }

  /**
   * Create S3 bucket notification configuration for email processing
   */
  static createEmailBucketNotification(options: {
    bucketLogicalId: string
    lambdaArn: string
    prefix?: string
    suffix?: string
    events?: string[]
  }): {
    notificationConfiguration: NonNullable<NonNullable<S3Bucket['Properties']>['NotificationConfiguration']>
  } {
    const {
      lambdaArn,
      prefix = 'inbound/',
      suffix,
      events = ['s3:ObjectCreated:*'],
    } = options

    const filter: any = {}
    if (prefix || suffix) {
      filter.S3Key = {
        Rules: [],
      }
      if (prefix) {
        filter.S3Key.Rules.push({ Name: 'prefix', Value: prefix })
      }
      if (suffix) {
        filter.S3Key.Rules.push({ Name: 'suffix', Value: suffix })
      }
    }

    const notificationConfiguration = {
      LambdaConfigurations: [
        {
          Event: events[0],
          Function: lambdaArn,
          Filter: Object.keys(filter).length > 0 ? filter : undefined,
        },
      ],
    }

    return { notificationConfiguration }
  }

  /**
   * Create Lambda permission for S3 to invoke email processing Lambda
   */
  static createS3LambdaPermission(options: {
    slug: string
    environment: EnvironmentType
    lambdaLogicalId: string
    s3BucketArn: string
  }): {
    permission: LambdaPermission
    logicalId: string
  } {
    const { slug, environment, lambdaLogicalId, s3BucketArn } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 's3-lambda-permission',
    })

    const logicalId = generateLogicalId(resourceName)

    const permission: LambdaPermission = {
      Type: 'AWS::Lambda::Permission',
      Properties: {
        FunctionName: Fn.Ref(lambdaLogicalId) as unknown as string,
        Action: 'lambda:InvokeFunction',
        Principal: 's3.amazonaws.com',
        SourceArn: s3BucketArn,
      },
    }

    return { permission, logicalId }
  }

  /**
   * Create complete email processing stack
   * Includes all Lambda functions, IAM roles, and S3 notifications
   */
  static createEmailProcessingStack(options: {
    slug: string
    environment: EnvironmentType
    domain: string
    s3BucketName: string
    s3BucketArn: string
    configurationSetName?: string
    enableInbound?: boolean
    enableConversion?: boolean
  }): {
    resources: Record<string, any>
    outputs: {
      roleLogicalId: string
      outboundLambdaLogicalId: string
      inboundLambdaLogicalId?: string
      conversionLambdaLogicalId?: string
    }
  } {
    const {
      slug,
      environment,
      domain,
      s3BucketName,
      s3BucketArn,
      configurationSetName,
      enableInbound = true,
      enableConversion = true,
    } = options

    const resources: Record<string, any> = {}

    // Create IAM role
    const { role, policy, roleLogicalId, policyLogicalId } = Email.createEmailLambdaRole({
      slug,
      environment,
      s3BucketArn,
      sesIdentityArn: `arn:aws:ses:*:*:identity/${domain}`,
    })
    resources[roleLogicalId] = role
    resources[policyLogicalId] = policy

    // Create outbound email Lambda
    const { function: outboundLambda, logicalId: outboundLambdaLogicalId } = Email.createOutboundEmailLambda({
      slug,
      environment,
      roleArn: Fn.GetAtt(roleLogicalId, 'Arn') as unknown as string,
      domain,
      configurationSetName,
    })
    resources[outboundLambdaLogicalId] = outboundLambda

    const outputs: any = {
      roleLogicalId,
      outboundLambdaLogicalId,
    }

    // Create inbound email Lambda if enabled
    if (enableInbound) {
      const {
        function: inboundLambda,
        permission: sesPermission,
        logicalId: inboundLambdaLogicalId,
        permissionLogicalId: sesPermissionLogicalId,
      } = Email.createInboundEmailLambda({
        slug,
        environment,
        roleArn: Fn.GetAtt(roleLogicalId, 'Arn') as unknown as string,
        s3BucketName,
      })
      resources[inboundLambdaLogicalId] = inboundLambda
      resources[sesPermissionLogicalId] = sesPermission

      // S3 permission for inbound Lambda
      const { permission: s3Permission, logicalId: s3PermissionLogicalId } = Email.createS3LambdaPermission({
        slug,
        environment,
        lambdaLogicalId: inboundLambdaLogicalId,
        s3BucketArn,
      })
      resources[s3PermissionLogicalId] = s3Permission

      outputs.inboundLambdaLogicalId = inboundLambdaLogicalId
    }

    // Create conversion Lambda if enabled
    if (enableConversion) {
      const { function: conversionLambda, logicalId: conversionLambdaLogicalId } = Email.createEmailConversionLambda({
        slug,
        environment,
        roleArn: Fn.GetAtt(roleLogicalId, 'Arn') as unknown as string,
        s3BucketName,
      })
      resources[conversionLambdaLogicalId] = conversionLambda

      outputs.conversionLambdaLogicalId = conversionLambdaLogicalId
    }

    return { resources, outputs }
  }

  /**
   * Lambda function code for email processing
   */
  static readonly LambdaCode = {
    /**
     * Outbound email Lambda - JSON to raw email conversion
     */
    outboundEmail: `
const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');
const ses = new SESClient({});

exports.handler = async (event) => {
  console.log('Processing outbound email:', JSON.stringify(event));

  const {
    to,
    from,
    subject,
    html,
    text,
    cc,
    bcc,
    replyTo,
    attachments = []
  } = event;

  const domain = process.env.DOMAIN;
  const configSet = process.env.CONFIGURATION_SET;

  // Build MIME message
  const boundary = 'NextPart_' + Date.now().toString(16);
  const fromAddress = from || \`noreply@\${domain}\`;

  let rawEmail = '';
  rawEmail += \`From: \${fromAddress}\\r\\n\`;
  rawEmail += \`To: \${Array.isArray(to) ? to.join(', ') : to}\\r\\n\`;
  if (cc) rawEmail += \`Cc: \${Array.isArray(cc) ? cc.join(', ') : cc}\\r\\n\`;
  if (bcc) rawEmail += \`Bcc: \${Array.isArray(bcc) ? bcc.join(', ') : bcc}\\r\\n\`;
  if (replyTo) rawEmail += \`Reply-To: \${replyTo}\\r\\n\`;
  rawEmail += \`Subject: \${subject}\\r\\n\`;
  rawEmail += 'MIME-Version: 1.0\\r\\n';
  rawEmail += \`Content-Type: multipart/mixed; boundary="\${boundary}"\\r\\n\\r\\n\`;

  // Text/HTML content
  rawEmail += \`--\${boundary}\\r\\n\`;
  rawEmail += 'Content-Type: multipart/alternative; boundary="alt_boundary"\\r\\n\\r\\n';

  if (text) {
    rawEmail += '--alt_boundary\\r\\n';
    rawEmail += 'Content-Type: text/plain; charset=UTF-8\\r\\n\\r\\n';
    rawEmail += text + '\\r\\n\\r\\n';
  }

  if (html) {
    rawEmail += '--alt_boundary\\r\\n';
    rawEmail += 'Content-Type: text/html; charset=UTF-8\\r\\n\\r\\n';
    rawEmail += html + '\\r\\n\\r\\n';
  }

  rawEmail += '--alt_boundary--\\r\\n';

  // Attachments
  for (const attachment of attachments) {
    rawEmail += \`--\${boundary}\\r\\n\`;
    rawEmail += \`Content-Type: \${attachment.contentType || 'application/octet-stream'}; name="\${attachment.filename}"\\r\\n\`;
    rawEmail += 'Content-Transfer-Encoding: base64\\r\\n';
    rawEmail += \`Content-Disposition: attachment; filename="\${attachment.filename}"\\r\\n\\r\\n\`;
    rawEmail += attachment.content + '\\r\\n';
  }

  rawEmail += \`--\${boundary}--\\r\\n\`;

  const params = {
    RawMessage: { Data: Buffer.from(rawEmail) },
    Source: fromAddress,
    Destinations: [
      ...(Array.isArray(to) ? to : [to]),
      ...(cc ? (Array.isArray(cc) ? cc : [cc]) : []),
      ...(bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : [])
    ]
  };

  if (configSet) {
    params.ConfigurationSetName = configSet;
  }

  const result = await ses.send(new SendRawEmailCommand(params));

  return {
    statusCode: 200,
    body: JSON.stringify({ messageId: result.MessageId })
  };
};
`,

    /**
     * Inbound email Lambda - Email organization by From/To
     */
    inboundEmail: `
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const s3 = new S3Client({});

exports.handler = async (event) => {
  console.log('Processing inbound email:', JSON.stringify(event));

  const bucket = process.env.S3_BUCKET;
  const organizedPrefix = process.env.ORGANIZED_PREFIX || 'organized/';

  // Handle SES notification
  let records = [];
  if (event.Records) {
    // S3 notification
    records = event.Records;
  } else if (event.mail) {
    // Direct SES notification
    records = [{ ses: { mail: event.mail } }];
  }

  for (const record of records) {
    let mailData;
    let objectKey;

    if (record.s3) {
      // S3 event - read the email from S3
      objectKey = decodeURIComponent(record.s3.object.key.replace(/\\+/g, ' '));
      const response = await s3.send(new GetObjectCommand({
        Bucket: bucket,
        Key: objectKey
      }));
      const rawEmail = await response.Body.transformToString();
      mailData = parseEmailHeaders(rawEmail);
    } else if (record.ses) {
      mailData = record.ses.mail;
      objectKey = record.ses.mail.messageId;
    }

    if (!mailData) continue;

    // Extract sender and recipients
    const from = extractEmail(mailData.commonHeaders?.from?.[0] || mailData.source || 'unknown');
    const to = mailData.commonHeaders?.to || mailData.destination || [];
    const subject = mailData.commonHeaders?.subject || 'No Subject';
    const date = mailData.timestamp || new Date().toISOString();

    // Create organized paths
    const dateFolder = date.slice(0, 10).replace(/-/g, '/');

    // Organize by recipient
    for (const recipient of to) {
      const recipientEmail = extractEmail(recipient);
      const organizedKey = \`\${organizedPrefix}by-recipient/\${recipientEmail}/\${dateFolder}/\${sanitizeFilename(subject)}_\${objectKey}\`;

      await copyOrCreateMetadata(bucket, objectKey, organizedKey, {
        from,
        to: recipientEmail,
        subject,
        date
      });
    }

    // Organize by sender
    const senderKey = \`\${organizedPrefix}by-sender/\${from}/\${dateFolder}/\${sanitizeFilename(subject)}_\${objectKey}\`;
    await copyOrCreateMetadata(bucket, objectKey, senderKey, {
      from,
      to: to.join(', '),
      subject,
      date
    });

    console.log(\`Organized email from \${from} to \${to.join(', ')}: \${subject}\`);
  }

  return { statusCode: 200, body: 'Emails organized successfully' };
};

function parseEmailHeaders(rawEmail) {
  const headers = {};
  const lines = rawEmail.split('\\r\\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') break; // Headers end at empty line

    const match = line.match(/^([^:]+):\\s*(.*)$/);
    if (match) {
      const [, key, value] = match;
      headers[key.toLowerCase()] = value;
    }
  }

  return {
    commonHeaders: {
      from: headers.from ? [headers.from] : [],
      to: headers.to ? headers.to.split(',').map(s => s.trim()) : [],
      subject: headers.subject
    },
    timestamp: headers.date
  };
}

function extractEmail(str) {
  const match = str.match(/<([^>]+)>/);
  return (match ? match[1] : str).toLowerCase().trim();
}

function sanitizeFilename(str) {
  return str.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 50);
}

async function copyOrCreateMetadata(bucket, sourceKey, destKey, metadata) {
  try {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: destKey + '.json',
      Body: JSON.stringify({ ...metadata, sourceKey }, null, 2),
      ContentType: 'application/json'
    }));
  } catch (error) {
    console.error('Error creating metadata:', error);
  }
}
`,

    /**
     * Email conversion Lambda - Raw to HTML/text
     */
    emailConversion: `
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const s3 = new S3Client({});

exports.handler = async (event) => {
  console.log('Processing email conversion:', JSON.stringify(event));

  const bucket = process.env.S3_BUCKET;
  const convertedPrefix = process.env.CONVERTED_PREFIX || 'converted/';

  for (const record of event.Records || []) {
    const objectKey = decodeURIComponent(record.s3.object.key.replace(/\\+/g, ' '));

    // Get the raw email
    const response = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: objectKey
    }));

    const rawEmail = await response.Body.transformToString();
    const parsed = parseEmail(rawEmail);

    // Save HTML version if exists
    if (parsed.html) {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: \`\${convertedPrefix}\${objectKey}.html\`,
        Body: parsed.html,
        ContentType: 'text/html'
      }));
    }

    // Save text version if exists
    if (parsed.text) {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: \`\${convertedPrefix}\${objectKey}.txt\`,
        Body: parsed.text,
        ContentType: 'text/plain'
      }));
    }

    // Save metadata
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: \`\${convertedPrefix}\${objectKey}.json\`,
      Body: JSON.stringify({
        from: parsed.headers.from,
        to: parsed.headers.to,
        subject: parsed.headers.subject,
        date: parsed.headers.date,
        attachments: parsed.attachments.map(a => ({
          filename: a.filename,
          contentType: a.contentType,
          size: a.size
        }))
      }, null, 2),
      ContentType: 'application/json'
    }));

    // Save attachments
    for (const attachment of parsed.attachments) {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: \`\${convertedPrefix}\${objectKey}/attachments/\${attachment.filename}\`,
        Body: Buffer.from(attachment.content, 'base64'),
        ContentType: attachment.contentType
      }));
    }

    console.log(\`Converted email: \${objectKey}\`);
  }

  return { statusCode: 200, body: 'Emails converted successfully' };
};

function parseEmail(rawEmail) {
  const result = {
    headers: {},
    text: '',
    html: '',
    attachments: []
  };

  // Split headers and body
  const parts = rawEmail.split('\\r\\n\\r\\n');
  const headerSection = parts[0];
  const body = parts.slice(1).join('\\r\\n\\r\\n');

  // Parse headers
  const headerLines = headerSection.split('\\r\\n');
  let currentHeader = '';
  let currentValue = '';

  for (const line of headerLines) {
    if (line.match(/^\\s/)) {
      currentValue += ' ' + line.trim();
    } else {
      if (currentHeader) {
        result.headers[currentHeader.toLowerCase()] = currentValue;
      }
      const match = line.match(/^([^:]+):\\s*(.*)$/);
      if (match) {
        currentHeader = match[1];
        currentValue = match[2];
      }
    }
  }
  if (currentHeader) {
    result.headers[currentHeader.toLowerCase()] = currentValue;
  }

  // Parse body based on content type
  const contentType = result.headers['content-type'] || 'text/plain';

  if (contentType.includes('multipart')) {
    const boundaryMatch = contentType.match(/boundary="?([^";\\s]+)"?/);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      const bodyParts = body.split('--' + boundary);

      for (const part of bodyParts) {
        if (part.trim() === '' || part.trim() === '--') continue;

        const [partHeaders, ...partBody] = part.split('\\r\\n\\r\\n');
        const partContent = partBody.join('\\r\\n\\r\\n');
        const partContentType = partHeaders.match(/Content-Type:\\s*([^;\\r\\n]+)/i)?.[1] || '';

        if (partContentType.includes('text/plain')) {
          result.text = decodeContent(partContent, partHeaders);
        } else if (partContentType.includes('text/html')) {
          result.html = decodeContent(partContent, partHeaders);
        } else if (partHeaders.toLowerCase().includes('content-disposition: attachment')) {
          const filenameMatch = partHeaders.match(/filename="?([^"\\r\\n]+)"?/i);
          result.attachments.push({
            filename: filenameMatch?.[1] || 'attachment',
            contentType: partContentType,
            content: partContent.trim(),
            size: partContent.length
          });
        }
      }
    }
  } else if (contentType.includes('text/html')) {
    result.html = body;
  } else {
    result.text = body;
  }

  return result;
}

function decodeContent(content, headers) {
  const encoding = headers.match(/Content-Transfer-Encoding:\\s*([^\\r\\n]+)/i)?.[1]?.toLowerCase();

  if (encoding === 'base64') {
    return Buffer.from(content.replace(/\\s/g, ''), 'base64').toString('utf-8');
  } else if (encoding === 'quoted-printable') {
    return content.replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
                  .replace(/=\\r?\\n/g, '');
  }

  return content;
}
`,
  }
}
