// AWS Signature V4
export {
  signRequest,
  signRequestAsync,
  makeAWSRequest,
  makeAWSRequestAsync,
  makeAWSRequestOnce,
  createPresignedUrl,
  createPresignedUrlAsync,
  detectServiceRegion,
  clearSigningKeyCache,
  getSigningKeyCacheSize,
  parseXMLResponse,
  parseJSONResponse,
  isNodeCryptoAvailable,
  isWebCryptoAvailable,
} from './signature'

export type {
  SignatureOptions,
  SignedRequest,
  PresignedUrlOptions,
  RetryOptions,
} from './signature'

// AWS Credentials
export {
  // New credential providers
  fromEnvironment,
  fromSharedCredentials,
  fromEC2Metadata,
  fromECSMetadata,
  fromWebIdentity,
  getCredentials,
  createCredentialProvider,
  // Backwards compatibility
  resolveCredentials,
  resolveRegion,
  getAccountId,
} from './credentials'

export type {
  AWSCredentials,
  AWSProfile,
  CredentialProviderOptions,
} from './credentials'

// CloudFormation Client
export {
  CloudFormationClient,
} from './cloudformation'

export type {
  CloudFormationStack,
  CreateStackOptions,
  UpdateStackOptions,
  StackEvent,
} from './cloudformation'

// S3 Client (High-Level API)
export {
  S3Client,
  S3Error,
  createS3Client,
} from './s3'

export type {
  S3ClientOptions,
  GetObjectOptions,
  PutObjectOptions,
  ListObjectsOptions,
  ListObjectsResult,
  S3Object,
  HeadObjectResult,
  CopyObjectOptions,
  MultipartUploadOptions,
  MultipartProgress,
} from './s3'

// CloudFront Client
export {
  CloudFrontClient,
} from './cloudfront'

export type {
  InvalidationOptions,
} from './cloudfront'
