/**
 * Top-level cloud provider selection
 */
export interface CloudProviderConfig {
  /**
   * Infrastructure provider for compute and related resources.
   * @default 'aws'
   */
  provider?: 'aws' | 'hetzner'
}

/**
 * Object storage provider selection.
 *
 * AWS S3, Backblaze B2 and Hetzner Object Storage are all S3-compatible, so the
 * same client drives any of them — only the endpoint, addressing style and
 * credentials differ. Choose a provider to move object storage (static assets,
 * release artifacts, registry tarballs/binaries) off AWS S3 for cost without
 * touching the rest of the deployment.
 */
export interface ObjectStorageConfig {
  /**
   * Object storage provider.
   * @default 'aws'
   */
  provider?: 'aws' | 'backblaze' | 'hetzner'
  /**
   * Region / location slug. Provider-specific default when omitted
   * (aws: us-east-1, backblaze: us-west-004, hetzner: fsn1).
   */
  region?: string
  /**
   * Endpoint host override (no scheme), e.g. `s3.us-west-004.backblazeb2.com`.
   * Defaults to the provider's standard endpoint for the region.
   */
  endpoint?: string
  /**
   * Force path-style addressing (bucket in the path) instead of virtual-hosted.
   * @default false
   */
  forcePathStyle?: boolean
}

/**
 * Hetzner Cloud configuration
 */
export interface HetznerConfig {
  /** Hetzner Cloud API token (falls back to HCLOUD_TOKEN / HETZNER_API_TOKEN) */
  apiToken?: string
  /** Location slug, e.g. fsn1, nbg1, hel1 @default 'fsn1' */
  location?: string
  /** Server image slug @default 'ubuntu-24.04' */
  image?: string
  /** Path to SSH private key used for deploy commands @default ~/.ssh/id_ed25519 */
  sshPrivateKeyPath?: string
  /** SSH user for deploy commands @default 'root' */
  sshUser?: string
}

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
   * Notification channels for deploy, SSL, health-check, and backup events
   * (Slack, Discord, Telegram, email, generic webhook). Project-wide default;
   * a site may override via {@link SiteConfig.notifications}.
   */
  notifications?: NotificationsConfig

  /**
   * AWS-specific configuration
   */
  aws?: AwsConfig

  /**
   * Cloud provider selection (AWS, Hetzner, …)
   */
  cloud?: CloudProviderConfig

  /**
   * Hetzner Cloud configuration (when cloud.provider is 'hetzner')
   */
  hetzner?: HetznerConfig

  /**
   * Object storage provider selection (AWS S3, Backblaze B2, Hetzner Object Storage).
   * Independent of `cloud.provider` — you can run compute on AWS while keeping
   * object storage on Backblaze, for example.
   */
  objectStorage?: ObjectStorageConfig

  /**
   * Feature flags to enable/disable resources conditionally
   * Example: { enableCache: true, enableMonitoring: false }
   */
  features?: Record<string, boolean>

  /**
   * Deployment hooks for custom logic
   */
  hooks?: {
    beforeDeploy?: string | ((_config: CloudConfig) => Promise<void>)
    afterDeploy?: string | ((_config: CloudConfig) => Promise<void>)
    beforeBuild?: string | ((_config: CloudConfig) => Promise<void>)
    afterBuild?: string | ((_config: CloudConfig) => Promise<void>)
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
  /**
   * Override the main CloudFormation stack name.
   * Default: `{slug}-{environment}` (e.g. `pantry-production`).
   */
  stackName?: string
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
  /**
   * Serverless application manifest (Laravel-Vapor-equivalent). Defining this opts
   * the environment into the serverless app deploy pipeline: one codebase deployed
   * as http/queue/cli Lambda functions with assets, hooks, and atomic activation.
   * @see ServerlessAppConfig
   */
  app?: ServerlessAppConfig
}

/**
 * Network/VPC configuration
 */
export interface NetworkConfig {
  cidr?: string
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
  /**
   * When false, `cloud deploy` skips the main CloudFormation stack and only runs
   * site deploys, compute sync, and hooks. Use when infrastructure is managed
   * elsewhere (e.g. registry EC2 via SSH) but site CDN/S3 still uses ts-cloud.
   */
  deployStack?: boolean

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

  /**
   * Container configuration (ECS Fargate)
   * Defines containerized services for serverless deployment mode
   *
   * @example
   * containers: {
   *   api: {
   *     cpu: 512,
   *     memory: 1024,
   *     port: 3000,
   *     healthCheck: '/health',
   *     desiredCount: 2,
   *     autoScaling: { min: 1, max: 10, targetCpuUtilization: 70 },
   *   }
   * }
   */
  containers?: Record<string, ContainerItemConfig>

  storage?: Record<string, StorageItemConfig & ResourceConditions>
  functions?: Record<string, FunctionConfig & ResourceConditions>
  /** @deprecated Use `compute` instead for EC2 configuration */
  servers?: Record<string, ServerItemConfig & ResourceConditions>
  databases?: Record<string, DatabaseItemConfig & ResourceConditions>
  /**
   * Single-database shorthand (Forge-style). Use this for the common case
   * of "I have one app and one database." For multiple named databases,
   * use `databases` (plural) instead.
   *
   * - `'sqlite'`   → installed on the EC2 box, file lives at /var/www/app/data.db
   * - `'mysql'`    → RDS MySQL with sane defaults, DATABASE_URL injected into env
   * - `'postgres'` → RDS Postgres with sane defaults, DATABASE_URL injected into env
   */
  database?: 'sqlite' | 'mysql' | 'postgres'
  /**
   * Application database connection (object form) for the Forge-style on-box /
   * managed database path. Provides the name/user/password that
   * `compute.managedServices` creates on the box, and the `DB_*` values
   * auto-wired into PHP sites' `.env`. Distinct from the {@link database}
   * string shorthand.
   */
  appDatabase?: DatabaseConfig
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

  /**
   * Domain and path redirect configuration
   *
   * Domain redirects create S3 buckets that redirect all traffic to a target domain.
   * Path redirects create CloudFront Functions for URL-level rewrites.
   *
   * @example
   * // Simple domain redirects (redirect these domains to your primary domain)
   * redirects: {
   *   domains: ['www.stacksjs.com', 'stacks.dev'],
   *   target: 'stacksjs.com',
   * }
   *
   * @example
   * // Domain + path redirects
   * redirects: {
   *   domains: ['old-domain.com'],
   *   target: 'new-domain.com',
   *   paths: {
   *     '/old-blog': '/blog',
   *     '/legacy/api': '/api/v2',
   *   },
   * }
   */
  redirects?: RedirectsConfig
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

  /**
   * Jump Box / Bastion Host configuration
   * Provides SSH access to private resources in your VPC
   *
   * Set to `true` for a default jump box, or provide a config object.
   *
   * @example
   * // Simple — default t3.micro jump box
   * jumpBox: true
   *
   * @example
   * // With EFS mount for file access
   * jumpBox: {
   *   enabled: true,
   *   size: 'micro',
   *   mountEfs: true,
   * }
   *
   * @example
   * // Restrict SSH to a specific IP
   * jumpBox: {
   *   enabled: true,
   *   allowedCidrs: ['203.0.113.0/32'],
   * }
   */
  jumpBox?: boolean | JumpBoxConfig

  /**
   * Email (SES) configuration
   * Configures Amazon SES for sending/receiving email
   *
   * @example
   * email: {
   *   domain: 'stacksjs.com',
   *   configurationSet: true,
   * }
   */
  email?: EmailInfraConfig

  /**
   * Search (OpenSearch) configuration
   * Configures an OpenSearch domain for full-text search
   *
   * @example
   * search: {
   *   instanceType: 't3.small.search',
   *   volumeSize: 10,
   * }
   */
  search?: SearchInfraConfig

  /**
   * AI (Bedrock) configuration
   * Configures IAM roles and policies for Amazon Bedrock model access
   *
   * @example
   * ai: {
   *   models: ['anthropic.claude-3-5-sonnet-20241022-v2:0'],
   *   allowStreaming: true,
   * }
   */
  ai?: AIInfraConfig
}

/**
 * Jump Box (Bastion Host) configuration
 */
export interface JumpBoxConfig {
  /**
   * Enable the jump box
   * @default true
   */
  enabled?: boolean

  /**
   * Instance size or direct instance type
   * @default 'micro'
   */
  size?: InstanceSize

  /**
   * SSH key pair name
   */
  keyName?: string

  /**
   * CIDR blocks allowed to SSH into the jump box
   * @default ['0.0.0.0/0']
   */
  allowedCidrs?: string[]

  /**
   * Mount an EFS file system on the jump box
   * Set to `true` to auto-detect from infrastructure.fileSystem, or provide an EFS ID
   */
  mountEfs?: boolean | string

  /**
   * EFS mount path
   * @default '/mnt/efs'
   */
  mountPath?: string

  /**
   * Install database CLI tools (psql, mysql, redis-cli)
   * @default false
   */
  databaseTools?: boolean
}

/**
 * Redirect configuration for domain and path-level redirects
 */
export interface RedirectsConfig {
  /**
   * Source domains to redirect (e.g. 'www.stacksjs.com', 'old-domain.com')
   * Each domain gets an S3 redirect bucket pointing to the target
   */
  domains?: string[]

  /**
   * Target domain all redirects point to
   * @example 'stacksjs.com'
   */
  target?: string

  /**
   * Protocol for the redirect target
   * @default 'https'
   */
  protocol?: 'http' | 'https'

  /**
   * Path-level redirects (CloudFront Function)
   * Keys are source paths, values are target paths
   * @example { '/old-page': '/new-page', '/blog/old-post': '/blog/new-post' }
   */
  paths?: Record<string, string>

  /**
   * Status code for path redirects
   * @default 301
   */
  statusCode?: 301 | 302 | 307 | 308
}

/**
 * Email (SES) infrastructure configuration
 */
export interface EmailInfraConfig {
  /** Domain to verify for sending email */
  domain?: string
  /** Create a SES configuration set for tracking */
  configurationSet?: boolean
  /** Hosted zone ID for DNS records (DKIM, SPF, DMARC) */
  hostedZoneId?: string
  /** DMARC reporting email */
  dmarcReportingEmail?: string
  /** Enable DKIM signing */
  enableDkim?: boolean
  /** DKIM key length */
  dkimKeyLength?: 'RSA_1024_BIT' | 'RSA_2048_BIT'
  /** Inbound email server configuration */
  server?: {
    enabled?: boolean
  }
}

/**
 * Search (OpenSearch) infrastructure configuration
 */
export interface SearchInfraConfig {
  /** OpenSearch engine version */
  engineVersion?: string
  /** Instance type for data nodes */
  instanceType?: string
  /** Number of data node instances */
  instanceCount?: number
  /** EBS volume size in GB */
  volumeSize?: number
  /** EBS volume type */
  volumeType?: 'gp2' | 'gp3' | 'io1'
  /** Enable dedicated master nodes */
  dedicatedMaster?: boolean
  /** Instance type for dedicated master nodes */
  dedicatedMasterType?: string
  /** Number of dedicated master nodes */
  dedicatedMasterCount?: number
  /** Enable multi-AZ deployment */
  multiAz?: boolean
  /** Encryption configuration */
  encryption?: {
    atRest?: boolean
    nodeToNode?: boolean
    kmsKeyId?: string
  }
  /** Fine-grained access control */
  advancedSecurity?: {
    enabled: boolean
    internalUserDatabase?: boolean
    masterUserName?: string
    masterUserPassword?: string
  }
  /** Auto-tune for performance optimization */
  autoTune?: boolean
  /** Deploy inside VPC */
  vpc?: boolean
}

/**
 * AI (Bedrock) infrastructure configuration
 */
export interface AIInfraConfig {
  /** Bedrock model IDs to allow access to (default: ['*'] for all models) */
  models?: string[]
  /** Allow streaming responses */
  allowStreaming?: boolean
  /** Allow async invocation */
  allowAsync?: boolean
  /** Service to grant access: 'ecs', 'ec2', 'lambda', or custom principal */
  service?: 'ecs' | 'ec2' | 'lambda' | string
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

/**
 * Where a {@link SiteConfig} is deployed.
 *
 * - `'bucket'` — the built `root` is uploaded to object storage (AWS S3 /
 *   Hetzner Object Storage) and served via a CDN (CloudFront on AWS). This is
 *   the classic static-site path.
 * - `'server'` — the site lives on the environment's compute server (EC2 /
 *   Hetzner VM). Proxying/TLS for these targets is handled by the operator's
 *   own tooling (e.g. rpx + tlsx), not ts-cloud. A `'server'` site resolves to
 *   one of two kinds depending on whether it declares a `start` command:
 *   - `start` present → a **dynamic app** run as a systemd service.
 *   - no `start` (but a static `root`) → a **static site built and shipped to
 *     the server** (to `/var/www/<site>`), optionally fronted by a CDN.
 *
 * @see resolveSiteDeployTarget for the default inference rules.
 */
export type SiteDeployTarget = 'bucket' | 'server'

/**
 * Per-site caching hint, applicable to either origin (bucket or server).
 *
 * `cdn` expresses the intent to place a CDN in front of the origin — on AWS
 * this reuses the existing CloudFront machinery; on Hetzner (no native CDN)
 * it's advisory only (put CloudFront / Cloudflare / bunny in front of the box
 * yourself). For a `server`-served static site, caching/TLS at the edge is
 * configured by the operator's own proxy (e.g. rpx + tlsx).
 */
export interface SiteCacheConfig {
  /** Emit cache-control headers / enable CDN caching for this site. */
  enabled?: boolean
  /** `max-age` (seconds) used in the emitted `Cache-Control` header. */
  maxAge?: number
  /** Front this origin with a CDN (CloudFront on AWS; advisory on Hetzner). */
  cdn?: boolean
}

export interface SiteConfig {
  /**
   * Directory to deploy.
   *  - For static sites: the built static files to upload to S3 (e.g., 'dist').
   *  - For SSR sites: the build output to tar+ship to EC2 (e.g., '.output').
   */
  root: string
  /** Path prefix for deployment (usually '/') */
  path?: string
  /** Custom domain for the site (e.g., 'stage.easyotc.com') */
  domain?: string
  /**
   * S3 bucket name. Default: `{slug}-{environment}-site` for `main`,
   * else `{slug}-{environment}-{siteKey}`.
   */
  bucket?: string
  /**
   * CloudFormation stack for this site's S3 + CloudFront infrastructure.
   * Default: `{slug}-{environment}-{siteKey}-site` (e.g. `pantry-production-main-site`).
   */
  stackName?: string
  /** SSL certificate ARN (auto-created if not provided) */
  certificateArn?: string
  /** Build command to run before deployment (e.g., 'bun run generate', 'npm run build') */
  build?: string
  /**
   * Path to a shell script to serve at the root URL.
   * Enables `curl -fsSL https://your-domain.com | bash` installs.
   * When set, the script is served as the default document with `text/plain`
   * content type and the URL rewrite function is disabled.
   */
  installScript?: string

  /**
   * Explicit deployment target for this site.
   *
   * When omitted, the target is **inferred** for backward compatibility:
   *  - if `start` is present → `'server'`;
   *  - otherwise → `'bucket'`.
   *
   * An explicit value always wins over the inference. Combined with `start`,
   * this resolves to one of three kinds (see {@link SiteDeployTarget}):
   *  - `'bucket'` → upload built `root` to object storage + CDN;
   *  - `'server'` + `start` → dynamic app as a systemd service;
   *  - `'server'` + no `start` (static `root`) → static site built and shipped
   *    **to the server** (`/var/www/<site>`), with optional CDN caching.
   *
   * Set `deploy: 'server'` (without `start`) to build/serve docs or a blog on an
   * existing compute box instead of a bucket. Set `deploy: 'bucket'` on a site
   * that also declares `start` to force the classic static path.
   */
  deploy?: SiteDeployTarget

  /**
   * Per-site caching hint, used for both bucket and server origins.
   * `cdn` expresses "front this origin with a CDN". For a server-served static
   * site, edge caching/TLS is configured by the operator's own proxy (rpx +
   * tlsx), not ts-cloud.
   */
  cache?: SiteCacheConfig

  /**
   * Whether this site serves a single-page application (client-side routing).
   * Mirrors {@link StorageItemConfig.spa} for the bucket path. For a
   * `server`-served static site, SPA fallback is configured in the operator's
   * own proxy.
   */
  spa?: boolean

  /**
   * URL rewrite style for a static site's extensionless URLs, mirroring
   * {@link StorageItemConfig.pathRewriteStyle}:
   *  - `'directory'` (default): `/guide/get-started` → `/guide/get-started/index.html`
   *  - `'flat'`: `/guide/get-started` → `/guide/get-started.html`
   */
  pathRewriteStyle?: 'directory' | 'flat'

  // ──────────────────────────────────────────────────────────────────────────
  // SSR app deploy — when `start` is set, this site deploys to the
  // environment's `infrastructure.compute` EC2 instance as a systemd service
  // instead of S3+CloudFront. Multiple SSR sites can share the same EC2 box.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Command the systemd service runs (becomes ExecStart).
   * Presence of this field, in the absence of an explicit `deploy`, is the
   * discriminator: set => `server` (deploy to compute as a systemd service),
   * unset => `bucket` (deploy to object storage + CDN). See {@link deploy}.
   *
   * Example: 'bun run server.ts'
   */
  start?: string

  /**
   * Port the SSR app listens on. Required when `start` is set.
   * Two SSR sites on the same EC2 instance must use different ports.
   */
  port?: number

  /**
   * Environment variables written to the per-site systemd EnvironmentFile
   * (`/var/www/<site>/.env`). Available as process.env.* inside the running app.
   */
  env?: Record<string, string>

  /**
   * SSR only. Commands run on the server inside the app directory after the
   * release tarball is extracted and the `.env` is written, but before the
   * systemd service (re)starts. Use this to install runtime dependencies and/or
   * produce build artifacts on the machine itself — so the release tarball can
   * ship source only (no `node_modules`) and stays small.
   *
   * Example: ['bun install --frozen-lockfile', 'bun run build']
   */
  preStart?: string[]

  /**
   * SSR only. tar `--exclude` patterns applied when packaging the release
   * tarball. Keep host-specific / heavy paths out of the artifact — most
   * importantly `node_modules` (host-built native binaries won't run on the
   * target OS; install fresh via `preStart` instead), plus `.git`, dev caches,
   * and the built frontend.
   *
   * Example: ['node_modules', '.git', 'dist']
   */
  exclude?: string[]

  // ──────────────────────────────────────────────────────────────────────────
  // Laravel / PHP sites (Forge-style). When `type` is a PHP framework, the site
  // is deployed to the environment's compute box via git clone into atomic
  // release directories, served by nginx + php-fpm (or rpx when
  // `compute.webServer === 'rpx'`). See drivers/shared/* for the generators.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Application type. Drives the default deploy script and the nginx vhost
   * template:
   *  - `'laravel'` — `public/` web root, Laravel deploy script (composer,
   *    artisan caches, migrate, storage:link, queue:restart).
   *  - `'php'` — generic PHP app behind php-fpm (vanilla PHP, custom framework).
   *  - `'statamic'` / `'wordpress'` — PHP apps with framework-specific defaults.
   *  - `'static'` — plain static files served by nginx.
   *  - `'spa'` — single-page app with a `try_files … /index.html` fallback.
   *
   * When omitted the legacy inference applies (`start` ⇒ a systemd runtime app,
   * otherwise a bucket static site) — so existing bun/node sites are unaffected.
   */
  type?: 'laravel' | 'php' | 'statamic' | 'wordpress' | 'static' | 'spa'

  /**
   * PHP version for this site (e.g. `'8.3'`). Selects the php-fpm pool/socket
   * the nginx vhost points at. Must be one of `compute.php.versions`. Defaults
   * to `compute.php.default`.
   */
  phpVersion?: PhpVersion

  /**
   * Web root relative to the release directory. Defaults to `'public'` for
   * `laravel`/`statamic`/`wordpress`, and `''` (the release root) for `php`,
   * `static`, and `spa`.
   */
  webDirectory?: string

  /**
   * Git repository the server clones/pulls on deploy (Forge-style). When set,
   * the deploy clones `branch` into `releases/<sha>` rather than shipping a
   * tarball over SCP.
   */
  repository?: SiteRepositoryConfig

  /**
   * Override the deploy script run inside the new release directory. When
   * omitted, a sensible default for `type` is used (e.g. the Laravel script).
   * The special tokens `$CREATE_RELEASE`, `$ACTIVATE_RELEASE`, and
   * `$RESTART_QUEUES` expand to the zero-downtime release macros.
   */
  deployScript?: string[]

  /**
   * Paths symlinked from the site's `shared/` directory into every release so
   * they persist across deploys (e.g. `storage`, uploaded files, a SQLite db).
   * `.env` is always shared and need not be listed.
   * @default ['storage', '.env']
   */
  sharedPaths?: string[]

  /**
   * Number of past releases to retain on the box for rollback.
   * @default 4
   */
  keepReleases?: number

  /**
   * Use zero-downtime atomic releases (Envoyer-style: clone → build → flip the
   * `current` symlink only after every step succeeds, with the previous release
   * kept for instant rollback). On by default for git-deployed PHP sites — set
   * `false` only to deploy in place.
   * @default true
   */
  zeroDowntime?: boolean

  /** Laravel queue workers to run for this site (systemd-managed). */
  queues?: QueueWorkerConfig[]

  /**
   * Run the Laravel scheduler for this site
   * (`* * * * * php artisan schedule:run`). `true` enables it with defaults;
   * pass a {@link SchedulerConfig} to attach heartbeat monitoring.
   */
  scheduler?: boolean | SchedulerConfig

  /** Arbitrary long-running processes to keep alive (systemd-managed). */
  daemons?: DaemonConfig[]

  /** TLS configuration for this site's nginx vhost. */
  ssl?: SiteSslConfig

  /** Additional hostnames served by the same vhost (nginx `server_name`). */
  aliases?: string[]

  /** `from` path/host → `to` URL redirects emitted into the nginx vhost. */
  redirects?: Record<string, string>

  /**
   * Give this site a dedicated php-fpm pool (isolated user/process) rather than
   * sharing the default pool.
   */
  isolation?: boolean

  /** Post-deploy health check (Forge-style) pinged after `current` is flipped. */
  healthCheck?: { path?: string }

  /**
   * Per-site notification channels, overriding the project-wide
   * {@link CloudConfig.notifications} for this site's events.
   */
  notifications?: NotificationsConfig

  /**
   * HTTP Basic auth (htpasswd) protecting the whole site at the nginx layer.
   * Typically driven from an env value, e.g. `{ username: 'admin', password:
   * process.env.UI_PASSWORD }`. The htpasswd file is generated on the box.
   */
  auth?: SiteAuthConfig

  /**
   * Package-registry credentials written into the release before
   * `composer install` / `npm install` so private packages resolve (Forge's
   * Composer/npm credentials feature).
   */
  credentials?: SiteCredentialsConfig

  /**
   * Custom nginx for this site's vhost (Forge's "Edit Nginx Configuration").
   * Directives are injected into the generated `server { … }` block, so the
   * managed root/locations/SSL still apply.
   */
  nginx?: SiteNginxConfig
}

/** Per-site nginx customization injected into the generated server block. */
export interface SiteNginxConfig {
  /**
   * Name of a reusable template defined in
   * {@link ComputeConfig.nginxTemplates}. Its directive lines are injected into
   * this site's server block.
   */
  template?: string
  /**
   * Raw nginx directive lines added to this site's server block (after the
   * managed directives), e.g. `['gzip on;', 'location /metrics { deny all; }']`.
   * Applied on top of {@link template} when both are set.
   */
  serverSnippet?: string[]
  /** `client_max_body_size` for this vhost (e.g. `'256M'`) for large uploads. */
  clientMaxBodySize?: string
}

/** Private package-registry credentials for a site's build. */
export interface SiteCredentialsConfig {
  /**
   * Composer `auth.json` contents — an object (serialized to JSON) or a
   * ready-made JSON string. Written to the release root before `composer
   * install` (e.g. `{ 'github-oauth': { 'github.com': '<token>' } }`).
   */
  composerAuth?: Record<string, unknown> | string
  /** `.npmrc` contents written to the release root before `npm install`. */
  npmrc?: string
}

/** HTTP Basic auth for a site's nginx vhost. See {@link SiteConfig.auth}. */
export interface SiteAuthConfig {
  /** Enable basic auth. @default true when this object is present */
  enabled?: boolean
  /** Username. @default 'admin' */
  username?: string
  /** Plaintext password (hashed on the box). Usually `process.env.X`. */
  password?: string
  /** Realm shown in the browser auth prompt. @default 'Restricted' */
  realm?: string
}

/**
 * Git source for a Forge-style git-clone deploy. See {@link SiteConfig.repository}.
 */
export interface SiteRepositoryConfig {
  /** Clone URL (https or git@). */
  url: string
  /** Branch to deploy. @default 'main' */
  branch?: string
  /** Hosting provider — drives push-to-deploy hook wiring. @default 'github' */
  provider?: 'github' | 'gitlab' | 'bitbucket' | 'custom'
  /**
   * Deploy strategy:
   *  - `'push'` (default) — deploy the tip of `branch` (push-to-deploy).
   *  - `'tag'` — deploy a git version tag: a specific {@link tag}, or the latest
   *    tag matching {@link tagPattern} (e.g. release `v*` tags). Useful for
   *    promoting tagged releases rather than every push.
   */
  strategy?: 'push' | 'tag'
  /** Exact tag to deploy when `strategy: 'tag'`. Overrides {@link tagPattern}. */
  tag?: string
  /**
   * Glob matching the tags to consider when `strategy: 'tag'` and no explicit
   * {@link tag} is set; the highest version (`-sort=-v:refname`) is deployed.
   * @default 'v*'
   */
  tagPattern?: string
}

/**
 * TLS for a PHP/static site's nginx vhost. See {@link SiteConfig.ssl}.
 */
export interface SiteSslConfig {
  /**
   * Certificate source:
   *  - `'letsencrypt'` — issue + auto-renew via certbot (default for sites with
   *    a `domain`).
   *  - `'custom'` — install operator-provided `certPath`/`keyPath`.
   *  - `'none'` — serve plain HTTP only.
   */
  provider?: 'letsencrypt' | 'custom' | 'none'
  /** Contact email for Let's Encrypt registration/expiry notices. */
  email?: string
  /** Path to the certificate (PEM) when `provider: 'custom'`. */
  certPath?: string
  /** Path to the private key (PEM) when `provider: 'custom'`. */
  keyPath?: string
  /**
   * Issue a **wildcard** certificate (`*.<domain>` + `<domain>`). Requires
   * DNS-01 validation, so {@link dns} must be set. The nginx plugin can't do
   * wildcards (that needs HTTP-01 per host).
   */
  wildcard?: boolean
  /**
   * Use DNS-01 validation via a certbot DNS plugin instead of the nginx
   * (HTTP-01) challenge. Needed for wildcard certs and for issuing before the
   * domain resolves to the box. The plugin + credentials are wired on the box.
   */
  dns?: SslDnsConfig
}

/** certbot DNS-01 plugin configuration for DNS-validated / wildcard certs. */
export interface SslDnsConfig {
  /** DNS provider whose certbot plugin handles the `_acme-challenge` records. */
  provider: 'cloudflare' | 'route53' | 'digitalocean' | 'google'
  /**
   * Provider credentials written to a root-only INI certbot reads
   * (`--dns-<provider>-credentials`). For route53, AWS env/instance-role creds
   * are used instead, so this may be omitted. Keys are provider-specific, e.g.
   * `{ dns_cloudflare_api_token: '…' }`.
   */
  credentials?: Record<string, string>
  /** Seconds to wait for DNS propagation before certbot asks the CA to verify. */
  propagationSeconds?: number
}

/**
 * Laravel scheduler options for a site (Forge's scheduler + heartbeat
 * monitoring). The scheduler runs `php artisan schedule:run` every minute.
 */
export interface SchedulerConfig {
  /**
   * Heartbeat monitor URL pinged after each successful `schedule:run`
   * (healthchecks.io, Oh Dear, Better Uptime, …). If the scheduler stops, the
   * monitor stops receiving pings and alerts you.
   */
  heartbeatUrl?: string
  /**
   * HTTP method for the heartbeat ping. @default 'GET'
   */
  heartbeatMethod?: 'GET' | 'POST' | 'HEAD'
}

/**
 * A Laravel queue worker (or Horizon supervisor) run as a systemd service.
 * Mirrors Forge's queue configuration. See {@link SiteConfig.queues}.
 */
export interface QueueWorkerConfig {
  /**
   * Use `php artisan horizon` instead of `queue:work`. When true, connection /
   * queue / worker tuning is taken from the app's `config/horizon.php`.
   * @default false
   */
  horizon?: boolean
  /** Queue connection (`php artisan queue:work <connection>`). @default 'default' */
  connection?: string
  /** Comma-separated queues to consume, highest priority first. @default 'default' */
  queue?: string
  /** Number of worker processes to run in parallel. @default 1 */
  processes?: number
  /** `--timeout`: seconds a child job may run before being killed. @default 60 */
  timeout?: number
  /** `--sleep`: seconds to wait when no job is available. @default 3 */
  sleep?: number
  /** `--tries`: attempts before a job is marked failed. @default 3 */
  tries?: number
  /** `--max-jobs`: restart the worker after N jobs (0 = unlimited). */
  maxJobs?: number
  /** `--max-time`: restart the worker after N seconds (0 = unlimited). */
  maxTime?: number
  /** `--memory`: restart the worker when it exceeds N MB. @default 128 */
  memory?: number
  /** Seconds to wait for in-flight jobs to finish on stop/restart. @default 90 */
  stopWaitSecs?: number
}

/**
 * A generic long-running process kept alive by systemd. Mirrors Forge daemons.
 * See {@link SiteConfig.daemons}.
 */
export interface DaemonConfig {
  /** Command to run (becomes systemd `ExecStart`). */
  command: string
  /** Working directory. Defaults to the site's `current` release directory. */
  directory?: string
  /** User to run as. Defaults to the deploy user. */
  user?: string
  /** Number of identical processes to run. @default 1 */
  processes?: number
  /** Restart policy. @default 'always' */
  restart?: 'always' | 'on-failure' | 'no'
  /** Optional explicit unit name; defaults to a slug of the command. */
  name?: string
}

/** A lifecycle event that can trigger a notification. */
export type NotifyEvent = 'deploy' | 'deploy-failed' | 'ssl' | 'health' | 'backup'

/**
 * Notification channels (Forge-style). Configure any subset; each configured
 * channel receives the events listed in {@link events} (all events by default).
 */
export interface NotificationsConfig {
  /** Slack incoming-webhook URL. */
  slack?: { webhookUrl: string }
  /** Discord webhook URL. */
  discord?: { webhookUrl: string }
  /** Telegram bot token + chat id. */
  telegram?: { botToken: string, chatId: string }
  /** Email recipients (sent via ts-cloud's email/SES client). */
  email?: { to: string | string[], from?: string }
  /** Generic webhook — receives `{ event, message }` as JSON. */
  webhook?: { url: string, method?: 'POST' | 'GET' }
  /**
   * Which events to notify on. @default all events
   */
  events?: NotifyEvent[]
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
  engine?: 'postgres' | 'mysql' | 'mariadb'
  instanceType?: string

  // ──────────────────────────────────────────────────────────────────────────
  // On-box / app database wiring (Forge single-server model). When the box
  // installs a database engine (`compute.services`), these create the app's
  // database + user at provision time. `host`/`port` point a PHP app at a
  // managed database instead.
  // ──────────────────────────────────────────────────────────────────────────

  /** Database/schema name to create (e.g. `forge`). */
  name?: string
  /** Application database user to create. */
  username?: string
  /** Password for {@link username}. */
  password?: string
  /** Hostname for a managed/external database (default `127.0.0.1` on-box). */
  host?: string
  /** Port (defaults: mysql/mariadb 3306, postgres 5432). */
  port?: number
  /**
   * Additional database users to create beyond the app {@link username}
   * (the Forge Database Users feature). Each can be granted full or read-only
   * access to one or more databases. Created at provision time on the on-box
   * engine.
   */
  users?: DatabaseUserConfig[]
}

/**
 * An extra database user provisioned on the on-box engine (per-user grants).
 * Beyond the application user, you can create reporting/read-only accounts or
 * service-specific logins with their own access scope.
 */
export interface DatabaseUserConfig {
  /** User name to create. */
  username: string
  /** Password for the user. */
  password: string
  /**
   * Databases this user may access. Defaults to the app database
   * ({@link DatabaseConfig.name}) when omitted.
   */
  databases?: string[]
  /**
   * Access level granted on {@link databases}. `all` (default) is full
   * read/write; `readonly` grants SELECT only (plus connect on Postgres).
   */
  access?: 'all' | 'readonly'
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
  /**
   * External DNS provider configuration
   * When set, DNS records will be managed via the external provider API
   * instead of Route53
   */
  provider?: 'route53' | 'cloudflare' | 'porkbun' | 'godaddy'
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
   * Physical S3 bucket name. When omitted, defaults to `{slug}-{environment}-{key}`.
   */
  bucket?: string
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
   * Explicit CloudFront distribution aliases for this bucket.
   * Overrides the default alias logic based on bucket name.
   * Example: ['example.com', 'www.example.com']
   */
  aliases?: string[]
  /**
   * Mount this website bucket under the main site CloudFront distribution instead
   * of provisioning a dedicated distribution/subdomain.
   * Example: '/docs' serves this bucket at https://example.com/docs.
   */
  path?: string
  mountPath?: string
  /**
   * URL rewrite style for path-mounted website buckets.
   *
   * - directory: /docs/guide/get-started -> /guide/get-started/index.html
   * - flat: /docs/guide/get-started -> /guide/get-started.html
   *
   * Defaults to directory, which matches most blog/static-export outputs.
   */
  pathRewriteStyle?: 'directory' | 'flat'
  /**
   * Whether this bucket serves a single-page application (SPA).
   * When true: 403/404 errors return index.html with status 200 (for client-side routing).
   * When false (default): A CloudFront Function rewrites extensionless URLs to .html files,
   * and 403/404 errors return a proper 404 page. This is correct for multi-page SSG sites.
   */
  spa?: boolean
  /**
   * Route dynamic app paths to the compute server (EC2) via CloudFront cache behaviors.
   * The `public` bucket enables this automatically; set explicitly for other bucket names.
   */
  routeCompute?: boolean
  /**
   * CloudFront path patterns forwarded to compute (POST/PUT/PATCH/DELETE allowed).
   * Used when `routeCompute` is true. Defaults to a registry-style path set when omitted.
   */
  computeRoutes?: string[]
  /**
   * Root directory containing the built static files to upload (e.g., 'dist', '.output/public').
   * When set, `cloud deploy` will auto-upload files from this directory to the S3 bucket
   * after the CloudFormation stack reaches a COMPLETE status, and invalidate CloudFront cache.
   */
  root?: string
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
 * Serverless application configuration — the Laravel-Vapor-equivalent manifest.
 *
 * One application codebase is deployed as three Lambda functions sharing a single
 * code artifact:
 *   - **http**     fronted by API Gateway v2 (or v1) + an optional custom domain
 *   - **queue**    triggered by an SQS event source mapping (one job per invocation)
 *   - **cli**      invoked by an EventBridge schedule (`schedule:run`) and on demand
 *                  (deploy hooks, migrations, `command`)
 *
 * Declared per-environment via {@link EnvironmentConfig.app}. Defining it opts a
 * project into the serverless application deploy pipeline (`cloud deploy:serverless`).
 *
 * @example
 * environments: {
 *   production: {
 *     type: 'production',
 *     domain: 'app.example.com',
 *     app: {
 *       runtime: 'nodejs20.x',
 *       entry: 'src/server.ts',
 *       memory: 1024,
 *       build: ['bun install', 'bun run build'],
 *       deploy: ['migrate'],
 *       queues: true,
 *       scheduler: 'on',
 *     },
 *   },
 * }
 */
export interface ServerlessAppConfig {
  /**
   * Explicit Lambda runtime override. Usually you don't set this — it's derived
   * from {@link kind} + {@link runtimeVersion}:
   * - `node` on a managed version → `nodejs{18,20,22}.x`
   * - `node` on a non-managed version (e.g. 24), `bun`, or `php` →
   *   `provided.al2023` with a ts-cloud-built custom runtime layer
   *
   * Set this to force a specific value (e.g. `provided.al2023` to run Node on a
   * custom layer even for a managed version).
   * @default derived from kind/runtimeVersion
   */
  runtime?: 'nodejs18.x' | 'nodejs20.x' | 'nodejs22.x' | 'provided.al2023' | (string & {})

  /**
   * Runtime version for `node`/`bun` apps (PHP uses {@link phpVersion}).
   * - node: '18' | '20' | '22' (managed) or '24'+ (custom provided.al2023 layer)
   * - bun:  a Bun release, e.g. '1.3.13' (always a custom provided.al2023 layer)
   * @default node '22', bun the layer's pinned default
   */
  runtimeVersion?: string

  /**
   * Application kind. Drives packaging + runtime selection.
   * - `node` / `bun`: bundle a JS/TS handler artifact
   * - `php`: build/attach the PHP runtime layer and FPM bridge (Laravel)
   * @default 'node'
   */
  kind?: 'node' | 'bun' | 'php'

  /**
   * Entry file (relative to project root) that exports the request handler.
   * Used when `handlers` is not provided; a single shim re-exports http/queue/cli.
   * @example 'src/server.ts'
   */
  entry?: string

  /**
   * Explicit per-function handlers, overriding the single-`entry` shim.
   * Values are Lambda handler strings (e.g. `dist/index.http`).
   */
  handlers?: {
    http?: string
    queue?: string
    cli?: string
  }

  // ── HTTP function ────────────────────────────────────────────────────────
  /** HTTP function memory in MB. @default 1024 */
  memory?: number
  /** HTTP request timeout in seconds (API Gateway caps at 29s for v2). @default 28 */
  timeout?: number
  /** Reserved concurrency for the HTTP function. */
  concurrency?: number
  /**
   * API Gateway version. Only `2` (HTTP API — cheaper, faster) is supported;
   * `1` (REST API) throws at compose time. @default 2
   */
  gatewayVersion?: 1 | 2
  /**
   * Cheap keep-warm count. Drives a scheduled EventBridge warmer rule that pings
   * the function(s) every few minutes (the runtime short-circuits warmer pings).
   * Reduces (does not eliminate) cold starts. For zero cold starts use
   * {@link provisionedConcurrency}. 0/undefined disables ping-warming.
   */
  warm?: number
  /**
   * Which functions the warmer keeps warm. @default ['http']
   * (queue/cli are async + latency-tolerant, so HTTP-only is the sensible default).
   */
  warmFunctions?: Array<'http' | 'queue' | 'cli'>
  /**
   * Real provisioned concurrency (zero cold starts for N environments). Opts the
   * app into the alias/version model: each function gets a `live` alias that
   * traffic routes through, and every deploy publishes a version + flips the
   * alias. Costs more than `warm` (you pay for the reserved capacity) but
   * eliminates cold starts. 0/undefined keeps the default $LATEST model.
   */
  provisionedConcurrency?: number
  /** CloudWatch log retention (days) for all function log groups. @default 14 */
  logRetention?: number

  // ── CLI function (scheduler + on-demand command/deploy hooks) ─────────────
  /** CLI function memory in MB. @default 1024 */
  cliMemory?: number
  /** CLI command timeout in seconds (allow room for migrations). @default 900 */
  cliTimeout?: number

  // ── Queue worker function ─────────────────────────────────────────────────
  /**
   * Queue names to process. `true` provisions a single `default` queue; `false`
   * disables the queue function entirely. Entries may carry a per-queue
   * concurrency, e.g. `[{ emails: 10 }]`.
   */
  queues?: boolean | Array<string | Record<string, number>>
  /** Max concurrent queue job executions (SQS event source mapping). @default 1000 */
  queueConcurrency?: number
  /** Queue visibility timeout in seconds. @default 120 */
  queueTimeout?: number
  /** Queue function memory in MB. @default 1024 */
  queueMemory?: number
  /** Max receive count before a message is sent to the DLQ. @default 3 */
  queueTries?: number

  // ── Scheduler ─────────────────────────────────────────────────────────────
  /**
   * Task scheduler mode:
   * - `on`         EventBridge rule invokes the CLI fn (`schedule:run`) every minute
   * - `sub-minute` adds a self-rescheduling runner for sub-minute tasks
   * - `off`        no scheduler
   * @default 'on'
   */
  scheduler?: 'off' | 'on' | 'sub-minute'

  // ── Build / deploy hooks (Vapor parity) ───────────────────────────────────
  /** Commands run locally before packaging (e.g. `composer install`, `bun run build`). */
  build?: string[]
  /**
   * Commands run remotely after the new code is live, by invoking the CLI function
   * (e.g. `migrate --force`). A failing hook aborts the deploy and rolls back.
   */
  deploy?: string[]

  /**
   * Persistent application mode (Laravel Octane / long-lived server) instead of
   * per-request FPM/handler boot. Lower latency; requires an Octane-safe app.
   * @default false
   */
  octane?: boolean

  /**
   * Deployment package format:
   * - `zip`   ship a ZIP artifact (250 MB unzipped layer+code limit)
   * - `image` ship a container image to ECR (up to 10 GB) for large apps
   * @default 'zip'
   */
  packaging?: 'zip' | 'image'

  // ── Networking / data attachment ──────────────────────────────────────────
  /** Attach the functions to a VPC (required for ElastiCache / private RDS / EFS). */
  vpc?: {
    /** VPC id — required when ts-cloud provisions a managed security group for data services. */
    id?: string
    subnets?: string[]
    securityGroups?: string[]
  }
  /** Front the database with an RDS Proxy for Lambda connection pooling. */
  rdsProxy?: boolean | { name?: string }
  /** Ephemeral storage in MB (512 to 10240) for the HTTP function. @default 512 */
  tmpStorage?: number
  /** Ephemeral storage in MB for the CLI function. @default tmpStorage */
  cliTmpStorage?: number
  /** Ephemeral storage in MB for the queue function. @default tmpStorage */
  queueTmpStorage?: number
  /** Database attachment. */
  database?: {
    connection?: 'rds-proxy' | 'aurora-serverless' | 'rds'
    cluster?: string
    /** Aurora Serverless v2 minimum capacity (ACUs). @default 0.5 */
    minCapacity?: number
    /** Aurora Serverless v2 maximum capacity (ACUs). @default 4 */
    maxCapacity?: number
  }
  /** Cache attachment. DynamoDB cache table is the zero-NAT default. */
  cache?: {
    driver?: 'dynamodb' | 'elasticache'
    cluster?: string
  }
  /** Application object-storage bucket (Vapor `storage:`). */
  storage?: {
    bucket?: string
  }
  /**
   * Mount a shared Elastic File System on the functions (Vapor's `/mnt/local`).
   * Requires a VPC. `true` provisions an EFS file system + access point;
   * otherwise attach an existing access point by ARN. The mount path defaults
   * to `/mnt/local`.
   */
  efs?: boolean | {
    /** Existing EFS Access Point ARN to attach (skips provisioning). */
    accessPointArn?: string
    /** Mount path inside the functions. @default '/mnt/local' */
    mountPath?: string
  }

  /** Managed WAF in front of the HTTP API / CloudFront. */
  firewall?: WafConfig

  // ── Domain & assets ────────────────────────────────────────────────────────
  /** Custom domain(s) for the app's HTTP API (overrides {@link EnvironmentConfig.domain}). */
  domain?: string | string[]
  /** Pre-issued ACM certificate ARN for the custom domain (regional, same region). */
  certificateArn?: string
  /**
   * Route53 hosted zone ID for the custom domain. When set (and no
   * `certificateArn`), ts-cloud issues + DNS-validates an ACM cert and creates
   * the alias record automatically. Without it, supply `certificateArn` and
   * point your DNS at the API's regional domain (emitted as a stack output).
   */
  hostedZoneId?: string
  /** Local directory whose contents are uploaded to S3/CloudFront as versioned assets. */
  assets?: string
  /**
   * Serve assets from a custom CDN host instead of the default CloudFront domain
   * (Vapor `asset-domain`). CloudFront needs a us-east-1 ACM cert: supply one via
   * {@link assetCertificateArn}, or give {@link hostedZoneId} and (for a us-east-1
   * app) ts-cloud auto-issues + DNS-validates one.
   */
  assetDomain?: string
  /**
   * us-east-1 ACM certificate ARN for {@link assetDomain} (CloudFront requirement).
   * Optional when {@link hostedZoneId} is set and the app is in us-east-1 — the
   * cert is then auto-issued and DNS-validated.
   */
  assetCertificateArn?: string
  /** Include dotfiles when uploading assets (Vapor `dot-files-as-assets`). @default false */
  dotFilesAsAssets?: boolean
  /** Serve assets from the app/root domain too (Vapor `serve_assets`). Injected as env. */
  serveAssets?: boolean
  /** Redirect robots.txt to the asset CDN (Vapor `redirect_robots_txt`). Injected as env. @default true */
  redirectRobotsTxt?: boolean

  // ── PHP-specific (kind: 'php') ───────────────────────────────────────────
  /** PHP version for the runtime layer. @default '8.3' */
  phpVersion?: PhpVersion
  /** CPU architecture. @default 'x86_64' */
  architecture?: 'x86_64' | 'arm64'
  /**
   * Lambda layer version ARNs attached to all functions. For PHP apps this is
   * the ts-cloud PHP runtime layer; if omitted, the deployer falls back to the
   * `TSCLOUD_PHP_LAYER_ARN` environment variable.
   */
  layers?: string[]

  // ── Env + secrets ──────────────────────────────────────────────────────────
  /** Plaintext environment variables injected into all functions. */
  env?: Record<string, string>
  /**
   * Secret names resolved from Secrets Manager / SSM at deploy time and injected
   * as environment variables. Array of names, or name→source map.
   */
  secrets?: string[] | Record<string, string>
}

/**
 * Elastic File System (EFS) configuration
 */
export interface FileSystemItemConfig {
  /**
   * Performance mode
   */
  performanceMode?: 'generalPurpose' | 'maxIO'
  /**
   * Throughput mode
   */
  throughputMode?: 'bursting' | 'provisioned' | 'elastic'
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

  /**
   * Human-readable server name
   * @example 'app-server-1'
   */
  name?: string

  /**
   * Domain associated with this server
   * @example 'stacksjs.com'
   */
  domain?: string

  /**
   * AWS region for this server
   * @example 'us-east-1'
   */
  region?: string

  /**
   * Server role type
   * @example 'app', 'web', 'worker', 'cache', 'search'
   */
  type?: 'app' | 'web' | 'worker' | 'cache' | 'search' | (string & {})

  /**
   * Disk size in GB
   * @default 20
   */
  diskSize?: number

  /**
   * Existing VPC ID or 'create' to provision a new one
   * @example 'vpc-123456789' or 'create'
   */
  privateNetwork?: string

  /**
   * Existing subnet ID
   * @example 'subnet-123456789'
   */
  subnet?: string

  /**
   * Server OS image identifier
   * @example 'ubuntu-20-lts-x86_64'
   */
  serverOS?: string

  /**
   * Bun runtime version to install
   * @example '1.1.26'
   */
  bunVersion?: string

  /**
   * Database engine to install clients for
   * @example 'sqlite', 'postgres'
   */
  database?: string

  /**
   * Database name to create
   * @example 'stacks'
   */
  databaseName?: string

  /**
   * Post-provision script (alias for startupScript)
   */
  userData?: string

  /**
   * Direct AWS instance type override
   * @example 't3.micro', 'm6i.large'
   */
  instanceType?: string

  /**
   * SSH key pair name for instance access
   */
  keyName?: string
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
export interface ContainerItemConfig {
  cpu?: number
  memory?: number
  port?: number
  healthCheck?: string
  desiredCount?: number
  autoScaling?: {
    min?: number
    max?: number
    targetCpuUtilization?: number
    targetMemoryUtilization?: number
  }
}

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
   * Number of application servers (Forge load-balanced fleet). When > 1, a load
   * balancer is provisioned in front and a private network connects the fleet;
   * the app is deployed to every app server. Pair with {@link servicesServer}
   * so the database/cache/search live on one shared box. @default 1
   */
  appServers?: number

  /**
   * Provision a **dedicated services server** (its own box) running the
   * configured {@link managedServices} (MySQL/Redis/Meilisearch), instead of
   * co-locating them on the app server(s). App servers then point their `.env`
   * at this box over the private network. Required for a multi-app fleet so all
   * app servers share one database/cache. `true` uses the default size.
   */
  servicesServer?: boolean | { size?: InstanceSize }

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
   * Custom machine image (optional). For the Forge path this is a ts-cloud
   * **golden image** (a Hetzner snapshot / AWS AMI baked with the full stack —
   * nginx, php-fpm, Composer, services). If not specified, the provider's
   * default Ubuntu image is used and the stack is installed at first boot.
   * @see bakedImage
   */
  image?: string

  /**
   * The configured {@link image} is a pre-provisioned golden image that already
   * has the runtime + PHP + services + base packages installed. Boot skips the
   * install-heavy provisioning for a near-instant start. Build + publish the
   * image with the bake recipe (see scripts/build-image.ts). @default false
   */
  bakedImage?: boolean

  /**
   * CloudFront custom origin for the registry/app server (when the site stack
   * fronts EC2 instead of S3-only). Use the EC2 public DNS name, not a raw IP.
   */
  cloudFrontOriginDomain?: string
  /** HTTP port on the compute origin. @default 3008 */
  cloudFrontOriginPort?: number
  /** Stable CloudFront origin Id (preserve across stack updates). @default `{slug}-compute` */
  cloudFrontOriginId?: string

  /**
   * Server mode (EC2) configuration
   */
  server?: {
    instanceType?: string
    ami?: string
    keyPair?: string
    /**
     * IAM instance profile name attached at launch. For the lightweight EC2
     * boot path, this should grant `AmazonSSMManagedInstanceCore` so deploys
     * (SSM Run Command) reach the box.
     */
    iamInstanceProfile?: string
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

  // ──────────────────────────────────────────────────────────────────────────
  // App runtime — installed at instance bootstrap via User Data.
  // Machine-level: shared across all sites running on this compute.
  // Per-site app config (build, start, port, env) lives on `SiteConfig`.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Application runtime to install on the instance.
   * Shared by every site that gets deployed to this compute. `'php'` provisions
   * nginx + php-fpm + Composer (see {@link php}) for Laravel/PHP sites.
   */
  runtime?: 'bun' | 'node' | 'deno' | 'php'

  /**
   * Pinned runtime version (e.g. '1.3.13'). Defaults to 'latest'.
   */
  runtimeVersion?: string

  /**
   * Extra OS packages to install at bootstrap (dnf/apt names).
   * Latest available version is always installed — no pinning.
   * Example: ['sqlite', 'imagemagick']
   */
  systemPackages?: string[]

  /**
   * Open port 22 (SSH) to 0.0.0.0/0 in the instance security group.
   * Default is `false` — deploys use SSM Run Command (no SSH needed) and
   * shell access can be obtained via SSM Session Manager
   * (`aws ssm start-session --target <instance-id>`), so SSH is only
   * useful for legacy tooling.
   *
   * Set to `true` only if you need traditional SSH access.
   */
  allowSsh?: boolean

  /**
   * Reverse-proxy gateway to provision on the box. When set to an engine,
   * `buddy deploy` generates the gateway's route config from the `sites` model
   * (mapping each non-bucket site to a route by `domain`/`path`) and installs +
   * starts the gateway on :80/:443.
   *
   * Opt-in and **off by default** (`undefined` → no gateway provisioned, the
   * operator runs their own), so existing deploys are unaffected.
   *
   * Currently the only engine is `rpx` (`@stacksjs/rpx`), which natively
   * supports path-based routing within a host, on-demand TLS, and serving
   * static dirs — so an app, docs, and a public site can share one domain.
   */
  proxy?: ComputeProxyConfig

  // ──────────────────────────────────────────────────────────────────────────
  // Laravel / PHP machine provisioning (Forge-style). Machine-level: shared by
  // every PHP site on this box. Per-site PHP version lives on `SiteConfig`.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * PHP-FPM provisioning. When set (or `runtime: 'php'`), the box installs the
   * requested PHP versions (via `ppa:ondrej/php`), Composer, and the common
   * Laravel extension set. Each site picks its version with `SiteConfig.phpVersion`.
   */
  php?: ComputePhpConfig

  /**
   * Web server that fronts the box.
   *  - `'nginx'` (default) — per-site nginx vhost + php-fpm, Let's Encrypt via certbot.
   *  - `'rpx'` — the existing `@stacksjs/rpx` gateway with on-demand TLS.
   * Independent of {@link proxy}, which only configures the rpx engine details.
   * @default 'nginx'
   */
  webServer?: 'nginx' | 'rpx'

  /**
   * Reusable nginx config templates, keyed by name. A site references one via
   * `site.nginx.template`, and its directive lines are injected into that
   * site's server block — define a hardening/caching/proxy snippet once and
   * share it across sites (Forge's nginx templates).
   */
  nginxTemplates?: Record<string, string[]>

  /**
   * On-box managed services to install (Forge's single-server model): the
   * database engine, cache, and search. Each may be `true` for defaults or an
   * object for pinning a version. Omit to install nothing (e.g. when pointing
   * the app at a managed/RDS database instead).
   *
   * Named `managedServices` to avoid colliding with the ECS microservices
   * `services` array above.
   */
  managedServices?: ComputeServicesConfig

  /**
   * Host firewall (UFW). When enabled, only SSH + the listed ports are open.
   * On Hetzner this complements the cloud firewall; on a bare box it's the
   * primary firewall. @default { enabled: true } for PHP boxes
   */
  firewall?: ComputeFirewallConfig

  /**
   * Automatic unattended security/system updates (Forge's "maintenance"). When
   * enabled, installs `unattended-upgrades` and enables daily auto-updates.
   * @default true for PHP boxes
   */
  autoUpdates?: boolean

  /**
   * Scheduled database backups (powered by `ts-backups`), synced to object
   * storage. Off unless configured.
   */
  backups?: ComputeBackupConfig

  /**
   * Operator SSH keys authorized on the box, in addition to the deploy key.
   * Managed declaratively: keys are written to `authorized_keys` inside a
   * ts-cloud-managed block on every provision/deploy, so adding one is as
   * simple as adding an entry here and redeploying.
   */
  sshKeys?: SshKeyConfig[]
}

/** An operator SSH key authorized on the box. See {@link ComputeConfig.sshKeys}. */
export interface SshKeyConfig {
  /** Human label for the key (comment). */
  name: string
  /** The public key line (e.g. `ssh-ed25519 AAAA… user@host`). */
  publicKey: string
}

/** Host firewall (UFW) configuration. See {@link ComputeConfig.firewall}. */
export interface ComputeFirewallConfig {
  /** Enable UFW. @default true */
  enabled?: boolean
  /** TCP ports to allow in addition to SSH/80/443 (always allowed). */
  allowedPorts?: number[]
}

/** Scheduled database backup configuration. See {@link ComputeConfig.backups}. */
export interface ComputeBackupConfig {
  /** Enable scheduled backups. @default false */
  enabled?: boolean
  /** Cron schedule for the backup run. @default '0 2 * * *' (daily 02:00) */
  schedule?: string
  /** Keep the newest N backups locally. @default 5 */
  retentionCount?: number
  /** Delete local backups older than N days. @default 30 */
  retentionDays?: number
  /** Object-storage bucket (S3 or Hetzner) the backups are synced to. */
  bucket?: string
  /** S3-compatible endpoint (e.g. Hetzner object storage). Omit for AWS S3. */
  endpoint?: string
}

/**
 * A PHP version selector. Known versions provide editor autocomplete; the
 * `(string & {})` arm keeps it open for versions released after this type was
 * written (e.g. a future `'8.5'`) without a type error.
 */
export type PhpVersion = '8.1' | '8.2' | '8.3' | '8.4' | (string & {})

/**
 * PHP-FPM provisioning for a compute box. See {@link ComputeConfig.php}.
 */
export interface ComputePhpConfig {
  /**
   * PHP versions to install (e.g. `['8.3', '8.2']`). Each gets its own php-fpm
   * pool/socket so sites can pin different versions. @default ['8.3']
   */
  versions?: PhpVersion[]
  /** Default PHP version for sites that don't set `phpVersion`. @default first of `versions` */
  default?: PhpVersion
  /**
   * Extra PHP extensions to install beyond the Laravel baseline (mbstring, xml,
   * curl, mysql, pgsql, redis, gd, bcmath, zip, intl). apt package suffixes,
   * e.g. `['imagick', 'swoole']`.
   */
  extensions?: string[]
  /**
   * Apply the production OPcache + php.ini tuning (Forge's "Optimize for
   * Production"): OPcache on with timestamp validation off, larger file/string
   * buffers, and a bigger realpath cache. Deploys restart php-fpm, so disabled
   * timestamp validation is safe. @default true
   */
  optimizeForProduction?: boolean
  /**
   * Extra `php.ini` directives merged on top of the production tuning (and
   * applied even when {@link optimizeForProduction} is false), e.g.
   * `{ memory_limit: '512M', upload_max_filesize: '128M' }`.
   */
  ini?: Record<string, string>
}

/**
 * On-box managed services (database / cache / search) for a compute box.
 * Each entry is `true` (install with defaults) or an object pinning a version.
 * See {@link ComputeConfig.services}.
 */
export interface ComputeServicesConfig {
  mysql?: boolean | { version?: string }
  mariadb?: boolean | { version?: string }
  postgres?: boolean | { version?: string }
  redis?: boolean | { version?: string }
  memcached?: boolean | { version?: string }
  meilisearch?: boolean | { version?: string }
}

/**
 * Reverse-proxy gateway provisioning for a compute box. The gateway is
 * generated from the `sites` model and installed by the driver's cloud-init /
 * deploy flow. See {@link ComputeConfig.proxy}.
 */
export interface ComputeProxyConfig {
  /**
   * Gateway engine. `rpx` provisions `@stacksjs/rpx` as a systemd service
   * (`rpx-gateway.service`) reading a generated config. This is the only
   * supported engine today.
   */
  engine: 'rpx'
  /**
   * npm version/range of `@stacksjs/rpx` to install on the box.
   * @default 'latest'
   */
  version?: string
  /**
   * Directory on the box holding real TLS certs (PEM `<domain>.crt`/`.key`),
   * served per-SNI by rpx. @default '/etc/rpx/certs'
   */
  certsDir?: string
  /**
   * Enable rpx on-demand TLS: lazily issue a real (Let's Encrypt) cert for an
   * approved host the first time it's needed. The site domains are used as the
   * allowlist. Off by default.
   */
  onDemandTls?: boolean
  /** Contact email for the ACME account when {@link onDemandTls} is enabled. */
  onDemandTlsEmail?: string
  /**
   * Put a CDN (CloudFront) in front of this self-hosted gateway. A CDN custom
   * origin can't be a bare IP and can't be one of the public aliases (it would
   * resolve back to the CDN — an infinite loop), so it needs a dedicated origin
   * hostname pointing at this box. Requests then flow
   * `viewer → CDN → originDomain (this box)`.
   *
   * When {@link CdnFrontConfig.secret} is set, the CDN injects it as a header
   * on the origin hop and the gateway rejects any request to the fronted hosts
   * that lacks it — so the publicly-resolvable origin can't be used to bypass
   * the CDN (origin lockdown via rpx `createOriginGuard`). Pair with
   * `buildCloudFrontOriginConfig` for the matching AWS distribution config.
   */
  cdn?: CdnFrontConfig
}

/** CDN-in-front-of-gateway configuration (see {@link ComputeProxyConfig.cdn}). */
export interface CdnFrontConfig {
  /**
   * Hostname the CDN connects to (e.g. `origin.example.com`). MUST resolve to
   * this box and MUST NOT be one of {@link frontedHosts} (else the CDN loops).
   */
  originDomain: string
  /** Public hosts served through the CDN (its aliases) — locked down when {@link secret} is set. */
  frontedHosts: string[]
  /** Shared secret the CDN injects on the origin hop; the gateway enforces it on {@link frontedHosts}. */
  secret?: string
  /** Header name carrying {@link secret}. @default 'X-Origin-Verify' */
  secretHeader?: string
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
  /**
   * Forward dynamic paths to the compute app (EC2) in addition to the S3 origin.
   */
  routeCompute?: boolean
  /**
   * CloudFront path patterns for compute routing. See `StorageConfig.computeRoutes`.
   */
  computeRoutes?: string[]
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
 * import { QueuePresets } from '@ts-cloud/core'
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
 * Echo.private('user.' + userId).listen('notification', (e) => {
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
 * import { RealtimePresets } from '@ts-cloud/core'
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
  /**
   * Origin port for app API traffic routed through the public CDN.
   * Defaults to 3008 so APIs do not contend with HTTP services such as
   * mail or ACME challenge responders on port 80.
   */
  port?: number
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
