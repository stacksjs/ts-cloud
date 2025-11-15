// Core configuration types
export interface CloudConfig {
  project: ProjectConfig
  mode: DeploymentMode
  environments: Record<string, EnvironmentConfig>
  infrastructure?: InfrastructureConfig
  sites?: Record<string, SiteConfig>
}

export interface ProjectConfig {
  name: string
  slug: string
  region: string
}

export type DeploymentMode = 'server' | 'serverless' | 'hybrid'

export type EnvironmentType = 'production' | 'staging' | 'development'

export interface EnvironmentConfig {
  type: EnvironmentType
  region?: string
  variables?: Record<string, string>
}

export interface InfrastructureConfig {
  vpc?: VpcConfig
  storage?: Record<string, StorageItemConfig>
  functions?: Record<string, FunctionConfig>
  servers?: Record<string, ServerItemConfig>
  databases?: Record<string, DatabaseItemConfig>
  cache?: CacheConfig
  cdn?: Record<string, CdnItemConfig>
  dns?: DnsConfig
  security?: SecurityConfig
  monitoring?: MonitoringConfig
  api?: ApiConfig
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

export interface ComputeConfig {
  mode?: 'server' | 'serverless'
  server?: ServerConfig
  serverless?: ServerlessConfig
}

export interface ServerConfig {
  instanceType?: string
  ami?: string
  autoScaling?: AutoScalingConfig
}

export interface ServerlessConfig {
  cpu?: number
  memory?: number
  desiredCount?: number
}

export interface AutoScalingConfig {
  min?: number
  max?: number
  desired?: number
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

export interface ServerItemConfig {
  instanceType?: string
  ami?: string
  userData?: string
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

export type CloudOptions = Partial<CloudConfig>
