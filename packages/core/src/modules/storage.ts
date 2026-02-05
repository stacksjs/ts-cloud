import type { BackupPlan, BackupSelection, BackupVault, S3Bucket, S3BucketPolicy } from '@stacksjs/ts-cloud-aws-types'
import type { IAMRole } from '@stacksjs/ts-cloud-aws-types'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'
import type { EnvironmentType } from '@stacksjs/ts-cloud-types'

export interface BucketOptions {
  name?: string
  bucketName?: string // Alias for name
  slug: string
  environment: EnvironmentType
  public?: boolean
  versioning?: boolean
  website?: boolean
  encryption?: boolean
  intelligentTiering?: boolean
  cors?: CorsRule[]
  lifecycleRules?: LifecycleRule[]
}

export interface CorsRule {
  allowedOrigins: string[]
  allowedMethods: string[]
  allowedHeaders?: string[]
  maxAge?: number
}

export interface LifecycleRule {
  id: string
  enabled: boolean
  expirationDays?: number
  transitions?: Array<{
    days: number
    storageClass: 'GLACIER' | 'DEEP_ARCHIVE' | 'INTELLIGENT_TIERING' | 'STANDARD_IA' | 'ONEZONE_IA'
  }>
}

export interface S3NotificationConfig {
  functionArn: string | { 'Fn::GetAtt': [string, string] }
  events: Array<'s3:ObjectCreated:*' | 's3:ObjectCreated:Put' | 's3:ObjectCreated:Post' | 's3:ObjectCreated:Copy' | 's3:ObjectCreated:CompleteMultipartUpload' | 's3:ObjectRemoved:*' | 's3:ObjectRemoved:Delete' | 's3:ObjectRemoved:DeleteMarkerCreated'>
  filter?: {
    prefix?: string
    suffix?: string
  }
}

export interface BackupPlanOptions {
  name: string
  slug: string
  environment: EnvironmentType
  bucketLogicalIds: string[]
  retentionDays: number
  schedule?: string // Cron expression (default: daily at 5am)
  vaultName?: string
  enableContinuousBackup?: boolean
  moveToColdStorageAfterDays?: number
}

/**
 * Storage Module - S3 Bucket Management
 * Provides clean API for creating and configuring S3 buckets
*/
export class Storage {
  /**
   * Create an S3 bucket with the specified options
  */
  static createBucket(options: BucketOptions): { bucket: S3Bucket, bucketPolicy?: S3BucketPolicy, logicalId: string } {
    const {
      name,
      slug,
      environment,
      public: isPublic = false,
      versioning = false,
      website = false,
      encryption = true,
      intelligentTiering = false,
      cors,
      lifecycleRules,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 's3',
      suffix: name,
    })

    const logicalId = generateLogicalId(resourceName)

    const bucket: S3Bucket = {
      Type: 'AWS::S3::Bucket',
      Properties: {
        BucketName: resourceName,
      },
    }

    // Configure encryption
    if (encryption) {
      bucket.Properties!.BucketEncryption = {
        ServerSideEncryptionConfiguration: [{
          ServerSideEncryptionByDefault: {
            SSEAlgorithm: 'AES256',
          },
        }],
      }
    }

    // Configure versioning
    if (versioning) {
      bucket.Properties!.VersioningConfiguration = {
        Status: 'Enabled',
      }
    }

    // Configure website hosting
    if (website) {
      bucket.Properties!.WebsiteConfiguration = {
        IndexDocument: 'index.html',
        ErrorDocument: 'error.html',
      }
    }

    // Configure public access block
    if (!isPublic) {
      bucket.Properties!.PublicAccessBlockConfiguration = {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      }
    }

    // Configure CORS
    if (cors && cors.length > 0) {
      bucket.Properties!.CorsConfiguration = {
        CorsRules: cors.map(rule => ({
          AllowedOrigins: rule.allowedOrigins,
          AllowedMethods: rule.allowedMethods,
          AllowedHeaders: rule.allowedHeaders,
          MaxAge: rule.maxAge,
        })),
      }
    }

    // Configure lifecycle rules
    if (lifecycleRules && lifecycleRules.length > 0) {
      bucket.Properties!.LifecycleConfiguration = {
        Rules: lifecycleRules.map(rule => ({
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

    // Configure intelligent tiering
    if (intelligentTiering && lifecycleRules) {
      const intelligentTieringRule: LifecycleRule = {
        id: 'IntelligentTieringRule',
        enabled: true,
        transitions: [{
          days: 0,
          storageClass: 'INTELLIGENT_TIERING',
        }],
      }

      if (!bucket.Properties!.LifecycleConfiguration) {
        bucket.Properties!.LifecycleConfiguration = { Rules: [] }
      }

      bucket.Properties!.LifecycleConfiguration.Rules.push({
        Id: intelligentTieringRule.id,
        Status: 'Enabled',
        Transitions: intelligentTieringRule.transitions?.map(t => ({
          TransitionInDays: t.days,
          StorageClass: t.storageClass,
        })),
      })
    }

    // Create bucket policy for public access if needed
    let bucketPolicy: S3BucketPolicy | undefined

    if (isPublic) {
      bucketPolicy = {
        Type: 'AWS::S3::BucketPolicy',
        Properties: {
          Bucket: Fn.Ref(logicalId),
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [{
              Sid: 'PublicReadGetObject',
              Effect: 'Allow',
              Principal: '*',
              Action: ['s3:GetObject'],
              Resource: [Fn.Join('', [Fn.GetAtt(logicalId, 'Arn'), '/*']) as any],
            }],
          },
        },
      }
    }

    return {
      bucket,
      bucketPolicy,
      logicalId,
    }
  }

  /**
   * Enable versioning on an existing bucket
  */
  static enableVersioning(bucket: S3Bucket): S3Bucket {
    if (!bucket.Properties) {
      bucket.Properties = {}
    }

    bucket.Properties.VersioningConfiguration = {
      Status: 'Enabled',
    }

    return bucket
  }

  /**
   * Enable website hosting on an existing bucket
  */
  static enableWebsiteHosting(
    bucket: S3Bucket,
    indexDocument = 'index.html',
    errorDocument = 'error.html',
  ): S3Bucket {
    if (!bucket.Properties) {
      bucket.Properties = {}
    }

    bucket.Properties.WebsiteConfiguration = {
      IndexDocument: indexDocument,
      ErrorDocument: errorDocument,
    }

    return bucket
  }

  /**
   * Set lifecycle rules on an existing bucket
  */
  static setLifecycleRules(bucket: S3Bucket, rules: LifecycleRule[]): S3Bucket {
    if (!bucket.Properties) {
      bucket.Properties = {}
    }

    bucket.Properties.LifecycleConfiguration = {
      Rules: rules.map(rule => ({
        Id: rule.id,
        Status: rule.enabled ? 'Enabled' : 'Disabled',
        ExpirationInDays: rule.expirationDays,
        Transitions: rule.transitions?.map(t => ({
          TransitionInDays: t.days,
          StorageClass: t.storageClass,
        })),
      })),
    }

    return bucket
  }

  /**
   * Enable intelligent tiering on an existing bucket
  */
  static enableIntelligentTiering(bucket: S3Bucket): S3Bucket {
    if (!bucket.Properties) {
      bucket.Properties = {}
    }

    if (!bucket.Properties.LifecycleConfiguration) {
      bucket.Properties.LifecycleConfiguration = { Rules: [] }
    }

    bucket.Properties.LifecycleConfiguration.Rules.push({
      Id: 'IntelligentTieringRule',
      Status: 'Enabled',
      Transitions: [{
        TransitionInDays: 0,
        StorageClass: 'INTELLIGENT_TIERING',
      }],
    })

    return bucket
  }

  /**
   * Add Lambda notification to bucket
  */
  static addLambdaNotification(bucket: S3Bucket, config: S3NotificationConfig): S3Bucket {
    if (!bucket.Properties) {
      bucket.Properties = {}
    }

    if (!bucket.Properties.NotificationConfiguration) {
      bucket.Properties.NotificationConfiguration = {}
    }

    if (!bucket.Properties.NotificationConfiguration.LambdaConfigurations) {
      bucket.Properties.NotificationConfiguration.LambdaConfigurations = []
    }

    const lambdaConfig: any = {
      Event: config.events[0], // S3 requires single event per config
      Function: config.functionArn,
    }

    if (config.filter) {
      lambdaConfig.Filter = {
        S3Key: {
          Rules: [
            ...(config.filter.prefix ? [{ Name: 'prefix', Value: config.filter.prefix }] : []),
            ...(config.filter.suffix ? [{ Name: 'suffix', Value: config.filter.suffix }] : []),
          ],
        },
      }
    }

    // Add a configuration for each event type
    for (const event of config.events) {
      const eventConfig = { ...lambdaConfig, Event: event }
      bucket.Properties.NotificationConfiguration.LambdaConfigurations.push(eventConfig)
    }

    return bucket
  }

  /**
   * Common notification configurations
  */
  static readonly Notifications = {
    /**
     * Trigger Lambda on any object creation
    */
    onObjectCreated: (functionArn: string | { 'Fn::GetAtt': [string, string] }): {
      functionArn: string | { 'Fn::GetAtt': [string, string] }
      events: readonly ['s3:ObjectCreated:*']
    } => ({
      functionArn: functionArn,
      events: ['s3:ObjectCreated:*'] as const,
    }),

    /**
     * Trigger Lambda on object deletion
    */
    onObjectRemoved: (functionArn: string | { 'Fn::GetAtt': [string, string] }): {
      functionArn: string | { 'Fn::GetAtt': [string, string] }
      events: readonly ['s3:ObjectRemoved:*']
    } => ({
      functionArn: functionArn,
      events: ['s3:ObjectRemoved:*'] as const,
    }),

    /**
     * Trigger Lambda on image uploads (jpg, png, gif)
    */
    onImageUpload: (functionArn: string | { 'Fn::GetAtt': [string, string] }, prefix?: string): {
      functionArn: string | { 'Fn::GetAtt': [string, string] }
      events: readonly ['s3:ObjectCreated:*']
      filter: { prefix: string | undefined; suffix: string }
    } => ({
      functionArn: functionArn,
      events: ['s3:ObjectCreated:*'] as const,
      filter: {
        prefix: prefix,
        suffix: '.jpg',
      },
    }),

    /**
     * Trigger Lambda on specific file type
    */
    onFileType: (
      functionArn: string | { 'Fn::GetAtt': [string, string] },
      suffix: string,
      prefix?: string,
    ): {
      functionArn: string | { 'Fn::GetAtt': [string, string] }
      events: readonly ['s3:ObjectCreated:*']
      filter: { prefix: string | undefined; suffix: string }
    } => ({
      functionArn: functionArn,
      events: ['s3:ObjectCreated:*'] as const,
      filter: {
        prefix: prefix,
        suffix: suffix,
      },
    }),

    /**
     * Trigger Lambda on uploads to specific folder
    */
    onFolderUpload: (
      functionArn: string | { 'Fn::GetAtt': [string, string] },
      folder: string,
    ): {
      functionArn: string | { 'Fn::GetAtt': [string, string] }
      events: readonly ['s3:ObjectCreated:*']
      filter: { prefix: string }
    } => ({
      functionArn: functionArn,
      events: ['s3:ObjectCreated:*'] as const,
      filter: {
        prefix: folder.endsWith('/') ? folder : `${folder}/`,
      },
    }),
  }

  /**
   * Create an AWS Backup plan for S3 buckets
  */
  static createBackupPlan(options: BackupPlanOptions): {
    vault: BackupVault
    plan: BackupPlan
    selection: BackupSelection
    role: IAMRole
    vaultLogicalId: string
    planLogicalId: string
    selectionLogicalId: string
    roleLogicalId: string
  } {
    const {
      name,
      slug,
      environment,
      bucketLogicalIds,
      retentionDays,
      schedule = 'cron(0 5 * * ? *)', // Daily at 5am UTC
      vaultName,
      enableContinuousBackup = false,
      moveToColdStorageAfterDays,
    } = options

    // Create backup vault
    const vaultResourceName = vaultName || generateResourceName({
      slug,
      environment,
      resourceType: 'backup-vault',
      suffix: name,
    })

    const vaultLogicalId = generateLogicalId(vaultResourceName)

    const vault: BackupVault = {
      Type: 'AWS::Backup::BackupVault',
      Properties: {
        BackupVaultName: vaultResourceName,
      },
    }

    // Create IAM role for AWS Backup
    const roleResourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'backup-role',
      suffix: name,
    })

    const roleLogicalId = generateLogicalId(roleResourceName)

    const role: IAMRole = {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: roleResourceName,
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Principal: {
              Service: 'backup.amazonaws.com',
            },
            Action: 'sts:AssumeRole',
          }],
        },
        ManagedPolicyArns: [
          'arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup',
          'arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores',
        ],
      },
    }

    // Create backup plan
    const planResourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'backup-plan',
      suffix: name,
    })

    const planLogicalId = generateLogicalId(planResourceName)

    const lifecycle: any = {
      DeleteAfterDays: retentionDays,
    }

    if (moveToColdStorageAfterDays && moveToColdStorageAfterDays < retentionDays) {
      lifecycle.MoveToColdStorageAfterDays = moveToColdStorageAfterDays
    }

    const plan: BackupPlan = {
      Type: 'AWS::Backup::BackupPlan',
      Properties: {
        BackupPlan: {
          BackupPlanName: planResourceName,
          BackupPlanRule: [{
            RuleName: `${name}-daily-backup`,
            TargetBackupVault: Fn.Ref(vaultLogicalId) as any,
            ScheduleExpression: schedule,
            StartWindowMinutes: 60,
            CompletionWindowMinutes: 120,
            Lifecycle: lifecycle,
            EnableContinuousBackup: enableContinuousBackup,
          }],
        },
      },
    }

    // Create backup selection
    const selectionResourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'backup-selection',
      suffix: name,
    })

    const selectionLogicalId = generateLogicalId(selectionResourceName)

    // Build bucket ARNs from logical IDs
    const bucketArns = bucketLogicalIds.map(logicalId =>
      Fn.GetAtt(logicalId, 'Arn') as any,
    )

    const selection: BackupSelection = {
      Type: 'AWS::Backup::BackupSelection',
      Properties: {
        BackupPlanId: Fn.Ref(planLogicalId) as any,
        BackupSelection: {
          SelectionName: selectionResourceName,
          IamRoleArn: Fn.GetAtt(roleLogicalId, 'Arn') as any,
          Resources: bucketArns,
        },
      },
    }

    return {
      vault,
      plan,
      selection,
      role,
      vaultLogicalId,
      planLogicalId,
      selectionLogicalId,
      roleLogicalId,
    }
  }

  /**
   * Common backup schedule expressions
  */
  static readonly BackupSchedules = {
    HOURLY: 'cron(0 * * * ? *)',
    DAILY_5AM: 'cron(0 5 * * ? *)',
    DAILY_MIDNIGHT: 'cron(0 0 * * ? *)',
    WEEKLY_SUNDAY: 'cron(0 5 ? * SUN *)',
    WEEKLY_SATURDAY: 'cron(0 5 ? * SAT *)',
    MONTHLY_FIRST: 'cron(0 5 1 * ? *)',
    EVERY_12_HOURS: 'cron(0 */12 * * ? *)',
    EVERY_6_HOURS: 'cron(0 */6 * * ? *)',
  }

  /**
   * Common backup retention periods (in days)
  */
  static readonly BackupRetention = {
    ONE_DAY: 1,
    ONE_WEEK: 7,
    TWO_WEEKS: 14,
    ONE_MONTH: 30,
    THREE_MONTHS: 90,
    SIX_MONTHS: 180,
    ONE_YEAR: 365,
    TWO_YEARS: 730,
    FIVE_YEARS: 1825,
    SEVEN_YEARS: 2555,
  }

  /**
   * Create a www redirect bucket
   * This bucket redirects www.domain.com to domain.com (or vice versa)
  */
  static createWwwRedirectBucket(options: {
    slug: string
    environment: EnvironmentType
    sourceDomain: string // e.g., www.example.com
    targetDomain: string // e.g., example.com
    protocol?: 'http' | 'https'
  }): { bucket: S3Bucket, bucketPolicy: S3BucketPolicy, logicalId: string } {
    const {
      slug,
      environment,
      sourceDomain,
      targetDomain,
      protocol = 'https',
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 's3',
      suffix: 'www-redirect',
    })

    const logicalId = generateLogicalId(resourceName)

    const bucket: S3Bucket = {
      Type: 'AWS::S3::Bucket',
      Properties: {
        BucketName: sourceDomain,
        WebsiteConfiguration: {
          RedirectAllRequestsTo: {
            HostName: targetDomain,
            Protocol: protocol,
          },
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: false,
          BlockPublicPolicy: false,
          IgnorePublicAcls: false,
          RestrictPublicBuckets: false,
        },
      },
    }

    // Policy to allow public read access for redirect
    const bucketPolicy: S3BucketPolicy = {
      Type: 'AWS::S3::BucketPolicy',
      Properties: {
        Bucket: Fn.Ref(logicalId),
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Sid: 'PublicReadForRedirect',
            Effect: 'Allow',
            Principal: '*',
            Action: ['s3:GetObject'],
            Resource: [Fn.Join('', [Fn.GetAtt(logicalId, 'Arn'), '/*']) as any],
          }],
        },
      },
    }

    return {
      bucket,
      bucketPolicy,
      logicalId,
    }
  }

  /**
   * Create a docs bucket (for documentation sites)
   * Conditional creation based on docs presence
  */
  static createDocsBucket(options: {
    slug: string
    environment: EnvironmentType
    domain?: string
  }): { bucket: S3Bucket, bucketPolicy?: S3BucketPolicy, logicalId: string } {
    const {
      slug,
      environment,
      domain,
    } = options

    const resourceName = domain || generateResourceName({
      slug,
      environment,
      resourceType: 's3',
      suffix: 'docs',
    })

    const logicalId = generateLogicalId(resourceName)

    const bucket: S3Bucket = {
      Type: 'AWS::S3::Bucket',
      Properties: {
        BucketName: resourceName,
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [{
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256',
            },
          }],
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        Tags: [{
          Key: 'backup',
          Value: 'weekly',
        }],
      },
    }

    return {
      bucket,
      logicalId,
    }
  }

  /**
   * Create an email bucket for storing emails
  */
  static createEmailBucket(options: {
    slug: string
    environment: EnvironmentType
  }): { bucket: S3Bucket, bucketPolicy: S3BucketPolicy, logicalId: string } {
    const {
      slug,
      environment,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 's3',
      suffix: 'email',
    })

    const logicalId = generateLogicalId(resourceName)

    const bucket: S3Bucket = {
      Type: 'AWS::S3::Bucket',
      Properties: {
        BucketName: resourceName,
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [{
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256',
            },
          }],
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        LifecycleConfiguration: {
          Rules: [{
            Id: 'EmailRetention',
            Status: 'Enabled',
            ExpirationInDays: 90, // Keep emails for 90 days
            Transitions: [{
              TransitionInDays: 30,
              StorageClass: 'STANDARD_IA', // Move to IA after 30 days
            }],
          }],
        },
      },
    }

    // Policy to allow SES to deliver emails to this bucket
    const bucketPolicy: S3BucketPolicy = {
      Type: 'AWS::S3::BucketPolicy',
      Properties: {
        Bucket: Fn.Ref(logicalId),
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Sid: 'AllowSESPuts',
            Effect: 'Allow',
            Principal: {
              Service: 'ses.amazonaws.com',
            },
            Action: 's3:PutObject',
            Resource: Fn.Join('', [Fn.GetAtt(logicalId, 'Arn'), '/*']) as any,
            Condition: {
              StringEquals: {
                'AWS:SourceAccount': Fn.Ref('AWS::AccountId') as any,
              },
            },
          }],
        },
      },
    }

    return {
      bucket,
      bucketPolicy,
      logicalId,
    }
  }

  /**
   * Check if a docs directory exists and has content
  */
  static docsExist(options: {
    projectRoot?: string
    docsPaths?: string[]
  } = {}): {
    exists: boolean
    path: string | null
    hasDistFolder: boolean
    distPath: string | null
  } {
    const {
      projectRoot = process.cwd(),
      docsPaths = ['docs', 'documentation', 'doc'],
    } = options

    for (const docsPath of docsPaths) {
      const fullPath = join(projectRoot, docsPath)

      if (existsSync(fullPath)) {
        // Check for dist/build folder within docs
        const distPaths = ['dist', 'build', '.vitepress/dist', '_site', 'out', 'public']

        for (const distPath of distPaths) {
          const fullDistPath = join(fullPath, distPath)
          if (existsSync(fullDistPath)) {
            // Verify it has files
            try {
              const files = readdirSync(fullDistPath)
              if (files.length > 0) {
                return {
                  exists: true,
                  path: fullPath,
                  hasDistFolder: true,
                  distPath: fullDistPath,
                }
              }
            }
            catch {
              // Continue to next path
            }
          }
        }

        // Docs folder exists but no dist yet
        return {
          exists: true,
          path: fullPath,
          hasDistFolder: false,
          distPath: null,
        }
      }
    }

    return {
      exists: false,
      path: null,
      hasDistFolder: false,
      distPath: null,
    }
  }

  /**
   * Conditionally create docs bucket if docs exist
  */
  static createDocsBucketIfExists(options: {
    slug: string
    environment: EnvironmentType
    domain?: string
    projectRoot?: string
    docsPaths?: string[]
  }): {
    bucket: S3Bucket | null
    bucketPolicy?: S3BucketPolicy
    logicalId: string | null
    docsInfo: {
      exists: boolean
      path: string | null
      hasDistFolder: boolean
      distPath: string | null
    }
  } {
    const docsInfo = Storage.docsExist({
      projectRoot: options.projectRoot,
      docsPaths: options.docsPaths,
    })

    if (!docsInfo.exists) {
      return {
        bucket: null,
        logicalId: null,
        docsInfo,
      }
    }

    const result = Storage.createDocsBucket({
      slug: options.slug,
      environment: options.environment,
      domain: options.domain,
    })

    return {
      bucket: result.bucket,
      bucketPolicy: result.bucketPolicy,
      logicalId: result.logicalId,
      docsInfo,
    }
  }

  /**
   * Create private files bucket
   * For storing private/sensitive files not accessible publicly
  */
  static createPrivateBucket(options: {
    slug: string
    environment: EnvironmentType
    enableVersioning?: boolean
    retentionDays?: number
    encryptionKeyArn?: string
  }): { bucket: S3Bucket, logicalId: string } {
    const {
      slug,
      environment,
      enableVersioning = true,
      retentionDays,
      encryptionKeyArn,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 's3',
      suffix: 'private',
    })

    const logicalId = generateLogicalId(resourceName)

    const bucket: S3Bucket = {
      Type: 'AWS::S3::Bucket',
      Properties: {
        BucketName: resourceName,
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [{
            ServerSideEncryptionByDefault: encryptionKeyArn
              ? {
                  SSEAlgorithm: 'aws:kms',
                  KMSMasterKeyID: encryptionKeyArn,
                }
              : {
                  SSEAlgorithm: 'AES256',
                },
          }],
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        VersioningConfiguration: enableVersioning
          ? { Status: 'Enabled' }
          : undefined,
        LifecycleConfiguration: retentionDays
          ? {
              Rules: [{
                Id: 'RetentionPolicy',
                Status: 'Enabled',
                ExpirationInDays: retentionDays,
              }],
            }
          : undefined,
        Tags: [{
          Key: 'backup',
          Value: 'daily',
        }],
      },
    }

    return {
      bucket,
      logicalId,
    }
  }

  /**
   * Check if source paths exist for deployment
   * Common paths: views/web/dist, docs/dist, private
  */
  static checkSourcePaths(options: {
    projectRoot?: string
    paths?: {
      web?: string
      docs?: string
      private?: string
    }
  } = {}): {
    web: { exists: boolean, path: string }
    docs: { exists: boolean, path: string }
    private: { exists: boolean, path: string }
  } {
    const {
      projectRoot = process.cwd(),
      paths = {},
    } = options

    const webPath = paths.web || 'views/web/dist'
    const docsPath = paths.docs || 'docs/dist'
    const privatePath = paths.private || 'private'

    return {
      web: {
        exists: existsSync(join(projectRoot, webPath)),
        path: join(projectRoot, webPath),
      },
      docs: {
        exists: existsSync(join(projectRoot, docsPath)),
        path: join(projectRoot, docsPath),
      },
      private: {
        exists: existsSync(join(projectRoot, privatePath)),
        path: join(projectRoot, privatePath),
      },
    }
  }

  /**
   * Create all deployment buckets based on source paths
   * Conditionally creates buckets only for source paths that exist
  */
  static createDeploymentBuckets(options: {
    slug: string
    environment: EnvironmentType
    domain?: string
    projectRoot?: string
    paths?: {
      web?: string
      docs?: string
      private?: string
    }
  }): {
    resources: Record<string, S3Bucket | S3BucketPolicy>
    created: {
      web: boolean
      docs: boolean
      private: boolean
    }
    sourcePaths: {
      web: { exists: boolean, path: string }
      docs: { exists: boolean, path: string }
      private: { exists: boolean, path: string }
    }
  } {
    const {
      slug,
      environment,
      domain,
      projectRoot,
      paths,
    } = options

    const sourcePaths = Storage.checkSourcePaths({ projectRoot, paths })
    const resources: Record<string, S3Bucket | S3BucketPolicy> = {}
    const created = {
      web: false,
      docs: false,
      private: false,
    }

    // Create web bucket (always created for main site)
    const webBucket = Storage.createBucket({
      name: 'web',
      slug,
      environment,
      public: false,
      versioning: false,
      encryption: true,
    })
    resources[webBucket.logicalId] = webBucket.bucket
    created.web = true

    // Create docs bucket if docs exist
    if (sourcePaths.docs.exists) {
      const docsBucket = Storage.createDocsBucket({
        slug,
        environment,
        domain: domain ? `docs.${domain}` : undefined,
      })
      resources[docsBucket.logicalId] = docsBucket.bucket
      if (docsBucket.bucketPolicy) {
        resources[`${docsBucket.logicalId}Policy`] = docsBucket.bucketPolicy
      }
      created.docs = true
    }

    // Create private bucket if private files exist
    if (sourcePaths.private.exists) {
      const privateBucket = Storage.createPrivateBucket({
        slug,
        environment,
        enableVersioning: true,
      })
      resources[privateBucket.logicalId] = privateBucket.bucket
      created.private = true
    }

    return {
      resources,
      created,
      sourcePaths,
    }
  }
}
