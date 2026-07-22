export * from './config'
export * from './auth'
export * from './automation'
export * from './api'
export * from './control-plane'
export * from './security'
export * from './preview'
export * from './compose'
export * from './generators'

// Validation exports - functions
export {
  validateTemplate,
  validateTemplateSize,
  validateResourceLimits,
} from './validation'

// Validation exports - types with prefixed names for conflicts with @ts-cloud/core
export type {
  ValidationError as TemplateValidationError,
  ValidationResult as TemplateValidationResult,
} from './validation'

// Export AWS module - classes and functions
export {
  AWSClient,
  CloudFormationClient,
  CloudFormationClient as AWSCloudFormationClient,
  CloudFrontClient,
  CloudFrontClient as AWSCloudFrontClient,
  EC2Client,
  S3Client,
  Route53Client,
  Route53DomainsClient,
  ACMClient,
  ACMDnsValidator,
  ECRClient,
  ECSClient,
  STSClient,
  SSMClient,
  SecretsManagerClient,
  SESClient,
  EmailClient,
  SNSClient,
  SQSClient,
  LambdaClient,
  CloudWatchLogsClient,
  ConnectClient,
  ELBv2Client,
  RDSClient,
  DynamoDBClient,
  OpenSearchClient,
  TranscribeClient,
  BedrockClient,
  BedrockRuntimeClient,
  ComprehendClient,
  RekognitionClient,
  TextractClient,
  PollyClient,
  TranslateClient,
  PersonalizeClient,
  KendraClient,
  EventBridgeClient,
  ElastiCacheClient,
  SchedulerClient,
  IAMClient,
  ApplicationAutoScalingClient,
  SmsClient,
  VoiceClient,
  SupportClient,
  EFSClient,
} from './aws'

// Export AWS module - types with prefixed names where needed
export type {
  AWSRequestOptions,
  AWSClientConfig,
  AWSError,
  AWSCredentials as AWSClientCredentials,
  StackParameter,
  StackTag,
  CreateStackOptions,
  UpdateStackOptions,
  DescribeStacksOptions,
  StackEvent,
  Stack,
  InvalidationOptions,
  Distribution,
  S3SyncOptions,
  S3CopyOptions,
  S3ListOptions,
  S3Object,
  CertificateDetail,
  Certificate as ELBv2Certificate,
  RekognitionS3Object,
  RekognitionBoundingBox,
  TextractS3Object,
  TextractBoundingBox,
  CountryCode,
  ContactType,
  ContactDetail,
  KendraCreateDataSourceCommandInput,
  KendraCreateDataSourceCommandOutput,
  KendraListDataSourcesCommandInput,
  KendraListDataSourcesCommandOutput,
  InvokeModelCommandInput,
  InvokeModelCommandOutput,
  InvokeModelWithResponseStreamCommandInput,
  InvokeModelWithResponseStreamCommandOutput,
  CreateModelCustomizationJobCommandInput,
  CreateModelCustomizationJobCommandOutput,
  GetModelCustomizationJobCommandInput,
  GetModelCustomizationJobCommandOutput,
  ListFoundationModelsCommandInput,
  ListFoundationModelsCommandOutput,
  AttributeValue as DynamoDBAttributeValue,
  KeySchemaElement,
  AttributeDefinition as DynamoDBAttributeDefinition,
} from './aws'

// Multi-provider object storage (AWS S3, Backblaze B2, Hetzner Object Storage)
export {
  createObjectStorageClient,
  providerEndpoint,
  resolveObjectStorage,
} from './object-storage'
export type {
  ObjectStorageConfig,
  ObjectStorageCredentials,
  ObjectStorageProvider,
  ResolvedObjectStorage,
} from './object-storage'
export {
  keyMatchesFilters,
  migrateObjectStorage,
  remapKey,
} from './object-storage/migrate'
export type {
  MigrateEndpoint,
  MigrateError,
  MigrateOptions,
  MigratePlanItem,
  MigrateProgress,
  MigrateResult,
  MigrateVerification,
} from './object-storage/migrate'

export * from './ssl'

// Export deployment modules
export {
  deployStaticSite,
  deployStaticSiteFull,
  uploadStaticFiles,
  invalidateCache,
  deleteStaticSite,
  generateStaticSiteTemplate,
  // External DNS support
  deployStaticSiteWithExternalDns,
  deployStaticSiteWithExternalDnsFull,
  generateExternalDnsStaticSiteTemplate,
  // High-level helper with smart defaults (Porkbun, non-SPA, etc.)
  deploySite,
  // Per-site deploy-target model (resolver + validation)
  resolveSiteDeployTarget,
  resolveSiteKind,
  validateDeploymentConfig,
  // Serverless application pipeline (Laravel-Vapor-equivalent)
  buildAndPushServerlessImage,
  buildFunctionEnv,
  deployServerlessApp,
  infraEnvFromOutputs,
  redeployServerlessApp,
  rollbackServerlessApp,
  runRemoteCommand,
  setMaintenance,
  // Management-dashboard auto-deploy (inject the `dashboard.<apex>` site)
  buildManagementDashboardArtifact,
  DASHBOARD_CREDENTIALS_FILE,
  ensureManagementDashboard,
  MANAGEMENT_DASHBOARD_SITE,
  resolveDashboardAuth,
  resolveUiSource,
} from './deploy'
export {
  collectServerDnsDomains,
  removeStaleServerAddressRecords,
} from './deploy/server-dns'
export type {
  EnsureDashboardLogger,
  ResolvedDashboardAuth,
  StaticSiteConfig,
  DeployResult,
  UploadOptions,
  // External DNS types
  ExternalDnsStaticSiteConfig,
  ExternalDnsDeployResult,
  // Helper types
  DeploySiteConfig,
  DeploySiteResult,
  StaticSiteDnsProvider,
  // Per-site deploy-target model
  SiteDeployKind,
  DeploymentValidationResult,
  // Serverless application pipeline
  BuildImageOptions,
  BuiltImage,
  CodeSource,
  DeployServerlessOptions,
  ResolvedContext,
} from './deploy'

// Export cloud drivers
export {
  createCloudDriver,
  CloudDriverFactory,
  cloudDrivers,
  AwsDriver,
  HetznerDriver,
  HetznerClient,
  resolveHetznerApiToken,
  normalizeSshPublicKey,
  ensureFirewall,
  ensureServer,
  ensureSshKey,
  serverPublicIpv4,
  sshExec,
  sshExecOrThrow,
  scpUpload,
  waitForSsh,
  waitForCloudInit,
  buildSshArgs,
  generateUbuntuAppCloudInit,
  wrapCloudInitUserData,
  buildHostCleanupScript,
  buildSiteDeployScript,
  buildStaticSiteDeployScript,
  resolveExecStart,
  deployAllComputeSites,
  deploySiteRelease,
} from './drivers'
export type { CreateCloudDriverOptions } from './drivers/factory'
export {
  dashboardActions,
  resolveDashboardAction,
  sanitizeCloudConfig,
  startLocalDashboardServer,
} from './deploy/local-dashboard-server'
export type {
  DashboardAction,
  LocalDashboardServer,
  LocalDashboardServerOptions,
} from './deploy/local-dashboard-server'

// Export DNS providers
export {
  createDnsProvider,
  detectDnsProvider,
  DnsProviderFactory,
  dnsProviders,
  PorkbunProvider,
  GoDaddyProvider,
  Route53Provider,
  UnifiedDnsValidator,
  createPorkbunValidator,
  createGoDaddyValidator,
  createRoute53Validator,
} from './dns'

// Provider-neutral Git source connections, repository bindings, and webhooks
export * from './source'
export * from './queue'
export type {
  DnsProvider,
  DnsProviderConfig,
  DnsRecord,
  DnsRecordType,
  DnsRecordResult,
  CreateRecordResult,
  DeleteRecordResult,
  ListRecordsResult,
} from './dns'

// Re-export core functionality (these take precedence for common types)
export * from '@ts-cloud/core'

// Re-export @ts-cloud/aws-types with explicit handling for duplicates
// Note: @ts-cloud/core also exports CloudFormation* types, so we skip re-exporting them here
// to avoid duplicates. Users can import directly from @ts-cloud/aws-types if needed.
export type {
  // S3 types
  S3Bucket,
  S3BucketPolicy,
  // CloudFront types
  CloudFrontDistribution,
  CloudFrontOriginAccessControl,
  CloudFrontCacheBehavior,
  CloudFrontOrigin,
} from '@ts-cloud/aws-types'
