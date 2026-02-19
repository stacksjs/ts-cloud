import type { CloudConfig } from 'ts-cloud-types'

/**
 * Jamstack Site Preset
 * Perfect for: Modern static sites with API routes, Next.js, Astro, SvelteKit
 * Includes: S3 + CloudFront + Lambda@Edge for SSR/ISR
 */
export function createJamstackPreset(options: {
  name: string
  slug: string
  domain: string
  apiDomain?: string
}): Partial<CloudConfig> {
  const {
    name,
    slug,
    domain,
    apiDomain,
  } = options

  return {
    project: {
      name,
      slug,
      region: 'us-east-1', // Lambda@Edge requires us-east-1
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
        static: {
          public: true,
          versioning: true,
          website: true,
          encryption: false,
          cors: [{
            allowedOrigins: ['*'],
            allowedMethods: ['GET', 'HEAD'],
          }],
          lifecycleRules: [{
            id: 'DeleteOldVersions',
            enabled: true,
            expirationDays: 90, // Clean up old versions after 90 days
          }],
        },
      },
      cdn: {
        enabled: true,
        customDomain: {
          domain,
          certificateArn: 'TO_BE_GENERATED',
        },
        cachePolicy: {
          minTTL: 0,
          defaultTTL: 0, // Let Next.js/framework control caching
          maxTTL: 31536000,
        },
        compress: true,
        http3: true,
        errorPages: {
          404: '/404.html',
          500: '/500.html',
        },
        // Lambda@Edge for SSR/ISR
        edgeFunctions: [{
          eventType: 'origin-request',
          functionArn: 'TO_BE_CREATED',
          name: 'ssr-handler',
        }],
      },
      functions: {
        ssr: {
          runtime: 'nodejs20.x',
          handler: 'dist/edge/ssr.handler',
          memory: 512,
          timeout: 5, // Edge functions have strict limits
        },
        // API routes as Lambda functions
        ...(apiDomain ? {
          api: {
            runtime: 'nodejs20.x',
            handler: 'dist/api/index.handler',
            memory: 1024,
            timeout: 30,
            events: [{
              type: 'http',
              path: '/{proxy+}',
              method: 'ANY',
            }],
          },
        } : {}),
      },
      apiGateway: apiDomain ? {
        type: 'HTTP',
        customDomain: {
          domain: apiDomain,
          certificateArn: 'TO_BE_GENERATED',
        },
        cors: {
          allowOrigins: [domain],
          allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
          allowHeaders: ['Content-Type', 'Authorization'],
        },
      } : undefined,
      databases: {
        dynamodb: {
          tables: {
            content: {
              partitionKey: { name: 'id', type: 'S' },
              sortKey: { name: 'type', type: 'S' },
              billingMode: 'PAY_PER_REQUEST',
              streamEnabled: false,
            },
          },
        },
      },
      security: {
        certificate: {
          domain,
          subdomains: apiDomain ? [apiDomain] : [],
          validationMethod: 'DNS',
        },
        waf: {
          enabled: true,
          rules: ['rateLimit', 'geoBlock'],
        },
      },
    },
  }
}
