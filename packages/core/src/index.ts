/**
 * ts-cloud Core - CloudFormation Generator Engine
 */

// Core types
export * from 'ts-cloud-types'

// Legacy exports (Phase 1)
export * from './template-builder'
// template-validator exports ValidationResult and ValidationError (interface)
// We prefer ValidationError (class) from errors, so exclude it here
export {
  validateTemplate,
  validateTemplateSize,
  validateResourceLimits,
  // ValidationResult is also exported here - we'll keep it from template-validator
  type ValidationResult,
} from './template-validator'
// intrinsic-functions exports Fn and Pseudo
// We prefer Fn from cloudformation/types, so only export Pseudo here
export { Pseudo } from './intrinsic-functions'
export * from './resource-naming'
export * from './dependency-graph'
export * from './stack-diff'
// modules re-exports many things including Cache (ElastiCache module)
// We prefer this Cache over utils/cache, so export all from modules
// But modules also exports: PolicyStatement, LifecycleRule, MetricTransformation
export * from './modules'

// CloudFormation builder (Phase 5)
export * from './cloudformation/builder'
// cloudformation/types exports Fn (which we prefer over intrinsic-functions)
export * from './cloudformation/types'

// Configuration presets (Phase 4)
export * from './presets/static-site'
export * from './presets/nodejs-server'
export * from './presets/nodejs-serverless'
export * from './presets/fullstack-app'
export * from './presets/api-backend'
export * from './presets/wordpress'
export * from './presets/jamstack'
export * from './presets/microservices'
export * from './presets/realtime-app'
export * from './presets/data-pipeline'
export * from './presets/ml-api'
export * from './presets/traditional-web-app'
export * from './presets/extend'

// AWS clients (Phase 5)
export * from './aws/signature'
export * from './aws/credentials'
export * from './aws/cloudformation'
export {
  S3Client,
  S3Error,
  createS3Client,
  type S3ClientOptions,
  type GetObjectOptions,
  type PutObjectOptions,
  type ListObjectsOptions,
  type ListObjectsResult,
  type S3Object,
  type HeadObjectResult,
  type CopyObjectOptions,
  type MultipartUploadOptions,
  type MultipartProgress,
  type PresignedUrlOptions as S3PresignedUrlOptions,
} from './aws/s3'
export * from './aws/cloudfront'

// Error handling (Phase 6)
// errors exports ValidationError (class) which we prefer
export * from './errors'

// Validators (Phase 6)
export * from './validators/credentials'
export * from './validators/quotas'

// Utilities (Phase 6)
// utils exports Cache (in-memory utility), but we prefer Cache from modules (ElastiCache)
// So we need to exclude Cache from utils
export {
  FileCache,
  TemplateCache,
  templateCache,
  type CacheOptions,
  type CacheEntry,
} from './utils/cache'
export * from './utils/hash'
export * from './utils/parallel'
export * from './utils/diff'

// Schema (Phase 6.5)
export * from './schema'

// Local development (Phase 6.6)
export * from './local/config'
export * from './local/mock-aws'

// Preview environments (Phase 6.7)
export * from './preview'

// Advanced CLI utilities (Phase 6.8)
export * from './cli'

// Multi-region support (Phase 7.1)
export * from './multi-region'

// Multi-account support (Phase 7.2)
export * from './multi-account'

// CI/CD integration (Phase 7.3)
export * from './cicd'

// Backup & Disaster Recovery (Phase 7.4)
export * from './backup'

// Compliance & Governance (Phase 7.5)
export * from './compliance'

// Advanced Deployment Strategies (Phase 7.6)
// deployment exports: RoutingConfig, CustomMetric, ABTest from its submodules
// These conflict with lambda and observability, so we use explicit exports
export {
  BlueGreenManager,
  blueGreenManager,
  type BlueGreenDeployment,
  type Environment,
  type RoutingConfig as DeploymentRoutingConfig,
  type HealthCheckConfig,
  type DeploymentResult,
} from './deployment/blue-green'
export {
  CanaryManager,
  canaryManager,
  type CanaryDeployment,
  type DeploymentVersion,
  type CanaryStage,
  type AlarmThresholds,
  type CustomMetric as DeploymentCustomMetric,
  type CanaryMetrics,
  type CanaryResult,
} from './deployment/canary'
export {
  ABTestManager,
  abTestManager,
  type ABTest as DeploymentABTest,
  type ABVariant,
  type RoutingStrategy,
  type ABMetrics,
  type VariantMetrics,
  type ABTestResult,
} from './deployment/ab-testing'
export {
  ProgressiveDeploymentManager,
  progressiveDeploymentManager,
  type ProgressiveRollout,
  type FeatureFlag,
  type DeploymentGate,
} from './deployment/progressive'

// Observability (Phase 7.7)
// observability exports CustomMetric from metrics.ts - we prefer this one
// observability/logs exports MetricTransformation which conflicts with modules/monitoring
// We'll use explicit exports to avoid the conflict
export * from './observability/xray'
export * from './observability/metrics'
// observability/logs exports MetricTransformation - we rename it
export {
  LogsManager,
  logsManager,
  type LogGroup,
  type LogStream,
  type MetricFilter,
  type MetricTransformation as LogMetricTransformation,
  type SubscriptionFilter,
  type LogQuery,
  type LogInsightsQuery,
} from './observability/logs'
export {
  SyntheticsManager,
  syntheticsManager,
  type SyntheticCanary,
  type CanaryCode,
  type CanarySchedule,
  type CanaryRunConfig,
  type VpcConfig as SyntheticsVpcConfig,
  type CanaryAlarm,
  type HeartbeatMonitor,
  type ApiMonitor,
  type ApiEndpoint,
  type ApiAssertion,
  type WorkflowStep,
  type WorkflowAction,
} from './observability/synthetics'

// Database Advanced Features (Phase 7.8)
// database exports AutoScalingConfig from replicas.ts
// We'll rename it to avoid conflict with lambda/concurrency
export * from './database/migrations'
export {
  ReplicaManager,
  replicaManager,
  type ReadReplica,
  type ReplicationGroup,
  type LoadBalancingStrategy,
  type AutoScalingConfig as DatabaseAutoScalingConfig,
  type RDSProxy,
  type SessionPinningFilter,
  type ProxyTarget,
  type ConnectionPoolConfig,
} from './database/replicas'
export * from './database/performance'
export * from './database/users'

// Secrets & Security Advanced (Phase 7.9)
// security/secrets-manager exports PolicyStatement which conflicts with modules/permissions
// We prefer PolicyStatement from modules, so rename security's version
export * from './security/secrets-rotation'
export {
  SecretsManager,
  secretsManager,
  type SecretVersion,
  type SecretAudit,
  type SecretAction,
  type ExternalSecretManager,
  type ExternalAuthConfig,
  type SecretReplication,
  type SecretPolicy,
  type PolicyDocument,
  type PolicyStatement as SecurityPolicyStatement,
} from './security/secrets-manager'
export * from './security/certificate-manager'
export * from './security/scanning'

// Container Advanced Features (Phase 7.10)
// containers/registry exports LifecyclePolicy, LifecycleRule, ReplicationRule
// These conflict with s3, so we rename them
export * from './containers/image-scanning'
export * from './containers/build-optimization'
export {
  ContainerRegistryManager,
  containerRegistryManager,
  type ContainerRegistry,
  type RegistryEncryption,
  type ScanningConfig,
  type ScanFilter,
  type LifecyclePolicy as ContainerLifecyclePolicy,
  type LifecycleRule as ContainerLifecycleRule,
  type ReplicationConfig,
  type ReplicationDestination,
  type ReplicationRule as ContainerReplicationRule,
  type RegistryCredentials,
} from './containers/registry'
// containers/service-mesh exports HealthCheck which conflicts with health-checks
// We rename it to MeshHealthCheck
export {
  ServiceMeshManager,
  serviceMeshManager,
  type ServiceMesh,
  type MeshService,
  type VirtualNode,
  type Listener,
  type HealthCheck as MeshHealthCheck,
  type Timeout,
  type TLSConfig,
  type Backend,
  type ClientPolicy,
  type ServiceDiscovery,
  type VirtualRouter,
  type RouterListener,
  type Route,
  type RouteMatch,
  type HeaderMatch,
  type RouteAction,
  type WeightedTarget,
  type RetryPolicy,
  type VirtualGateway,
  type GatewayListener,
} from './containers/service-mesh'

// Lambda Advanced Features (Phase 7.11)
// lambda exports AutoScalingConfig from concurrency.ts and RoutingConfig from versions.ts
// We'll keep the lambda versions as the primary ones
export * from './lambda/layers'
// lambda/versions exports RoutingConfig which conflicts with deployment
// We keep the lambda version as primary
export * from './lambda/versions'
export * from './lambda/concurrency'
export * from './lambda/destinations'
export * from './lambda/vpc'
export * from './lambda/dlq'

// DNS Advanced Features (Phase 7.12)
// dns/routing exports HealthCheck which conflicts with health-checks
// We rename it to DNSHealthCheck
export {
  Route53RoutingManager,
  route53RoutingManager,
  type RoutingPolicy,
  type WeightedRoutingPolicy,
  type LatencyRoutingPolicy,
  type FailoverRoutingPolicy,
  type GeolocationRoutingPolicy,
  type GeoproximityRoutingPolicy,
  type HealthCheck as DNSHealthCheck,
  type CalculatedHealthCheck,
  type TrafficPolicy,
  type TrafficPolicyDocument,
  type TrafficPolicyEndpoint,
  type TrafficPolicyRule,
} from './dns/routing'
export * from './dns/dnssec'
export * from './dns/resolver'

// Email Advanced Features (Phase 7.13)
export * from './email'

// Phone Advanced Features
export * from './phone'

// SMS Advanced Features
export * from './sms'

// Queue Advanced Features (Phase 7.14)
export * from './queue'

// Static Site Features (Phase 7.15)
export * from './static-site'

// S3 Advanced Features (Phase 7.16)
// s3 exports LifecyclePolicy, ReplicationRule which conflict with modules and containers
// We'll rename them with S3 prefix
export {
  StorageAdvancedManager,
  storageAdvancedManager,
  type LifecyclePolicy as S3LifecyclePolicy,
  type VersioningConfig,
  type ReplicationRule as S3ReplicationRule,
  type IntelligentTieringConfig,
  type ObjectLockConfig,
  type TransferAccelerationConfig,
  type AccessPoint,
  type GlacierArchiveConfig,
  type InventoryConfig,
  type BatchOperation,
  type EventNotification,
} from './s3'

// Health Checks & Monitoring (Phase 7.17)
// health-checks exports HealthCheck which conflicts with containers
// We keep health-checks version as primary (it's more specific to health checks)
export * from './health-checks'

// Network Security (Phase 7.18)
export * from './network-security'

// Resource Management (Phase 7.20)
export * from './resource-mgmt'
