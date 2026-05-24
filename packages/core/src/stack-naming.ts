import type { CloudConfig, EnvironmentType, SiteConfig } from './types'

/**
 * CloudFormation stack for project-wide infrastructure (VPC, compute, shared storage).
 * Convention: `{slug}-{environment}` (e.g. `pantry-production`).
 */
export function resolveProjectStackName(
  config: Pick<CloudConfig, 'project'>,
  environment: EnvironmentType,
): string {
  return config.project.stackName ?? `${config.project.slug}-${environment}`
}

/**
 * CloudFormation stack for a static site (S3 + CloudFront + ACM).
 * Convention: `{slug}-{environment}-{siteKey}-site` (e.g. `pantry-production-main-site`).
 */
export function resolveSiteStackName(
  config: Pick<CloudConfig, 'project'>,
  siteKey: string,
  site: Pick<SiteConfig, 'stackName'>,
  environment: EnvironmentType,
): string {
  return site.stackName ?? `${config.project.slug}-${environment}-${siteKey}-site`
}

/**
 * Prefix for site-scoped AWS resource names (deploy tarball paths, systemd units, etc.).
 * Convention: `{slug}-{siteKey}` (e.g. `pantry-main`).
 */
export function resolveSiteResourceName(
  config: Pick<CloudConfig, 'project'>,
  siteKey: string,
): string {
  return `${config.project.slug}-${siteKey}`
}

/**
 * S3 bucket for a site (install script / static assets).
 * Convention: `{slug}-{environment}-site` (e.g. `pantry-production-site`).
 */
export function resolveSiteBucketName(
  slug: string,
  environment: EnvironmentType,
  siteKey: string,
  explicitBucket?: string,
): string {
  if (explicitBucket) return explicitBucket
  if (siteKey === 'main') return `${slug}-${environment}-site`
  return `${slug}-${environment}-${siteKey}`
}

/**
 * S3 bucket name for a storage block in infrastructure.storage.
 * Convention: `{slug}-{environment}-{bucketKey}` unless `bucket` is set on the item.
 */
export function resolveStorageBucketName(
  slug: string,
  environment: EnvironmentType,
  bucketKey: string,
  explicitBucket?: string,
): string {
  return explicitBucket ?? `${slug}-${environment}-${bucketKey}`
}

/**
 * Deploy staging bucket for compute app releases.
 * Convention: `{slug}-{environment}-deploy`.
 */
export function resolveDeployBucketName(slug: string, environment: EnvironmentType): string {
  return `${slug}-${environment}-deploy`
}
