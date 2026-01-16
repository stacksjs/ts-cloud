import type { CloudConfig } from '@ts-cloud/types'

/**
 * Traditional Web App Preset
 * Perfect for: Server-rendered web apps, CMS platforms, admin panels
 * Includes: EC2 + ALB + RDS + Redis + EFS (for session storage and uploads)
 */
export function createTraditionalWebAppPreset(options: {
  name: string
  slug: string
  domain?: string
  instanceType?: string
  minInstances?: number
  maxInstances?: number
  databaseEngine?: 'mysql' | 'postgres'
  sessionStore?: 'redis' | 'database'
}): Partial<CloudConfig> {
  const {
    name,
    slug,
    domain,
    instanceType = 't3.medium',
    minInstances = 2,
    maxInstances = 10,
    databaseEngine = 'mysql',
    sessionStore = 'redis',
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
          natGateways: 2, // Multi-AZ NAT for high availability
        },
      },
      compute: {
        server: {
          instanceType,
          ami: 'ubuntu-22.04',
          autoScaling: {
            min: minInstances,
            max: maxInstances,
            targetCPU: 70,
            scaleUpCooldown: 300,
            scaleDownCooldown: 300,
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
            stickySession: {
              enabled: true,
              duration: 86400, // 24 hours
            },
          },
          userData: `#!/bin/bash
# Install Node.js or PHP/Python based on app needs
# Configure application server (PM2, Nginx, Apache)
# Mount EFS for shared file storage
`,
        },
      },
      storage: {
        uploads: {
          // EFS for shared file storage across instances
          type: 'efs',
          performanceMode: 'generalPurpose',
          throughputMode: 'bursting',
          encrypted: true,
          lifecyclePolicy: {
            transitionToIA: 30, // Move to infrequent access after 30 days
          },
        },
        backups: {
          // S3 for backups and static assets
          public: false,
          versioning: true,
          encryption: true,
          lifecycleRules: [{
            id: 'ArchiveOldBackups',
            enabled: true,
            transitions: [{
              days: 90,
              storageClass: 'GLACIER',
            }],
          }],
        },
        static: {
          // S3 for static assets with CloudFront CDN
          public: true,
          versioning: false,
          encryption: false,
          cors: [{
            allowedOrigins: [domain || '*'],
            allowedMethods: ['GET', 'HEAD'],
          }],
        },
      },
      cdn: {
        enabled: true,
        origins: [{
          // Static assets from S3
          originId: 'static-assets',
          domainName: `${slug}-static.s3.amazonaws.com`,
          pathPattern: '/static/*',
        }],
        customDomain: domain ? {
          domain,
          certificateArn: 'TO_BE_GENERATED',
        } : undefined,
        cachePolicy: {
          minTTL: 0,
          defaultTTL: 86400, // 1 day for static assets
          maxTTL: 31536000, // 1 year max
        },
        compress: true,
        http3: true,
      },
      databases: databaseEngine === 'mysql' ? {
        mysql: {
          engine: 'mysql',
          version: '8.0',
          instanceClass: 'db.t3.medium',
          allocatedStorage: 100,
          maxAllocatedStorage: 500, // Auto-scaling storage
          multiAZ: true,
          backupRetentionDays: 14,
          preferredBackupWindow: '03:00-04:00',
          preferredMaintenanceWindow: 'sun:04:00-sun:05:00',
          enablePerformanceInsights: true,
          performanceInsightsRetention: 7,
          deletionProtection: true,
          parameters: {
            max_connections: '500',
            innodb_buffer_pool_size: '{DBInstanceClassMemory*3/4}',
            slow_query_log: '1',
            long_query_time: '2',
          },
        },
      } : {
        postgres: {
          engine: 'postgres',
          version: '15',
          instanceClass: 'db.t3.medium',
          allocatedStorage: 100,
          maxAllocatedStorage: 500,
          multiAZ: true,
          backupRetentionDays: 14,
          preferredBackupWindow: '03:00-04:00',
          preferredMaintenanceWindow: 'sun:04:00-sun:05:00',
          enablePerformanceInsights: true,
          performanceInsightsRetention: 7,
          deletionProtection: true,
          parameters: {
            max_connections: '500',
            shared_buffers: '{DBInstanceClassMemory/4}',
            log_min_duration_statement: '2000', // Log slow queries > 2s
          },
        },
      },
      cache: sessionStore === 'redis' ? {
        redis: {
          nodeType: 'cache.t3.medium',
          numCacheNodes: 2,
          engine: 'redis',
          engineVersion: '7.0',
          port: 6379,
          parameterGroup: {
            maxmemoryPolicy: 'allkeys-lru',
            timeout: '300',
          },
          snapshotRetentionLimit: 5,
          snapshotWindow: '03:00-05:00',
          automaticFailoverEnabled: true,
        },
      } : undefined,
      queues: {
        jobs: {
          // Background job processing
          fifo: false,
          visibilityTimeout: 900, // 15 minutes
          messageRetentionPeriod: 345600, // 4 days
          receiveMessageWaitTime: 20, // Long polling
          deadLetterQueue: true,
          maxReceiveCount: 3,
        },
        emails: {
          // Email queue
          fifo: false,
          visibilityTimeout: 300,
          messageRetentionPeriod: 86400,
          deadLetterQueue: true,
        },
      },
      functions: {
        // Background job worker
        'job-worker': {
          runtime: 'nodejs20.x',
          handler: 'dist/workers/jobs.handler',
          memory: 2048,
          timeout: 900, // 15 minutes
          events: [{
            type: 'sqs',
            queueName: `${slug}-jobs`,
            batchSize: 10,
          }],
        },
        // Email sender
        'email-sender': {
          runtime: 'nodejs20.x',
          handler: 'dist/workers/email.handler',
          memory: 512,
          timeout: 60,
          events: [{
            type: 'sqs',
            queueName: `${slug}-emails`,
            batchSize: 10,
          }],
        },
        // Cleanup task
        cleanup: {
          runtime: 'nodejs20.x',
          handler: 'dist/tasks/cleanup.handler',
          memory: 512,
          timeout: 300,
          events: [{
            type: 'schedule',
            expression: 'cron(0 2 * * ? *)', // Daily at 2 AM
          }],
        },
      },
      monitoring: {
        dashboard: {
          name: `${slug}-web-app`,
          widgets: [{
            type: 'metric',
            metrics: [
              'EC2CPUUtilization',
              'ALBRequestCount',
              'ALBTargetResponseTime',
              'RDSCPUUtilization',
              'RDSDatabaseConnections',
              'RDSReadLatency',
              'RDSWriteLatency',
            ],
          }],
        },
        alarms: [{
          metric: 'EC2CPUUtilization',
          threshold: 80,
          evaluationPeriods: 2,
        }, {
          metric: 'RDSCPUUtilization',
          threshold: 80,
          evaluationPeriods: 2,
        }, {
          metric: 'RDSDatabaseConnections',
          threshold: 400, // Alert at 80% of max connections
          evaluationPeriods: 1,
        }, {
          metric: 'ALBTargetResponseTime',
          threshold: 2000, // 2 seconds
          evaluationPeriods: 2,
        }, {
          metric: 'ALBUnhealthyHostCount',
          threshold: 1,
          evaluationPeriods: 1,
        }],
        logs: {
          retention: 14, // Days
          groups: [
            `${slug}-app`,
            `${slug}-nginx`,
            `${slug}-workers`,
          ],
        },
      },
      security: {
        certificate: domain ? {
          domain,
          validationMethod: 'DNS',
        } : undefined,
        waf: {
          enabled: true,
          rules: [
            'rateLimit',
            'sqlInjection',
            'xss',
            'knownBadInputs',
          ],
        },
        securityGroups: {
          alb: {
            ingress: [
              { port: 80, protocol: 'tcp', cidr: '0.0.0.0/0' },
              { port: 443, protocol: 'tcp', cidr: '0.0.0.0/0' },
            ],
          },
          app: {
            ingress: [
              { port: 3000, protocol: 'tcp', source: 'alb-sg' },
            ],
          },
          database: {
            ingress: [
              { port: databaseEngine === 'mysql' ? 3306 : 5432, protocol: 'tcp', source: 'app-sg' },
            ],
          },
          ...(sessionStore === 'redis' && {
            cache: {
              ingress: [
                { port: 6379, protocol: 'tcp', source: 'app-sg' },
              ],
            },
          }),
        },
      },
    },
  }
}
