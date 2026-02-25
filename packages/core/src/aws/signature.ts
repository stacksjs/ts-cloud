/**
 * AWS Signature Version 4 Signing Process
 * Implements request signing for direct AWS API calls without SDK
 *
 * Reference: https://docs.aws.amazon.com/general/latest/gr/signature-version-4.html
 *
 * Browser compatible: Use async functions (signRequestAsync, createPresignedUrlAsync)
 * Node.js/Bun: Use sync functions for better performance (signRequest, createPresignedUrl)
 */

// Conditional import for Node.js crypto - will be undefined in browser
let nodeCrypto: typeof import('node:crypto') | undefined
try {
  nodeCrypto = await import('node:crypto')
} catch {
  // Running in browser - nodeCrypto stays undefined
}

/**
 * Signing key cache for improved performance on repeated requests
 * Keys are cached by: secretAccessKey + date + region + service
 * Supports both Buffer (Node.js) and Uint8Array (browser)
 */
const signingKeyCache = new Map<string, Buffer | Uint8Array>()
const MAX_CACHE_SIZE = 100

/**
 * Service name mappings for hosts that don't follow standard naming
 */
const HOST_SERVICES: Record<string, string> = {
  'appstream2': 'appstream',
  'cloudhsmv2': 'cloudhsm',
  'email': 'ses',
  'marketplace': 'aws-marketplace',
  'mobile': 'AWSMobileHubService',
  'pinpoint': 'mobiletargeting',
  'queue': 'sqs',
  'git-codecommit': 'codecommit',
  'mturk-requester-sandbox': 'mturk-requester',
  'personalize-runtime': 'personalize',
}

export interface SignatureOptions {
  method: string
  url: string
  /** Service name - if not provided, will be auto-detected from URL */
  service?: string
  /** Region - if not provided, will be auto-detected from URL */
  region?: string
  headers?: Record<string, string>
  body?: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /**
   * Optional external cache for signing keys
   * If not provided, uses internal cache
   * Supports both Buffer (Node.js) and Uint8Array (browser)
   */
  cache?: Map<string, Buffer | Uint8Array>
  /**
   * Sign via query string instead of Authorization header
   * Used for presigned URLs (e.g., S3 presigned URLs)
   */
  signQuery?: boolean
  /**
   * Expiration time in seconds for presigned URLs (default: 86400 = 24 hours)
   * Only used when signQuery is true
   */
  expiresIn?: number
  /**
   * Custom datetime for signing (format: YYYYMMDDTHHMMSSZ)
   * If not provided, uses current time
   * Useful for testing and reproducibility
   */
  datetime?: string
}

export interface SignedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

export interface PresignedUrlOptions {
  url: string
  method?: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /** Service name - if not provided, will be auto-detected from URL */
  service?: string
  /** Region - if not provided, will be auto-detected from URL */
  region?: string
  /** Expiration time in seconds (default: 3600 = 1 hour, max: 604800 = 7 days) */
  expiresIn?: number
  /** Optional external cache for signing keys */
  cache?: Map<string, Buffer | Uint8Array>
}

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number
  /** Initial delay in ms before first retry (default: 100) */
  initialDelayMs?: number
  /** Maximum delay in ms between retries (default: 5000) */
  maxDelayMs?: number
  /** HTTP status codes that should trigger a retry (default: [429, 500, 502, 503, 504]) */
  retryableStatusCodes?: number[]
  /** Request timeout in milliseconds (default: 30000 = 30 seconds) */
  timeoutMs?: number
}

/**
 * Detect service and region from AWS URL
 * Supports standard AWS endpoints, Lambda URLs, R2, and Backblaze B2
 */
export function detectServiceRegion(url: string | URL): { service: string, region: string } {
  const urlObj = typeof url === 'string' ? new URL(url) : url
  const { hostname, pathname } = urlObj

  // Lambda function URLs: xxx.lambda-url.region.on.aws
  if (hostname.endsWith('.on.aws')) {
    const match = hostname.match(/^[^.]+\.lambda-url\.([^.]+)\.on\.aws$/)
    if (match) {
      return { service: 'lambda', region: match[1] }
    }
    return { service: '', region: '' }
  }

  // Cloudflare R2: xxx.r2.cloudflarestorage.com
  if (hostname.endsWith('.r2.cloudflarestorage.com')) {
    return { service: 's3', region: 'auto' }
  }

  // Backblaze B2: xxx.s3.region.backblazeb2.com
  if (hostname.endsWith('.backblazeb2.com')) {
    const match = hostname.match(/^(?:[^.]+\.)?s3\.([^.]+)\.backblazeb2\.com$/)
    if (match) {
      return { service: 's3', region: match[1] }
    }
    return { service: '', region: '' }
  }

  // Standard AWS endpoints: service.region.amazonaws.com
  const match = hostname
    .replace('dualstack.', '')
    .match(/([^.]+)\.(?:([^.]+)\.)?amazonaws\.com(?:\.cn)?$/)

  if (!match) {
    return { service: '', region: '' }
  }

  let service = match[1]
  let region = match[2] || ''

  // Handle special cases
  if (region === 'us-gov') {
    region = 'us-gov-west-1'
  } else if (region === 's3' || region === 's3-accelerate') {
    region = 'us-east-1'
    service = 's3'
  } else if (service === 'iot') {
    if (hostname.startsWith('iot.')) {
      service = 'execute-api'
    } else if (hostname.startsWith('data.jobs.iot.')) {
      service = 'iot-jobs-data'
    } else {
      service = pathname === '/mqtt' ? 'iotdevicegateway' : 'iotdata'
    }
  } else if (service === 'autoscaling') {
    // Could be application-autoscaling or autoscaling-plans based on target
    // Default to autoscaling
  } else if (!region && service.startsWith('s3-')) {
    region = service.slice(3).replace(/^fips-|^external-1/, '')
    service = 's3'
  } else if (service.endsWith('-fips')) {
    service = service.slice(0, -5)
  } else if (region && /-\d$/.test(service) && !/-\d$/.test(region)) {
    // Swap service and region if they appear reversed
    [service, region] = [region, service]
  }

  // Apply service name mappings
  service = HOST_SERVICES[service] || service

  return { service, region: region || 'us-east-1' }
}

/**
 * Sign an AWS request using Signature Version 4
 */
export function signRequest(options: SignatureOptions): SignedRequest {
  const {
    method,
    url,
    body = '',
    accessKeyId,
    secretAccessKey,
    sessionToken,
    signQuery = false,
    expiresIn = 86400,
    datetime,
  } = options

  const urlObj = new URL(url)
  const host = urlObj.hostname

  // Auto-detect service and region if not provided
  const detected = detectServiceRegion(urlObj)
  const service = options.service || detected.service
  const region = options.region || detected.region

  if (!service) {
    throw new Error('Could not detect service from URL. Please provide service explicitly.')
  }
  if (!region) {
    throw new Error('Could not detect region from URL. Please provide region explicitly.')
  }

  // Step 1: Create canonical request
  const timestamp = datetime || new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const date = timestamp.substring(0, 8)
  const credentialScope = [date, region, service, 'aws4_request'].join('/')
  const algorithm = 'AWS4-HMAC-SHA256'

  if (signQuery) {
    // Query string signing (for presigned URLs)
    return signWithQueryString({
      urlObj,
      method,
      body,
      accessKeyId,
      secretAccessKey,
      sessionToken,
      service,
      region,
      timestamp,
      date,
      credentialScope,
      algorithm,
      expiresIn,
      cache: options.cache,
    })
  }

  // Header-based signing
  const path = urlObj.pathname || '/'
  const query = canonicalQueryString(urlObj.searchParams)

  const headers: Record<string, string> = {
    'host': host,
    'x-amz-date': timestamp,
    ...options.headers,
  }

  if (sessionToken) {
    headers['x-amz-security-token'] = sessionToken
  }

  // Add content-type for requests with body (case-insensitive check)
  const hasContentType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type')
  if (body && !hasContentType) {
    headers['content-type'] = 'application/x-amz-json-1.0'
  }

  // For S3, add content hash header
  if (service === 's3' && !headers['x-amz-content-sha256']) {
    headers['x-amz-content-sha256'] = hash(body)
  }

  const canonicalHeaders = getCanonicalHeaders(headers)
  const signedHeaders = getSignedHeaders(headers)
  const payloadHash = headers['x-amz-content-sha256'] || hash(body)

  const canonicalRequest = [
    method,
    encodePath(path),
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  // Step 2: Create string to sign
  const canonicalRequestHash = hash(canonicalRequest)

  const stringToSign = [
    algorithm,
    timestamp,
    credentialScope,
    canonicalRequestHash,
  ].join('\n')

  // Step 3: Calculate signature (with key caching for performance)
  const cache = options.cache ?? signingKeyCache
  const signature = calculateSignature(
    secretAccessKey,
    date,
    region,
    service,
    stringToSign,
    cache,
  )

  // Step 4: Add authorization header
  const authorization = [
    `${algorithm} Credential=${accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ')

  headers['authorization'] = authorization

  return {
    url,
    method,
    headers,
    body: body || undefined,
  }
}

/**
 * Sign an AWS request using Signature Version 4 (async - browser compatible)
 * Use this in browser environments where crypto.subtle is available
 */
export async function signRequestAsync(options: SignatureOptions): Promise<SignedRequest> {
  const {
    method,
    url,
    body = '',
    accessKeyId,
    secretAccessKey,
    sessionToken,
    signQuery = false,
    expiresIn = 86400,
    datetime,
  } = options

  const urlObj = new URL(url)
  const host = urlObj.hostname

  // Auto-detect service and region if not provided
  const detected = detectServiceRegion(urlObj)
  const service = options.service || detected.service
  const region = options.region || detected.region

  if (!service) {
    throw new Error('Could not detect service from URL. Please provide service explicitly.')
  }
  if (!region) {
    throw new Error('Could not detect region from URL. Please provide region explicitly.')
  }

  // Step 1: Create canonical request
  const timestamp = datetime || new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const date = timestamp.substring(0, 8)
  const credentialScope = [date, region, service, 'aws4_request'].join('/')
  const algorithm = 'AWS4-HMAC-SHA256'

  if (signQuery) {
    // Query string signing (for presigned URLs)
    return signWithQueryStringAsync({
      urlObj,
      method,
      body,
      accessKeyId,
      secretAccessKey,
      sessionToken,
      service,
      region,
      timestamp,
      date,
      credentialScope,
      algorithm,
      expiresIn,
      cache: options.cache,
    })
  }

  // Header-based signing
  const path = urlObj.pathname || '/'
  const query = canonicalQueryString(urlObj.searchParams)

  const headers: Record<string, string> = {
    'host': host,
    'x-amz-date': timestamp,
    ...options.headers,
  }

  if (sessionToken) {
    headers['x-amz-security-token'] = sessionToken
  }

  // Add content-type for requests with body (case-insensitive check)
  const hasContentType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type')
  if (body && !hasContentType) {
    headers['content-type'] = 'application/x-amz-json-1.0'
  }

  // For S3, add content hash header
  const bodyHash = await hashAsync(body)
  if (service === 's3' && !headers['x-amz-content-sha256']) {
    headers['x-amz-content-sha256'] = bodyHash
  }

  const canonicalHeaders = getCanonicalHeaders(headers)
  const signedHeaders = getSignedHeaders(headers)
  const payloadHash = headers['x-amz-content-sha256'] || bodyHash

  const canonicalRequest = [
    method,
    encodePath(path),
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  // Step 2: Create string to sign
  const canonicalRequestHash = await hashAsync(canonicalRequest)

  const stringToSign = [
    algorithm,
    timestamp,
    credentialScope,
    canonicalRequestHash,
  ].join('\n')

  // Step 3: Calculate signature (with key caching for performance)
  const cache = options.cache ?? signingKeyCache
  const signature = await calculateSignatureAsync(
    secretAccessKey,
    date,
    region,
    service,
    stringToSign,
    cache,
  )

  // Step 4: Add authorization header
  const authorization = [
    `${algorithm} Credential=${accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ')

  headers['authorization'] = authorization

  return {
    url,
    method,
    headers,
    body: body || undefined,
  }
}

/**
 * Sign request using query string parameters (for presigned URLs)
 */
function signWithQueryString(params: {
  urlObj: URL
  method: string
  body: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  service: string
  region: string
  timestamp: string
  date: string
  credentialScope: string
  algorithm: string
  expiresIn: number
  cache?: Map<string, Buffer | Uint8Array>
}): SignedRequest {
  const {
    urlObj,
    method,
    body,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    service,
    region,
    timestamp,
    date,
    credentialScope,
    algorithm,
    expiresIn,
    cache,
  } = params

  // Clone URL to avoid modifying original
  const signedUrl = new URL(urlObj.toString())

  // Add required query parameters
  signedUrl.searchParams.set('X-Amz-Algorithm', algorithm)
  signedUrl.searchParams.set('X-Amz-Credential', `${accessKeyId}/${credentialScope}`)
  signedUrl.searchParams.set('X-Amz-Date', timestamp)
  signedUrl.searchParams.set('X-Amz-Expires', String(expiresIn))

  // For S3, default to UNSIGNED-PAYLOAD
  const payloadHash = service === 's3' ? 'UNSIGNED-PAYLOAD' : hash(body)
  if (service === 's3') {
    signedUrl.searchParams.set('X-Amz-Content-Sha256', payloadHash)
  }

  // Signed headers (only host for query string signing)
  const signedHeaders = 'host'
  signedUrl.searchParams.set('X-Amz-SignedHeaders', signedHeaders)

  if (sessionToken) {
    signedUrl.searchParams.set('X-Amz-Security-Token', sessionToken)
  }

  // Build canonical request
  const path = encodePath(signedUrl.pathname || '/')
  const canonicalHeaders = `host:${signedUrl.hostname}\n`
  const query = canonicalQueryString(signedUrl.searchParams)

  const canonicalRequest = [
    method,
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  // Create string to sign
  const stringToSign = [
    algorithm,
    timestamp,
    credentialScope,
    hash(canonicalRequest),
  ].join('\n')

  // Calculate signature
  const signingCache = cache ?? signingKeyCache
  const signature = calculateSignature(
    secretAccessKey,
    date,
    region,
    service,
    stringToSign,
    signingCache,
  )

  // Add signature to URL
  signedUrl.searchParams.set('X-Amz-Signature', signature)

  return {
    url: signedUrl.toString(),
    method,
    headers: {},
    body: body || undefined,
  }
}

/**
 * Sign request using query string parameters (async - browser compatible)
 */
async function signWithQueryStringAsync(params: {
  urlObj: URL
  method: string
  body: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  service: string
  region: string
  timestamp: string
  date: string
  credentialScope: string
  algorithm: string
  expiresIn: number
  cache?: Map<string, Buffer | Uint8Array>
}): Promise<SignedRequest> {
  const {
    urlObj,
    method,
    body,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    service,
    region,
    timestamp,
    date,
    credentialScope,
    algorithm,
    expiresIn,
    cache,
  } = params

  // Clone URL to avoid modifying original
  const signedUrl = new URL(urlObj.toString())

  // Add required query parameters
  signedUrl.searchParams.set('X-Amz-Algorithm', algorithm)
  signedUrl.searchParams.set('X-Amz-Credential', `${accessKeyId}/${credentialScope}`)
  signedUrl.searchParams.set('X-Amz-Date', timestamp)
  signedUrl.searchParams.set('X-Amz-Expires', String(expiresIn))

  // For S3, default to UNSIGNED-PAYLOAD
  const payloadHash = service === 's3' ? 'UNSIGNED-PAYLOAD' : await hashAsync(body)
  if (service === 's3') {
    signedUrl.searchParams.set('X-Amz-Content-Sha256', payloadHash)
  }

  // Signed headers (only host for query string signing)
  const signedHeaders = 'host'
  signedUrl.searchParams.set('X-Amz-SignedHeaders', signedHeaders)

  if (sessionToken) {
    signedUrl.searchParams.set('X-Amz-Security-Token', sessionToken)
  }

  // Build canonical request
  const path = encodePath(signedUrl.pathname || '/')
  const canonicalHeaders = `host:${signedUrl.hostname}\n`
  const query = canonicalQueryString(signedUrl.searchParams)

  const canonicalRequest = [
    method,
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  // Create string to sign
  const stringToSign = [
    algorithm,
    timestamp,
    credentialScope,
    await hashAsync(canonicalRequest),
  ].join('\n')

  // Calculate signature
  const signingCache = cache ?? signingKeyCache
  const signature = await calculateSignatureAsync(
    secretAccessKey,
    date,
    region,
    service,
    stringToSign,
    signingCache,
  )

  // Add signature to URL
  signedUrl.searchParams.set('X-Amz-Signature', signature)

  return {
    url: signedUrl.toString(),
    method,
    headers: {},
    body: body || undefined,
  }
}

/**
 * Generate a presigned URL for AWS requests (e.g., S3 GetObject, PutObject)
 */
export function createPresignedUrl(options: PresignedUrlOptions): string {
  const {
    url,
    method = 'GET',
    expiresIn = 3600,
    ...rest
  } = options

  // Max expiration is 7 days for most services
  const clampedExpires = Math.min(expiresIn, 604800)

  const signed = signRequest({
    ...rest,
    url,
    method,
    signQuery: true,
    expiresIn: clampedExpires,
  })

  return signed.url
}

/**
 * Generate a presigned URL for AWS requests (async - browser compatible)
 */
export async function createPresignedUrlAsync(options: PresignedUrlOptions): Promise<string> {
  const {
    url,
    method = 'GET',
    expiresIn = 3600,
    ...rest
  } = options

  // Max expiration is 7 days for most services
  const clampedExpires = Math.min(expiresIn, 604800)

  const signed = await signRequestAsync({
    ...rest,
    url,
    method,
    signQuery: true,
    expiresIn: clampedExpires,
  })

  return signed.url
}

/**
 * Create canonical headers string
 */
function getCanonicalHeaders(headers: Record<string, string>): string {
  return Object.keys(headers)
    .sort()
    .map(key => `${key.toLowerCase()}:${headers[key].trim().replace(/\s+/g, ' ')}`)
    .join('\n') + '\n'
}

/**
 * Get signed headers string
 */
function getSignedHeaders(headers: Record<string, string>): string {
  return Object.keys(headers)
    .sort()
    .map(key => key.toLowerCase())
    .join(';')
}

/**
 * Create canonical query string (sorted and encoded)
 */
function canonicalQueryString(params: URLSearchParams): string {
  const sorted: Array<[string, string]> = []

  params.forEach((value, key) => {
    sorted.push([encodeRfc3986(key), encodeRfc3986(value)])
  })

  sorted.sort((a, b) => {
    if (a[0] < b[0]) return -1
    if (a[0] > b[0]) return 1
    if (a[1] < b[1]) return -1
    if (a[1] > b[1]) return 1
    return 0
  })

  return sorted.map(([k, v]) => `${k}=${v}`).join('&')
}

/**
 * Encode path for canonical request
 */
function encodePath(path: string): string {
  return path
    .split('/')
    .map(segment => encodeRfc3986(segment))
    .join('/')
}

/**
 * RFC 3986 URI encoding (stricter than encodeURIComponent)
 */
function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * Calculate SHA256 hash (synchronous - Node.js/Bun only)
 */
function hash(data: string): string {
  if (!nodeCrypto) {
    throw new Error('Synchronous hash not available in browser. Use signRequestAsync() instead.')
  }
  return nodeCrypto.createHash('sha256').update(data, 'utf8').digest('hex')
}

/**
 * Calculate HMAC SHA256 (synchronous - Node.js/Bun only)
 */
function hmac(key: Buffer | string, data: string): Buffer {
  if (!nodeCrypto) {
    throw new Error('Synchronous hmac not available in browser. Use signRequestAsync() instead.')
  }
  return nodeCrypto.createHmac('sha256', key).update(data, 'utf8').digest()
}

/**
 * Calculate SHA256 hash (async - browser compatible)
 */
async function hashAsync(data: string): Promise<string> {
  const encoder = new TextEncoder()
  const dataBuffer = encoder.encode(data)
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer)
  return bufferToHex(new Uint8Array(hashBuffer))
}

/**
 * Calculate HMAC SHA256 (async - browser compatible)
 */
async function hmacAsync(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const encoder = new TextEncoder()
  const keyBuffer = typeof key === 'string' ? encoder.encode(key) : key
  const dataBuffer = encoder.encode(data)

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, dataBuffer.buffer)
  return new Uint8Array(signature)
}

/**
 * Convert Uint8Array to hex string
 */
function bufferToHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Calculate signature using AWS signing key derivation (sync - Node.js/Bun only)
 * Uses caching for signing keys to improve performance on repeated requests
 */
function calculateSignature(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
  stringToSign: string,
  cache: Map<string, Buffer | Uint8Array>,
): string {
  // Create cache key from signing parameters
  const cacheKey = `${secretAccessKey}:${date}:${region}:${service}`

  let kSigning = cache.get(cacheKey) as Buffer | undefined

  if (!kSigning) {
    // Derive signing key (expensive operation)
    const kDate = hmac(`AWS4${secretAccessKey}`, date)
    const kRegion = hmac(kDate, region)
    const kService = hmac(kRegion, service)
    kSigning = hmac(kService, 'aws4_request')

    // Limit cache size to prevent memory leaks
    if (cache.size >= MAX_CACHE_SIZE) {
      // Remove oldest entry (first key)
      const firstKey = cache.keys().next().value
      if (firstKey)
        cache.delete(firstKey)
    }

    cache.set(cacheKey, kSigning)
  }

  return hmac(kSigning, stringToSign).toString('hex')
}

/**
 * Calculate signature using AWS signing key derivation (async - browser compatible)
 * Uses caching for signing keys to improve performance on repeated requests
 */
async function calculateSignatureAsync(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
  stringToSign: string,
  cache: Map<string, Buffer | Uint8Array>,
): Promise<string> {
  // Create cache key from signing parameters
  const cacheKey = `${secretAccessKey}:${date}:${region}:${service}`

  let kSigning = cache.get(cacheKey) as Uint8Array | undefined

  if (!kSigning) {
    // Derive signing key (expensive operation)
    const kDate = await hmacAsync(`AWS4${secretAccessKey}`, date)
    const kRegion = await hmacAsync(kDate, region)
    const kService = await hmacAsync(kRegion, service)
    kSigning = await hmacAsync(kService, 'aws4_request')

    // Limit cache size to prevent memory leaks
    if (cache.size >= MAX_CACHE_SIZE) {
      // Remove oldest entry (first key)
      const firstKey = cache.keys().next().value
      if (firstKey)
        cache.delete(firstKey)
    }

    cache.set(cacheKey, kSigning)
  }

  const signature = await hmacAsync(kSigning, stringToSign)
  return bufferToHex(signature)
}

/**
 * Check if an error/status code is retryable
 */
function isRetryable(status: number, retryableCodes: number[]): boolean {
  return retryableCodes.includes(status)
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateBackoff(attempt: number, initialDelayMs: number, maxDelayMs: number): number {
  const exponentialDelay = initialDelayMs * Math.pow(2, attempt)
  const jitter = Math.random() * 0.3 * exponentialDelay // 0-30% jitter
  return Math.min(exponentialDelay + jitter, maxDelayMs)
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Make a signed AWS API request with automatic retry
 */
export async function makeAWSRequest(
  options: SignatureOptions,
  retryOptions?: RetryOptions,
): Promise<Response> {
  const {
    maxRetries = 3,
    initialDelayMs = 100,
    maxDelayMs = 5000,
    retryableStatusCodes = [429, 500, 502, 503, 504],
    timeoutMs = 30000,
  } = retryOptions ?? {}

  let lastError: Error | undefined
  let lastResponse: Response | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Re-sign request on each attempt (timestamp changes)
    const signedRequest = signRequest(options)

    const fetchOptions: RequestInit = {
      method: signedRequest.method,
      headers: signedRequest.headers,
    }

    if (signedRequest.body) {
      fetchOptions.body = signedRequest.body
    }

    // Add timeout support via AbortController
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    fetchOptions.signal = controller.signal

    try {
      const response = await fetch(signedRequest.url, fetchOptions)
      clearTimeout(timeoutId)
      lastResponse = response

      // Success - return immediately
      if (response.ok) {
        return response
      }

      // Check if we should retry
      if (attempt < maxRetries && isRetryable(response.status, retryableStatusCodes)) {
        const delay = calculateBackoff(attempt, initialDelayMs, maxDelayMs)
        await sleep(delay)
        continue
      }

      // Non-retryable error or max retries reached
      const errorText = await response.text()
      throw new Error(`AWS API request failed (${response.status}): ${errorText}`)
    } catch (error) {
      clearTimeout(timeoutId)
      lastError = error as Error

      // Handle timeout errors
      if (error instanceof Error && error.name === 'AbortError') {
        lastError = new Error(`Request timed out after ${timeoutMs}ms`)
      }

      // Network errors and timeouts are retryable
      if (attempt < maxRetries && !(error instanceof Error && error.message.includes('AWS API request failed'))) {
        const delay = calculateBackoff(attempt, initialDelayMs, maxDelayMs)
        await sleep(delay)
        continue
      }

      throw lastError
    }
  }

  // Should not reach here, but just in case
  throw lastError ?? new Error('Request failed after retries')
}

/**
 * Make a signed AWS API request without retry (for backwards compatibility)
 */
export async function makeAWSRequestOnce(
  options: SignatureOptions,
): Promise<Response> {
  return makeAWSRequest(options, { maxRetries: 0 })
}

/**
 * Make a signed AWS API request with automatic retry (async - browser compatible)
 * Use this in browser environments where crypto.subtle is available
 */
export async function makeAWSRequestAsync(
  options: SignatureOptions,
  retryOptions?: RetryOptions,
): Promise<Response> {
  const {
    maxRetries = 3,
    initialDelayMs = 100,
    maxDelayMs = 5000,
    retryableStatusCodes = [429, 500, 502, 503, 504],
    timeoutMs = 30000,
  } = retryOptions ?? {}

  let lastError: Error | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Re-sign request on each attempt (timestamp changes)
    const signedRequest = await signRequestAsync(options)

    const fetchOptions: RequestInit = {
      method: signedRequest.method,
      headers: signedRequest.headers,
    }

    if (signedRequest.body) {
      fetchOptions.body = signedRequest.body
    }

    // Add timeout support via AbortController
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    fetchOptions.signal = controller.signal

    try {
      const response = await fetch(signedRequest.url, fetchOptions)
      clearTimeout(timeoutId)

      // Success - return immediately
      if (response.ok) {
        return response
      }

      // Check if we should retry
      if (attempt < maxRetries && isRetryable(response.status, retryableStatusCodes)) {
        const delay = calculateBackoff(attempt, initialDelayMs, maxDelayMs)
        await sleep(delay)
        continue
      }

      // Non-retryable error or max retries reached
      const errorText = await response.text()
      throw new Error(`AWS API request failed (${response.status}): ${errorText}`)
    } catch (error) {
      clearTimeout(timeoutId)
      lastError = error as Error

      // Handle timeout errors
      if (error instanceof Error && error.name === 'AbortError') {
        lastError = new Error(`Request timed out after ${timeoutMs}ms`)
      }

      // Network errors and timeouts are retryable
      if (attempt < maxRetries && !(error instanceof Error && error.message.includes('AWS API request failed'))) {
        const delay = calculateBackoff(attempt, initialDelayMs, maxDelayMs)
        await sleep(delay)
        continue
      }

      throw lastError
    }
  }

  // Should not reach here, but just in case
  throw lastError ?? new Error('Request failed after retries')
}

/**
 * Parse XML response from AWS
 */
export async function parseXMLResponse<T = any>(response: Response): Promise<T> {
  const text = await response.text()

  // Simple XML parsing (for production, use a proper XML parser)
  // This is a basic implementation for demonstration
  const result: any = {}

  // Extract key-value pairs from XML
  const regex = /<(\w+)>([^<]+)<\/\1>/g
  let match
  while ((match = regex.exec(text)) !== null) {
    const [, key, value] = match
    result[key] = value
  }

  return result as T
}

/**
 * Parse JSON response from AWS
 */
export async function parseJSONResponse<T = any>(response: Response): Promise<T> {
  return await response.json() as T
}

/**
 * Clear the internal signing key cache
 * Call this when credentials change or for testing
 */
export function clearSigningKeyCache(): void {
  signingKeyCache.clear()
}

/**
 * Get current cache size (for diagnostics)
 */
export function getSigningKeyCacheSize(): number {
  return signingKeyCache.size
}

/**
 * Check if Node.js crypto is available (for sync operations)
 * Returns true in Node.js/Bun, false in browser
 */
export function isNodeCryptoAvailable(): boolean {
  return nodeCrypto !== undefined
}

/**
 * Check if Web Crypto API is available (for async operations)
 * Returns true in modern browsers and Node.js 15+
 */
export function isWebCryptoAvailable(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined'
}
