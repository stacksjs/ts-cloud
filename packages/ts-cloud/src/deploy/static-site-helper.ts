/**
 * High-level static site deployer with smart defaults.
 *
 * Most callers don't need the full surface of
 * `deployStaticSiteWithExternalDnsFull` — they want to point a build
 * directory at a domain and let the helper sort out:
 *   - Porkbun DNS (default for non-Route53 setups)
 *   - Non-SPA error handling (so /favicon.ico, /robots.txt, etc. don't
 *     masquerade as the homepage)
 *   - AWS env-var validation up front
 *   - Sensible cache-control headers
 *
 * `deploySite` is the one-call entrypoint; the lower-level
 * `deployStaticSiteWithExternalDnsFull` and `deployStaticSiteFull`
 * remain available for callers that need the full surface.
 */

import process from 'node:process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { deployStaticSiteWithExternalDnsFull, type ExternalDnsDeployResult } from './static-site-external-dns'

export type StaticSiteDnsProvider =
  | 'porkbun'
  | 'godaddy'
  | { provider: 'porkbun', apiKey?: string, secretKey?: string }
  | { provider: 'godaddy', apiKey?: string, secretKey?: string, environment?: 'production' | 'ote' }

export interface DeploySiteConfig {
  /** Site name used for AWS resource naming. */
  siteName: string
  /** Apex or subdomain (e.g. "paweldregan.com"). */
  domain: string
  /** AWS region for the S3 bucket. Defaults to "us-east-1". */
  region?: string
  /** Output directory containing built files. Defaults to "dist". */
  sourceDir?: string
  /** S3 bucket name (auto-generated from the domain if omitted). */
  bucket?: string
  /** CloudFormation stack name (auto-generated if omitted). */
  stackName?: string
  /** Default root object served at "/". Defaults to "index.html". */
  defaultRootObject?: string
  /** Error document served on 403/404. Defaults to "404.html". */
  errorDocument?: string
  /**
   * DNS provider config. Defaults to Porkbun, reading PORKBUN_API_KEY /
   * PORKBUN_SECRET_KEY from env. Pass `'godaddy'` or a full provider
   * object to override.
   */
  dnsProvider?: StaticSiteDnsProvider
  /** Pre-issued ACM cert ARN. Auto-created when omitted. */
  certificateArn?: string
  /**
   * Cache-Control header for uploaded objects. Defaults to short-TTL
   * (one hour) so HTML edits propagate quickly; long-lived assets can
   * still set their own Cache-Control via S3 object metadata if needed.
   */
  cacheControl?: string
  /**
   * SPA mode. Defaults to false. With false, missing files return a
   * real 404 with the error document. With true, missing files fall
   * through to the index document with a 200 — required for
   * client-side-routed SPAs but wrong for multi-page static sites.
   */
  singlePageApp?: boolean
  /** Empty the bucket before uploading (default: false). */
  cleanBucket?: boolean
  /** AWS resource tags. */
  tags?: Record<string, string>
  /** Progress callback. */
  onProgress?: (stage: string, detail?: string) => void
}

export interface DeploySiteResult {
  success: boolean
  domain?: string
  url?: string
  bucket?: string
  distributionId?: string
  distributionDomain?: string
  certificateArn?: string
  filesUploaded?: number
  filesSkipped?: number
  message?: string
  durationMs: number
}

/**
 * Deploy a static site to AWS (S3 + CloudFront + ACM) with DNS managed
 * via Porkbun (or another supported external provider). Validates AWS +
 * DNS-provider credentials up front, fills in opinionated defaults, and
 * routes to the underlying CloudFormation flow.
 */
export async function deploySite(config: DeploySiteConfig): Promise<DeploySiteResult> {
  const start = Date.now()
  const sourceDir = config.sourceDir ?? 'dist'

  if (!existsSync(join(sourceDir, 'index.html'))) {
    return fail(start, `${sourceDir}/ has no index.html — build first.`)
  }

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return fail(start, 'Missing AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in env.')
  }

  const dns = resolveDnsProvider(config.dnsProvider)
  if ('error' in dns)
    return fail(start, dns.error)

  const result: ExternalDnsDeployResult = await deployStaticSiteWithExternalDnsFull({
    siteName: config.siteName,
    region: config.region ?? 'us-east-1',
    domain: config.domain,
    bucket: config.bucket,
    stackName: config.stackName,
    certificateArn: config.certificateArn,
    defaultRootObject: config.defaultRootObject ?? 'index.html',
    errorDocument: config.errorDocument ?? '404.html',
    cacheControl: config.cacheControl ?? 'max-age=3600, public',
    sourceDir,
    cleanBucket: config.cleanBucket ?? false,
    singlePageApp: config.singlePageApp ?? false,
    dnsProvider: dns,
    tags: {
      ManagedBy: 'ts-cloud',
      Application: config.siteName,
      ...config.tags,
    },
    onProgress: config.onProgress,
  })

  return {
    success: !!result.success,
    domain: result.domain,
    url: result.domain ? `https://${result.domain}` : result.distributionDomain ? `https://${result.distributionDomain}` : undefined,
    bucket: result.bucket,
    distributionId: result.distributionId,
    distributionDomain: result.distributionDomain,
    certificateArn: result.certificateArn,
    filesUploaded: result.filesUploaded,
    filesSkipped: result.filesSkipped,
    message: result.message,
    durationMs: Date.now() - start,
  }
}

// eslint-disable-next-line pickier/no-unused-vars
function resolveDnsProvider(input?: DeploySiteConfig['dnsProvider']):
  | { provider: 'porkbun', apiKey: string, secretKey: string }
  | { provider: 'godaddy', apiKey: string, apiSecret: string, environment?: 'production' | 'ote' }
  | { error: string } {
  const config = typeof input === 'string'
    ? { provider: input } as { provider: 'porkbun' | 'godaddy' }
    : input ?? { provider: 'porkbun' as const }

  if (config.provider === 'porkbun') {
    const c = config as Extract<DeploySiteConfig['dnsProvider'], { provider: 'porkbun' }>
    const apiKey = c?.apiKey ?? process.env.PORKBUN_API_KEY
    const secretKey = c?.secretKey ?? process.env.PORKBUN_SECRET_KEY ?? process.env.PORKBUN_SECRET_API_KEY
    if (!apiKey || !secretKey)
      return { error: 'Missing PORKBUN_API_KEY / PORKBUN_SECRET_KEY in env.' }
    return { provider: 'porkbun', apiKey, secretKey }
  }

  if (config.provider === 'godaddy') {
    const c = config as Extract<DeploySiteConfig['dnsProvider'], { provider: 'godaddy' }>
    const apiKey = c?.apiKey ?? process.env.GODADDY_API_KEY
    const apiSecret = c?.secretKey ?? process.env.GODADDY_API_SECRET
    const environment = c?.environment ?? (process.env.GODADDY_ENVIRONMENT as 'production' | 'ote' | undefined)
    if (!apiKey || !apiSecret)
      return { error: 'Missing GODADDY_API_KEY / GODADDY_API_SECRET in env.' }
    return { provider: 'godaddy', apiKey, apiSecret, environment }
  }

  return { error: `Unsupported DNS provider: ${(config as any).provider}` }
}

function fail(start: number, message: string): DeploySiteResult {
  return { success: false, message, durationMs: Date.now() - start }
}
