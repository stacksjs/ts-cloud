/**
 * AWS Signature Version 4 Signing Process
 * Implements request signing for direct AWS API calls without SDK
 *
 * Reference: https://docs.aws.amazon.com/general/latest/gr/signature-version-4.html
 */

import { createHmac, createHash } from 'node:crypto'

export interface SignatureOptions {
  method: string
  url: string
  service: string
  region: string
  headers?: Record<string, string>
  body?: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export interface SignedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/**
 * Sign an AWS request using Signature Version 4
 */
export function signRequest(options: SignatureOptions): SignedRequest {
  const {
    method,
    url,
    service,
    region,
    body = '',
    accessKeyId,
    secretAccessKey,
    sessionToken,
  } = options

  const urlObj = new URL(url)
  const host = urlObj.hostname
  const path = urlObj.pathname || '/'
  const query = urlObj.search.substring(1) // Remove leading '?'

  // Step 1: Create canonical request
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const date = timestamp.substring(0, 8)

  const headers: Record<string, string> = {
    'host': host,
    'x-amz-date': timestamp,
    ...options.headers,
  }

  if (sessionToken) {
    headers['x-amz-security-token'] = sessionToken
  }

  // Add content-type for requests with body
  if (body && !headers['content-type']) {
    headers['content-type'] = 'application/x-amz-json-1.0'
  }

  const canonicalHeaders = getCanonicalHeaders(headers)
  const signedHeaders = getSignedHeaders(headers)
  const payloadHash = hash(body)

  const canonicalRequest = [
    method,
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  // Step 2: Create string to sign
  const algorithm = 'AWS4-HMAC-SHA256'
  const credentialScope = [date, region, service, 'aws4_request'].join('/')
  const canonicalRequestHash = hash(canonicalRequest)

  const stringToSign = [
    algorithm,
    timestamp,
    credentialScope,
    canonicalRequestHash,
  ].join('\n')

  // Step 3: Calculate signature
  const signature = calculateSignature(
    secretAccessKey,
    date,
    region,
    service,
    stringToSign,
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
 * Create canonical headers string
 */
function getCanonicalHeaders(headers: Record<string, string>): string {
  return Object.keys(headers)
    .sort()
    .map(key => `${key.toLowerCase()}:${headers[key].trim()}`)
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
 * Calculate SHA256 hash
 */
function hash(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

/**
 * Calculate HMAC SHA256
 */
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/**
 * Calculate signature using AWS signing key derivation
 */
function calculateSignature(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
  stringToSign: string,
): string {
  const kDate = hmac(`AWS4${secretAccessKey}`, date)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')

  return hmac(kSigning, stringToSign).toString('hex')
}

/**
 * Make a signed AWS API request
 */
export async function makeAWSRequest(
  options: SignatureOptions,
): Promise<Response> {
  const signedRequest = signRequest(options)

  const fetchOptions: RequestInit = {
    method: signedRequest.method,
    headers: signedRequest.headers,
  }

  if (signedRequest.body) {
    fetchOptions.body = signedRequest.body
  }

  const response = await fetch(signedRequest.url, fetchOptions)

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`AWS API request failed (${response.status}): ${errorText}`)
  }

  return response
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
  const matches = text.matchAll(/<(\w+)>([^<]+)<\/\1>/g)
  for (const match of matches) {
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
