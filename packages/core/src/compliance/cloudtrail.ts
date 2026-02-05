/**
 * AWS CloudTrail Configuration
 * API logging and auditing for security and compliance
*/

export interface CloudTrailConfig {
  id: string
  name: string
  s3BucketName: string
  s3KeyPrefix?: string
  includeGlobalServiceEvents?: boolean
  isMultiRegionTrail?: boolean
  enableLogFileValidation?: boolean
  cloudWatchLogsLogGroupArn?: string
  cloudWatchLogsRoleArn?: string
  snsTopicName?: string
  kmsKeyId?: string
  eventSelectors?: EventSelector[]
  insightSelectors?: InsightSelector[]
  advancedEventSelectors?: AdvancedEventSelector[]
}

export interface EventSelector {
  readWriteType: 'ReadOnly' | 'WriteOnly' | 'All'
  includeManagementEvents?: boolean
  dataResources?: DataResource[]
  excludeManagementEventSources?: string[]
}

export interface DataResource {
  type: string // e.g., 'AWS::S3::Object', 'AWS::Lambda::Function'
  values: string[] // ARNs
}

export interface InsightSelector {
  insightType: 'ApiCallRateInsight' | 'ApiErrorRateInsight'
}

export interface AdvancedEventSelector {
  name: string
  fieldSelectors: FieldSelector[]
}

export interface FieldSelector {
  field: string
  equals?: string[]
  startsWith?: string[]
  endsWith?: string[]
  notEquals?: string[]
  notStartsWith?: string[]
  notEndsWith?: string[]
}

/**
 * CloudTrail manager
*/
export class CloudTrailManager {
  private trails: Map<string, CloudTrailConfig> = new Map()
  private trailCounter = 0

  /**
   * Create CloudTrail
  */
  createTrail(trail: Omit<CloudTrailConfig, 'id'>): CloudTrailConfig {
    const id = `trail-${Date.now()}-${this.trailCounter++}`

    const cloudTrail: CloudTrailConfig = {
      id,
      ...trail,
    }

    this.trails.set(id, cloudTrail)

    return cloudTrail
  }

  /**
   * Create organization trail
  */
  createOrganizationTrail(options: {
    name: string
    s3BucketName: string
    kmsKeyId?: string
    cloudWatchLogsLogGroupArn?: string
    cloudWatchLogsRoleArn?: string
  }): CloudTrailConfig {
    return this.createTrail({
      name: options.name,
      s3BucketName: options.s3BucketName,
      s3KeyPrefix: 'organization-trail',
      includeGlobalServiceEvents: true,
      isMultiRegionTrail: true,
      enableLogFileValidation: true,
      kmsKeyId: options.kmsKeyId,
      cloudWatchLogsLogGroupArn: options.cloudWatchLogsLogGroupArn,
      cloudWatchLogsRoleArn: options.cloudWatchLogsRoleArn,
    })
  }

  /**
   * Create security audit trail
  */
  createSecurityAuditTrail(options: {
    name: string
    s3BucketName: string
    kmsKeyId: string
    cloudWatchLogsLogGroupArn: string
    cloudWatchLogsRoleArn: string
  }): CloudTrailConfig {
    return this.createTrail({
      name: options.name,
      s3BucketName: options.s3BucketName,
      s3KeyPrefix: 'security-audit',
      includeGlobalServiceEvents: true,
      isMultiRegionTrail: true,
      enableLogFileValidation: true,
      kmsKeyId: options.kmsKeyId,
      cloudWatchLogsLogGroupArn: options.cloudWatchLogsLogGroupArn,
      cloudWatchLogsRoleArn: options.cloudWatchLogsRoleArn,
      eventSelectors: [
        {
          readWriteType: 'All',
          includeManagementEvents: true,
          excludeManagementEventSources: [],
        },
      ],
      insightSelectors: [
        { insightType: 'ApiCallRateInsight' },
        { insightType: 'ApiErrorRateInsight' },
      ],
    })
  }

  /**
   * Create data events trail (S3 and Lambda)
  */
  createDataEventsTrail(options: {
    name: string
    s3BucketName: string
    s3DataBuckets?: string[]
    lambdaFunctions?: string[]
  }): CloudTrailConfig {
    const dataResources: DataResource[] = []

    if (options.s3DataBuckets && options.s3DataBuckets.length > 0) {
      dataResources.push({
        type: 'AWS::S3::Object',
        values: options.s3DataBuckets.map(bucket => `arn:aws:s3:::${bucket}/*`),
      })
    }

    if (options.lambdaFunctions && options.lambdaFunctions.length > 0) {
      dataResources.push({
        type: 'AWS::Lambda::Function',
        values: options.lambdaFunctions,
      })
    }

    return this.createTrail({
      name: options.name,
      s3BucketName: options.s3BucketName,
      s3KeyPrefix: 'data-events',
      includeGlobalServiceEvents: true,
      isMultiRegionTrail: true,
      enableLogFileValidation: true,
      eventSelectors: [
        {
          readWriteType: 'All',
          includeManagementEvents: false,
          dataResources,
        },
      ],
    })
  }

  /**
   * Create advanced event selectors trail
  */
  createAdvancedTrail(options: {
    name: string
    s3BucketName: string
    selectors: AdvancedEventSelector[]
  }): CloudTrailConfig {
    return this.createTrail({
      name: options.name,
      s3BucketName: options.s3BucketName,
      includeGlobalServiceEvents: true,
      isMultiRegionTrail: true,
      enableLogFileValidation: true,
      advancedEventSelectors: options.selectors,
    })
  }

  /**
   * Create read-only trail
  */
  createReadOnlyTrail(options: {
    name: string
    s3BucketName: string
  }): CloudTrailConfig {
    return this.createTrail({
      name: options.name,
      s3BucketName: options.s3BucketName,
      includeGlobalServiceEvents: true,
      isMultiRegionTrail: true,
      enableLogFileValidation: true,
      eventSelectors: [
        {
          readWriteType: 'ReadOnly',
          includeManagementEvents: true,
        },
      ],
    })
  }

  /**
   * Create write-only trail
  */
  createWriteOnlyTrail(options: {
    name: string
    s3BucketName: string
  }): CloudTrailConfig {
    return this.createTrail({
      name: options.name,
      s3BucketName: options.s3BucketName,
      includeGlobalServiceEvents: true,
      isMultiRegionTrail: true,
      enableLogFileValidation: true,
      eventSelectors: [
        {
          readWriteType: 'WriteOnly',
          includeManagementEvents: true,
        },
      ],
    })
  }

  /**
   * Get trail
  */
  getTrail(id: string): CloudTrailConfig | undefined {
    return this.trails.get(id)
  }

  /**
   * List trails
  */
  listTrails(): CloudTrailConfig[] {
    return Array.from(this.trails.values())
  }

  /**
   * Generate CloudFormation for trail
  */
  generateTrailCF(trail: CloudTrailConfig): any {
    const cf: any = {
      Type: 'AWS::CloudTrail::Trail',
      Properties: {
        TrailName: trail.name,
        S3BucketName: trail.s3BucketName,
        IsLogging: true,
        IncludeGlobalServiceEvents: trail.includeGlobalServiceEvents ?? true,
        IsMultiRegionTrail: trail.isMultiRegionTrail ?? true,
        EnableLogFileValidation: trail.enableLogFileValidation ?? true,
      },
    }

    if (trail.s3KeyPrefix) {
      cf.Properties.S3KeyPrefix = trail.s3KeyPrefix
    }

    if (trail.cloudWatchLogsLogGroupArn) {
      cf.Properties.CloudWatchLogsLogGroupArn = trail.cloudWatchLogsLogGroupArn
    }

    if (trail.cloudWatchLogsRoleArn) {
      cf.Properties.CloudWatchLogsRoleArn = trail.cloudWatchLogsRoleArn
    }

    if (trail.snsTopicName) {
      cf.Properties.SnsTopicName = trail.snsTopicName
    }

    if (trail.kmsKeyId) {
      cf.Properties.KMSKeyId = trail.kmsKeyId
    }

    if (trail.eventSelectors) {
      cf.Properties.EventSelectors = trail.eventSelectors.map(selector => ({
        ReadWriteType: selector.readWriteType,
        IncludeManagementEvents: selector.includeManagementEvents ?? true,
        ...(selector.dataResources && {
          DataResources: selector.dataResources.map(dr => ({
            Type: dr.type,
            Values: dr.values,
          })),
        }),
        ...(selector.excludeManagementEventSources && {
          ExcludeManagementEventSources: selector.excludeManagementEventSources,
        }),
      }))
    }

    if (trail.insightSelectors) {
      cf.Properties.InsightSelectors = trail.insightSelectors.map(selector => ({
        InsightType: selector.insightType,
      }))
    }

    if (trail.advancedEventSelectors) {
      cf.Properties.AdvancedEventSelectors = trail.advancedEventSelectors.map(selector => ({
        Name: selector.name,
        FieldSelectors: selector.fieldSelectors.map(fs => ({
          Field: fs.field,
          ...(fs.equals && { Equals: fs.equals }),
          ...(fs.startsWith && { StartsWith: fs.startsWith }),
          ...(fs.endsWith && { EndsWith: fs.endsWith }),
          ...(fs.notEquals && { NotEquals: fs.notEquals }),
          ...(fs.notStartsWith && { NotStartsWith: fs.notStartsWith }),
          ...(fs.notEndsWith && { NotEndsWith: fs.notEndsWith }),
        })),
      }))
    }

    return cf
  }

  /**
   * Generate CloudTrail bucket policy
  */
  generateBucketPolicy(bucketName: string, trailAccountIds: string[]): any {
    return {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'AWSCloudTrailAclCheck',
          Effect: 'Allow',
          Principal: {
            Service: 'cloudtrail.amazonaws.com',
          },
          Action: 's3:GetBucketAcl',
          Resource: `arn:aws:s3:::${bucketName}`,
        },
        {
          Sid: 'AWSCloudTrailWrite',
          Effect: 'Allow',
          Principal: {
            Service: 'cloudtrail.amazonaws.com',
          },
          Action: 's3:PutObject',
          Resource: trailAccountIds.map(
            accountId => `arn:aws:s3:::${bucketName}/AWSLogs/${accountId}/*`,
          ),
          Condition: {
            StringEquals: {
              's3:x-amz-acl': 'bucket-owner-full-control',
            },
          },
        },
      ],
    }
  }

  /**
   * Clear all data
  */
  clear(): void {
    this.trails.clear()
    this.trailCounter = 0
  }
}

/**
 * Global CloudTrail manager instance
*/
export const cloudTrailManager: CloudTrailManager = new CloudTrailManager()
