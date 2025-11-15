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
