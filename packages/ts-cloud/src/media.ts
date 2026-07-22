import { createHmac, createSign, timingSafeEqual } from 'node:crypto'

export interface CloudFrontPolicyOptions {
  resource: string
  expiresAt: Date | number
  activeAt?: Date | number
  ipAddress?: string
}

export interface CloudFrontSignerOptions {
  keyPairId: string
  privateKey: string | Buffer
}

export interface CloudFrontSignedCookies {
  'CloudFront-Key-Pair-Id': string
  'CloudFront-Policy': string
  'CloudFront-Signature': string
}

export interface MediaAccessTokenOptions {
  resource: string
  secret: string | Uint8Array
  expiresAt: Date | number
  keyId?: string
  audience?: string
}

export interface VerifiedMediaAccessToken {
  resource: string
  expiresAt: number
  keyId?: string
  audience?: string
}

export interface MediaCdnPlanOptions {
  bucket: string
  region: string
  domain?: string
  prefix?: string
  protected?: boolean
  trustedKeyGroupIds?: string[]
}

export interface MediaCdnBehavior {
  pathPattern: string
  cacheControl: string
  compress: boolean
  signed: boolean
}

export interface MediaCdnPlan {
  originDomain: string
  originPath: string
  domain?: string
  behaviors: MediaCdnBehavior[]
  trustedKeyGroupIds: string[]
  responseHeaders: Record<string, string>
}

function epochSeconds(value: Date | number): number {
  const milliseconds = value instanceof Date ? value.getTime() : value
  if (!Number.isFinite(milliseconds)) throw new TypeError('Media access timestamp must be finite')
  return Math.floor(milliseconds / 1000)
}

function cloudFrontBase64(value: Uint8Array | Buffer): string {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('=', '_').replaceAll('/', '~')
}

function regularBase64Url(value: Uint8Array | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

function assertHttpResource(resource: string, allowWildcard = false): void {
  if (!resource || /[\r\n]/.test(resource)) throw new TypeError('Media resource is invalid')
  const candidate = allowWildcard ? resource.replaceAll('*', 'wildcard') : resource
  const url = new URL(candidate)
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('Media resource must use HTTP or HTTPS')
  if (!allowWildcard && resource.includes('*')) throw new TypeError('Canned policies cannot contain wildcards')
}

function signCloudFrontValue(value: string, privateKey: string | Buffer): string {
  const signer = createSign('RSA-SHA1')
  signer.update(value)
  signer.end()
  return cloudFrontBase64(signer.sign(privateKey))
}

export function createCloudFrontPolicy(options: CloudFrontPolicyOptions): string {
  assertHttpResource(options.resource, true)
  const expiresAt = epochSeconds(options.expiresAt)
  const condition: Record<string, Record<string, number | string>> = {
    DateLessThan: { 'AWS:EpochTime': expiresAt },
  }
  if (options.activeAt !== undefined) condition.DateGreaterThan = { 'AWS:EpochTime': epochSeconds(options.activeAt) }
  if (options.ipAddress) condition.IpAddress = { 'AWS:SourceIp': options.ipAddress }
  return JSON.stringify({ Statement: [{ Resource: options.resource, Condition: condition }] })
}

export function signCloudFrontUrl(
  resource: string,
  expiresAt: Date | number,
  signer: CloudFrontSignerOptions,
): string {
  assertHttpResource(resource)
  const expires = epochSeconds(expiresAt)
  const separator = resource.includes('?') ? '&' : '?'
  const policy = createCloudFrontPolicy({ resource, expiresAt })
  const signature = signCloudFrontValue(policy, signer.privateKey)
  return `${resource}${separator}Expires=${expires}&Signature=${encodeURIComponent(signature)}&Key-Pair-Id=${encodeURIComponent(signer.keyPairId)}`
}

export function signCloudFrontCookies(
  policyOptions: CloudFrontPolicyOptions,
  signer: CloudFrontSignerOptions,
): CloudFrontSignedCookies {
  const policy = createCloudFrontPolicy(policyOptions)
  return {
    'CloudFront-Key-Pair-Id': signer.keyPairId,
    'CloudFront-Policy': cloudFrontBase64(Buffer.from(policy)),
    'CloudFront-Signature': signCloudFrontValue(policy, signer.privateKey),
  }
}

export function createMediaAccessToken(options: MediaAccessTokenOptions): string {
  if (!options.resource || /[\r\n]/.test(options.resource)) throw new TypeError('Media resource is invalid')
  const payload = regularBase64Url(Buffer.from(JSON.stringify({
    resource: options.resource,
    expiresAt: epochSeconds(options.expiresAt),
    ...(options.keyId ? { keyId: options.keyId } : {}),
    ...(options.audience ? { audience: options.audience } : {}),
  })))
  const signature = createHmac('sha256', options.secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

export function verifyMediaAccessToken(
  token: string,
  options: { secret: string | Uint8Array, now?: Date | number, resource?: string, audience?: string },
): VerifiedMediaAccessToken | null {
  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra) return null
  const expected = createHmac('sha256', options.secret).update(payload).digest()
  let actual: Buffer
  try {
    actual = Buffer.from(signature, 'base64url')
  }
  catch {
    return null
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as VerifiedMediaAccessToken
    const now = epochSeconds(options.now ?? Date.now())
    if (!value.resource || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now) return null
    if (options.resource && value.resource !== options.resource) return null
    if (options.audience && value.audience !== options.audience) return null
    return value
  }
  catch {
    return null
  }
}

export function mediaObjectHeaders(path: string, protectedMedia = false): Record<string, string> {
  const pathname = new URL(path, 'https://media.invalid').pathname.toLowerCase()
  const isManifest = /\.(?:m3u8|mpd|vtt|json)$/.test(pathname)
  const isKey = /\.(?:key|license)$/.test(pathname) || pathname.includes('/keys/') || pathname.includes('/licenses/')
  const cacheControl = protectedMedia && (isManifest || isKey)
    ? 'private, no-store'
    : isManifest
      ? 'public, max-age=5, s-maxage=30, stale-while-revalidate=30'
      : 'public, max-age=31536000, immutable'
  return {
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
  }
}

export function buildMediaCdnPlan(options: MediaCdnPlanOptions): MediaCdnPlan {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) throw new TypeError('Media bucket is invalid')
  if (!/^[a-z0-9-]+$/.test(options.region)) throw new TypeError('Media bucket region is invalid')
  const prefix = options.prefix ? `/${options.prefix.replace(/^\/+|\/+$/g, '')}` : ''
  const signed = options.protected ?? false
  const immutable = 'public, max-age=31536000, immutable'
  const manifests = signed ? 'private, no-store' : 'public, max-age=5, s-maxage=30, stale-while-revalidate=30'
  return {
    originDomain: `${options.bucket}.s3.${options.region}.amazonaws.com`,
    originPath: prefix,
    domain: options.domain,
    trustedKeyGroupIds: [...new Set(options.trustedKeyGroupIds ?? [])],
    behaviors: [
      { pathPattern: '*.m3u8', cacheControl: manifests, compress: true, signed },
      { pathPattern: '*.mpd', cacheControl: manifests, compress: true, signed },
      { pathPattern: '*.vtt', cacheControl: manifests, compress: true, signed },
      { pathPattern: '*', cacheControl: immutable, compress: false, signed },
    ],
    responseHeaders: {
      'Access-Control-Allow-Headers': 'Range, If-Range',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, ETag',
      'X-Content-Type-Options': 'nosniff',
    },
  }
}
