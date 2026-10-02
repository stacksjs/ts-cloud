/**
 * CloudFront origin failover (origin groups).
 *
 * An origin group pairs a primary origin with a secondary one. On a cache miss
 * CloudFront asks the primary; when the primary returns one of the configured
 * status codes, or cannot be reached (503) or times out (504), CloudFront
 * retries the same request against the secondary.
 *
 * These are pure builders: they produce the `OriginGroups` block and check the
 * constraints CloudFront enforces, so every distribution builder in ts-cloud
 * emits the same shape. The block is identical in a CloudFormation
 * `AWS::CloudFront::Distribution` and in the CloudFront API's
 * `DistributionConfig`:
 *
 * ```
 * OriginGroups: {
 *   Quantity: 1,
 *   Items: [{
 *     Id,
 *     FailoverCriteria: { StatusCodes: { Quantity, Items: [500, 502, ...] } },
 *     Members: { Quantity: 2, Items: [{ OriginId: primary }, { OriginId: secondary }] },
 *   }],
 * }
 * ```
 *
 * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/high_availability_origin_failover.html
 * @experimental Built against the AWS documentation; not yet exercised against a live distribution.
 */

/** Every status code CloudFront accepts as a failover criterion. */
export const CLOUDFRONT_FAILOVER_STATUS_CODES: readonly number[] = [400, 403, 404, 416, 429, 500, 502, 503, 504]

/** Server-side failures: what ts-cloud fails over on when no codes are given. */
export const DEFAULT_FAILOVER_STATUS_CODES: readonly number[] = [500, 502, 503, 504]

/**
 * The only methods a cache behavior may allow when it targets an origin group.
 * CloudFront never fails over a write, so a behavior that accepts writes cannot
 * point at a group.
 */
export const ORIGIN_GROUP_ALLOWED_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS']

/** Suffix appended to the primary origin id to name its origin group. */
export const ORIGIN_GROUP_ID_SUFFIX = '-failover-group'

export interface OriginGroupOptions {
  /** Id of the origin CloudFront asks first. */
  primaryOriginId: string
  /** Id of the origin CloudFront retries against when the primary fails. */
  secondaryOriginId: string
  /** Status codes from the primary that trigger failover. @default [500, 502, 503, 504] */
  statusCodes?: readonly number[]
  /** Origin group id, which cache behaviors use as their `TargetOriginId`. @default `<primaryOriginId>-failover-group` */
  groupId?: string
}

export interface CloudFrontOriginGroup {
  Id: string
  FailoverCriteria: { StatusCodes: { Quantity: number; Items: number[] } }
  Members: { Quantity: number; Items: Array<{ OriginId: string }> }
}

export interface CloudFrontOriginGroups {
  Quantity: number
  Items: CloudFrontOriginGroup[]
}

/**
 * Validate failover status codes and return them deduplicated and sorted.
 * With no codes, returns {@link DEFAULT_FAILOVER_STATUS_CODES}.
 *
 * @throws when the list is empty or holds a code CloudFront does not accept.
 */
export function resolveFailoverStatusCodes(statusCodes?: readonly number[]): number[] {
  if (statusCodes === undefined) return [...DEFAULT_FAILOVER_STATUS_CODES]

  if (statusCodes.length === 0) {
    throw new Error(
      `CloudFront origin failover: statusCodes must list at least one code (allowed: ${CLOUDFRONT_FAILOVER_STATUS_CODES.join(', ')}). Omit it to use the default ${DEFAULT_FAILOVER_STATUS_CODES.join(', ')}.`,
    )
  }

  const invalid = statusCodes.filter((code) => !CLOUDFRONT_FAILOVER_STATUS_CODES.includes(code))
  if (invalid.length > 0) {
    throw new Error(
      `CloudFront origin failover: ${invalid.join(', ')} ${invalid.length === 1 ? 'is not a status code' : 'are not status codes'} CloudFront can fail over on. Allowed: ${CLOUDFRONT_FAILOVER_STATUS_CODES.join(', ')}.`,
    )
  }

  return [...new Set(statusCodes)].sort((a, b) => a - b)
}

/** Build one origin group (primary first, secondary second). */
export function buildOriginGroup(options: OriginGroupOptions): CloudFrontOriginGroup {
  const { primaryOriginId, secondaryOriginId } = options
  if (!primaryOriginId || !secondaryOriginId) {
    throw new Error('CloudFront origin failover: both a primary and a secondary origin id are required')
  }
  if (primaryOriginId === secondaryOriginId) {
    throw new Error(
      `CloudFront origin failover: the secondary origin must differ from the primary (both are "${primaryOriginId}")`,
    )
  }

  const codes = resolveFailoverStatusCodes(options.statusCodes)

  return {
    Id: options.groupId ?? `${primaryOriginId}${ORIGIN_GROUP_ID_SUFFIX}`,
    FailoverCriteria: { StatusCodes: { Quantity: codes.length, Items: codes } },
    Members: { Quantity: 2, Items: [{ OriginId: primaryOriginId }, { OriginId: secondaryOriginId }] },
  }
}

/** Build a distribution's `OriginGroups` block holding a single failover group. */
export function buildOriginGroups(options: OriginGroupOptions): CloudFrontOriginGroups {
  return { Quantity: 1, Items: [buildOriginGroup(options)] }
}

/**
 * Throw unless a cache behavior that targets an origin group allows only
 * GET, HEAD and OPTIONS.
 *
 * Accepts either the CloudFormation form (`['GET', 'HEAD']`) or the CloudFront
 * API form (`{ Quantity, Items: [...] }`) of `AllowedMethods`.
 *
 * @param where Names the behavior in the error, e.g. `the default cache behavior`.
 */
export function assertOriginGroupMethods(
  allowedMethods: readonly string[] | { Items?: readonly string[] } | undefined,
  where = 'the cache behavior',
): void {
  // CloudFront's own default for an unset AllowedMethods is GET + HEAD.
  const methods = Array.isArray(allowedMethods)
    ? allowedMethods
    : ((allowedMethods as { Items?: readonly string[] } | undefined)?.Items ?? [])
  const writes = methods.filter((method) => !ORIGIN_GROUP_ALLOWED_METHODS.includes(method.toUpperCase()))
  if (writes.length > 0) {
    throw new Error(
      `CloudFront origin failover: ${where} allows ${writes.join(', ')}, but a cache behavior that targets an origin group may only allow ${ORIGIN_GROUP_ALLOWED_METHODS.join(', ')}. CloudFront never fails over a write, so point the write paths at a single origin in their own cache behavior.`,
    )
  }
}

/**
 * Whether a domain is an S3 REST endpoint (and so takes an `S3OriginConfig`).
 * S3 *website* endpoints only speak HTTP and are custom origins.
 */
export function isS3RestEndpoint(domainName: string): boolean {
  return /\.s3[.-](?:[a-z0-9-]+\.)?amazonaws\.com(?:\.cn)?$/i.test(domainName) && !/s3-website/i.test(domainName)
}
