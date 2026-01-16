// AWS Signature V4
export {
  signRequest,
  makeAWSRequest,
  parseXMLResponse,
  parseJSONResponse,
} from './signature'

export type {
  SignatureOptions,
  SignedRequest,
} from './signature'

// AWS Credentials
export {
  resolveCredentials,
  resolveRegion,
  getAccountId,
} from './credentials'

export type {
  AWSCredentials,
  AWSProfile,
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

// S3 Client
export {
  S3Client,
} from './s3'

export type {
  S3UploadOptions,
  S3MultipartUploadOptions,
} from './s3'

// CloudFront Client
export {
  CloudFrontClient,
} from './cloudfront'

export type {
  InvalidationOptions,
} from './cloudfront'
