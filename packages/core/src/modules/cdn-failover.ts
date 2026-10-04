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
 * {@link validateOriginGroups} checks a whole distribution config the same way
 * CloudFront does, so a distribution assembled by hand fails at template
 * generation instead of half way through a CloudFormation deploy.
 *
 * Verified against a live distribution (S3 origins in two regions, failover on
 * a missing object and on a primary that denies every read) for
 * stacksjs/stacks#1159.
 *
 * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/high_availability_origin_failover.html
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

/**
 * How CloudFront picks the origin it asks first.
 *
 * - `default`: always the primary (the first member), falling back to the
 *   secondary on a failover status code.
 * - `media-quality-based`: CloudFront scores both origins and asks the better
 *   one first. Only valid when both members are AWS Elemental MediaPackage v2
 *   endpoints.
 */
export type OriginGroupSelectionCriteria = 'default' | 'media-quality-based'

export const ORIGIN_GROUP_SELECTION_CRITERIA: readonly OriginGroupSelectionCriteria[] = ['default', 'media-quality-based']

/** `ConnectionAttempts` CloudFront accepts on an origin (its default is 3). */
export const ORIGIN_CONNECTION_ATTEMPTS = { min: 1, max: 3 } as const

/** `ConnectionTimeout`, in seconds, CloudFront accepts on an origin (its default is 10). */
export const ORIGIN_CONNECTION_TIMEOUT = { min: 1, max: 10 } as const

export interface OriginGroupOptions {
  /** Id of the origin CloudFront asks first. */
  primaryOriginId: string
  /** Id of the origin CloudFront retries against when the primary fails. */
  secondaryOriginId: string
  /** Status codes from the primary that trigger failover. @default [500, 502, 503, 504] */
  statusCodes?: readonly number[]
  /** Origin group id, which cache behaviors use as their `TargetOriginId`. @default `<primaryOriginId>-failover-group` */
  groupId?: string
  /**
   * How CloudFront picks the origin it asks first. Omitted from the template
   * unless set, which CloudFront treats as `default`.
   */
  selectionCriteria?: OriginGroupSelectionCriteria
}

export interface CloudFrontOriginGroup {
  Id: string
  FailoverCriteria: { StatusCodes: { Quantity: number; Items: number[] } }
  Members: { Quantity: number; Items: Array<{ OriginId: string }> }
  SelectionCriteria?: OriginGroupSelectionCriteria
}

/** Connection tuning for one origin. Unset keys keep CloudFront's defaults (3 attempts, 10 seconds). */
export interface OriginConnectionOptions {
  /** Times CloudFront tries to connect to the origin, 1-3. */
  connectionAttempts?: number
  /** Seconds CloudFront waits to establish a connection, 1-10. */
  connectionTimeout?: number
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
  assertSelectionCriteria(options.selectionCriteria)

  return {
    Id: options.groupId ?? `${primaryOriginId}${ORIGIN_GROUP_ID_SUFFIX}`,
    FailoverCriteria: { StatusCodes: { Quantity: codes.length, Items: codes } },
    Members: { Quantity: 2, Items: [{ OriginId: primaryOriginId }, { OriginId: secondaryOriginId }] },
    ...(options.selectionCriteria ? { SelectionCriteria: options.selectionCriteria } : {}),
  }
}

function assertSelectionCriteria(value: unknown, where = 'the origin group'): void {
  if (value === undefined) return
  if (!ORIGIN_GROUP_SELECTION_CRITERIA.includes(value as OriginGroupSelectionCriteria)) {
    throw new Error(
      `CloudFront origin failover: ${where} has selection criteria ${JSON.stringify(value)}. Allowed: ${ORIGIN_GROUP_SELECTION_CRITERIA.join(', ')}.`,
    )
  }
}

function assertIntegerInRange(value: unknown, range: { min: number; max: number }, what: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < range.min || value > range.max) {
    throw new Error(
      `CloudFront origin: ${what} must be a whole number from ${range.min} to ${range.max}, got ${JSON.stringify(value)}.`,
    )
  }
}

/**
 * Validate an origin's connection tuning and return it in template form
 * (`ConnectionAttempts` / `ConnectionTimeout`), holding only the keys that were
 * set so an untuned origin's template is unchanged.
 *
 * Lowering these on the primary is how failover gets faster: by default
 * CloudFront spends up to 30 seconds (3 attempts of 10 seconds) on an
 * unreachable primary before it asks the secondary.
 *
 * @param where Names the origin in the error, e.g. `infrastructure.cdn.main`.
 * @throws when a value is not a whole number in CloudFront's range.
 */
export function resolveOriginConnection(
  options: OriginConnectionOptions | undefined,
  where = 'the origin',
): { ConnectionAttempts?: number; ConnectionTimeout?: number } {
  const out: { ConnectionAttempts?: number; ConnectionTimeout?: number } = {}
  if (options?.connectionAttempts !== undefined) {
    assertIntegerInRange(options.connectionAttempts, ORIGIN_CONNECTION_ATTEMPTS, `${where} connectionAttempts`)
    out.ConnectionAttempts = options.connectionAttempts
  }
  if (options?.connectionTimeout !== undefined) {
    assertIntegerInRange(options.connectionTimeout, ORIGIN_CONNECTION_TIMEOUT, `${where} connectionTimeout (seconds)`)
    out.ConnectionTimeout = options.connectionTimeout
  }
  return out
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

/** Either list shape CloudFront config uses: a CloudFormation array, or the API's `{ Quantity, Items }`. */
type ListLike<T> = readonly T[] | { Quantity?: number; Items?: readonly T[] } | undefined

function itemsOf<T>(list: ListLike<T>): readonly T[] {
  if (!list) return []
  if (Array.isArray(list)) return list as readonly T[]
  return (list as { Items?: readonly T[] }).Items ?? []
}

/** A string id, or undefined for a CloudFormation intrinsic (`{ Ref }`, `{ 'Fn::Sub' }`) that only resolves at deploy. */
function literal(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** MediaPackage v2 egress endpoints, the only origins `media-quality-based` selection works with. */
const MEDIAPACKAGE_V2_DOMAIN = /\.mediapackagev2\.[a-z0-9-]+\.amazonaws\.com$/i

/**
 * Check every origin group in a distribution config against the rules
 * CloudFront enforces, and throw a message that names the broken piece.
 *
 * Accepts the CloudFormation `DistributionConfig` (arrays) and the CloudFront
 * API's (`{ Quantity, Items }`), and skips comparisons on values that are
 * CloudFormation intrinsics. Checked:
 *
 * - each group has exactly two members, both existing origins, and distinct;
 * - group ids are unique and do not shadow an origin id;
 * - failover status codes are ones CloudFront accepts, and `Quantity` matches;
 * - `SelectionCriteria` is `default` or `media-quality-based`, the latter only
 *   between MediaPackage v2 origins;
 * - every cache behavior (default and path) that targets a group allows only
 *   GET, HEAD and OPTIONS;
 * - every cache behavior targets an origin or group that exists;
 * - every origin's `ConnectionAttempts` (1-3) and `ConnectionTimeout` (1-10).
 *
 * A distribution with no origin groups passes the group checks trivially.
 *
 * @param where Names the distribution in errors, e.g. `infrastructure.cdn.main`.
 */
export function validateOriginGroups(distributionConfig: Record<string, any>, where = 'the distribution'): void {
  const origins = itemsOf<Record<string, any>>(distributionConfig.Origins)
  const originIds = new Set(origins.map((origin) => literal(origin.Id)).filter((id): id is string => !!id))
  const domainById = new Map<string, unknown>(origins.map((origin) => [literal(origin.Id) ?? '', origin.DomainName]))
  const hasIntrinsicOriginId = origins.some((origin) => literal(origin.Id) === undefined)

  for (const origin of origins) {
    const id = literal(origin.Id) ?? '(unnamed origin)'
    if (origin.ConnectionAttempts !== undefined) {
      assertIntegerInRange(origin.ConnectionAttempts, ORIGIN_CONNECTION_ATTEMPTS, `${where} origin "${id}" ConnectionAttempts`)
    }
    if (origin.ConnectionTimeout !== undefined) {
      assertIntegerInRange(
        origin.ConnectionTimeout,
        ORIGIN_CONNECTION_TIMEOUT,
        `${where} origin "${id}" ConnectionTimeout (seconds)`,
      )
    }
  }

  const groupsBlock = distributionConfig.OriginGroups as { Quantity?: number; Items?: unknown[] } | undefined
  const groups = itemsOf<Record<string, any>>(groupsBlock as ListLike<Record<string, any>>)
  if (groupsBlock && !Array.isArray(groupsBlock) && groupsBlock.Quantity !== undefined && groupsBlock.Quantity !== groups.length) {
    throw new Error(
      `CloudFront origin failover: ${where} OriginGroups.Quantity is ${groupsBlock.Quantity} but it lists ${groups.length} group(s).`,
    )
  }

  const groupIds = new Set<string>()
  for (const group of groups) {
    const groupId = literal(group.Id)
    if (group.Id === undefined || group.Id === '') {
      throw new Error(`CloudFront origin failover: ${where} has an origin group without an Id.`)
    }
    const label = `${where} origin group "${groupId ?? '(intrinsic id)'}"`
    if (groupId) {
      if (groupIds.has(groupId)) throw new Error(`CloudFront origin failover: ${where} declares origin group "${groupId}" twice.`)
      if (originIds.has(groupId)) {
        throw new Error(
          `CloudFront origin failover: ${label} has the same id as an origin. Cache behaviors target groups and origins by id, so the two must differ.`,
        )
      }
      groupIds.add(groupId)
    }

    const membersBlock = group.Members as { Quantity?: number; Items?: Array<{ OriginId?: unknown }> } | undefined
    const members = itemsOf(membersBlock as ListLike<{ OriginId?: unknown }>)
    if (members.length !== 2 || (membersBlock?.Quantity !== undefined && membersBlock.Quantity !== members.length)) {
      throw new Error(
        `CloudFront origin failover: ${label} must have exactly 2 members (a primary and a secondary), it has ${members.length}${membersBlock?.Quantity !== undefined && membersBlock.Quantity !== members.length ? ` with Quantity ${membersBlock.Quantity}` : ''}.`,
      )
    }
    const memberIds = members.map((member) => literal(member.OriginId))
    for (const memberId of memberIds) {
      if (memberId && !originIds.has(memberId) && !hasIntrinsicOriginId) {
        throw new Error(
          `CloudFront origin failover: ${label} lists member "${memberId}", which is not an origin of this distribution. Origins: ${[...originIds].join(', ') || '(none)'}.`,
        )
      }
    }
    if (memberIds[0] && memberIds[0] === memberIds[1]) {
      throw new Error(`CloudFront origin failover: ${label} lists "${memberIds[0]}" as both primary and secondary.`)
    }

    const statusCodes = group.FailoverCriteria?.StatusCodes as { Quantity?: number; Items?: number[] } | undefined
    const codes = itemsOf(statusCodes as ListLike<number>)
    resolveFailoverStatusCodes(codes)
    if (statusCodes?.Quantity !== undefined && statusCodes.Quantity !== codes.length) {
      throw new Error(
        `CloudFront origin failover: ${label} FailoverCriteria.StatusCodes.Quantity is ${statusCodes.Quantity} but it lists ${codes.length} code(s).`,
      )
    }

    assertSelectionCriteria(group.SelectionCriteria, label)
    if (group.SelectionCriteria === 'media-quality-based') {
      for (const memberId of memberIds) {
        const domain = memberId ? literal(domainById.get(memberId)) : undefined
        if (domain && !MEDIAPACKAGE_V2_DOMAIN.test(domain)) {
          throw new Error(
            `CloudFront origin failover: ${label} uses media-quality-based selection, which only works between AWS Elemental MediaPackage v2 origins, but member "${memberId}" is ${domain}. Use 'default'.`,
          )
        }
      }
    }
  }

  const behaviors: Array<{ behavior: Record<string, any>; name: string }> = []
  if (distributionConfig.DefaultCacheBehavior) {
    behaviors.push({ behavior: distributionConfig.DefaultCacheBehavior, name: 'the default cache behavior' })
  }
  for (const behavior of itemsOf<Record<string, any>>(distributionConfig.CacheBehaviors)) {
    behaviors.push({ behavior, name: `the cache behavior for ${JSON.stringify(behavior.PathPattern)}` })
  }

  for (const { behavior, name } of behaviors) {
    const target = literal(behavior.TargetOriginId)
    if (!target) continue
    if (groupIds.has(target)) {
      // CloudFront's own default for an unset AllowedMethods is GET + HEAD.
      assertOriginGroupMethods(behavior.AllowedMethods ?? ['GET', 'HEAD'], `${name} of ${where} (origin group "${target}")`)
    } else if (!originIds.has(target) && !hasIntrinsicOriginId && groups.every((group) => literal(group.Id) !== undefined)) {
      throw new Error(
        `CloudFront: ${name} of ${where} targets "${target}", which is neither an origin nor an origin group of this distribution.`,
      )
    }
  }
}
