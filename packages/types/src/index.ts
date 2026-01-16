/**
 * AWS-specific configuration
 */
export interface AwsConfig {
  /**
   * AWS region for deployment
   */
  region?: string

  /**
   * AWS CLI profile to use
   */
  profile?: string

  /**
   * AWS account ID
   */
  accountId?: string
}

// Core configuration types
export interface CloudConfig {
  project: ProjectConfig
  mode?: DeploymentMode // Optional - auto-detected from infrastructure config
  environments: Record<string, EnvironmentConfig>
  infrastructure?: InfrastructureConfig
  sites?: Record<string, SiteConfig>

  /**
   * AWS-specific configuration
   */
  aws?: AwsConfig

  /**
   * Feature flags to enable/disable resources conditionally
   * Example: { enableCache: true, enableMonitoring: false }
   */
  features?: Record<string, boolean>

  /**
   * Deployment hooks for custom logic
   */
  hooks?: {
    beforeDeploy?: string | ((config: CloudConfig) => Promise<void>)
    afterDeploy?: string | ((config: CloudConfig) => Promise<void>)
    beforeBuild?: string | ((config: CloudConfig) => Promise<void>)
    afterBuild?: string | ((config: CloudConfig) => Promise<void>)
  }

  /**
   * Cost optimization preset
   * Automatically adjusts resource sizes based on budget
   */
  costPreset?: 'minimal' | 'balanced' | 'performance' | 'custom'

  /**
   * Tags applied to all resources
   */
  tags?: Record<string, string>
}

export type CloudOptions = Partial<CloudConfig>

export interface ProjectConfig {
  name: string
  slug: string
  region: string
}

/**
 * Deployment mode (optional)
 * @deprecated Mode is now auto-detected from your infrastructure configuration.
 * Simply define the resources you need (functions, servers, storage, etc.) and
 * ts-cloud will deploy them accordingly. No need to specify a mode.
 */
export type DeploymentMode = 'server' | 'serverless' | 'hybrid'

export type EnvironmentType = 'production' | 'staging' | 'development'

export interface EnvironmentConfig {
  type: EnvironmentType
  region?: string
  variables?: Record<string, string>
  /**
   * Custom domain for this environment
   * Example: 'example.com' for production, 'staging.example.com' for staging
   */
  domain?: string
  /**
   * Environment-specific infrastructure overrides
   * Allows different infrastructure per environment
   * Example: smaller instances in dev, larger in production
   */
  infrastructure?: Partial<InfrastructureConfig>
}

/**
 * Network/VPC configuration
 */
export interface NetworkConfig {
  vpc?: VpcConfig
  subnets?: {
    public?: number
    private?: number
  }
  natGateway?: boolean | 'single' | 'perAz'
}

/**
 * API Gateway configuration
 */
export interface ApiGatewayConfig {
  type?: 'REST' | 'HTTP' | 'websocket'
  name?: string
  description?: string
  stageName?: string
  cors?: boolean | {
    allowOrigins?: string[]
    allowMethods?: string[]
    allowHeaders?: string[]
    maxAge?: number
  }
  authorization?: 'NONE' | 'IAM' | 'COGNITO' | 'LAMBDA'
  throttling?: {
    rateLimit?: number
    burstLimit?: number
  }
  customDomain?: {
    domain?: string
    certificateArn?: string
  }
  authorizer?: {
    type?: string
    identitySource?: string
    audience?: string[]
  }
  routes?: Array<{
    path?: string
    method?: string
    integration?: string | { type?: string; service?: string }
    authorizer?: string
  }> | Record<string, {
    path?: string
    method?: string
    integration?: string | { type?: string; service?: string }
  }>
}

/**
 * Messaging (SNS) configuration
 */
export interface MessagingConfig {
  topics?: Record<string, {
    name?: string
    displayName?: string
    subscriptions?: Array<{
      protocol: 'email' | 'sqs' | 'lambda' | 'http' | 'https'
      endpoint: string
      filterPolicy?: Record<string, string[]>
    }>
  }>
}

export interface InfrastructureConfig {
  vpc?: VpcConfig

  /**
   * Network/VPC configuration
   * Defines the network infrastructure including VPC, subnets, and NAT gateways
   */
  network?: NetworkConfig

  /**
   * Compute/EC2 configuration
   * Defines the EC2 instances running your Stacks/Bun application
   *
   * @example
   * // Single instance (no load balancer needed)
   * compute: {
   *   instances: 1,
   *   instanceType: 't3.micro',
   * }
   *
   * @example
   * // Multiple instances (load balancer auto-enabled)
   * compute: {
   *   instances: 3,
   *   instanceType: 't3.small',
   *   autoScaling: {
   *     min: 2,
   *     max: 10,
   *     scaleUpThreshold: 70,
   *   },
   * }
   */
  compute?: ComputeConfig

  storage?: Record<string, StorageItemConfig & ResourceConditions>
  functions?: Record<string, FunctionConfig & ResourceConditions>
  /** @deprecated Use `compute` instead for EC2 configuration */
  servers?: Record<string, ServerItemConfig & ResourceConditions>
  databases?: Record<string, DatabaseItemConfig & ResourceConditions>
  cache?: CacheConfig
  cdn?: Record<string, CdnItemConfig & ResourceConditions> | CdnItemConfig
  /**
   * Elastic File System (EFS) configuration
   * For shared file storage across multiple instances
   */
  fileSystem?: Record<string, FileSystemItemConfig>

  /**
   * API Gateway configuration
   * Defines the API Gateway for routing HTTP requests to Lambda functions
   */
  apiGateway?: ApiGatewayConfig

  /**
   * Messaging (SNS) configuration
   * Defines SNS topics for pub/sub messaging patterns
   */
  messaging?: MessagingConfig

  /**
   * Queue (SQS) configuration
   * Defines message queues for async processing, background jobs, and event-driven architectures
   *
   * @example
   * queues: {
   *   // Standard queue for background jobs
   *   jobs: {
   *     visibilityTimeout: 120,
   *     deadLetterQueue: true,
   *   },
   *   // FIFO queue for ordered processing
   *   orders: {
   *     fifo: true,
   *     contentBasedDeduplication: true,
   *   },
   *   // High-throughput events queue
   *   events: {
   *     receiveMessageWaitTime: 20,
   *   },
   * }
   */
  queues?: Record<string, QueueItemConfig & ResourceConditions>

  /**
   * Realtime (WebSocket) configuration
   * Laravel Echo / Pusher-compatible broadcasting for Stacks.js
   *
   * @example
   * realtime: {
   *   enabled: true,
   *   channels: { public: true, private: true, presence: true },
   *   auth: { functionName: 'authorizeChannel' },
   * }
   *
   * @example Using presets
   * realtime: RealtimePresets.production
   */
  realtime?: RealtimeConfig

  dns?: DnsConfig
  security?: SecurityConfig
  monitoring?: MonitoringConfig
  api?: ApiConfig
  loadBalancer?: LoadBalancerConfig
  ssl?: SslConfig
  streaming?: Record<string, {
    name?: string
    shardCount?: number
    retentionPeriod?: number
    encryption?: boolean | string
  }>
  machineLearning?: {
    sagemakerEndpoint?: string
    modelBucket?: string
    sagemaker?: {
      endpointName?: string
      instanceType?: string
      endpoints?: Array<{
        name?: string
        modelName?: string
        modelS3Path?: string
        instanceType?: string
        instanceCount?: number
        initialInstanceCount?: number
        autoScaling?: {
          minInstances?: number
          maxInstances?: number
          targetInvocationsPerInstance?: number
        }
      }>
      trainingJobs?: Array<{
        name?: string
        algorithmSpecification?: {
          trainingImage?: string
          trainingInputMode?: string
        }
        instanceType?: string
        instanceCount?: number
        volumeSizeInGB?: number
        maxRuntimeInSeconds?: number
      }>
    }
  }
  analytics?: {
    enabled?: boolean
    firehose?: Record<string, {
      name?: string
      destination?: string
      bufferSize?: number
      bufferInterval?: number
    }>
    athena?: {
      database?: string
      workgroup?: string
      outputLocation?: string
      outputBucket?: string
      tables?: Array<{
        name?: string
        location?: string
        format?: string
        partitionKeys?: string[]
      }>
    }
    glue?: {
      crawlers?: Array<{
        name?: string
        databaseName?: string
        s3Targets?: string[]
        schedule?: string
      }>
      jobs?: Array<{
        name?: string
        scriptLocation?: string
        role?: string
        maxCapacity?: number
        timeout?: number
      }>
    }
  }
  workflow?: {
    pipelines?: Array<{
      name?: string
      type?: 'stepFunctions' | string
      definition?: Record<string, unknown>
      schedule?: string
    }>
  }
}

/**
 * Conditions that determine if a resource should be deployed
 */
export interface ResourceConditions {
  /**
   * Only deploy in these environments
   * Example: ['production', 'staging']
   */
  environments?: EnvironmentType[]

  /**
   * Only deploy if these features are enabled
   * Example: ['enableDatabase', 'enableCache']
   */
  requiresFeatures?: string[]

  /**
   * Only deploy in these regions
   */
  regions?: string[]

  /**
   * Custom condition function
   */
  condition?: (config: CloudConfig, env: EnvironmentType) => boolean
}

export interface SiteConfig {
  root: string
  path: string
  domain?: string
}

export interface VpcConfig {
  cidr?: string
  zones?: number
  availabilityZones?: number // Alias for zones
  natGateway?: boolean
  natGateways?: number | boolean
}

export interface StorageConfig {
  buckets?: BucketConfig[]
}

export interface BucketConfig {
  name: string
  public?: boolean
  versioning?: boolean
  website?: boolean
  encryption?: boolean
}

export interface DatabaseConfig {
  type?: 'rds' | 'dynamodb'
  engine?: 'postgres' | 'mysql'
  instanceType?: string
}

export interface CacheConfig {
  type?: 'redis' | 'memcached'
  nodeType?: string
  /**
   * Redis-specific configuration
   */
  redis?: {
    nodeType?: string
    numCacheNodes?: number
    engine?: string
    engineVersion?: string
    port?: number
    parameterGroup?: Record<string, string>
    snapshotRetentionLimit?: number
    snapshotWindow?: string
    automaticFailoverEnabled?: boolean
  }
  /**
   * ElastiCache configuration
   */
  elasticache?: {
    nodeType?: string
    numCacheNodes?: number
    engine?: string
    engineVersion?: string
  }
}

export interface CdnConfig {
  enabled?: boolean
  customDomain?: string
  certificateArn?: string
}

export interface DnsConfig {
  domain?: string
  hostedZoneId?: string
}

export interface SecurityConfig {
  waf?: WafConfig
  kms?: boolean
  /**
   * SSL/TLS Certificate configuration
   */
  certificate?: {
    domain: string
    subdomains?: string[]
    validationMethod?: 'DNS' | 'EMAIL'
  }
  /**
   * Security groups configuration
   */
  securityGroups?: Record<string, {
    ingress?: Array<{
      port: number
      protocol: string
      cidr?: string
      source?: string
    }>
    egress?: Array<{
      port: number
      protocol: string
      cidr?: string
      destination?: string
    }>
  }>
}

export interface WafConfig {
  enabled?: boolean
  blockCountries?: string[]
  blockIps?: string[]
  rateLimit?: number
  /**
   * WAF rules to enable
   * @example ['rateLimit', 'sqlInjection', 'xss']
   */
  rules?: string[]
}

export interface MonitoringConfig {
  alarms?: Record<string, AlarmItemConfig> | AlarmItemConfig[]
  dashboards?: boolean
  /**
   * Dashboard configuration
   */
  dashboard?: {
    name?: string
    widgets?: Array<{
      type?: string
      metrics?: string[] | Array<{
        service?: string
        metric?: string
      }>
    }>
  }
  /**
   * Log configuration
   */
  logs?: {
    retention?: number
    groups?: string[]
  }
}

export interface AlarmConfig {
  name: string
  metric: string
  threshold: number
}

export interface AlarmItemConfig {
  /**
   * Name of the alarm (optional, auto-generated if not provided)
   */
  name?: string
  /**
   * Metric name (short form)
   */
  metric?: string
  metricName?: string
  namespace?: string
  threshold: number
  comparisonOperator?: string
  /**
   * Period in seconds for metric aggregation
   */
  period?: number
  /**
   * Number of periods to evaluate
   */
  evaluationPeriods?: number
  /**
   * Service name for service-specific alarms
   */
  service?: string
}

export interface StorageItemConfig {
  /**
   * Make bucket publicly accessible
   */
  public?: boolean
  versioning?: boolean
  encryption?: boolean
  encrypted?: boolean // Alias for encryption (for EFS compatibility)
  website?: boolean | {
    indexDocument?: string
    errorDocument?: string
  }
  /**
   * Storage type (for special storage like EFS)
   */
  type?: 'efs' | 's3'
  /**
   * Enable Intelligent Tiering for cost optimization
   */
  intelligentTiering?: boolean
  /**
   * CORS configuration
   */
  cors?: Array<{
    allowedOrigins?: string[]
    allowedMethods?: string[]
    allowedHeaders?: string[]
    maxAge?: number
  }>
  /**
   * Lifecycle rules for automatic transitions/deletions
   */
  lifecycleRules?: Array<{
    id?: string
    enabled?: boolean
    expirationDays?: number
    transitions?: Array<{
      days?: number
      storageClass?: string
    }>
  }>
  /**
   * Performance mode (for EFS)
   */
  performanceMode?: string
  /**
   * Throughput mode (for EFS)
   */
  throughputMode?: string
  /**
   * Lifecycle policy (for EFS)
   */
  lifecyclePolicy?: {
    transitionToIA?: number
  }
}

export interface FunctionConfig {
  handler?: string
  runtime?: string
  code?: string
  timeout?: number
  memorySize?: number
  memory?: number // Alias for memorySize
  events?: Array<{
    type?: string
    path?: string
    method?: string
    queueName?: string
    streamName?: string
    tableName?: string
    expression?: string
    batchSize?: number
    startingPosition?: string
    parallelizationFactor?: number
    bucket?: string
    prefix?: string
    suffix?: string
  }>
  environment?: Record<string, string>
}

/**
 * Elastic File System (EFS) configuration
 */
export interface FileSystemItemConfig {
  /**
   * Performance mode
   */
  performanceMode?: 'generalPurpose' | 'maxIO' | string
  /**
   * Throughput mode
   */
  throughputMode?: 'bursting' | 'provisioned' | string
  /**
   * Enable encryption
   */
  encrypted?: boolean
  /**
   * Lifecycle policy
   */
  lifecyclePolicy?: {
    transitionToIA?: number
  }
  /**
   * Mount path
   */
  mountPath?: string
}

/**
 * Instance size presets
 * Provider-agnostic sizing that maps to appropriate instance types
 */
export type InstanceSize =
  | 'nano'      // ~0.5 vCPU, 0.5GB RAM
  | 'micro'     // ~1 vCPU, 1GB RAM
  | 'small'     // ~1 vCPU, 2GB RAM
  | 'medium'    // ~2 vCPU, 4GB RAM
  | 'large'     // ~2 vCPU, 8GB RAM
  | 'xlarge'    // ~4 vCPU, 16GB RAM
  | '2xlarge'   // ~8 vCPU, 32GB RAM
  | (string & {}) // Allow provider-specific types like 't3.micro'

/**
 * Server/VM Instance Configuration
 */
export interface ServerItemConfig {
  /**
   * Instance size or provider-specific type
   * @example 'small', 'medium', 'large' or 't3.micro'
   * @default 'micro'
   */
  size?: InstanceSize

  /**
   * Custom machine image (optional)
   * If not specified, uses the provider's default Linux image
   */
  image?: string

  /**
   * Custom startup script
   */
  startupScript?: string
}

/**
 * Instance configuration for mixed instance fleets
 */
export interface InstanceConfig {
  /**
   * Instance size or provider-specific type
   * @example 'small', 'medium', 'large' or 't3.micro'
   */
  size: InstanceSize

  /**
   * Weight for this instance type in auto scaling
   * Higher weight = more capacity per instance
   * @default 1
   */
  weight?: number

  /**
   * Use spot/preemptible instances for cost savings
   * @default false
   */
  spot?: boolean

  /**
   * Maximum price for spot instances (per hour)
   * Only used when spot: true
   */
  maxPrice?: string
}

/**
 * Compute Configuration
 * Defines the virtual machines/instances for your application
 *
 * @example Single instance
 * compute: {
 *   instances: 1,
 *   size: 'small',
 * }
 *
 * @example Multiple instances (auto-enables load balancer)
 * compute: {
 *   instances: 3,
 *   size: 'medium',
 *   autoScaling: { min: 2, max: 10 },
 * }
 *
 * @example Mixed instance fleet for cost optimization
 * compute: {
 *   instances: 3,
 *   fleet: [
 *     { size: 'small', weight: 1 },
 *     { size: 'medium', weight: 2 },
 *     { size: 'small', weight: 1, spot: true },
 *   ],
 * }
 */
export interface ComputeConfig {
  /**
   * Compute mode: 'server' for EC2, 'serverless' for Fargate/Lambda
   */
  mode?: 'server' | 'serverless'

  /**
   * Number of instances to run
   * When > 1, load balancer is automatically enabled
   * @default 1
   */
  instances?: number

  /**
   * Instance size (simple configuration)
   * Use this OR fleet, not both
   * @default 'micro'
   */
  size?: InstanceSize

  /**
   * Mixed instance fleet for cost optimization
   * Allows combining different sizes and spot instances
   *
   * @example
   * fleet: [
   *   { size: 'small', weight: 1 },
   *   { size: 'medium', weight: 2 },
   *   { size: 'small', weight: 1, spot: true },
   * ]
   */
  fleet?: InstanceConfig[]

  /**
   * Custom machine image (optional)
   * If not specified, uses the provider's default Linux image
   */
  image?: string

  /**
   * Server mode (EC2) configuration
   */
  server?: {
    instanceType?: string
    ami?: string
    keyPair?: string
    autoScaling?: {
      min?: number
      max?: number
      desired?: number
      targetCPU?: number
      scaleUpCooldown?: number
      scaleDownCooldown?: number
    }
    loadBalancer?: {
      type?: string
      healthCheck?: {
        path?: string
        interval?: number
        timeout?: number
        healthyThreshold?: number
        unhealthyThreshold?: number
      }
      stickySession?: {
        enabled?: boolean
        duration?: number
      }
    }
    userData?: string | {
      packages?: string[]
      commands?: string[]
    }
  }

  /**
   * Serverless configuration (ECS/Lambda)
   */
  serverless?: {
    cpu?: number
    memory?: number
    desiredCount?: number
  }

  /**
   * Fargate configuration
   */
  fargate?: {
    taskDefinition?: {
      cpu?: string
      memory?: string
      containerDefinitions?: Array<{
        name?: string
        image?: string
        portMappings?: Array<{
          containerPort?: number
        }>
        environment?: unknown[]
        secrets?: unknown[]
      }>
    }
    service?: {
      desiredCount?: number
      healthCheck?: {
        path?: string
        interval?: number
        timeout?: number
        healthyThreshold?: number
        unhealthyThreshold?: number
      }
      serviceDiscovery?: {
        enabled?: boolean
        namespace?: string
      }
      autoScaling?: {
        min?: number
        max?: number
        targetCPU?: number
        targetMemory?: number
      }
    }
    loadBalancer?: {
      type?: string
      customDomain?: {
        domain?: string
        certificateArn?: string
      }
    }
  }

  /**
   * Microservices configuration
   */
  services?: Array<{
    name: string
    type?: string
    taskDefinition?: {
      cpu?: string
      memory?: string
      containerDefinitions?: Array<{
        name?: string
        image?: string
        portMappings?: Array<{
          containerPort?: number
        }>
        healthCheck?: {
          command?: string[]
          interval?: number
          timeout?: number
          retries?: number
        }
      }>
    }
    service?: {
      desiredCount?: number
      serviceDiscovery?: {
        enabled?: boolean
        namespace?: string
      }
      autoScaling?: {
        min?: number
        max?: number
        targetCPU?: number
      }
    }
  }>

  /**
   * Auto Scaling configuration
   */
  autoScaling?: {
    /** Minimum number of instances @default 1 */
    min?: number
    /** Maximum number of instances @default instances value */
    max?: number
    /** Desired number of instances @default instances value */
    desired?: number
    /** CPU threshold to scale up (%) @default 70 */
    scaleUpThreshold?: number
    /** CPU threshold to scale down (%) @default 30 */
    scaleDownThreshold?: number
    /** Cooldown in seconds @default 300 */
    cooldown?: number
  }

  /**
   * Root disk configuration
   */
  disk?: {
    /** Size in GB @default 20 */
    size?: number
    /** Disk type @default 'ssd' */
    type?: 'standard' | 'ssd' | 'premium'
    /** Enable encryption @default true */
    encrypted?: boolean
  }

  /**
   * SSH key name for instance access
   */
  sshKey?: string

  /**
   * Enable detailed monitoring
   * @default false
   */
  monitoring?: boolean

  /**
   * Spot/preemptible instance settings (when using fleet)
   */
  spotConfig?: {
    /** Base capacity that must be on-demand @default 1 */
    baseCapacity?: number
    /** % of instances above base that are on-demand @default 100 */
    onDemandPercentage?: number
    /** Allocation strategy @default 'capacity-optimized' */
    strategy?: 'lowest-price' | 'capacity-optimized'
  }
}

export interface DatabaseItemConfig {
  engine?: 'dynamodb' | 'postgres' | 'mysql'
  partitionKey?: string | { name: string; type: string }
  sortKey?: string | { name: string; type: string }
  username?: string
  password?: string
  storage?: number
  instanceClass?: string
  version?: string
  allocatedStorage?: number
  maxAllocatedStorage?: number
  multiAZ?: boolean
  backupRetentionDays?: number
  preferredBackupWindow?: string
  preferredMaintenanceWindow?: string
  deletionProtection?: boolean
  streamEnabled?: boolean
  pointInTimeRecovery?: boolean
  billingMode?: string
  parameters?: Record<string, string | number>
  databaseName?: string
  enablePerformanceInsights?: boolean
  performanceInsightsRetention?: number
  tables?: Record<string, {
    name?: string
    partitionKey?: string | { name: string; type: string }
    sortKey?: string | { name: string; type: string }
    billing?: string
    billingMode?: string
    streamEnabled?: boolean
    pointInTimeRecovery?: boolean
    globalSecondaryIndexes?: Array<{
      name: string
      partitionKey: { name: string; type: string }
      sortKey?: { name: string; type: string }
      projection: string
    }>
  }>
}

export interface CdnItemConfig {
  origin?: string
  customDomain?: string | {
    domain: string
    certificateArn?: string
  }
  certificateArn?: string
  /**
   * Custom domain configuration
   */
  domain?: string
  /**
   * Enable CDN
   */
  enabled?: boolean
  /**
   * Cache policy configuration
   */
  cachePolicy?: {
    minTTL?: number
    defaultTTL?: number
    maxTTL?: number
  }
  /**
   * TTL settings
   */
  minTTL?: number
  defaultTTL?: number
  maxTTL?: number
  /**
   * Enable compression
   */
  compress?: boolean
  /**
   * Enable HTTP/3
   */
  http3?: boolean
  /**
   * Custom error pages
   */
  errorPages?: Record<number | string, string>
  /**
   * Origins configuration
   */
  origins?: Array<{
    type?: string
    pathPattern?: string
    domainName?: string
    originId?: string
  }>
  /**
   * Edge functions for Lambda@Edge
   */
  edgeFunctions?: Array<{
    eventType?: string
    functionArn?: string
    name?: string
  }>
}

/**
 * Lambda trigger configuration for SQS queues
 */
export interface QueueLambdaTrigger {
  /**
   * Name of the Lambda function to trigger (references functions config)
   * @example 'processOrders' - references infrastructure.functions.processOrders
   */
  functionName: string

  /**
   * Number of messages to process in each batch
   * @default 10
   */
  batchSize?: number

  /**
   * Maximum time to gather messages before invoking (0-300 seconds)
   * Helps reduce Lambda invocations for low-traffic queues
   * @default 0
   */
  batchWindow?: number

  /**
   * Enable partial batch responses (report individual failures)
   * @default true
   */
  reportBatchItemFailures?: boolean

  /**
   * Maximum concurrency for Lambda invocations (2-1000)
   * Limits how many concurrent Lambda instances process this queue
   */
  maxConcurrency?: number

  /**
   * Filter pattern to selectively process messages
   * @example { body: { type: ['order'] } }
   */
  filterPattern?: Record<string, unknown>
}

/**
 * CloudWatch alarm configuration for SQS queues
 */
export interface QueueAlarms {
  /**
   * Enable all default alarms
   * @default false
   */
  enabled?: boolean

  /**
   * Alarm when queue depth exceeds this threshold
   * @default 1000
   */
  queueDepthThreshold?: number

  /**
   * Alarm when oldest message age exceeds this (in seconds)
   * @default 3600 (1 hour)
   */
  messageAgeThreshold?: number

  /**
   * Alarm when DLQ has any messages
   * @default true when deadLetterQueue is enabled
   */
  dlqAlarm?: boolean

  /**
   * SNS topic ARN for alarm notifications
   */
  notificationTopicArn?: string

  /**
   * Email addresses to notify (creates SNS topic automatically)
   */
  notificationEmails?: string[]
}

/**
 * SNS subscription configuration for SQS queues
 */
export interface QueueSnsSubscription {
  /**
   * SNS topic ARN to subscribe to
   */
  topicArn?: string

  /**
   * SNS topic name (references infrastructure or creates new)
   */
  topicName?: string

  /**
   * Filter policy for selective message delivery
   * @example { eventType: ['order.created', 'order.updated'] }
   */
  filterPolicy?: Record<string, string[]>

  /**
   * Apply filter to message attributes (default) or body
   * @default 'MessageAttributes'
   */
  filterPolicyScope?: 'MessageAttributes' | 'MessageBody'

  /**
   * Enable raw message delivery (no SNS envelope)
   * @default false
   */
  rawMessageDelivery?: boolean
}

/**
 * Queue (SQS) Configuration
 * Defines message queue settings for async processing
 *
 * @example Standard queue with Lambda trigger
 * queues: {
 *   orders: {
 *     visibilityTimeout: 60,
 *     deadLetterQueue: true,
 *     trigger: {
 *       functionName: 'processOrders',
 *       batchSize: 10,
 *     },
 *   }
 * }
 *
 * @example FIFO queue with alarms
 * queues: {
 *   transactions: {
 *     fifo: true,
 *     contentBasedDeduplication: true,
 *     alarms: {
 *       enabled: true,
 *       queueDepthThreshold: 500,
 *       notificationEmails: ['ops@example.com'],
 *     },
 *   }
 * }
 *
 * @example Queue subscribed to SNS topic
 * queues: {
 *   notifications: {
 *     subscribe: {
 *       topicArn: 'arn:aws:sns:us-east-1:123456789:events',
 *       filterPolicy: { eventType: ['user.created'] },
 *     },
 *   }
 * }
 */
export interface QueueItemConfig {
  /**
   * Enable FIFO (First-In-First-Out) queue
   * FIFO queues guarantee message ordering and exactly-once processing
   * @default false
   */
  fifo?: boolean

  /**
   * Time (in seconds) a message is invisible after being received
   * Should be long enough for your consumer to process the message
   * @default 30
   */
  visibilityTimeout?: number

  /**
   * Time (in seconds) messages are retained in the queue
   * Valid range: 60 (1 minute) to 1209600 (14 days)
   * @default 345600 (4 days)
   */
  messageRetentionPeriod?: number

  /**
   * Time (in seconds) to delay message delivery
   * Useful for scheduling or rate limiting
   * Valid range: 0 to 900 (15 minutes)
   * @default 0
   */
  delaySeconds?: number

  /**
   * Maximum message size in bytes
   * Valid range: 1024 (1 KB) to 262144 (256 KB)
   * @default 262144 (256 KB)
   */
  maxMessageSize?: number

  /**
   * Time (in seconds) to wait for messages when polling
   * Use 1-20 for long polling (recommended), 0 for short polling
   * Long polling reduces costs and improves responsiveness
   * @default 0
   */
  receiveMessageWaitTime?: number

  /**
   * Enable dead letter queue for failed messages
   * Messages that fail processing will be moved to a DLQ
   * @default false
   */
  deadLetterQueue?: boolean

  /**
   * Number of times a message can be received before going to DLQ
   * Only used when deadLetterQueue is true
   * @default 3
   */
  maxReceiveCount?: number

  /**
   * Enable content-based deduplication (FIFO queues only)
   * Uses SHA-256 hash of message body as deduplication ID
   * @default false
   */
  contentBasedDeduplication?: boolean

  /**
   * Enable server-side encryption
   * @default true
   */
  encrypted?: boolean

  /**
   * Custom KMS key ID for encryption
   * If not specified, uses AWS managed key
   */
  kmsKeyId?: string

  /**
   * Lambda function trigger configuration
   * Automatically invokes a Lambda when messages arrive
   *
   * @example
   * trigger: {
   *   functionName: 'processOrders',
   *   batchSize: 10,
   *   batchWindow: 30,
   * }
   */
  trigger?: QueueLambdaTrigger

  /**
   * CloudWatch alarms for queue monitoring
   * Creates alarms for queue depth, message age, and DLQ
   *
   * @example
   * alarms: {
   *   enabled: true,
   *   queueDepthThreshold: 500,
   *   notificationEmails: ['ops@example.com'],
   * }
   */
  alarms?: QueueAlarms

  /**
   * Subscribe this queue to an SNS topic
   * Enables fan-out patterns where one message reaches multiple queues
   *
   * @example
   * subscribe: {
   *   topicArn: 'arn:aws:sns:us-east-1:123456789:events',
   *   filterPolicy: { eventType: ['order.created'] },
   * }
   */
  subscribe?: QueueSnsSubscription

  /**
   * Custom tags for the queue
   * Useful for cost allocation and organization
   */
  tags?: Record<string, string>
}

/**
 * Queue configuration presets for common use cases
 * Use these to quickly configure queues with sensible defaults
 *
 * @example Basic usage
 * import { QueuePresets } from '@ts-cloud/types'
 *
 * queues: {
 *   jobs: QueuePresets.backgroundJobs,
 *   orders: QueuePresets.fifo,
 *   events: QueuePresets.highThroughput,
 * }
 *
 * @example With Lambda trigger
 * queues: {
 *   orders: {
 *     ...QueuePresets.backgroundJobs,
 *     trigger: { functionName: 'processOrders' },
 *   },
 * }
 *
 * @example With monitoring
 * queues: {
 *   critical: {
 *     ...QueuePresets.monitored,
 *     alarms: {
 *       ...QueuePresets.monitored.alarms,
 *       notificationEmails: ['ops@example.com'],
 *     },
 *   },
 * }
 */
export const QueuePresets: {
  backgroundJobs: QueueItemConfig
  fifo: QueueItemConfig
  highThroughput: QueueItemConfig
  delayed: QueueItemConfig
  longRunning: QueueItemConfig
  monitored: QueueItemConfig
  lambdaOptimized: QueueItemConfig
  fanOut: QueueItemConfig
} = {
  /**
   * Background job queue with dead letter support
   * Good for: async tasks, email sending, file processing
   */
  backgroundJobs: {
    visibilityTimeout: 120,
    messageRetentionPeriod: 604800, // 7 days
    deadLetterQueue: true,
    maxReceiveCount: 3,
    encrypted: true,
  },

  /**
   * FIFO queue for ordered, exactly-once processing
   * Good for: financial transactions, order processing
   */
  fifo: {
    fifo: true,
    contentBasedDeduplication: true,
    visibilityTimeout: 30,
    encrypted: true,
  },

  /**
   * High-throughput queue with long polling
   * Good for: event streaming, real-time processing
   */
  highThroughput: {
    visibilityTimeout: 30,
    receiveMessageWaitTime: 20,
    encrypted: true,
  },

  /**
   * Delayed queue for scheduled messages
   * Good for: scheduled tasks, rate limiting
   */
  delayed: {
    delaySeconds: 60,
    visibilityTimeout: 60,
    encrypted: true,
  },

  /**
   * Long-running task queue
   * Good for: video processing, ML inference, batch jobs
   */
  longRunning: {
    visibilityTimeout: 900, // 15 minutes
    messageRetentionPeriod: 1209600, // 14 days
    deadLetterQueue: true,
    maxReceiveCount: 2,
    encrypted: true,
  },

  /**
   * Production queue with full monitoring
   * Good for: critical workloads requiring observability
   */
  monitored: {
    visibilityTimeout: 60,
    messageRetentionPeriod: 604800, // 7 days
    deadLetterQueue: true,
    maxReceiveCount: 3,
    encrypted: true,
    alarms: {
      enabled: true,
      queueDepthThreshold: 1000,
      messageAgeThreshold: 3600,
      dlqAlarm: true,
    },
  },

  /**
   * Event-driven queue optimized for Lambda processing
   * Good for: serverless event processing, webhooks
   */
  lambdaOptimized: {
    visibilityTimeout: 360, // 6x default Lambda timeout
    receiveMessageWaitTime: 20,
    deadLetterQueue: true,
    maxReceiveCount: 3,
    encrypted: true,
  },

  /**
   * Fan-out queue for SNS integration
   * Good for: pub/sub patterns, multi-consumer scenarios
   */
  fanOut: {
    visibilityTimeout: 30,
    receiveMessageWaitTime: 20,
    encrypted: true,
  },
}

// ============================================================================
// Realtime (WebSocket) Configuration
// Laravel Echo / Pusher-compatible broadcasting for Stacks.js
// Supports both serverless (API Gateway) and server (ts-broadcasting) modes
// ============================================================================

/**
 * Realtime deployment mode
 * - 'serverless': Uses API Gateway WebSocket + Lambda (auto-scales, pay-per-use)
 * - 'server': Uses ts-broadcasting Bun WebSocket server on EC2/ECS (lowest latency)
 */
export type RealtimeMode = 'serverless' | 'server'

/**
 * Server mode configuration (ts-broadcasting)
 * High-performance Bun WebSocket server for EC2/ECS deployments
 */
export interface RealtimeServerConfig {
  /**
   * Server host binding
   * @default '0.0.0.0'
   */
  host?: string

  /**
   * Server port
   * @default 6001
   */
  port?: number

  /**
   * WebSocket scheme
   * @default 'wss' in production, 'ws' in development
   */
  scheme?: 'ws' | 'wss'

  /**
   * Driver to use
   * @default 'bun'
   */
  driver?: 'bun' | 'reverb' | 'pusher' | 'ably'

  /**
   * Idle connection timeout in seconds
   * @default 120
   */
  idleTimeout?: number

  /**
   * Maximum message payload size in bytes
   * @default 16777216 (16 MB)
   */
  maxPayloadLength?: number

  /**
   * Backpressure limit in bytes
   * @default 1048576 (1 MB)
   */
  backpressureLimit?: number

  /**
   * Close connection when backpressure limit is reached
   * @default false
   */
  closeOnBackpressureLimit?: boolean

  /**
   * Send WebSocket ping frames
   * @default true
   */
  sendPings?: boolean

  /**
   * Enable per-message deflate compression
   * @default true
   */
  perMessageDeflate?: boolean

  /**
   * Redis configuration for horizontal scaling
   * Enables multiple server instances to share state
   */
  redis?: RealtimeRedisConfig

  /**
   * Rate limiting configuration
   */
  rateLimit?: RealtimeRateLimitConfig

  /**
   * Message encryption configuration
   */
  encryption?: RealtimeEncryptionConfig

  /**
   * Webhook notifications configuration
   */
  webhooks?: RealtimeWebhooksConfig

  /**
   * Queue configuration for background jobs
   */
  queue?: RealtimeQueueConfig

  /**
   * Load management configuration
   */
  loadManagement?: RealtimeLoadConfig

  /**
   * Prometheus metrics endpoint
   * @default false
   */
  metrics?: boolean | {
    enabled: boolean
    path?: string
  }

  /**
   * Health check endpoint path
   * @default '/health'
   */
  healthCheckPath?: string

  /**
   * Number of server instances to run
   * Used when deploying to EC2/ECS
   * @default 1
   */
  instances?: number

  /**
   * Auto-scaling configuration for EC2/ECS
   */
  autoScaling?: {
    min?: number
    max?: number
    targetCPU?: number
    targetConnections?: number
  }
}

/**
 * Redis configuration for ts-broadcasting horizontal scaling
 */
export interface RealtimeRedisConfig {
  /**
   * Enable Redis adapter
   * @default false
   */
  enabled?: boolean

  /**
   * Redis host
   * @default 'localhost'
   */
  host?: string

  /**
   * Redis port
   * @default 6379
   */
  port?: number

  /**
   * Redis password
   */
  password?: string

  /**
   * Redis database number
   * @default 0
   */
  database?: number

  /**
   * Redis connection URL (overrides host/port)
   * @example 'redis://user:pass@localhost:6379/0'
   */
  url?: string

  /**
   * Key prefix for Redis keys
   * @default 'broadcasting:'
   */
  keyPrefix?: string

  /**
   * Use existing ElastiCache from cache config
   * References infrastructure.cache
   */
  useElastiCache?: boolean
}

/**
 * Rate limiting for WebSocket connections
 */
export interface RealtimeRateLimitConfig {
  /**
   * Enable rate limiting
   * @default true
   */
  enabled?: boolean

  /**
   * Maximum messages per window
   * @default 100
   */
  max?: number

  /**
   * Time window in milliseconds
   * @default 60000 (1 minute)
   */
  window?: number

  /**
   * Apply rate limit per channel
   * @default true
   */
  perChannel?: boolean

  /**
   * Apply rate limit per user
   * @default true
   */
  perUser?: boolean
}

/**
 * Message encryption configuration
 */
export interface RealtimeEncryptionConfig {
  /**
   * Enable message encryption
   * @default false
   */
  enabled?: boolean

  /**
   * Encryption algorithm
   * @default 'aes-256-gcm'
   */
  algorithm?: 'aes-256-gcm' | 'aes-128-gcm'

  /**
   * Key rotation interval in milliseconds
   * @default 86400000 (24 hours)
   */
  keyRotationInterval?: number
}

/**
 * Webhook notifications for realtime events
 */
export interface RealtimeWebhooksConfig {
  /**
   * Enable webhooks
   * @default false
   */
  enabled?: boolean

  /**
   * Webhook endpoints for different events
   */
  endpoints?: {
    /**
     * Called when a client connects
     */
    connection?: string

    /**
     * Called when a client subscribes to a channel
     */
    subscribe?: string

    /**
     * Called when a client unsubscribes
     */
    unsubscribe?: string

    /**
     * Called when a client disconnects
     */
    disconnect?: string

    /**
     * Custom event webhooks
     */
    [event: string]: string | undefined
  }
}

/**
 * Queue configuration for background broadcasting
 */
export interface RealtimeQueueConfig {
  /**
   * Enable queue for broadcast operations
   * @default false
   */
  enabled?: boolean

  /**
   * Default queue name
   * @default 'broadcasts'
   */
  defaultQueue?: string

  /**
   * Retry configuration
   */
  retry?: {
    attempts?: number
    backoff?: {
      type: 'fixed' | 'exponential'
      delay: number
    }
  }

  /**
   * Dead letter queue for failed broadcasts
   */
  deadLetter?: {
    enabled?: boolean
    maxRetries?: number
  }
}

/**
 * Load management for server mode
 */
export interface RealtimeLoadConfig {
  /**
   * Enable load management
   * @default true
   */
  enabled?: boolean

  /**
   * Maximum concurrent connections
   * @default 10000
   */
  maxConnections?: number

  /**
   * Maximum subscriptions per connection
   * @default 100
   */
  maxSubscriptionsPerConnection?: number

  /**
   * CPU threshold to start shedding load (0-1)
   * @default 0.8
   */
  shedLoadThreshold?: number
}

/**
 * Channel authorization configuration
 */
export interface RealtimeChannelAuth {
  /**
   * Lambda function name for channel authorization
   * Called when clients join private/presence channels
   * @example 'authorizeChannel'
   */
  functionName?: string

  /**
   * Authorization endpoint URL (if using external auth)
   * @example 'https://api.example.com/broadcasting/auth'
   */
  endpoint?: string

  /**
   * JWT secret for token validation
   * Can reference Secrets Manager: '{{resolve:secretsmanager:my-secret}}'
   */
  jwtSecret?: string

  /**
   * Token expiration time in seconds
   * @default 3600
   */
  tokenExpiration?: number
}

/**
 * Presence channel configuration
 */
export interface RealtimePresenceConfig {
  /**
   * Enable presence channels (who's online)
   * @default true
   */
  enabled?: boolean

  /**
   * Maximum members per presence channel
   * @default 100
   */
  maxMembers?: number

  /**
   * How often to send presence heartbeats (seconds)
   * @default 30
   */
  heartbeatInterval?: number

  /**
   * Time before considering a member offline (seconds)
   * @default 60
   */
  inactivityTimeout?: number
}

/**
 * Connection storage configuration
 */
export interface RealtimeStorageConfig {
  /**
   * Storage type for connection management
   * - 'dynamodb': DynamoDB tables (recommended, auto-scales)
   * - 'elasticache': Redis cluster (lowest latency)
   * @default 'dynamodb'
   */
  type?: 'dynamodb' | 'elasticache'

  /**
   * DynamoDB table configuration
   */
  dynamodb?: {
    /**
     * Billing mode for DynamoDB
     * @default 'PAY_PER_REQUEST'
     */
    billingMode?: 'PAY_PER_REQUEST' | 'PROVISIONED'

    /**
     * Read capacity units (only for PROVISIONED)
     * @default 5
     */
    readCapacity?: number

    /**
     * Write capacity units (only for PROVISIONED)
     * @default 5
     */
    writeCapacity?: number

    /**
     * Enable point-in-time recovery
     * @default false
     */
    pointInTimeRecovery?: boolean

    /**
     * TTL for connection records (seconds)
     * @default 86400 (24 hours)
     */
    connectionTTL?: number
  }

  /**
   * ElastiCache configuration (if using Redis)
   */
  elasticache?: {
    /**
     * Node type for Redis cluster
     * @default 'cache.t3.micro'
     */
    nodeType?: string

    /**
     * Number of cache nodes
     * @default 1
     */
    numNodes?: number
  }
}

/**
 * WebSocket scaling configuration
 */
export interface RealtimeScalingConfig {
  /**
   * Maximum concurrent connections
   * @default 10000
   */
  maxConnections?: number

  /**
   * Message throughput limit per second
   * @default 1000
   */
  messagesPerSecond?: number

  /**
   * Lambda memory for WebSocket handlers (MB)
   * @default 256
   */
  handlerMemory?: number

  /**
   * Lambda timeout for WebSocket handlers (seconds)
   * @default 30
   */
  handlerTimeout?: number

  /**
   * Enable Lambda provisioned concurrency for low latency
   */
  provisionedConcurrency?: number
}

/**
 * Realtime monitoring and alarms
 */
export interface RealtimeMonitoringConfig {
  /**
   * Enable CloudWatch alarms
   * @default false
   */
  enabled?: boolean

  /**
   * Alert when concurrent connections exceed threshold
   * @default 8000
   */
  connectionThreshold?: number

  /**
   * Alert when message errors exceed threshold per minute
   * @default 100
   */
  errorThreshold?: number

  /**
   * Alert when latency exceeds threshold (ms)
   * @default 1000
   */
  latencyThreshold?: number

  /**
   * SNS topic ARN for alarm notifications
   */
  notificationTopicArn?: string

  /**
   * Email addresses for alarm notifications
   */
  notificationEmails?: string[]
}

/**
 * Realtime event hooks
 */
export interface RealtimeHooksConfig {
  /**
   * Lambda function called on new connections
   * Receives: { connectionId, requestContext }
   */
  onConnect?: string

  /**
   * Lambda function called on disconnections
   * Receives: { connectionId, requestContext }
   */
  onDisconnect?: string

  /**
   * Lambda function called for incoming messages
   * Receives: { connectionId, body, requestContext }
   */
  onMessage?: string

  /**
   * Lambda function called when clients subscribe to channels
   * Receives: { connectionId, channel, auth }
   */
  onSubscribe?: string

  /**
   * Lambda function called when clients unsubscribe
   * Receives: { connectionId, channel }
   */
  onUnsubscribe?: string
}

/**
 * Realtime (WebSocket) Configuration
 * Provides Laravel Echo / Pusher-compatible broadcasting
 *
 * @example Serverless mode (API Gateway WebSocket)
 * realtime: {
 *   enabled: true,
 *   mode: 'serverless',
 *   channels: { public: true, private: true, presence: true },
 * }
 *
 * @example Server mode (ts-broadcasting on EC2/ECS)
 * realtime: {
 *   enabled: true,
 *   mode: 'server',
 *   server: {
 *     port: 6001,
 *     redis: { enabled: true, host: 'redis.example.com' },
 *     rateLimit: { max: 100, window: 60000 },
 *   },
 * }
 *
 * @example Production server mode with clustering
 * realtime: {
 *   enabled: true,
 *   mode: 'server',
 *   server: {
 *     port: 6001,
 *     instances: 3,
 *     redis: { enabled: true, useElastiCache: true },
 *     autoScaling: { min: 2, max: 10, targetCPU: 70 },
 *     metrics: true,
 *   },
 *   channels: { public: true, private: true, presence: true },
 * }
 *
 * @example Integration with Stacks.js
 * // In your Stacks app:
 * import { Broadcast } from '@stacksjs/broadcast'
 *
 * // Broadcast to a channel
 * Broadcast.channel('orders').emit('order.created', { id: 123 })
 *
 * // Client-side (similar to Laravel Echo)
 * Echo.channel('orders').listen('order.created', (e) => {
 *   console.log('New order:', e.id)
 * })
 *
 * // Private channel
 * Echo.private(`user.${userId}`).listen('notification', (e) => {
 *   console.log('Private notification:', e)
 * })
 *
 * // Presence channel
 * Echo.join('chat-room')
 *   .here((users) => console.log('Online:', users))
 *   .joining((user) => console.log('Joined:', user))
 *   .leaving((user) => console.log('Left:', user))
 */
export interface RealtimeConfig {
  /**
   * Enable realtime/WebSocket support
   * @default false
   */
  enabled?: boolean

  /**
   * Deployment mode
   * - 'serverless': API Gateway WebSocket + Lambda (auto-scales, pay-per-use)
   * - 'server': ts-broadcasting Bun WebSocket on EC2/ECS (lowest latency)
   * @default 'serverless'
   */
  mode?: RealtimeMode

  /**
   * Custom WebSocket API/server name
   */
  name?: string

  /**
   * Server mode configuration (ts-broadcasting)
   * Only used when mode is 'server'
   */
  server?: RealtimeServerConfig

  /**
   * Channel configuration
   */
  channels?: {
    /**
     * Enable public channels (no auth required)
     * @default true
     */
    public?: boolean

    /**
     * Enable private channels (requires auth)
     * @default true
     */
    private?: boolean

    /**
     * Enable presence channels (track online users)
     * @default false
     */
    presence?: boolean | RealtimePresenceConfig
  }

  /**
   * Channel authorization configuration
   */
  auth?: RealtimeChannelAuth

  /**
   * Connection storage configuration
   */
  storage?: RealtimeStorageConfig

  /**
   * Scaling configuration
   */
  scaling?: RealtimeScalingConfig

  /**
   * Monitoring and alarms
   */
  monitoring?: RealtimeMonitoringConfig

  /**
   * Event hooks (Lambda functions)
   */
  hooks?: RealtimeHooksConfig

  /**
   * Custom domain for WebSocket endpoint
   * @example 'ws.example.com'
   */
  customDomain?: string

  /**
   * ACM certificate ARN for custom domain
   */
  certificateArn?: string

  /**
   * Enable connection keep-alive pings
   * @default true
   */
  keepAlive?: boolean

  /**
   * Keep-alive interval in seconds
   * @default 30
   */
  keepAliveInterval?: number

  /**
   * Idle connection timeout in seconds
   * @default 600 (10 minutes)
   */
  idleTimeout?: number

  /**
   * Maximum message size in bytes
   * @default 32768 (32 KB)
   */
  maxMessageSize?: number

  /**
   * Enable message compression
   * @default false
   */
  compression?: boolean

  /**
   * Custom tags for all realtime resources
   */
  tags?: Record<string, string>
}

/**
 * Realtime configuration presets
 *
 * @example Serverless presets
 * import { RealtimePresets } from '@ts-cloud/types'
 * realtime: RealtimePresets.serverless.production
 *
 * @example Server presets (ts-broadcasting)
 * realtime: RealtimePresets.server.production
 */
export const RealtimePresets: {
  serverless: {
    development: RealtimeConfig
    production: RealtimeConfig
    notifications: RealtimeConfig
  }
  server: {
    development: RealtimeConfig
    production: RealtimeConfig
    highPerformance: RealtimeConfig
    chat: RealtimeConfig
    gaming: RealtimeConfig
    single: RealtimeConfig
  }
} = {
  // ============================================
  // SERVERLESS MODE PRESETS (API Gateway WebSocket)
  // ============================================
  serverless: {
    /**
     * Development preset - minimal resources
     */
    development: {
      enabled: true,
      mode: 'serverless',
      channels: {
        public: true,
        private: true,
        presence: true,
      },
      storage: {
        type: 'dynamodb',
        dynamodb: { billingMode: 'PAY_PER_REQUEST' },
      },
      scaling: {
        maxConnections: 1000,
        handlerMemory: 128,
      },
    },

    /**
     * Production preset - scalable with monitoring
     */
    production: {
      enabled: true,
      mode: 'serverless',
      channels: {
        public: true,
        private: true,
        presence: {
          enabled: true,
          maxMembers: 100,
          heartbeatInterval: 30,
          inactivityTimeout: 60,
        },
      },
      storage: {
        type: 'dynamodb',
        dynamodb: {
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: true,
          connectionTTL: 86400,
        },
      },
      scaling: {
        maxConnections: 50000,
        messagesPerSecond: 5000,
        handlerMemory: 256,
        handlerTimeout: 30,
      },
      monitoring: {
        enabled: true,
        connectionThreshold: 40000,
        errorThreshold: 100,
        latencyThreshold: 500,
      },
      keepAlive: true,
      keepAliveInterval: 30,
      idleTimeout: 600,
    },

    /**
     * Notifications only preset - no presence
     */
    notifications: {
      enabled: true,
      mode: 'serverless',
      channels: {
        public: false,
        private: true,
        presence: false,
      },
      storage: {
        type: 'dynamodb',
        dynamodb: { billingMode: 'PAY_PER_REQUEST' },
      },
      scaling: {
        maxConnections: 50000,
        messagesPerSecond: 2000,
        handlerMemory: 128,
      },
      keepAlive: true,
      keepAliveInterval: 60,
      idleTimeout: 1800,
    },
  },

  // ============================================
  // SERVER MODE PRESETS (ts-broadcasting / Bun)
  // ============================================
  server: {
    /**
     * Development preset - single server, no clustering
     */
    development: {
      enabled: true,
      mode: 'server',
      channels: {
        public: true,
        private: true,
        presence: true,
      },
      server: {
        host: '0.0.0.0',
        port: 6001,
        scheme: 'ws',
        driver: 'bun',
        idleTimeout: 120,
        perMessageDeflate: false, // Faster in dev
        metrics: false,
      },
    },

    /**
     * Production preset - clustered with Redis
     */
    production: {
      enabled: true,
      mode: 'server',
      channels: {
        public: true,
        private: true,
        presence: true,
      },
      server: {
        host: '0.0.0.0',
        port: 6001,
        scheme: 'wss',
        driver: 'bun',
        idleTimeout: 120,
        maxPayloadLength: 16 * 1024 * 1024, // 16 MB
        backpressureLimit: 1024 * 1024, // 1 MB
        sendPings: true,
        perMessageDeflate: true,
        instances: 2,
        redis: {
          enabled: true,
          keyPrefix: 'broadcasting:',
        },
        rateLimit: {
          enabled: true,
          max: 100,
          window: 60000,
          perChannel: true,
          perUser: true,
        },
        loadManagement: {
          enabled: true,
          maxConnections: 10000,
          maxSubscriptionsPerConnection: 100,
          shedLoadThreshold: 0.8,
        },
        metrics: true,
        autoScaling: {
          min: 2,
          max: 10,
          targetCPU: 70,
        },
      },
      monitoring: {
        enabled: true,
        connectionThreshold: 8000,
        errorThreshold: 100,
      },
    },

    /**
     * High-performance preset - optimized for lowest latency
     */
    highPerformance: {
      enabled: true,
      mode: 'server',
      channels: {
        public: true,
        private: true,
        presence: true,
      },
      server: {
        host: '0.0.0.0',
        port: 6001,
        scheme: 'wss',
        driver: 'bun',
        idleTimeout: 60,
        maxPayloadLength: 8 * 1024 * 1024, // 8 MB
        backpressureLimit: 2 * 1024 * 1024, // 2 MB
        closeOnBackpressureLimit: true,
        sendPings: true,
        perMessageDeflate: true,
        instances: 4,
        redis: {
          enabled: true,
          useElastiCache: true,
          keyPrefix: 'rt:',
        },
        rateLimit: {
          enabled: true,
          max: 200,
          window: 60000,
          perChannel: true,
        },
        loadManagement: {
          enabled: true,
          maxConnections: 25000,
          maxSubscriptionsPerConnection: 50,
          shedLoadThreshold: 0.7,
        },
        metrics: { enabled: true, path: '/metrics' },
        autoScaling: {
          min: 4,
          max: 20,
          targetCPU: 60,
          targetConnections: 20000,
        },
      },
      monitoring: {
        enabled: true,
        connectionThreshold: 80000,
        errorThreshold: 50,
        latencyThreshold: 50,
      },
    },

    /**
     * Chat application preset - optimized for presence and typing indicators
     */
    chat: {
      enabled: true,
      mode: 'server',
      channels: {
        public: true,
        private: true,
        presence: {
          enabled: true,
          maxMembers: 200,
          heartbeatInterval: 20,
          inactivityTimeout: 60,
        },
      },
      server: {
        host: '0.0.0.0',
        port: 6001,
        scheme: 'wss',
        driver: 'bun',
        idleTimeout: 300, // 5 minutes for chat
        maxPayloadLength: 1024 * 1024, // 1 MB (smaller for chat)
        sendPings: true,
        perMessageDeflate: true,
        instances: 2,
        redis: {
          enabled: true,
          keyPrefix: 'chat:',
        },
        rateLimit: {
          enabled: true,
          max: 60, // 1 message per second
          window: 60000,
          perChannel: true,
        },
        loadManagement: {
          enabled: true,
          maxConnections: 15000,
          maxSubscriptionsPerConnection: 20,
        },
        metrics: true,
      },
      keepAlive: true,
      keepAliveInterval: 25,
      idleTimeout: 900,
    },

    /**
     * Gaming/real-time app preset - ultra-low latency
     */
    gaming: {
      enabled: true,
      mode: 'server',
      channels: {
        public: true,
        private: true,
        presence: {
          enabled: true,
          maxMembers: 100,
          heartbeatInterval: 10,
          inactivityTimeout: 30,
        },
      },
      server: {
        host: '0.0.0.0',
        port: 6001,
        scheme: 'wss',
        driver: 'bun',
        idleTimeout: 30,
        maxPayloadLength: 64 * 1024, // 64 KB (small, fast messages)
        backpressureLimit: 512 * 1024, // 512 KB
        closeOnBackpressureLimit: true,
        sendPings: true,
        perMessageDeflate: false, // Disable for lowest latency
        instances: 4,
        redis: {
          enabled: true,
          useElastiCache: true,
        },
        rateLimit: {
          enabled: true,
          max: 120, // 2 messages per second
          window: 60000,
        },
        loadManagement: {
          enabled: true,
          maxConnections: 5000,
          maxSubscriptionsPerConnection: 10,
          shedLoadThreshold: 0.6,
        },
        metrics: true,
        autoScaling: {
          min: 4,
          max: 16,
          targetCPU: 50,
        },
      },
      keepAlive: true,
      keepAliveInterval: 10,
      idleTimeout: 60,
    },

    /**
     * Single server preset - no clustering, simple setup
     */
    single: {
      enabled: true,
      mode: 'server',
      channels: {
        public: true,
        private: true,
        presence: true,
      },
      server: {
        host: '0.0.0.0',
        port: 6001,
        scheme: 'wss',
        driver: 'bun',
        idleTimeout: 120,
        sendPings: true,
        perMessageDeflate: true,
        instances: 1,
        rateLimit: {
          enabled: true,
          max: 100,
          window: 60000,
        },
        loadManagement: {
          enabled: true,
          maxConnections: 10000,
        },
        metrics: true,
      },
    },
  },
}

export interface ApiConfig {
  enabled?: boolean
  name?: string
}

/**
 * Load Balancer Configuration
 * Controls whether and how traffic is load balanced
 */
export interface LoadBalancerConfig {
  /**
   * Enable Application Load Balancer
   * When false, traffic goes directly to EC2 instances
   * @default true for production with SSL
   */
  enabled?: boolean

  /**
   * Load balancer type
   * - 'application': HTTP/HTTPS traffic (ALB)
   * - 'network': TCP/UDP traffic (NLB)
   * @default 'application'
   */
  type?: 'application' | 'network'

  /**
   * Health check configuration
   */
  healthCheck?: {
    path?: string
    interval?: number
    timeout?: number
    healthyThreshold?: number
    unhealthyThreshold?: number
  }

  /**
   * Idle timeout in seconds
   * @default 60
   */
  idleTimeout?: number

  /**
   * Enable access logs
   */
  accessLogs?: {
    enabled?: boolean
    bucket?: string
    prefix?: string
  }
}

/**
 * SSL/TLS Configuration
 * Supports both AWS ACM certificates and Let's Encrypt
 */
export interface SslConfig {
  /**
   * Enable HTTPS
   * @default true for production
   */
  enabled?: boolean

  /**
   * SSL certificate provider
   * - 'acm': AWS Certificate Manager (requires ALB or CloudFront)
   * - 'letsencrypt': Free certificates from Let's Encrypt (works without ALB)
   * @default 'acm' if loadBalancer.enabled, otherwise 'letsencrypt'
   */
  provider?: 'acm' | 'letsencrypt'

  /**
   * ACM certificate ARN (if using ACM)
   * If not provided, a certificate will be automatically requested
   */
  certificateArn?: string

  /**
   * Domain names for the certificate
   * If not provided, uses the primary domain from dns config
   */
  domains?: string[]

  /**
   * Redirect HTTP to HTTPS
   * @default true when SSL is enabled
   */
  redirectHttp?: boolean

  /**
   * Let's Encrypt specific options
   */
  letsEncrypt?: {
    /**
     * Email for Let's Encrypt notifications
     */
    email?: string

    /**
     * Use staging server for testing
     * @default false
     */
    staging?: boolean

    /**
     * Auto-renew certificates
     * @default true
     */
    autoRenew?: boolean
  }
}
