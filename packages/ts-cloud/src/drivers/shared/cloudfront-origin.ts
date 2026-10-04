/**
 * CloudFront-in-front-of-a-custom-origin distribution config.
 *
 * When a self-hosted gateway (rpx on a Hetzner box) is the origin behind
 * CloudFront, the distribution needs a very specific shape — and several
 * non-obvious settings will silently break it if wrong. This builder encodes
 * the working configuration so it can't regress:
 *
 *  - **One custom origin**, the dedicated origin host (e.g. `origin.example.com`),
 *    HTTPS-only. It must NOT be a public alias (that loops) and can't be a bare IP.
 *  - **Host forwarding** via the AWS-managed `AllViewer` origin-request policy, so
 *    the box receives `Host: <alias>` and routes by it (not by the origin host).
 *  - **No `DefaultRootObject`.** Setting it to `index.html` makes CloudFront fetch
 *    `/index.html`, which a gateway with clean-URLs 301-redirects back to `/` — an
 *    infinite loop. Leave it empty and let the origin serve `/`.
 *  - **No CloudFront Functions / Lambda@Edge.** S3-era URL-rewrite functions fight
 *    a gateway that already does its own path-mounting + clean URLs (→ 301 loops).
 *  - **Dynamic paths** (e.g. `/api/*`) use the managed `CachingDisabled` policy and
 *    allow all HTTP methods; **static paths** use `CachingOptimized`.
 *  - **Origin lockdown header** (optional): a secret injected on the origin hop,
 *    paired with rpx `createOriginGuard`, so the publicly-resolvable origin can't
 *    be used to bypass the CDN.
 *
 *  - **Origin failover** (optional, experimental): a second box, the
 *    `failoverOriginDomain`, grouped with the primary in a CloudFront origin
 *    group. The default (static, GET/HEAD/OPTIONS) behavior targets the group;
 *    path behaviors keep the primary, since CloudFront never fails over writes.
 *
 * The result is a complete `DistributionConfig` suitable for CloudFront
 * `CreateDistribution` or `UpdateDistribution`.
 */
import { assertOriginGroupMethods, buildOriginGroups, resolveOriginConnection, validateOriginGroups } from '@ts-cloud/core'

/** AWS-managed cache/origin-request policy IDs (identical across all accounts). */
export const MANAGED_CACHE_POLICY_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6'
export const MANAGED_CACHE_POLICY_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad'
export const MANAGED_ORIGIN_REQUEST_POLICY_ALL_VIEWER = '216adef6-5c7f-47e4-b989-5492eafa07d3'

export interface OriginFrontedBehavior {
  /** Path pattern this behavior owns, e.g. `/api/*`, `/docs`, `/docs/*`. */
  pathPattern: string
  /** `dynamic` → no caching + all methods (apps/APIs); `static` → cached (CachingOptimized). */
  kind: 'dynamic' | 'static'
}

export interface BuildCloudFrontOriginOptions {
  /** Public aliases (CNAMEs) on the distribution, e.g. `['example.com', 'www.example.com']`. */
  aliases: string[]
  /** Dedicated origin hostname CloudFront connects to. MUST resolve to the box, MUST NOT be an alias. */
  originDomain: string
  /** ACM certificate ARN (us-east-1) covering {@link aliases}. */
  viewerCertificateArn: string
  /** Per-path behaviors layered over the default. The default behavior (`/`) is always `static`. */
  behaviors?: OriginFrontedBehavior[]
  /** Secret injected on the origin hop (paired with rpx `createOriginGuard`). Omit to leave the origin open. */
  originSecret?: string
  /** Header carrying {@link originSecret}. @default 'X-Origin-Verify' */
  originSecretHeader?: string
  /** Stable id used to deterministically derive `CallerReference`. @default originDomain */
  callerReference?: string
  /** Distribution comment. */
  comment?: string
  /** `PriceClass_All` | `PriceClass_200` | `PriceClass_100`. @default 'PriceClass_All' */
  priceClass?: string
  /** Enable CloudFront Origin Shield for the custom origin. @default false */
  originShield?: boolean
  /** AWS region used by Origin Shield. Required when {@link originShield} is enabled. */
  originShieldRegion?: string
  /**
   * Hostname of a second box CloudFront fails over to when {@link originDomain}
   * errors. Same rules as {@link originDomain}: it must not be an alias. It
   * receives the same origin secret header, so lock it down the same way.
   * The default cache behavior targets the origin group; path behaviors stay
   * on the primary.
   */
  failoverOriginDomain?: string
  /**
   * Primary-origin status codes that trigger failover. Allowed: 400, 403, 404,
   * 416, 429, 500, 502, 503, 504. @default [500, 502, 503, 504]
   */
  failoverStatusCodes?: number[]
  /**
   * Times CloudFront tries to connect to {@link originDomain}, 1-3. @default 3
   *
   * With {@link connectionTimeout} this bounds how long an unreachable primary
   * holds a request before CloudFront fails over (3 x 10 seconds by default).
   */
  connectionAttempts?: number
  /** Seconds CloudFront waits to connect to {@link originDomain}, 1-10. @default 10 */
  connectionTimeout?: number
}

const ORIGIN_ID = 'origin'
const FAILOVER_ORIGIN_ID = 'origin-failover'

function cacheBehavior(pathPattern: string | null, kind: 'dynamic' | 'static') {
  const base: Record<string, any> = {
    TargetOriginId: ORIGIN_ID,
    ViewerProtocolPolicy: 'redirect-to-https',
    Compress: true,
    CachePolicyId: kind === 'dynamic' ? MANAGED_CACHE_POLICY_DISABLED : MANAGED_CACHE_POLICY_OPTIMIZED,
    OriginRequestPolicyId: MANAGED_ORIGIN_REQUEST_POLICY_ALL_VIEWER,
    // Forwarded values must be absent when a CachePolicyId is set.
    SmoothStreaming: false,
    FieldLevelEncryptionId: '',
    TrustedSigners: { Enabled: false, Quantity: 0 },
    TrustedKeyGroups: { Enabled: false, Quantity: 0 },
    LambdaFunctionAssociations: { Quantity: 0 },
    FunctionAssociations: { Quantity: 0 },
    AllowedMethods:
      kind === 'dynamic'
        ? {
            Quantity: 7,
            Items: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
            CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] },
          }
        : { Quantity: 3, Items: ['GET', 'HEAD', 'OPTIONS'], CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] } },
  }
  if (pathPattern !== null) base.PathPattern = pathPattern
  return base
}

/**
 * Build a complete CloudFront `DistributionConfig` for a self-hosted origin.
 * See the module docblock for the rationale behind each fixed setting.
 */
export function buildCloudFrontOriginConfig(options: BuildCloudFrontOriginOptions): Record<string, any> {
  const aliases = options.aliases
  if (aliases.length === 0) throw new Error('buildCloudFrontOriginConfig: at least one alias is required')
  if (aliases.includes(options.originDomain))
    throw new Error(
      `buildCloudFrontOriginConfig: originDomain ${options.originDomain} must not be one of the aliases (it would loop)`,
    )
  if (options.originShield && !options.originShieldRegion)
    throw new Error('buildCloudFrontOriginConfig: originShieldRegion is required when originShield is enabled')
  const failoverDomain = options.failoverOriginDomain
  if (failoverDomain !== undefined) {
    if (aliases.includes(failoverDomain))
      throw new Error(
        `buildCloudFrontOriginConfig: failoverOriginDomain ${failoverDomain} must not be one of the aliases (it would loop)`,
      )
    if (failoverDomain === options.originDomain)
      throw new Error('buildCloudFrontOriginConfig: failoverOriginDomain must differ from originDomain')
  } else if (options.failoverStatusCodes) {
    throw new Error('buildCloudFrontOriginConfig: failoverStatusCodes needs failoverOriginDomain to fail over to')
  }

  const header = options.originSecretHeader ?? 'X-Origin-Verify'
  const customHeaders = options.originSecret
    ? { Quantity: 1, Items: [{ HeaderName: header, HeaderValue: options.originSecret }] }
    : { Quantity: 0 }

  // Sort behaviors most-specific-first so CloudFront matches deterministically.
  const behaviors = [...(options.behaviors ?? [])].sort((a, b) => b.pathPattern.length - a.pathPattern.length)

  const primaryConnection = resolveOriginConnection(options, 'buildCloudFrontOriginConfig')

  const customOrigin = (
    id: string,
    domainName: string,
    originShield: Record<string, any>,
    connection: { ConnectionAttempts?: number; ConnectionTimeout?: number } = {},
  ) => ({
    Id: id,
    DomainName: domainName,
    OriginPath: '',
    CustomHeaders: customHeaders,
    CustomOriginConfig: {
      HTTPPort: 80,
      HTTPSPort: 443,
      OriginProtocolPolicy: 'https-only',
      OriginSslProtocols: { Quantity: 1, Items: ['TLSv1.2'] },
      OriginReadTimeout: 30,
      OriginKeepaliveTimeout: 5,
    },
    ConnectionAttempts: connection.ConnectionAttempts ?? 3,
    ConnectionTimeout: connection.ConnectionTimeout ?? 10,
    OriginShield: originShield,
    OriginAccessControlId: '',
  })

  const origins = [
    customOrigin(
      ORIGIN_ID,
      options.originDomain,
      options.originShield ? { Enabled: true, OriginShieldRegion: options.originShieldRegion } : { Enabled: false },
      primaryConnection,
    ),
  ]
  let originGroups: Record<string, any> = { Quantity: 0 }
  const defaultBehavior = cacheBehavior(null, 'static')
  if (failoverDomain !== undefined) {
    origins.push(customOrigin(FAILOVER_ORIGIN_ID, failoverDomain, { Enabled: false }))
    originGroups = buildOriginGroups({
      primaryOriginId: ORIGIN_ID,
      secondaryOriginId: FAILOVER_ORIGIN_ID,
      statusCodes: options.failoverStatusCodes,
    })
    assertOriginGroupMethods(defaultBehavior.AllowedMethods, 'the default cache behavior')
    defaultBehavior.TargetOriginId = originGroups.Items[0].Id
  }

  const config = {
    CallerReference: options.callerReference ?? options.originDomain,
    Comment: options.comment ?? `Origin-fronted distribution for ${aliases[0]} → ${options.originDomain}`,
    Enabled: true,
    Aliases: { Quantity: aliases.length, Items: aliases },
    // No DefaultRootObject — see docblock (avoids the /index.html → / redirect loop).
    DefaultRootObject: '',
    Origins: { Quantity: origins.length, Items: origins },
    OriginGroups: originGroups,
    DefaultCacheBehavior: defaultBehavior,
    CacheBehaviors: { Quantity: behaviors.length, Items: behaviors.map((b) => cacheBehavior(b.pathPattern, b.kind)) },
    ViewerCertificate: {
      CloudFrontDefaultCertificate: false,
      ACMCertificateArn: options.viewerCertificateArn,
      Certificate: options.viewerCertificateArn,
      CertificateSource: 'acm',
      SSLSupportMethod: 'sni-only',
      MinimumProtocolVersion: 'TLSv1.2_2021',
    },
    PriceClass: options.priceClass ?? 'PriceClass_All',
    HttpVersion: 'http2and3',
    IsIPV6Enabled: true,
    Restrictions: { GeoRestriction: { RestrictionType: 'none', Quantity: 0 } },
    Logging: { Enabled: false, IncludeCookies: false, Bucket: '', Prefix: '' },
    WebACLId: '',
    CustomErrorResponses: { Quantity: 0 },
  }
  validateOriginGroups(config, 'buildCloudFrontOriginConfig')
  return config
}
