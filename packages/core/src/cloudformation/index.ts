// CloudFormation template builder
export {
  CloudFormationBuilder,
  buildCloudFormationTemplate,
} from './builder'

// CloudFormation types
export type {
  CloudFormationTemplate,
  CloudFormationResource,
  CloudFormationParameter,
  CloudFormationOutput,
  CloudFormationCondition,
  CloudFormationIntrinsicFunction,
} from './types'

export {
  Fn,
  Arn,
  AWS_PSEUDO_PARAMETERS,
} from './types'

// Resource builders
export { addNetworkResources } from './builders/network'
export { addStorageResources } from './builders/storage'
export { addComputeResources } from './builders/compute'
export { addDatabaseResources } from './builders/database'
export { addFunctionResources } from './builders/functions'
export { addQueueResources } from './builders/queue'
export type { QueueConfig } from './builders/queue'
