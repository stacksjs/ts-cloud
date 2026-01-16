import type { CloudConfig } from '@ts-cloud/types'

/**
 * Data Pipeline Preset
 * Perfect for: ETL pipelines, data processing, analytics workflows
 * Includes: Kinesis + Lambda + S3 + Athena + Glue
 */
export function createDataPipelinePreset(options: {
  name: string
  slug: string
  retentionDays?: number
}): Partial<CloudConfig> {
  const {
    name,
    slug,
    retentionDays = 7,
  } = options

  return {
    project: {
      name,
      slug,
      region: 'us-east-1',
    },
    mode: 'serverless',
    infrastructure: {
      streaming: {
        dataStream: {
          name: `${slug}-stream`,
          shardCount: 2,
          retentionPeriod: retentionDays * 24, // Convert to hours
          encryption: true,
        },
      },
      storage: {
        raw: {
          public: false,
          versioning: true,
          encryption: true,
          intelligentTiering: true,
          lifecycleRules: [{
            id: 'ArchiveOldData',
            enabled: true,
            transitions: [{
              days: 30,
              storageClass: 'GLACIER',
            }, {
              days: 90,
              storageClass: 'DEEP_ARCHIVE',
            }],
          }],
        },
        processed: {
          public: false,
          versioning: true,
          encryption: true,
          intelligentTiering: true,
        },
      },
      functions: {
        'stream-processor': {
          runtime: 'nodejs20.x',
          handler: 'dist/processors/stream.handler',
          memory: 2048,
          timeout: 300, // 5 minutes for batch processing
          events: [{
            type: 'kinesis',
            streamName: `${slug}-stream`,
            batchSize: 1000,
            startingPosition: 'LATEST',
            parallelizationFactor: 10,
          }],
        },
        transformer: {
          runtime: 'nodejs20.x',
          handler: 'dist/processors/transform.handler',
          memory: 3008,
          timeout: 900, // 15 minutes
          events: [{
            type: 's3',
            bucket: `${slug}-raw`,
            prefix: 'incoming/',
          }],
        },
        aggregator: {
          runtime: 'nodejs20.x',
          handler: 'dist/processors/aggregate.handler',
          memory: 2048,
          timeout: 600, // 10 minutes
          events: [{
            type: 'schedule',
            expression: 'cron(0 * * * ? *)', // Every hour
          }],
        },
      },
      analytics: {
        athena: {
          database: `${slug}_analytics`,
          workgroup: `${slug}-workgroup`,
          outputBucket: `${slug}-query-results`,
          tables: [{
            name: 'raw_events',
            location: `s3://${slug}-raw/events/`,
            format: 'parquet',
            partitionKeys: ['year', 'month', 'day'],
          }, {
            name: 'processed_events',
            location: `s3://${slug}-processed/events/`,
            format: 'parquet',
            partitionKeys: ['year', 'month', 'day'],
          }],
        },
        glue: {
          crawlers: [{
            name: `${slug}-crawler`,
            databaseName: `${slug}_analytics`,
            s3Targets: [
              `s3://${slug}-raw/`,
              `s3://${slug}-processed/`,
            ],
            schedule: 'cron(0 2 * * ? *)', // Daily at 2 AM
          }],
          jobs: [{
            name: `${slug}-etl-job`,
            scriptLocation: `s3://${slug}-scripts/etl.py`,
            role: `${slug}-glue-role`,
            maxCapacity: 10,
            timeout: 120, // 2 hours
          }],
        },
      },
      databases: {
        dynamodb: {
          tables: {
            [`${slug}-metadata`]: {
              partitionKey: { name: 'pipelineId', type: 'S' },
              sortKey: { name: 'timestamp', type: 'S' },
              billingMode: 'PAY_PER_REQUEST',
            },
          },
        },
      },
      queues: {
        failedJobs: {
          fifo: false,
          visibilityTimeout: 900, // 15 minutes
          messageRetentionPeriod: 1209600, // 14 days
          deadLetterQueue: true,
          maxReceiveCount: 3,
        },
      },
      workflow: {
        pipelines: [{
          name: `${slug}-daily-pipeline`,
          type: 'stepFunctions',
          definition: {
            StartAt: 'ExtractData',
            States: {
              ExtractData: {
                Type: 'Task',
                Resource: 'arn:aws:states:::lambda:invoke',
                Next: 'TransformData',
              },
              TransformData: {
                Type: 'Task',
                Resource: 'arn:aws:states:::lambda:invoke',
                Next: 'LoadData',
              },
              LoadData: {
                Type: 'Task',
                Resource: 'arn:aws:states:::lambda:invoke',
                End: true,
              },
            },
          },
          schedule: 'cron(0 0 * * ? *)', // Daily at midnight
        }],
      },
      monitoring: {
        dashboard: {
          name: `${slug}-pipeline`,
          widgets: [{
            type: 'metric',
            metrics: [
              'KinesisIncomingRecords',
              'LambdaInvocations',
              'S3ObjectsCreated',
              'GlueJobsSucceeded',
            ],
          }],
        },
        alarms: [{
          metric: 'LambdaErrors',
          threshold: 10,
          evaluationPeriods: 1,
        }, {
          metric: 'KinesisIteratorAge',
          threshold: 60000, // 1 minute
          evaluationPeriods: 2,
        }],
      },
    },
  }
}
