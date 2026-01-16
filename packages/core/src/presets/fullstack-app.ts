import type { CloudConfig } from '@ts-cloud/types'

/**
 * Full Stack App Preset
 * Perfect for: Complete web applications with frontend and API
 * Includes: S3 + CloudFront (frontend) + ECS Fargate (API) + RDS + Redis
 */
export function createFullStackAppPreset(options: {
  name: string
  slug: string
  domain: string
  apiSubdomain?: string
}): Partial<CloudConfig> {
  const {
    name,
    slug,
    domain,
    apiSubdomain = 'api',
  } = options

  return {
    project: {
      name,
      slug,
      region: 'us-east-1',
    },
    mode: 'hybrid',
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
          natGateways: 1,
        },
      },
      // Frontend: S3 + CloudFront
      storage: {
        frontend: {
          public: true,
          versioning: true,
          website: true,
          encryption: false,
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
          defaultTTL: 86400,
          maxTTL: 31536000,
        },
        compress: true,
        http3: true,
        errorPages: {
          404: '/index.html',
        },
      },
      // Backend: ECS Fargate
      compute: {
        fargate: {
          taskDefinition: {
            cpu: '512',
            memory: '1024',
            containerDefinitions: [{
              name: 'api',
              image: `${slug}-api:latest`,
              portMappings: [{ containerPort: 3000 }],
            }],
          },
          service: {
            desiredCount: 2,
            healthCheck: {
              path: '/api/health',
              interval: 30,
            },
            autoScaling: {
              min: 2,
              max: 10,
              targetCPU: 70,
            },
          },
          loadBalancer: {
            type: 'application',
            customDomain: {
              domain: `${apiSubdomain}.${domain}`,
              certificateArn: 'TO_BE_GENERATED',
            },
          },
        },
      },
      // Database: PostgreSQL
      databases: {
        postgres: {
          engine: 'postgres',
          version: '15',
          instanceClass: 'db.t3.small',
          allocatedStorage: 50,
          multiAZ: true,
          backupRetentionDays: 14,
          deletionProtection: true,
        },
      },
      // Cache: Redis
      cache: {
        redis: {
          nodeType: 'cache.t3.small',
          numCacheNodes: 2,
          engine: 'redis',
          engineVersion: '7.0',
        },
      },
      // Queue for async jobs
      queues: {
        jobs: {
          fifo: false,
          visibilityTimeout: 300,
          messageRetentionPeriod: 345600, // 4 days
          deadLetterQueue: true,
        },
      },
      security: {
        certificate: {
          domain,
          subdomains: [`*.${domain}`],
          validationMethod: 'DNS',
        },
        waf: {
          enabled: true,
          rules: ['rateLimit', 'sqlInjection', 'xss'],
        },
      },
    },
  }
}
