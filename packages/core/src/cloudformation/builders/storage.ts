import type { CloudFormationBuilder } from '../builder'
import { Arn, Fn } from '../types'

export interface StorageConfig {
  [bucketName: string]: {
    public?: boolean
    versioning?: boolean
    website?: boolean
    encryption?: boolean
    intelligentTiering?: boolean
    cors?: Array<{
      allowedOrigins: string[]
      allowedMethods: string[]
      allowedHeaders?: string[]
      maxAge?: number
    }>
    lifecycleRules?: Array<{
      id: string
      enabled: boolean
      expirationDays?: number
      transitions?: Array<{
        days: number
        storageClass: 'STANDARD_IA' | 'ONEZONE_IA' | 'INTELLIGENT_TIERING' | 'GLACIER' | 'DEEP_ARCHIVE'
      }>
    }>
    type?: 'efs'
    performanceMode?: 'generalPurpose' | 'maxIO'
    throughputMode?: 'bursting' | 'provisioned'
    lifecyclePolicy?: {
      transitionToIA?: number
      transitionToPrimaryStorageClass?: number
    }
  }
}

/**
 * Add S3 and EFS storage resources to CloudFormation template
 */
export function addStorageResources(
  builder: CloudFormationBuilder,
  config: StorageConfig,
): void {
  for (const [bucketName, bucketConfig] of Object.entries(config)) {
    // Check if this is an EFS configuration
    if (bucketConfig.type === 'efs') {
      addEFSResource(builder, bucketName, bucketConfig)
      continue
    }

    // Otherwise, create S3 bucket
    addS3Bucket(builder, bucketName, bucketConfig)
  }
}

/**
 * Add S3 bucket resource
 */
function addS3Bucket(
  builder: CloudFormationBuilder,
  bucketName: string,
  config: StorageConfig[string],
): void {
  const logicalId = builder.toLogicalId(`${bucketName}-bucket`)
  const properties: Record<string, any> = {
    BucketName: Fn.sub(`\${AWS::StackName}-${bucketName}`),
    Tags: [
      { Key: 'Name', Value: Fn.sub(`\${AWS::StackName}-${bucketName}`) },
    ],
  }

  // Versioning
  if (config.versioning) {
    properties.VersioningConfiguration = {
      Status: 'Enabled',
    }
  }

  // Encryption
  if (config.encryption) {
    properties.BucketEncryption = {
      ServerSideEncryptionConfiguration: [{
        ServerSideEncryptionByDefault: {
          SSEAlgorithm: 'AES256',
        },
      }],
    }
  }

  // Public access
  if (!config.public) {
    properties.PublicAccessBlockConfiguration = {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    }
  }

  // Website configuration
  if (config.website) {
    properties.WebsiteConfiguration = {
      IndexDocument: 'index.html',
      ErrorDocument: 'index.html', // For SPA routing
    }
  }

  // CORS configuration
  if (config.cors && config.cors.length > 0) {
    properties.CorsConfiguration = {
      CorsRules: config.cors.map(rule => ({
        AllowedOrigins: rule.allowedOrigins,
        AllowedMethods: rule.allowedMethods,
        AllowedHeaders: rule.allowedHeaders || ['*'],
        MaxAge: rule.maxAge || 3600,
      })),
    }
  }

  // Lifecycle rules
  if (config.lifecycleRules && config.lifecycleRules.length > 0) {
    properties.LifecycleConfiguration = {
      Rules: config.lifecycleRules.map(rule => ({
        Id: rule.id,
        Status: rule.enabled ? 'Enabled' : 'Disabled',
        ExpirationInDays: rule.expirationDays,
        Transitions: rule.transitions?.map(t => ({
          TransitionInDays: t.days,
          StorageClass: t.storageClass,
        })),
      })),
    }
  }

  // Intelligent tiering
  if (config.intelligentTiering) {
    properties.IntelligentTieringConfigurations = [{
      Id: 'EntireBucket',
      Status: 'Enabled',
      Tierings: [
        {
          AccessTier: 'ARCHIVE_ACCESS',
          Days: 90,
        },
        {
          AccessTier: 'DEEP_ARCHIVE_ACCESS',
          Days: 180,
        },
      ],
    }]
  }

  builder.addResource(logicalId, 'AWS::S3::Bucket', properties, {
    deletionPolicy: config.versioning ? 'Retain' : 'Delete',
  })

  // Bucket policy for public access if needed
  if (config.public) {
    builder.addResource(`${logicalId}Policy`, 'AWS::S3::BucketPolicy', {
      Bucket: Fn.ref(logicalId),
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Sid: 'PublicReadGetObject',
          Effect: 'Allow',
          Principal: '*',
          Action: 's3:GetObject',
          Resource: Fn.join('', [Arn.s3Bucket(Fn.ref(logicalId)), '/*']),
        }],
      },
    }, {
      dependsOn: logicalId,
    })
  }

  // Output bucket name and ARN
  builder.template.Outputs = {
    ...builder.template.Outputs,
    [`${logicalId}Name`]: {
      Description: `${bucketName} bucket name`,
      Value: Fn.ref(logicalId),
      Export: {
        Name: Fn.sub(`\${AWS::StackName}-${bucketName}-bucket`),
      },
    },
    [`${logicalId}Arn`]: {
      Description: `${bucketName} bucket ARN`,
      Value: Fn.getAtt(logicalId, 'Arn'),
      Export: {
        Name: Fn.sub(`\${AWS::StackName}-${bucketName}-bucket-arn`),
      },
    },
  }

  if (config.website) {
    builder.template.Outputs[`${logicalId}WebsiteURL`] = {
      Description: `${bucketName} website URL`,
      Value: Fn.getAtt(logicalId, 'WebsiteURL'),
    }
  }
}

/**
 * Add EFS file system resource
 */
function addEFSResource(
  builder: CloudFormationBuilder,
  name: string,
  config: StorageConfig[string],
): void {
  const logicalId = builder.toLogicalId(`${name}-efs`)

  // EFS File System
  const properties: Record<string, any> = {
    Encrypted: config.encryption !== false,
    PerformanceMode: config.performanceMode || 'generalPurpose',
    ThroughputMode: config.throughputMode || 'bursting',
    FileSystemTags: [
      { Key: 'Name', Value: Fn.sub(`\${AWS::StackName}-${name}`) },
    ],
  }

  // Lifecycle policy
  if (config.lifecyclePolicy) {
    properties.LifecyclePolicies = []

    if (config.lifecyclePolicy.transitionToIA) {
      properties.LifecyclePolicies.push({
        TransitionToIA: `AFTER_${config.lifecyclePolicy.transitionToIA}_DAYS`,
      })
    }

    if (config.lifecyclePolicy.transitionToPrimaryStorageClass) {
      properties.LifecyclePolicies.push({
        TransitionToPrimaryStorageClass: 'AFTER_1_ACCESS',
      })
    }
  }

  builder.addResource(logicalId, 'AWS::EFS::FileSystem', properties, {
    deletionPolicy: 'Retain',
  })

  // EFS Mount Targets (one per AZ/subnet)
  // Note: Assumes VPC and subnets are already created
  // In a real implementation, you'd get the subnet IDs from the VPC configuration
  const availabilityZones = 2 // Should come from network config
  for (let i = 0; i < availabilityZones; i++) {
    builder.addResource(`${logicalId}MountTarget${i + 1}`, 'AWS::EFS::MountTarget', {
      FileSystemId: Fn.ref(logicalId),
      SubnetId: Fn.ref(`PrivateSubnet${i + 1}`),
      SecurityGroups: [Fn.ref('EFSSecurityGroup')],
    }, {
      dependsOn: [logicalId, `PrivateSubnet${i + 1}`],
    })
  }

  // Security group for EFS
  builder.addResource('EFSSecurityGroup', 'AWS::EC2::SecurityGroup', {
    GroupDescription: 'Security group for EFS mount targets',
    VpcId: Fn.ref('VPC'),
    SecurityGroupIngress: [{
      IpProtocol: 'tcp',
      FromPort: 2049,
      ToPort: 2049,
      SourceSecurityGroupId: Fn.ref('AppSecurityGroup'), // Assumes app security group exists
    }],
    Tags: [
      { Key: 'Name', Value: Fn.sub('${AWS::StackName}-efs-sg') },
    ],
  }, {
    dependsOn: 'VPC',
  })

  // Output EFS ID
  builder.template.Outputs = {
    ...builder.template.Outputs,
    [`${logicalId}Id`]: {
      Description: `${name} EFS file system ID`,
      Value: Fn.ref(logicalId),
      Export: {
        Name: Fn.sub(`\${AWS::StackName}-${name}-efs`),
      },
    },
  }
}
