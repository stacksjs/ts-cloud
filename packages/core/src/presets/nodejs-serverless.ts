import type { CloudConfig } from '@stacksjs/ts-cloud-types'

/**
 * Node.js Serverless Preset
 * Perfect for: Serverless APIs, microservices
 * Includes: ECS Fargate + ALB + DynamoDB + Lambda functions
 */
export function createNodeJsServerlessPreset(options: {
  name: string
  slug: string
  domain?: string
  taskCpu?: string
  taskMemory?: string
  desiredCount?: number
}): Partial<CloudConfig> {
  const {
    name,
    slug,
    domain,
    taskCpu = '256', // 0.25 vCPU
    taskMemory = '512', // 512 MB
    desiredCount = 2,
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
      network: {
        vpc: {
          cidr: '10.0.0.0/16',
          availabilityZones: 2,
          natGateways: 0, // Fargate can use public subnets or VPC endpoints
        },
      },
      compute: {
        fargate: {
          taskDefinition: {
            cpu: taskCpu,
            memory: taskMemory,
            containerDefinitions: [{
              name: 'app',
              image: `${slug}-app:latest`,
              portMappings: [{ containerPort: 3000 }],
              environment: [],
              secrets: [],
            }],
          },
          service: {
            desiredCount,
            healthCheck: {
              path: '/health',
              interval: 30,
              timeout: 5,
              healthyThreshold: 2,
              unhealthyThreshold: 3,
            },
            autoScaling: {
              min: desiredCount,
              max: desiredCount * 5,
              targetCPU: 70,
              targetMemory: 80,
            },
          },
          loadBalancer: {
            type: 'application',
          },
        },
      },
      databases: {
        dynamodb: {
          tables: {
            [`${slug}-main`]: {
              partitionKey: { name: 'id', type: 'S' },
              sortKey: { name: 'createdAt', type: 'S' },
              billingMode: 'PAY_PER_REQUEST',
              streamEnabled: true,
              pointInTimeRecovery: true,
            },
          },
        },
      },
      functions: {
        'process-queue': {
          runtime: 'nodejs20.x',
          handler: 'dist/workers/queue.handler',
          memory: 512,
          timeout: 60,
          events: [{
            type: 'sqs',
            queueName: `${slug}-queue`,
          }],
        },
      },
      security: {
        certificate: domain ? {
          domain,
          subdomains: [`*.${domain}`],
          validationMethod: 'DNS',
        } : undefined,
      },
    },
  }
}
