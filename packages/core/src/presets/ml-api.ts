import type { CloudConfig } from '@ts-cloud/types'

/**
 * Machine Learning API Preset
 * Perfect for: ML inference APIs, AI-powered applications
 * Includes: SageMaker + API Gateway + Lambda + S3
 */
export function createMLApiPreset(options: {
  name: string
  slug: string
  domain?: string
  modelS3Path?: string
  instanceType?: string
}): Partial<CloudConfig> {
  const {
    name,
    slug,
    domain,
    modelS3Path = `s3://${slug}-models/`,
    instanceType = 'ml.t3.medium',
  } = options

  return {
    project: {
      name,
      slug,
      region: 'us-east-1',
    },
    mode: 'serverless',
    environments: {
      production: {
        type: 'production',
        domain,
      },
    },
    infrastructure: {
      storage: {
        models: {
          public: false,
          versioning: true,
          encryption: true,
          intelligentTiering: true,
        },
        datasets: {
          public: false,
          versioning: true,
          encryption: true,
          lifecycleRules: [{
            id: 'ArchiveOldDatasets',
            enabled: true,
            transitions: [{
              days: 90,
              storageClass: 'GLACIER',
            }],
          }],
        },
        predictions: {
          public: false,
          versioning: false,
          encryption: true,
          lifecycleRules: [{
            id: 'DeleteOldPredictions',
            enabled: true,
            expirationDays: 30,
          }],
        },
      },
      machineLearning: {
        sagemaker: {
          endpoints: [{
            name: `${slug}-inference`,
            modelS3Path,
            instanceType,
            initialInstanceCount: 1,
            autoScaling: {
              minInstances: 1,
              maxInstances: 5,
              targetInvocationsPerInstance: 1000,
            },
          }],
          trainingJobs: [{
            name: `${slug}-training`,
            algorithmSpecification: {
              trainingImage: 'TO_BE_SPECIFIED',
              trainingInputMode: 'File',
            },
            instanceType: 'ml.p3.2xlarge',
            instanceCount: 1,
            volumeSizeInGB: 50,
            maxRuntimeInSeconds: 86400, // 24 hours
          }],
        },
      },
      apiGateway: {
        type: 'HTTP',
        customDomain: domain ? {
          domain,
          certificateArn: 'TO_BE_GENERATED',
        } : undefined,
        cors: {
          allowOrigins: ['*'],
          allowMethods: ['POST'],
          allowHeaders: ['Content-Type', 'Authorization'],
        },
        throttling: {
          rateLimit: 1000,
          burstLimit: 500,
        },
      },
      functions: {
        predict: {
          runtime: 'python3.11',
          handler: 'handlers/predict.handler',
          memory: 2048,
          timeout: 60,
          events: [{
            type: 'http',
            path: '/predict',
            method: 'POST',
          }],
          environment: {
            SAGEMAKER_ENDPOINT: `${slug}-inference`,
            MODEL_BUCKET: `${slug}-models`,
          },
        },
        'batch-predict': {
          runtime: 'python3.11',
          handler: 'handlers/batchPredict.handler',
          memory: 3008,
          timeout: 900, // 15 minutes
          events: [{
            type: 's3',
            bucket: `${slug}-datasets`,
            suffix: '.csv',
          }],
        },
        'trigger-training': {
          runtime: 'python3.11',
          handler: 'handlers/training.handler',
          memory: 1024,
          timeout: 300,
          events: [{
            type: 'schedule',
            expression: 'cron(0 2 * * ? *)', // Daily at 2 AM
          }],
        },
      },
      databases: {
        dynamodb: {
          tables: {
            [`${slug}-predictions`]: {
              partitionKey: { name: 'requestId', type: 'S' },
              sortKey: { name: 'timestamp', type: 'S' },
              billingMode: 'PAY_PER_REQUEST',
              streamEnabled: true,
            },
            [`${slug}-models`]: {
              partitionKey: { name: 'modelId', type: 'S' },
              sortKey: { name: 'version', type: 'S' },
              billingMode: 'PAY_PER_REQUEST',
            },
          },
        },
      },
      queues: {
        predictions: {
          fifo: false,
          visibilityTimeout: 300,
          messageRetentionPeriod: 86400, // 1 day
          deadLetterQueue: true,
        },
      },
      monitoring: {
        dashboard: {
          name: `${slug}-ml`,
          widgets: [{
            type: 'metric',
            metrics: [
              'SageMakerInvocations',
              'SageMakerModelLatency',
              'APIGatewayRequests',
              'LambdaErrors',
            ],
          }],
        },
        alarms: [{
          metric: 'SageMakerModelLatency',
          threshold: 1000, // 1 second
          evaluationPeriods: 2,
        }, {
          metric: 'SageMakerInvocationErrors',
          threshold: 10,
          evaluationPeriods: 1,
        }],
      },
      security: {
        certificate: domain ? {
          domain,
          validationMethod: 'DNS',
        } : undefined,
        waf: {
          enabled: true,
          rules: ['rateLimit', 'apiProtection'],
        },
      },
    },
  }
}
