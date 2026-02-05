import type { CloudConfig } from '@stacksjs/ts-cloud-types'

/**
 * API-Only Backend Preset
 * Perfect for: REST APIs, GraphQL APIs, mobile backends
 * Includes: API Gateway + Lambda functions + DynamoDB
*/
export function createApiBackendPreset(options: {
  name: string
  slug: string
  domain?: string
}): Partial<CloudConfig> {
  const { name, slug, domain } = options

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
      apiGateway: {
        type: 'HTTP', // HTTP API is cheaper and simpler
        cors: {
          allowOrigins: ['*'],
          allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
          allowHeaders: ['Content-Type', 'Authorization'],
          maxAge: 3600,
        },
        customDomain: domain ? {
          domain,
          certificateArn: 'TO_BE_GENERATED',
        } : undefined,
        throttling: {
          rateLimit: 10000,
          burstLimit: 5000,
        },
        authorizer: {
          type: 'JWT',
          identitySource: '$request.header.Authorization',
        },
      },
      functions: {
        users: {
          runtime: 'nodejs20.x',
          handler: 'dist/api/users.handler',
          memory: 512,
          timeout: 30,
          events: [{
            type: 'http',
            path: '/users',
            method: 'GET',
          }, {
            type: 'http',
            path: '/users',
            method: 'POST',
          }],
        },
        products: {
          runtime: 'nodejs20.x',
          handler: 'dist/api/products.handler',
          memory: 512,
          timeout: 30,
          events: [{
            type: 'http',
            path: '/products',
            method: 'GET',
          }],
        },
      },
      databases: {
        dynamodb: {
          tables: {
            [`${slug}-users`]: {
              partitionKey: { name: 'userId', type: 'S' },
              billingMode: 'PAY_PER_REQUEST',
              streamEnabled: true,
              pointInTimeRecovery: true,
              globalSecondaryIndexes: [{
                name: 'EmailIndex',
                partitionKey: { name: 'email', type: 'S' },
                projection: 'ALL',
              }],
            },
            [`${slug}-products`]: {
              partitionKey: { name: 'productId', type: 'S' },
              sortKey: { name: 'category', type: 'S' },
              billingMode: 'PAY_PER_REQUEST',
              streamEnabled: false,
            },
          },
        },
      },
      cache: {
        elasticache: {
          nodeType: 'cache.t3.micro',
          numCacheNodes: 1,
          engine: 'redis',
          engineVersion: '7.0',
        },
      },
      security: {
        certificate: domain ? {
          domain,
          validationMethod: 'DNS',
        } : undefined,
        waf: {
          enabled: true,
          rules: ['rateLimit', 'sqlInjection'],
        },
      },
      monitoring: {
        alarms: [{
          metric: 'Errors',
          threshold: 10,
          period: 300,
          evaluationPeriods: 1,
        }, {
          metric: 'Duration',
          threshold: 3000, // 3 seconds
          period: 300,
          evaluationPeriods: 2,
        }],
      },
    },
  }
}
