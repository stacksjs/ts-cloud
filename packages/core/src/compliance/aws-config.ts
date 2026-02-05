/**
 * AWS Config Rules
 * Automated compliance checking and configuration management
*/

export interface ConfigRule {
  id: string
  name: string
  description: string
  source: 'AWS_MANAGED' | 'CUSTOM_LAMBDA'
  identifier?: string
  lambdaFunctionArn?: string
  inputParameters?: Record<string, any>
  scope?: ConfigScope
  maxExecutionFrequency?: 'One_Hour' | 'Three_Hours' | 'Six_Hours' | 'Twelve_Hours' | 'TwentyFour_Hours'
}

export interface ConfigScope {
  complianceResourceTypes?: string[]
  tagKey?: string
  tagValue?: string
}

export interface ConfigRecorder {
  name: string
  roleArn: string
  recordingGroup?: RecordingGroup
}

export interface RecordingGroup {
  allSupported?: boolean
  includeGlobalResourceTypes?: boolean
  resourceTypes?: string[]
}

export interface DeliveryChannel {
  name: string
  s3BucketName: string
  s3KeyPrefix?: string
  snsTopicArn?: string
  configSnapshotDeliveryProperties?: {
    deliveryFrequency?: 'One_Hour' | 'Three_Hours' | 'Six_Hours' | 'Twelve_Hours' | 'TwentyFour_Hours'
  }
}

/**
 * AWS Config manager
*/
export class AWSConfigManager {
  private configRules: Map<string, ConfigRule> = new Map()
  private configRecorders: Map<string, ConfigRecorder> = new Map()
  private deliveryChannels: Map<string, DeliveryChannel> = new Map()
  private ruleCounter = 0

  /**
   * Create config recorder
  */
  createConfigRecorder(recorder: ConfigRecorder): ConfigRecorder {
    this.configRecorders.set(recorder.name, recorder)
    return recorder
  }

  /**
   * Create delivery channel
  */
  createDeliveryChannel(channel: DeliveryChannel): DeliveryChannel {
    this.deliveryChannels.set(channel.name, channel)
    return channel
  }

  /**
   * Create config rule
  */
  createConfigRule(rule: Omit<ConfigRule, 'id'>): ConfigRule {
    const id = `config-rule-${Date.now()}-${this.ruleCounter++}`

    const configRule: ConfigRule = {
      id,
      ...rule,
    }

    this.configRules.set(id, configRule)

    return configRule
  }

  /**
   * Create S3 bucket encryption rule
  */
  createS3EncryptionRule(): ConfigRule {
    return this.createConfigRule({
      name: 's3-bucket-server-side-encryption-enabled',
      description: 'Checks that S3 buckets have server-side encryption enabled',
      source: 'AWS_MANAGED',
      identifier: 'S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED',
      scope: {
        complianceResourceTypes: ['AWS::S3::Bucket'],
      },
    })
  }

  /**
   * Create S3 bucket public access block rule
  */
  createS3PublicAccessBlockRule(): ConfigRule {
    return this.createConfigRule({
      name: 's3-bucket-public-read-prohibited',
      description: 'Checks that S3 buckets do not allow public read access',
      source: 'AWS_MANAGED',
      identifier: 'S3_BUCKET_PUBLIC_READ_PROHIBITED',
      scope: {
        complianceResourceTypes: ['AWS::S3::Bucket'],
      },
    })
  }

  /**
   * Create S3 bucket versioning rule
  */
  createS3VersioningRule(): ConfigRule {
    return this.createConfigRule({
      name: 's3-bucket-versioning-enabled',
      description: 'Checks whether versioning is enabled for S3 buckets',
      source: 'AWS_MANAGED',
      identifier: 'S3_BUCKET_VERSIONING_ENABLED',
      scope: {
        complianceResourceTypes: ['AWS::S3::Bucket'],
      },
    })
  }

  /**
   * Create RDS encryption rule
  */
  createRdsEncryptionRule(): ConfigRule {
    return this.createConfigRule({
      name: 'rds-storage-encrypted',
      description: 'Checks whether storage encryption is enabled for RDS DB instances',
      source: 'AWS_MANAGED',
      identifier: 'RDS_STORAGE_ENCRYPTED',
      scope: {
        complianceResourceTypes: ['AWS::RDS::DBInstance'],
      },
    })
  }

  /**
   * Create RDS snapshot encryption rule
  */
  createRdsSnapshotEncryptionRule(): ConfigRule {
    return this.createConfigRule({
      name: 'rds-snapshots-public-prohibited',
      description: 'Checks if RDS snapshots are public',
      source: 'AWS_MANAGED',
      identifier: 'RDS_SNAPSHOTS_PUBLIC_PROHIBITED',
      scope: {
        complianceResourceTypes: ['AWS::RDS::DBSnapshot', 'AWS::RDS::DBClusterSnapshot'],
      },
    })
  }

  /**
   * Create RDS backup rule
  */
  createRdsBackupRule(retentionPeriod: number = 7): ConfigRule {
    return this.createConfigRule({
      name: 'db-backup-enabled',
      description: 'Checks whether RDS DB instances have backups enabled',
      source: 'AWS_MANAGED',
      identifier: 'DB_BACKUP_ENABLED',
      inputParameters: {
        backupRetentionPeriod: retentionPeriod,
      },
      scope: {
        complianceResourceTypes: ['AWS::RDS::DBInstance'],
      },
    })
  }

  /**
   * Create EC2 instance profile rule
  */
  createEc2InstanceProfileRule(): ConfigRule {
    return this.createConfigRule({
      name: 'ec2-instance-managed-by-systems-manager',
      description: 'Checks if EC2 instances are managed by Systems Manager',
      source: 'AWS_MANAGED',
      identifier: 'EC2_INSTANCE_MANAGED_BY_SSM',
      scope: {
        complianceResourceTypes: ['AWS::EC2::Instance'],
      },
    })
  }

  /**
   * Create EBS encryption rule
  */
  createEbsEncryptionRule(): ConfigRule {
    return this.createConfigRule({
      name: 'encrypted-volumes',
      description: 'Checks whether EBS volumes are encrypted',
      source: 'AWS_MANAGED',
      identifier: 'ENCRYPTED_VOLUMES',
      scope: {
        complianceResourceTypes: ['AWS::EC2::Volume'],
      },
    })
  }

  /**
   * Create IAM password policy rule
  */
  createIamPasswordPolicyRule(): ConfigRule {
    return this.createConfigRule({
      name: 'iam-password-policy',
      description: 'Checks whether the IAM password policy meets specified requirements',
      source: 'AWS_MANAGED',
      identifier: 'IAM_PASSWORD_POLICY',
      inputParameters: {
        RequireUppercaseCharacters: true,
        RequireLowercaseCharacters: true,
        RequireSymbols: true,
        RequireNumbers: true,
        MinimumPasswordLength: 14,
        PasswordReusePrevention: 24,
        MaxPasswordAge: 90,
      },
    })
  }

  /**
   * Create IAM MFA rule
  */
  createIamMfaRule(): ConfigRule {
    return this.createConfigRule({
      name: 'iam-user-mfa-enabled',
      description: 'Checks whether IAM users have MFA enabled',
      source: 'AWS_MANAGED',
      identifier: 'IAM_USER_MFA_ENABLED',
    })
  }

  /**
   * Create IAM root account MFA rule
  */
  createRootAccountMfaRule(): ConfigRule {
    return this.createConfigRule({
      name: 'root-account-mfa-enabled',
      description: 'Checks whether the root account has MFA enabled',
      source: 'AWS_MANAGED',
      identifier: 'ROOT_ACCOUNT_MFA_ENABLED',
    })
  }

  /**
   * Create VPC flow logs rule
  */
  createVpcFlowLogsRule(): ConfigRule {
    return this.createConfigRule({
      name: 'vpc-flow-logs-enabled',
      description: 'Checks whether VPC Flow Logs is enabled',
      source: 'AWS_MANAGED',
      identifier: 'VPC_FLOW_LOGS_ENABLED',
      scope: {
        complianceResourceTypes: ['AWS::EC2::VPC'],
      },
    })
  }

  /**
   * Create CloudTrail enabled rule
  */
  createCloudTrailEnabledRule(): ConfigRule {
    return this.createConfigRule({
      name: 'cloudtrail-enabled',
      description: 'Checks whether CloudTrail is enabled',
      source: 'AWS_MANAGED',
      identifier: 'CLOUD_TRAIL_ENABLED',
      maxExecutionFrequency: 'TwentyFour_Hours',
    })
  }

  /**
   * Create CloudWatch alarm rule
  */
  createCloudWatchAlarmRule(): ConfigRule {
    return this.createConfigRule({
      name: 'cloudwatch-alarm-action-check',
      description: 'Checks whether CloudWatch alarms have actions configured',
      source: 'AWS_MANAGED',
      identifier: 'CLOUDWATCH_ALARM_ACTION_CHECK',
      inputParameters: {
        alarmActionRequired: true,
        insufficientDataActionRequired: false,
        okActionRequired: false,
      },
      scope: {
        complianceResourceTypes: ['AWS::CloudWatch::Alarm'],
      },
    })
  }

  /**
   * Create custom Lambda rule
  */
  createCustomLambdaRule(options: {
    name: string
    description: string
    lambdaFunctionArn: string
    resourceTypes?: string[]
    maxExecutionFrequency?: ConfigRule['maxExecutionFrequency']
    inputParameters?: Record<string, any>
  }): ConfigRule {
    return this.createConfigRule({
      name: options.name,
      description: options.description,
      source: 'CUSTOM_LAMBDA',
      lambdaFunctionArn: options.lambdaFunctionArn,
      scope: options.resourceTypes
        ? {
            complianceResourceTypes: options.resourceTypes,
          }
        : undefined,
      maxExecutionFrequency: options.maxExecutionFrequency,
      inputParameters: options.inputParameters,
    })
  }

  /**
   * Create compliance preset rules
  */
  createCompliancePreset(preset: 'hipaa' | 'pci-dss' | 'sox' | 'gdpr' | 'basic'): ConfigRule[] {
    const rules: ConfigRule[] = []

    switch (preset) {
      case 'hipaa':
        rules.push(
          this.createS3EncryptionRule(),
          this.createRdsEncryptionRule(),
          this.createEbsEncryptionRule(),
          this.createCloudTrailEnabledRule(),
          this.createIamPasswordPolicyRule(),
          this.createRdsBackupRule(7),
          this.createVpcFlowLogsRule(),
        )
        break

      case 'pci-dss':
        rules.push(
          this.createS3EncryptionRule(),
          this.createS3PublicAccessBlockRule(),
          this.createRdsEncryptionRule(),
          this.createEbsEncryptionRule(),
          this.createCloudTrailEnabledRule(),
          this.createIamPasswordPolicyRule(),
          this.createIamMfaRule(),
          this.createRootAccountMfaRule(),
          this.createVpcFlowLogsRule(),
        )
        break

      case 'sox':
        rules.push(
          this.createS3VersioningRule(),
          this.createCloudTrailEnabledRule(),
          this.createRdsBackupRule(30),
          this.createIamPasswordPolicyRule(),
        )
        break

      case 'gdpr':
        rules.push(
          this.createS3EncryptionRule(),
          this.createRdsEncryptionRule(),
          this.createEbsEncryptionRule(),
          this.createCloudTrailEnabledRule(),
          this.createRdsSnapshotEncryptionRule(),
        )
        break

      case 'basic':
        rules.push(
          this.createS3EncryptionRule(),
          this.createS3PublicAccessBlockRule(),
          this.createRdsEncryptionRule(),
          this.createCloudTrailEnabledRule(),
          this.createIamMfaRule(),
          this.createRootAccountMfaRule(),
        )
        break
    }

    return rules
  }

  /**
   * Get config rule
  */
  getConfigRule(id: string): ConfigRule | undefined {
    return this.configRules.get(id)
  }

  /**
   * List config rules
  */
  listConfigRules(): ConfigRule[] {
    return Array.from(this.configRules.values())
  }

  /**
   * Get config recorder
  */
  getConfigRecorder(name: string): ConfigRecorder | undefined {
    return this.configRecorders.get(name)
  }

  /**
   * List config recorders
  */
  listConfigRecorders(): ConfigRecorder[] {
    return Array.from(this.configRecorders.values())
  }

  /**
   * Get delivery channel
  */
  getDeliveryChannel(name: string): DeliveryChannel | undefined {
    return this.deliveryChannels.get(name)
  }

  /**
   * List delivery channels
  */
  listDeliveryChannels(): DeliveryChannel[] {
    return Array.from(this.deliveryChannels.values())
  }

  /**
   * Generate CloudFormation for config rule
  */
  generateConfigRuleCF(rule: ConfigRule): any {
    const cfRule: any = {
      Type: 'AWS::Config::ConfigRule',
      Properties: {
        ConfigRuleName: rule.name,
        Description: rule.description,
        Source: {
          Owner: rule.source === 'AWS_MANAGED' ? 'AWS' : 'CUSTOM_LAMBDA',
        },
      },
    }

    if (rule.source === 'AWS_MANAGED' && rule.identifier) {
      cfRule.Properties.Source.SourceIdentifier = rule.identifier
    }

    if (rule.source === 'CUSTOM_LAMBDA' && rule.lambdaFunctionArn) {
      cfRule.Properties.Source.SourceIdentifier = rule.lambdaFunctionArn
      cfRule.Properties.Source.SourceDetails = [
        {
          EventSource: 'aws.config',
          MessageType: 'ConfigurationItemChangeNotification',
        },
      ]
    }

    if (rule.inputParameters) {
      cfRule.Properties.InputParameters = JSON.stringify(rule.inputParameters)
    }

    if (rule.scope) {
      cfRule.Properties.Scope = {}

      if (rule.scope.complianceResourceTypes) {
        cfRule.Properties.Scope.ComplianceResourceTypes = rule.scope.complianceResourceTypes
      }

      if (rule.scope.tagKey) {
        cfRule.Properties.Scope.TagKey = rule.scope.tagKey
      }

      if (rule.scope.tagValue) {
        cfRule.Properties.Scope.TagValue = rule.scope.tagValue
      }
    }

    if (rule.maxExecutionFrequency) {
      cfRule.Properties.MaximumExecutionFrequency = rule.maxExecutionFrequency
    }

    return cfRule
  }

  /**
   * Generate CloudFormation for config recorder
  */
  generateConfigRecorderCF(recorder: ConfigRecorder): any {
    return {
      Type: 'AWS::Config::ConfigurationRecorder',
      Properties: {
        Name: recorder.name,
        RoleArn: recorder.roleArn,
        RecordingGroup: recorder.recordingGroup || {
          AllSupported: true,
          IncludeGlobalResourceTypes: true,
        },
      },
    }
  }

  /**
   * Generate CloudFormation for delivery channel
  */
  generateDeliveryChannelCF(channel: DeliveryChannel): any {
    return {
      Type: 'AWS::Config::DeliveryChannel',
      Properties: {
        Name: channel.name,
        S3BucketName: channel.s3BucketName,
        ...(channel.s3KeyPrefix && { S3KeyPrefix: channel.s3KeyPrefix }),
        ...(channel.snsTopicArn && { SnsTopicARN: channel.snsTopicArn }),
        ...(channel.configSnapshotDeliveryProperties && {
          ConfigSnapshotDeliveryProperties: channel.configSnapshotDeliveryProperties,
        }),
      },
    }
  }

  /**
   * Clear all data
  */
  clear(): void {
    this.configRules.clear()
    this.configRecorders.clear()
    this.deliveryChannels.clear()
    this.ruleCounter = 0
  }
}

/**
 * Global AWS Config manager instance
*/
export const awsConfigManager: AWSConfigManager = new AWSConfigManager()
