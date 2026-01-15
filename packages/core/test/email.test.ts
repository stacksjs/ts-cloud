import { describe, expect, it } from 'bun:test'
import { Email } from '../src/modules/email'
import { TemplateBuilder } from '../src/template-builder'

describe('Email Module', () => {
  describe('verifyDomain', () => {
    it('should create email identity with DKIM enabled by default', () => {
      const { emailIdentity, logicalId } = Email.verifyDomain({
        domain: 'example.com',
        slug: 'my-app',
        environment: 'production',
      })

      expect(emailIdentity.Type).toBe('AWS::SES::EmailIdentity')
      expect(emailIdentity.Properties.EmailIdentity).toBe('example.com')
      expect(emailIdentity.Properties.FeedbackAttributes?.EmailForwardingEnabled).toBe(true)
      expect(emailIdentity.Properties.DkimSigningAttributes?.NextSigningKeyLength).toBe('RSA_2048_BIT')
      expect(logicalId).toBeDefined()
    })

    it('should support disabling DKIM', () => {
      const { emailIdentity } = Email.verifyDomain({
        domain: 'example.com',
        slug: 'my-app',
        environment: 'production',
        enableDkim: false,
      })

      expect(emailIdentity.Properties.DkimSigningAttributes).toBeUndefined()
    })

    it('should support RSA_1024_BIT key length', () => {
      const { emailIdentity } = Email.verifyDomain({
        domain: 'example.com',
        slug: 'my-app',
        environment: 'production',
        dkimKeyLength: 'RSA_1024_BIT',
      })

      expect(emailIdentity.Properties.DkimSigningAttributes?.NextSigningKeyLength).toBe('RSA_1024_BIT')
    })
  })

  describe('createDkimRecords', () => {
    it('should create CNAME records for DKIM tokens', () => {
      const dkimTokens = ['token1', 'token2', 'token3']
      const records = Email.createDkimRecords('example.com', dkimTokens, 'Z1234567890ABC')

      expect(records).toHaveLength(3)

      for (let i = 0; i < records.length; i++) {
        const { record, logicalId } = records[i]
        expect(record.Type).toBe('AWS::Route53::RecordSet')
        expect(record.Properties.HostedZoneId).toBe('Z1234567890ABC')
        expect(record.Properties.Name).toBe(`${dkimTokens[i]}._domainkey.example.com`)
        expect(record.Properties.Type).toBe('CNAME')
        expect(record.Properties.TTL).toBe(1800)
        expect(record.Properties.ResourceRecords).toEqual([`${dkimTokens[i]}.dkim.amazonses.com`])
        expect(logicalId).toBeDefined()
      }
    })
  })

  describe('createConfigurationSet', () => {
    it('should create configuration set with default settings', () => {
      const { configurationSet, logicalId } = Email.createConfigurationSet({
        slug: 'my-app',
        environment: 'production',
      })

      expect(configurationSet.Type).toBe('AWS::SES::ConfigurationSet')
      expect(configurationSet.Properties.ReputationOptions?.ReputationMetricsEnabled).toBe(true)
      expect(configurationSet.Properties.SendingOptions?.SendingEnabled).toBe(true)
      expect(configurationSet.Properties.SuppressionOptions?.SuppressedReasons).toContain('BOUNCE')
      expect(configurationSet.Properties.SuppressionOptions?.SuppressedReasons).toContain('COMPLAINT')
      expect(logicalId).toBeDefined()
    })

    it('should support custom configuration set name', () => {
      const { configurationSet } = Email.createConfigurationSet({
        slug: 'my-app',
        environment: 'production',
        name: 'custom-config-set',
      })

      expect(configurationSet.Properties.Name).toBe('custom-config-set')
    })

    it('should disable reputation metrics when requested', () => {
      const { configurationSet } = Email.createConfigurationSet({
        slug: 'my-app',
        environment: 'production',
        reputationMetrics: false,
      })

      expect(configurationSet.Properties.ReputationOptions?.ReputationMetricsEnabled).toBe(false)
    })

    it('should disable sending when requested', () => {
      const { configurationSet } = Email.createConfigurationSet({
        slug: 'my-app',
        environment: 'production',
        sendingEnabled: false,
      })

      expect(configurationSet.Properties.SendingOptions?.SendingEnabled).toBe(false)
    })

    it('should suppress only bounces', () => {
      const { configurationSet } = Email.createConfigurationSet({
        slug: 'my-app',
        environment: 'production',
        suppressBounces: true,
        suppressComplaints: false,
      })

      expect(configurationSet.Properties.SuppressionOptions?.SuppressedReasons).toEqual(['BOUNCE'])
    })

    it('should suppress only complaints', () => {
      const { configurationSet } = Email.createConfigurationSet({
        slug: 'my-app',
        environment: 'production',
        suppressBounces: false,
        suppressComplaints: true,
      })

      expect(configurationSet.Properties.SuppressionOptions?.SuppressedReasons).toEqual(['COMPLAINT'])
    })

    it('should not suppress anything when both disabled', () => {
      const { configurationSet } = Email.createConfigurationSet({
        slug: 'my-app',
        environment: 'production',
        suppressBounces: false,
        suppressComplaints: false,
      })

      expect(configurationSet.Properties.SuppressionOptions?.SuppressedReasons).toEqual([])
    })
  })

  describe('createReceiptRuleSet', () => {
    it('should create receipt rule set', () => {
      const { ruleSet, logicalId } = Email.createReceiptRuleSet({
        slug: 'my-app',
        environment: 'production',
      })

      expect(ruleSet.Type).toBe('AWS::SES::ReceiptRuleSet')
      expect(ruleSet.Properties!.RuleSetName).toBeDefined()
      expect(logicalId).toBeDefined()
    })

    it('should support custom rule set name', () => {
      const { ruleSet } = Email.createReceiptRuleSet({
        slug: 'my-app',
        environment: 'production',
        name: 'custom-ruleset',
      })

      expect(ruleSet.Properties!.RuleSetName).toBe('custom-ruleset')
    })
  })

  describe('createReceiptRule', () => {
    it('should create receipt rule with default settings', () => {
      const { receiptRule, logicalId } = Email.createReceiptRule('ruleset-id', {
        slug: 'my-app',
        environment: 'production',
        ruleSetName: 'my-ruleset',
      })

      expect(receiptRule.Type).toBe('AWS::SES::ReceiptRule')
      expect(receiptRule.Properties.RuleSetName).toBe('my-ruleset')
      expect(receiptRule.Properties.Rule.Enabled).toBe(true)
      expect(receiptRule.Properties.Rule.ScanEnabled).toBe(true)
      expect(receiptRule.Properties.Rule.TlsPolicy).toBe('Require')
      expect(logicalId).toBeDefined()
    })

    it('should support recipient filtering', () => {
      const { receiptRule } = Email.createReceiptRule('ruleset-id', {
        slug: 'my-app',
        environment: 'production',
        ruleSetName: 'my-ruleset',
        recipients: ['user@example.com', 'admin@example.com'],
      })

      expect(receiptRule.Properties.Rule.Recipients).toEqual(['user@example.com', 'admin@example.com'])
    })

    it('should support disabled rule', () => {
      const { receiptRule } = Email.createReceiptRule('ruleset-id', {
        slug: 'my-app',
        environment: 'production',
        ruleSetName: 'my-ruleset',
        enabled: false,
      })

      expect(receiptRule.Properties.Rule.Enabled).toBe(false)
    })

    it('should support optional TLS policy', () => {
      const { receiptRule } = Email.createReceiptRule('ruleset-id', {
        slug: 'my-app',
        environment: 'production',
        ruleSetName: 'my-ruleset',
        tlsPolicy: 'Optional',
      })

      expect(receiptRule.Properties.Rule.TlsPolicy).toBe('Optional')
    })

    it('should support S3 action', () => {
      const { receiptRule } = Email.createReceiptRule('ruleset-id', {
        slug: 'my-app',
        environment: 'production',
        ruleSetName: 'my-ruleset',
        s3Action: {
          bucketName: 'my-email-bucket',
          prefix: 'emails/',
          kmsKeyArn: 'arn:aws:kms:us-east-1:123456789:key/abc',
        },
      })

      expect(receiptRule.Properties.Rule.Actions).toHaveLength(1)
      expect(receiptRule.Properties.Rule.Actions?.[0].S3Action?.BucketName).toBe('my-email-bucket')
      expect(receiptRule.Properties.Rule.Actions?.[0].S3Action?.ObjectKeyPrefix).toBe('emails/')
      expect(receiptRule.Properties.Rule.Actions?.[0].S3Action?.KmsKeyArn).toBe('arn:aws:kms:us-east-1:123456789:key/abc')
    })

    it('should support Lambda action', () => {
      const { receiptRule } = Email.createReceiptRule('ruleset-id', {
        slug: 'my-app',
        environment: 'production',
        ruleSetName: 'my-ruleset',
        lambdaAction: {
          functionArn: 'arn:aws:lambda:us-east-1:123456789:function:process-email',
          invocationType: 'RequestResponse',
        },
      })

      expect(receiptRule.Properties.Rule.Actions).toHaveLength(1)
      expect(receiptRule.Properties.Rule.Actions?.[0].LambdaAction?.FunctionArn).toBe('arn:aws:lambda:us-east-1:123456789:function:process-email')
      expect(receiptRule.Properties.Rule.Actions?.[0].LambdaAction?.InvocationType).toBe('RequestResponse')
    })

    it('should support SNS action', () => {
      const { receiptRule } = Email.createReceiptRule('ruleset-id', {
        slug: 'my-app',
        environment: 'production',
        ruleSetName: 'my-ruleset',
        snsAction: {
          topicArn: 'arn:aws:sns:us-east-1:123456789:email-notifications',
          encoding: 'Base64',
        },
      })

      expect(receiptRule.Properties.Rule.Actions).toHaveLength(1)
      expect(receiptRule.Properties.Rule.Actions?.[0].SNSAction?.TopicArn).toBe('arn:aws:sns:us-east-1:123456789:email-notifications')
      expect(receiptRule.Properties.Rule.Actions?.[0].SNSAction?.Encoding).toBe('Base64')
    })

    it('should support multiple actions', () => {
      const { receiptRule } = Email.createReceiptRule('ruleset-id', {
        slug: 'my-app',
        environment: 'production',
        ruleSetName: 'my-ruleset',
        s3Action: {
          bucketName: 'my-email-bucket',
        },
        lambdaAction: {
          functionArn: 'arn:aws:lambda:us-east-1:123456789:function:process-email',
        },
        snsAction: {
          topicArn: 'arn:aws:sns:us-east-1:123456789:email-notifications',
        },
      })

      expect(receiptRule.Properties.Rule.Actions).toHaveLength(3)
    })
  })

  describe('createMxRecord', () => {
    it('should create MX record for receiving emails', () => {
      const { record, logicalId } = Email.createMxRecord(
        'example.com',
        'Z1234567890ABC',
        'us-east-1',
      )

      expect(record.Type).toBe('AWS::Route53::RecordSet')
      expect(record.Properties.HostedZoneId).toBe('Z1234567890ABC')
      expect(record.Properties.Name).toBe('example.com')
      expect(record.Properties.Type).toBe('MX')
      expect(record.Properties.TTL).toBe(300)
      expect(record.Properties.ResourceRecords).toEqual(['10 inbound-smtp.us-east-1.amazonaws.com'])
      expect(logicalId).toBeDefined()
    })
  })

  describe('createVerificationRecord', () => {
    it('should create TXT record for domain verification', () => {
      const { record, logicalId } = Email.createVerificationRecord(
        'example.com',
        'abc123xyz',
        'Z1234567890ABC',
      )

      expect(record.Type).toBe('AWS::Route53::RecordSet')
      expect(record.Properties.HostedZoneId).toBe('Z1234567890ABC')
      expect(record.Properties.Name).toBe('_amazonses.example.com')
      expect(record.Properties.Type).toBe('TXT')
      expect(record.Properties.TTL).toBe(1800)
      expect(record.Properties.ResourceRecords).toEqual(['"abc123xyz"'])
      expect(logicalId).toBeDefined()
    })
  })

  describe('getSmtpEndpoint', () => {
    it('should return SMTP endpoint for region', () => {
      expect(Email.getSmtpEndpoint('us-east-1')).toBe('email-smtp.us-east-1.amazonaws.com')
      expect(Email.getSmtpEndpoint('eu-west-1')).toBe('email-smtp.eu-west-1.amazonaws.com')
      expect(Email.getSmtpEndpoint('ap-southeast-1')).toBe('email-smtp.ap-southeast-1.amazonaws.com')
    })
  })

  describe('SmtpPorts', () => {
    it('should provide SMTP port constants', () => {
      expect(Email.SmtpPorts.TLS).toBe(587)
      expect(Email.SmtpPorts.SSL).toBe(465)
      expect(Email.SmtpPorts.Unencrypted).toBe(25)
    })
  })

  describe('Integration with TemplateBuilder', () => {
    it('should create complete email infrastructure with domain verification', () => {
      const template = new TemplateBuilder('Email Infrastructure')

      // Verify domain
      const { emailIdentity, logicalId: identityId } = Email.verifyDomain({
        domain: 'example.com',
        slug: 'my-app',
        environment: 'production',
      })
      template.addResource(identityId, emailIdentity)

      // Create DKIM records
      const dkimTokens = ['token1', 'token2', 'token3']
      const dkimRecords = Email.createDkimRecords('example.com', dkimTokens, 'Z1234567890ABC')
      for (const { record, logicalId } of dkimRecords) {
        template.addResource(logicalId, record)
      }

      // Create verification record
      const { record: verifyRecord, logicalId: verifyId } = Email.createVerificationRecord(
        'example.com',
        'verification-token',
        'Z1234567890ABC',
      )
      template.addResource(verifyId, verifyRecord)

      // Create configuration set
      const { configurationSet, logicalId: configId } = Email.createConfigurationSet({
        slug: 'my-app',
        environment: 'production',
      })
      template.addResource(configId, configurationSet)

      const result = template.build()

      // Identity + 3 DKIM + 1 Verification + 1 ConfigSet = 6 resources
      expect(Object.keys(result.Resources)).toHaveLength(6)
      expect(result.Resources[identityId].Type).toBe('AWS::SES::EmailIdentity')
      expect(result.Resources[configId].Type).toBe('AWS::SES::ConfigurationSet')
    })

    it('should create inbound email processing infrastructure', () => {
      const template = new TemplateBuilder('Inbound Email')

      // Create receipt rule set
      const { ruleSet, logicalId: ruleSetId } = Email.createReceiptRuleSet({
        slug: 'my-app',
        environment: 'production',
      })
      template.addResource(ruleSetId, ruleSet)

      // Create receipt rule with S3 and Lambda actions
      const { receiptRule, logicalId: ruleId } = Email.createReceiptRule(ruleSetId, {
        slug: 'my-app',
        environment: 'production',
        ruleSetName: 'my-ruleset',
        recipients: ['support@example.com'],
        s3Action: {
          bucketName: 'my-email-bucket',
          prefix: 'incoming/',
        },
        lambdaAction: {
          functionArn: 'arn:aws:lambda:us-east-1:123456789:function:process-email',
        },
      })
      template.addResource(ruleId, receiptRule)

      // Create MX record
      const { record: mxRecord, logicalId: mxId } = Email.createMxRecord(
        'example.com',
        'Z1234567890ABC',
        'us-east-1',
      )
      template.addResource(mxId, mxRecord)

      const result = template.build()

      // RuleSet + Rule + MX = 3 resources
      expect(Object.keys(result.Resources)).toHaveLength(3)
      expect(result.Resources[ruleSetId].Type).toBe('AWS::SES::ReceiptRuleSet')
      expect(result.Resources[ruleId].Type).toBe('AWS::SES::ReceiptRule')
      expect(result.Resources[mxId].Type).toBe('AWS::Route53::RecordSet')
    })

    it('should generate valid JSON template', () => {
      const template = new TemplateBuilder('Email Test')

      const { emailIdentity, logicalId } = Email.verifyDomain({
        domain: 'example.com',
        slug: 'test',
        environment: 'development',
      })
      template.addResource(logicalId, emailIdentity)

      const json = template.toJSON()
      const parsed = JSON.parse(json)

      expect(parsed.Resources[logicalId].Type).toBe('AWS::SES::EmailIdentity')
      expect(parsed.Resources[logicalId].Properties.EmailIdentity).toBe('example.com')
    })
  })
})
