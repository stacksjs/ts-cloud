// Core configuration types
export interface CloudConfig {
  project: ProjectConfig
  mode?: DeploymentMode // Optional - auto-detected from infrastructure config
  environments: Record<string, EnvironmentConfig>
  infrastructure?: InfrastructureConfig
  sites?: Record<string, SiteConfig>

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
   * Environment-specific infrastructure overrides
   * Allows different infrastructure per environment
   * Example: smaller instances in dev, larger in production
   */
  infrastructure?: Partial<InfrastructureConfig>
}

export interface InfrastructureConfig {
  vpc?: VpcConfig

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
  cdn?: Record<string, CdnItemConfig & ResourceConditions>
  dns?: DnsConfig
  security?: SecurityConfig
  monitoring?: MonitoringConfig
  api?: ApiConfig
  loadBalancer?: LoadBalancerConfig
  ssl?: SslConfig
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
  natGateway?: boolean
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
}

export interface WafConfig {
  enabled?: boolean
  blockCountries?: string[]
  blockIps?: string[]
  rateLimit?: number
}

export interface MonitoringConfig {
  alarms?: Record<string, AlarmItemConfig>
  dashboards?: boolean
}

export interface AlarmConfig {
  name: string
  metric: string
  threshold: number
}

export interface AlarmItemConfig {
  metricName: string
  namespace: string
  threshold: number
  comparisonOperator: string
}

export interface StorageItemConfig {
  versioning?: boolean
  encryption?: boolean
  website?: {
    indexDocument?: string
    errorDocument?: string
  }
}

export interface FunctionConfig {
  handler?: string
  runtime?: string
  code?: string
  timeout?: number
  memorySize?: number
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
  partitionKey?: {
    name: string
    type: string
  }
  sortKey?: {
    name: string
    type: string
  }
  username?: string
  password?: string
  storage?: number
  instanceClass?: string
}

export interface CdnItemConfig {
  origin: string
  customDomain?: string
  certificateArn?: string
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
