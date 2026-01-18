export * from './config'
// Note: ./types re-exports @ts-cloud/types, which we export below
// export * from './types'
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
  CloudFormationClient as AWSCloudFormationClient,
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
  KendraCreateDataSourceCommandInput,
  KendraCreateDataSourceCommandOutput,
  KendraListDataSourcesCommandInput,
  KendraListDataSourcesCommandOutput,
} from './aws'

export * from './ssl'

// Export deployment modules
export {
  deployStaticSite,
  deployStaticSiteFull,
  uploadStaticFiles,
  invalidateCache,
  deleteStaticSite,
  generateStaticSiteTemplate,
} from './deploy'
export type {
  StaticSiteConfig,
  DeployResult,
  UploadOptions,
} from './deploy'

// Re-export core functionality (these take precedence for common types)
export * from '@ts-cloud/core'

// Re-export @ts-cloud/types (includes VpcConfig, etc.)
export * from '@ts-cloud/types'

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
