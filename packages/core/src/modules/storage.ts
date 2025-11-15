import type { S3Bucket, S3BucketPolicy } from '@ts-cloud/aws-types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'
import type { EnvironmentType } from '@ts-cloud/types'

export interface BucketOptions {
  name: string
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
}
