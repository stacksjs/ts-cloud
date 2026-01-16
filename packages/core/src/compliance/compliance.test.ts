import { describe, expect, it, beforeEach } from 'bun:test'
import { AWSConfigManager } from './aws-config'
import { CloudTrailManager } from './cloudtrail'
import { GuardDutyManager } from './guardduty'
import { SecurityHubManager } from './security-hub'

describe('AWS Config Manager', () => {
  let manager: AWSConfigManager

  beforeEach(() => {
    manager = new AWSConfigManager()
  })

  describe('Config Recorder', () => {
    it('should create config recorder', () => {
      const recorder = manager.createConfigRecorder({
        name: 'default',
        roleArn: 'arn:aws:iam::123456789012:role/config-role',
        recordingGroup: {
          allSupported: true,
          includeGlobalResourceTypes: true,
        },
      })

      expect(recorder.name).toBe('default')
      expect(recorder.roleArn).toBe('arn:aws:iam::123456789012:role/config-role')
      expect(recorder.recordingGroup?.allSupported).toBe(true)
    })

    it('should get config recorder', () => {
      manager.createConfigRecorder({
        name: 'test-recorder',
        roleArn: 'arn:aws:iam::123456789012:role/config-role',
      })

      const retrieved = manager.getConfigRecorder('test-recorder')
      expect(retrieved).toBeDefined()
      expect(retrieved?.name).toBe('test-recorder')
    })
  })

  describe('Delivery Channel', () => {
    it('should create delivery channel', () => {
      const channel = manager.createDeliveryChannel({
        name: 'default',
        s3BucketName: 'config-bucket',
        s3KeyPrefix: 'config',
        snsTopicArn: 'arn:aws:sns:us-east-1:123456789012:config-topic',
      })

      expect(channel.name).toBe('default')
      expect(channel.s3BucketName).toBe('config-bucket')
      expect(channel.s3KeyPrefix).toBe('config')
    })
  })

  describe('Config Rules', () => {
    it('should create S3 encryption rule', () => {
      const rule = manager.createS3EncryptionRule()

      expect(rule.name).toBe('s3-bucket-server-side-encryption-enabled')
      expect(rule.source).toBe('AWS_MANAGED')
      expect(rule.identifier).toBe('S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED')
      expect(rule.scope?.complianceResourceTypes).toContain('AWS::S3::Bucket')
    })

    it('should create RDS encryption rule', () => {
      const rule = manager.createRdsEncryptionRule()

      expect(rule.name).toBe('rds-storage-encrypted')
      expect(rule.identifier).toBe('RDS_STORAGE_ENCRYPTED')
      expect(rule.scope?.complianceResourceTypes).toContain('AWS::RDS::DBInstance')
    })

    it('should create IAM password policy rule', () => {
      const rule = manager.createIamPasswordPolicyRule()

      expect(rule.name).toBe('iam-password-policy')
      expect(rule.inputParameters?.MinimumPasswordLength).toBe(14)
      expect(rule.inputParameters?.RequireUppercaseCharacters).toBe(true)
    })

    it('should create custom Lambda rule', () => {
      const rule = manager.createCustomLambdaRule({
        name: 'custom-compliance-check',
        description: 'Custom compliance validation',
        lambdaFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:compliance-check',
        resourceTypes: ['AWS::EC2::Instance'],
        maxExecutionFrequency: 'TwentyFour_Hours',
      })

      expect(rule.name).toBe('custom-compliance-check')
      expect(rule.source).toBe('CUSTOM_LAMBDA')
      expect(rule.lambdaFunctionArn).toBeDefined()
      expect(rule.maxExecutionFrequency).toBe('TwentyFour_Hours')
    })

    it('should list config rules', () => {
      manager.createS3EncryptionRule()
      manager.createRdsEncryptionRule()

      const rules = manager.listConfigRules()
      expect(rules).toHaveLength(2)
    })
  })

  describe('Compliance Presets', () => {
    it('should create HIPAA preset', () => {
      const rules = manager.createCompliancePreset('hipaa')

      expect(rules.length).toBeGreaterThan(5)
      expect(rules.some(r => r.name.includes('encryption'))).toBe(true)
      expect(rules.some(r => r.name.includes('cloudtrail'))).toBe(true)
    })

    it('should create PCI-DSS preset', () => {
      const rules = manager.createCompliancePreset('pci-dss')

      expect(rules.length).toBeGreaterThan(7)
      expect(rules.some(r => r.name.includes('mfa'))).toBe(true)
      expect(rules.some(r => r.name.includes('encryption'))).toBe(true)
    })

    it('should create basic preset', () => {
      const rules = manager.createCompliancePreset('basic')

      expect(rules.length).toBeGreaterThan(4)
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate config rule CloudFormation', () => {
      const rule = manager.createS3EncryptionRule()
      const cf = manager.generateConfigRuleCF(rule)

      expect(cf.Type).toBe('AWS::Config::ConfigRule')
      expect(cf.Properties.ConfigRuleName).toBe('s3-bucket-server-side-encryption-enabled')
      expect(cf.Properties.Source.Owner).toBe('AWS')
      expect(cf.Properties.Source.SourceIdentifier).toBe('S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED')
    })

    it('should generate recorder CloudFormation', () => {
      const recorder = manager.createConfigRecorder({
        name: 'default',
        roleArn: 'arn:aws:iam::123456789012:role/config-role',
      })

      const cf = manager.generateConfigRecorderCF(recorder)

      expect(cf.Type).toBe('AWS::Config::ConfigurationRecorder')
      expect(cf.Properties.Name).toBe('default')
    })
  })
})

describe('CloudTrail Manager', () => {
  let manager: CloudTrailManager

  beforeEach(() => {
    manager = new CloudTrailManager()
  })

  describe('Trail Creation', () => {
    it('should create basic trail', () => {
      const trail = manager.createTrail({
        name: 'my-trail',
        s3BucketName: 'cloudtrail-bucket',
        includeGlobalServiceEvents: true,
        isMultiRegionTrail: true,
        enableLogFileValidation: true,
      })

      expect(trail.id).toMatch(/^trail-\d+-\d+$/)
      expect(trail.name).toBe('my-trail')
      expect(trail.s3BucketName).toBe('cloudtrail-bucket')
      expect(trail.enableLogFileValidation).toBe(true)
    })

    it('should create organization trail', () => {
      const trail = manager.createOrganizationTrail({
        name: 'org-trail',
        s3BucketName: 'org-cloudtrail',
        kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/12345',
      })

      expect(trail.name).toBe('org-trail')
      expect(trail.isMultiRegionTrail).toBe(true)
      expect(trail.s3KeyPrefix).toBe('organization-trail')
    })

    it('should create security audit trail', () => {
      const trail = manager.createSecurityAuditTrail({
        name: 'security-audit',
        s3BucketName: 'security-logs',
        kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/12345',
        cloudWatchLogsLogGroupArn: 'arn:aws:logs:us-east-1:123456789012:log-group:cloudtrail',
        cloudWatchLogsRoleArn: 'arn:aws:iam::123456789012:role/cloudtrail-logs',
      })

      expect(trail.insightSelectors).toHaveLength(2)
      expect(trail.eventSelectors).toHaveLength(1)
      expect(trail.enableLogFileValidation).toBe(true)
    })

    it('should create data events trail', () => {
      const trail = manager.createDataEventsTrail({
        name: 'data-events',
        s3BucketName: 'data-events-bucket',
        s3DataBuckets: ['app-bucket-1', 'app-bucket-2'],
        lambdaFunctions: ['arn:aws:lambda:us-east-1:123456789012:function:my-function'],
      })

      expect(trail.eventSelectors).toHaveLength(1)
      expect(trail.eventSelectors![0].dataResources).toHaveLength(2)
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate trail CloudFormation', () => {
      const trail = manager.createTrail({
        name: 'my-trail',
        s3BucketName: 'cloudtrail-bucket',
        kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/12345',
      })

      const cf = manager.generateTrailCF(trail)

      expect(cf.Type).toBe('AWS::CloudTrail::Trail')
      expect(cf.Properties.TrailName).toBe('my-trail')
      expect(cf.Properties.S3BucketName).toBe('cloudtrail-bucket')
      expect(cf.Properties.KMSKeyId).toBeDefined()
    })

    it('should generate bucket policy', () => {
      const policy = manager.generateBucketPolicy('cloudtrail-bucket', ['123456789012', '987654321098'])

      expect(policy.Statement).toHaveLength(2)
      expect(policy.Statement[0].Action).toBe('s3:GetBucketAcl')
      expect(policy.Statement[1].Action).toBe('s3:PutObject')
    })
  })
})

describe('GuardDuty Manager', () => {
  let manager: GuardDutyManager

  beforeEach(() => {
    manager = new GuardDutyManager()
  })

  describe('Detector Creation', () => {
    it('should create basic detector', () => {
      const detector = manager.createBasicDetector()

      expect(detector.id).toMatch(/^detector-\d+-\d+$/)
      expect(detector.enable).toBe(true)
      expect(detector.findingPublishingFrequency).toBe('SIX_HOURS')
    })

    it('should create comprehensive detector', () => {
      const detector = manager.createComprehensiveDetector()

      expect(detector.enable).toBe(true)
      expect(detector.findingPublishingFrequency).toBe('FIFTEEN_MINUTES')
      expect(detector.dataSources?.s3Logs?.enable).toBe(true)
      expect(detector.dataSources?.kubernetes?.auditLogs.enable).toBe(true)
      expect(detector.features).toHaveLength(5)
    })
  })

  describe('Finding Filters', () => {
    it('should create low severity archive filter', () => {
      const detector = manager.createBasicDetector()
      const filter = manager.createLowSeverityArchiveFilter(detector.id)

      expect(filter.action).toBe('ARCHIVE')
      expect(filter.findingCriteria.criterion.severity.lt).toBe(4)
    })

    it('should create finding type filter', () => {
      const detector = manager.createBasicDetector()
      const filter = manager.createFindingTypeFilter(
        detector.id,
        ['Recon:EC2/PortProbeUnprotectedPort'],
        'ARCHIVE',
      )

      expect(filter.action).toBe('ARCHIVE')
      expect(filter.findingCriteria.criterion.type.eq).toContain('Recon:EC2/PortProbeUnprotectedPort')
    })

    it('should create trusted IP filter', () => {
      const detector = manager.createBasicDetector()
      const filter = manager.createTrustedIPFilter(detector.id, ['10.0.1.100', '10.0.2.200'])

      expect(filter.action).toBe('ARCHIVE')
      expect(filter.rank).toBe(3)
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate detector CloudFormation', () => {
      const detector = manager.createComprehensiveDetector()
      const cf = manager.generateDetectorCF(detector)

      expect(cf.Type).toBe('AWS::GuardDuty::Detector')
      expect(cf.Properties.Enable).toBe(true)
      expect(cf.Properties.DataSources.S3Logs.Enable).toBe(true)
      expect(cf.Properties.Features).toHaveLength(5)
    })
  })
})

describe('Security Hub Manager', () => {
  let manager: SecurityHubManager

  beforeEach(() => {
    manager = new SecurityHubManager()
  })

  describe('Hub Creation', () => {
    it('should create basic hub', () => {
      const hub = manager.createBasicHub()

      expect(hub.id).toMatch(/^hub-\d+-\d+$/)
      expect(hub.enable).toBe(true)
      expect(hub.standards).toHaveLength(1)
    })

    it('should create comprehensive hub', () => {
      const hub = manager.createComprehensiveHub()

      expect(hub.enable).toBe(true)
      expect(hub.controlFindingGenerator).toBe('SECURITY_CONTROL')
      expect(hub.standards).toHaveLength(3)
    })
  })

  describe('Automation Rules', () => {
    it('should create low severity suppression rule', () => {
      const rule = manager.createLowSeveritySuppressionRule()

      expect(rule.ruleName).toBe('Suppress Low Severity Informational Findings')
      expect(rule.actions[0].findingFieldsUpdate.workflow?.status).toBe('SUPPRESSED')
      expect(rule.criteria.severityLabel![0].value).toBe('INFORMATIONAL')
    })

    it('should create resource type notification rule', () => {
      const rule = manager.createResourceTypeNotificationRule(['AWS::EC2::Instance', 'AWS::RDS::DBInstance'])

      expect(rule.ruleName).toBe('Notify on Critical Resource Findings')
      expect(rule.criteria.resourceType).toHaveLength(2)
      expect(rule.criteria.severityLabel).toHaveLength(2)
    })

    it('should create compliance failure rule', () => {
      const rule = manager.createComplianceFailureRule()

      expect(rule.ruleName).toBe('Flag Compliance Failures')
      expect(rule.actions[0].findingFieldsUpdate.severity?.label).toBe('HIGH')
      expect(rule.criteria.complianceStatus![0].value).toBe('FAILED')
    })

    it('should create false positive suppression rule', () => {
      const rule = manager.createFalsePositiveSuppressionRule('GuardDuty', ['Recon:', 'UnauthorizedAccess:'])

      expect(rule.ruleName).toContain('GuardDuty')
      expect(rule.criteria.title).toHaveLength(2)
      expect(rule.actions[0].findingFieldsUpdate.workflow?.status).toBe('SUPPRESSED')
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate hub CloudFormation', () => {
      const hub = manager.createBasicHub()
      const cf = manager.generateHubCF(hub)

      expect(cf.Type).toBe('AWS::SecurityHub::Hub')
      expect(cf.Properties.ControlFindingGenerator).toBe('STANDARD_CONTROL')
    })

    it('should generate standard CloudFormation', () => {
      const hub = manager.createComprehensiveHub()
      const standard = hub.standards![0]
      const cf = manager.generateStandardCF(standard)

      expect(cf.Type).toBe('AWS::SecurityHub::Standard')
      expect(cf.Properties.StandardsArn).toContain('aws-foundational-security-best-practices')
    })

    it('should generate automation rule CloudFormation', () => {
      const rule = manager.createLowSeveritySuppressionRule()
      const cf = manager.generateAutomationRuleCF(rule)

      expect(cf.Type).toBe('AWS::SecurityHub::AutomationRule')
      expect(cf.Properties.RuleName).toBe('Suppress Low Severity Informational Findings')
      expect(cf.Properties.RuleStatus).toBe('ENABLED')
    })
  })

  describe('Security Standards', () => {
    it('should have AWS Foundational Security standard', () => {
      const standard = SecurityHubManager.Standards.AWS_FOUNDATIONAL_SECURITY

      expect(standard.name).toBe('AWS Foundational Security Best Practices')
      expect(standard.arn).toContain('aws-foundational-security-best-practices')
    })

    it('should have CIS benchmarks', () => {
      const cis14 = SecurityHubManager.Standards.CIS_AWS_FOUNDATIONS_1_4

      expect(cis14.name).toContain('CIS')
      expect(cis14.arn).toContain('cis-aws-foundations-benchmark')
    })

    it('should have PCI-DSS standard', () => {
      const pci = SecurityHubManager.Standards.PCI_DSS

      expect(pci.name).toContain('PCI DSS')
      expect(pci.arn).toContain('pci-dss')
    })
  })
})
