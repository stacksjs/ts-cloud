import type { CloudConfig } from '@stacksjs/ts-cloud-types'

/**
 * Microservices Preset
 * Perfect for: Service-oriented architectures, distributed systems
 * Includes: Multiple ECS services + API Gateway + Service Discovery + DynamoDB
*/
export function createMicroservicesPreset(options: {
  name: string
  slug: string
  domain: string
  services: Array<{
    name: string
    port: number
    cpu?: string
    memory?: string
    desiredCount?: number
  }>
}): Partial<CloudConfig> {
  const { name, slug, domain, services } = options

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
          availabilityZones: 3, // Higher availability for microservices
          natGateways: 2,
        },
      },
      compute: {
        services: services.map(service => ({
          name: service.name,
          type: 'fargate',
          taskDefinition: {
            cpu: service.cpu || '256',
            memory: service.memory || '512',
            containerDefinitions: [{
              name: service.name,
              image: `${slug}-${service.name}:latest`,
              portMappings: [{ containerPort: service.port }],
              healthCheck: {
                command: ['CMD-SHELL', `curl -f http://localhost:${service.port}/health || exit 1`],
                interval: 30,
                timeout: 5,
                retries: 3,
              },
            }],
          },
          service: {
            desiredCount: service.desiredCount || 2,
            serviceDiscovery: {
              enabled: true,
              namespace: `${slug}.local`,
            },
            autoScaling: {
              min: 2,
              max: 10,
              targetCPU: 70,
            },
          },
        })),
      },
      apiGateway: {
        type: 'HTTP',
        customDomain: {
          domain,
          certificateArn: 'TO_BE_GENERATED',
        },
        cors: {
          allowOrigins: ['*'],
          allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
        },
        routes: services.map(service => ({
          path: `/${service.name}/{proxy+}`,
          integration: {
            type: 'vpc-link',
            service: service.name,
          },
        })),
      },
      databases: {
        dynamodb: {
          tables: Object.fromEntries(
            services.map(service => [
              `${slug}-${service.name}`,
              {
                partitionKey: { name: 'id', type: 'S' },
                billingMode: 'PAY_PER_REQUEST',
                streamEnabled: true,
                pointInTimeRecovery: true,
              },
            ]),
          ),
        },
      },
      queues: {
        events: {
          fifo: false,
          visibilityTimeout: 300,
          messageRetentionPeriod: 345600,
          deadLetterQueue: true,
        },
      },
      messaging: {
        topics: {
          events: {
            name: `${slug}-events`,
            subscriptions: services.map(service => ({
              protocol: 'sqs' as const,
              endpoint: `${slug}-${service.name}-queue`,
              filterPolicy: {
                service: [service.name],
              },
            })),
          },
        },
      },
      monitoring: {
        dashboard: {
          name: `${slug}-microservices`,
          widgets: services.map(service => ({
            type: 'metric',
            metrics: [
              { service: service.name, metric: 'CPUUtilization' },
              { service: service.name, metric: 'MemoryUtilization' },
              { service: service.name, metric: 'RequestCount' },
            ],
          })),
        },
        alarms: services.flatMap(service => [{
          name: `${service.name}-high-cpu`,
          metric: 'CPUUtilization',
          threshold: 80,
          service: service.name,
        }, {
          name: `${service.name}-errors`,
          metric: 'Errors',
          threshold: 10,
          service: service.name,
        }]),
      },
      security: {
        certificate: {
          domain,
          validationMethod: 'DNS',
        },
        waf: {
          enabled: true,
          rules: ['rateLimit', 'sqlInjection'],
        },
      },
    },
  }
}
