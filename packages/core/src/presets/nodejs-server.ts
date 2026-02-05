import type { CloudConfig } from '@stacksjs/ts-cloud-types'

/**
 * Node.js Server Preset
 * Perfect for: Traditional Node.js applications, API servers
 * Includes: EC2 instances + ALB + Auto Scaling + RDS + Redis
*/
export function createNodeJsServerPreset(options: {
  name: string
  slug: string
  domain?: string
  instanceType?: string
  minInstances?: number
  maxInstances?: number
}): Partial<CloudConfig> {
  const {
    name,
    slug,
    domain,
    instanceType = 't3.small',
    minInstances = 2,
    maxInstances = 10,
  } = options

  return {
    project: {
      name,
      slug,
      region: 'us-east-1',
    },
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
          natGateways: 1, // Cost-effective: 1 NAT for both AZs
        },
      },
      compute: {
        server: {
          instanceType,
          ami: 'ubuntu-22.04',
          keyPair: `${slug}-key`,
          autoScaling: {
            min: minInstances,
            max: maxInstances,
            desired: minInstances,
            targetCPU: 70,
          },
          loadBalancer: {
            type: 'application',
            healthCheck: {
              path: '/health',
              interval: 30,
              timeout: 5,
              healthyThreshold: 2,
              unhealthyThreshold: 3,
            },
          },
          userData: {
            packages: ['nodejs', 'npm', 'nginx'],
            commands: [
              'curl -fsSL https://bun.sh/install | bash',
              'npm install -g pm2',
            ],
          },
        },
      },
      databases: {
        postgres: {
          engine: 'postgres',
          version: '15',
          instanceClass: 'db.t3.micro',
          allocatedStorage: 20,
          multiAZ: true,
          backupRetentionDays: 7,
          deletionProtection: true,
        },
      },
      cache: {
        redis: {
          nodeType: 'cache.t3.micro',
          numCacheNodes: 1,
          engine: 'redis',
          engineVersion: '7.0',
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
