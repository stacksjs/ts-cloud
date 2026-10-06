/**
 * Cloudflare R2: bucket management through the account API, S3 credentials
 * derived from an API token, and the deploy-time reconcile for `infrastructure.r2`.
 */
export type {
  R2ApiLifecycleRule,
  R2Bucket,
  R2BucketScope,
  R2CustomDomain,
  R2ManagedDomain,
  R2ProviderOptions,
  R2S3Credentials,
} from './provider'
export {
  R2_NOT_ENABLED_ERROR_CODE,
  R2ApiError,
  r2Endpoint,
  R2NotEnabledError,
  R2Provider,
  r2S3Credentials,
  sameCorsRules,
  sameLifecycleRules,
} from './provider'
export type {
  R2BucketSummary,
  R2ConfigSource,
  R2ReconcileSummary,
  ReconcileR2BucketsOptions,
} from './reconcile'
export {
  cacheRuleParameters,
  domainStatus,
  managedRuleInSync,
  reconcileR2Buckets,
  toApiLifecycleRule,
} from './reconcile'
