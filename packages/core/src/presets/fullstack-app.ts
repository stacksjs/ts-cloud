import type { CloudConfig } from '../types'
import { Fn } from '../cloudformation/types'

/**
 * Backend-only companion stack for an already deployed S3/CloudFront frontend.
 * The caller attaches AppLoadBalancerDnsName to the existing distribution only
 * after this stack is healthy.
 */
export function createExistingStaticFullStackPreset(options: {
  name: string
  slug: string
  domain: string
  imageUri: string
  certificateArn?: string
  desiredCount?: number
  database?: boolean
  cache?: boolean
  queue?: boolean
}): Partial<CloudConfig> {
  const database = options.database !== false
  const cache = options.cache !== false
  const queue = options.queue !== false
  return {
    project: { name: options.name, slug: options.slug, region: 'us-east-1' },
    mode: 'server',
    environments: { production: { type: 'production', domain: options.domain } },
    infrastructure: {
      network: { vpc: { cidr: '10.0.0.0/16', availabilityZones: 2, natGateways: 1 } },
      compute: {
        fargate: {
          taskDefinition: {
            cpu: '256',
            memory: '512',
            containerDefinitions: [{
              name: 'api',
              image: options.imageUri,
              portMappings: [{ containerPort: 3000 }],
              environment: [
                { name: 'NODE_ENV', value: 'production' },
                { name: 'PORT', value: '3000' },
                { name: 'AWS_REGION', value: Fn.ref('AWS::Region') },
                ...(database ? [{ name: 'DB_HOST', value: Fn.getAtt('PostgresDb', 'Endpoint.Address') }, { name: 'DB_PORT', value: Fn.getAtt('PostgresDb', 'Endpoint.Port') }] : []),
                ...(cache ? [{ name: 'REDIS_HOST', value: Fn.getAtt('RedisReplicationGroup', 'PrimaryEndPoint.Address') }, { name: 'REDIS_PORT', value: Fn.getAtt('RedisReplicationGroup', 'PrimaryEndPoint.Port') }, { name: 'REDIS_TLS', value: 'true' }] : []),
                ...(queue ? [{ name: 'QUEUE_URL', value: Fn.ref('JobsQueue') }] : []),
                { name: 'MAIL_TRANSPORT', value: 'ses' },
              ],
              secrets: database ? [{ name: 'DB_USERNAME', valueFrom: Fn.sub('${DBSecret}:username::') }, { name: 'DB_PASSWORD', valueFrom: Fn.sub('${DBSecret}:password::') }] : [],
            }],
          },
          service: { desiredCount: options.desiredCount || 1, healthCheck: { path: '/api/health', interval: 30, timeout: 5 }, autoScaling: { min: options.desiredCount || 1, max: 6, targetCPU: 70 } },
          loadBalancer: { type: 'application', ...(options.certificateArn ? { customDomain: { domain: options.domain, certificateArn: options.certificateArn } } : {}) },
        },
      },
      ...(database ? { databases: { postgres: { engine: 'postgres', version: '16', instanceClass: 'db.t4g.micro', allocatedStorage: 20, maxAllocatedStorage: 100, multiAZ: false, backupRetentionDays: 7, deletionProtection: true } } } : {}),
      ...(cache ? { cache: { redis: { nodeType: 'cache.t4g.micro', numCacheNodes: 2, engine: 'redis', engineVersion: '7.1', automaticFailoverEnabled: true, snapshotRetentionLimit: 5 } } } : {}),
      ...(queue ? { queues: { jobs: { fifo: false, visibilityTimeout: 300, messageRetentionPeriod: 345600, deadLetterQueue: true, maxReceiveCount: 3, receiveMessageWaitTime: 20 } } } : {}),
    },
  }
}

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
    // Static frontend (S3/CloudFront) + a Fargate backend: a server (compute)
    // deployment, not a serverless Lambda app.
    mode: 'server',
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
