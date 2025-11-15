import type { CloudConfig } from '@ts-cloud/types'

/**
 * TS Cloud Configuration
 *
 * This file defines your cloud infrastructure configuration.
 * Supports both server mode (Forge-style) and serverless mode (Vapor-style).
 *
 * Environment variables:
 * - CLOUD_ENV: Set the active environment (production, staging, development)
 * - NODE_ENV: Fallback for CLOUD_ENV
 *
 * @see https://github.com/stacksjs/ts-cloud
 */
const config: CloudConfig = {
  /**
   * Project configuration
   */
  project: {
    name: 'TS Cloud',
    slug: 'ts-cloud',
    region: 'us-east-1', // Default AWS region
  },

  /**
   * Deployment mode
   * - 'server': Traditional EC2-based deployment (Forge-style)
   * - 'serverless': Container/Lambda-based deployment (Vapor-style)
   * - 'hybrid': Mix of both server and serverless
   */
  mode: 'serverless',

  /**
   * Environment configurations
   * Each environment can have its own settings
   */
  environments: {
    production: {
      type: 'production',
      region: 'us-east-1',
      variables: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },
    },
    staging: {
      type: 'staging',
      region: 'us-east-1',
      variables: {
        NODE_ENV: 'staging',
        LOG_LEVEL: 'debug',
      },
    },
    development: {
      type: 'development',
      region: 'us-east-1',
      variables: {
        NODE_ENV: 'development',
        LOG_LEVEL: 'debug',
      },
    },
  },

  /**
   * Infrastructure configuration
   * Define your cloud resources here
   */
  infrastructure: {
    /**
     * VPC Configuration (optional)
     * Creates a Virtual Private Cloud for your resources
     */
    vpc: {
      cidr: '10.0.0.0/16',
      zones: 2, // Number of availability zones
      natGateway: true, // Enable NAT gateway for private subnets
    },

    /**
     * Storage Configuration
     * S3 buckets for files, backups, etc.
     */
    storage: {
      buckets: [
        {
          name: 'assets',
          public: true,
          website: true,
          encryption: true,
          versioning: false,
        },
        {
          name: 'uploads',
          public: false,
          encryption: true,
          versioning: true,
        },
        {
          name: 'backups',
          public: false,
          encryption: true,
          versioning: true,
        },
      ],
    },

    /**
     * Compute Configuration
     * Server or serverless compute resources
     */
    compute: {
      mode: 'serverless',

      // Server mode (EC2) configuration
      server: {
        instanceType: 't3.small',
        ami: 'ami-0c55b159cbfafe1f0', // Amazon Linux 2023
        autoScaling: {
          min: 1,
          max: 5,
          desired: 2,
        },
      },

      // Serverless mode (ECS/Lambda) configuration
      serverless: {
        cpu: 512, // CPU units
        memory: 1024, // Memory in MB
        desiredCount: 2, // Number of tasks
      },
    },

    /**
     * Database Configuration
     */
    database: {
      type: 'rds', // 'rds' for relational, 'dynamodb' for NoSQL
      engine: 'postgres',
      instanceType: 'db.t3.micro',
    },

    /**
     * Cache Configuration
     */
    cache: {
      type: 'redis',
      nodeType: 'cache.t3.micro',
    },

    /**
     * CDN Configuration
     * CloudFront distribution for global content delivery
     */
    cdn: {
      enabled: true,
      customDomain: 'cdn.example.com',
      // certificateArn will be auto-created if not provided
    },

    /**
     * DNS Configuration
     * Route53 hosted zone and records
     */
    dns: {
      domain: 'example.com',
      // hostedZoneId: 'Z1234567890ABC', // Optional: use existing hosted zone
    },

    /**
     * Security Configuration
     */
    security: {
      // Web Application Firewall
      waf: {
        enabled: true,
        blockCountries: ['CN', 'RU', 'KP'], // Geo-blocking
        blockIps: ['192.0.2.0/24'], // IP blocking
        rateLimit: 2000, // Requests per 5 minutes
      },
      // KMS encryption
      kms: true,
    },

    /**
     * Monitoring Configuration
     */
    monitoring: {
      dashboards: true,
      alarms: [
        {
          name: 'HighCPU',
          metric: 'CPUUtilization',
          threshold: 80,
        },
        {
          name: 'HighMemory',
          metric: 'MemoryUtilization',
          threshold: 80,
        },
      ],
    },
  },

  /**
   * Sites Configuration (optional)
   * For multi-site deployments
   */
  sites: {
    main: {
      root: '/var/www/main',
      path: '/',
      domain: 'example.com',
    },
    api: {
      root: '/var/www/api',
      path: '/api',
      domain: 'api.example.com',
    },
  },
}

export default config
