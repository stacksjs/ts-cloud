/**
 * AWS API Client - Direct API calls without AWS CLI
 * Implements AWS Signature Version 4 for authentication
 */

import * as crypto from 'node:crypto'

export interface AWSCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export interface AWSRequestOptions {
  service: string
  region: string
  method: string
  path: string
  queryParams?: Record<string, string>
  headers?: Record<string, string>
  body?: string
  credentials?: AWSCredentials
}

/**
 * AWS API Client - Makes authenticated requests to AWS services
 */
export class AWSClient {
  private credentials?: AWSCredentials

  constructor(credentials?: AWSCredentials) {
    this.credentials = credentials || this.loadCredentials()
  }

  /**
   * Load AWS credentials from environment variables
   */
  private loadCredentials(): AWSCredentials {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
    const sessionToken = process.env.AWS_SESSION_TOKEN

    if (!accessKeyId || !secretAccessKey) {
      throw new Error('AWS credentials not found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.')
    }

    return {
      accessKeyId,
      secretAccessKey,
      sessionToken,
    }
  }

  /**
   * Make a signed AWS API request
   */
  async request(options: AWSRequestOptions): Promise<any> {
    const credentials = options.credentials || this.credentials
    if (!credentials) {
      throw new Error('AWS credentials not provided')
    }

    const url = this.buildUrl(options)
    const headers = this.signRequest(options, credentials)

    const response = await fetch(url, {
      method: options.method,
      headers,
      body: options.body,
    })

    const responseText = await response.text()

    if (!response.ok) {
      throw new Error(`AWS API Error (${response.status}): ${responseText}`)
    }

    // Handle empty responses
    if (!responseText || responseText.trim() === '') {
      return null
    }

    // Parse XML or JSON response
    if (responseText.startsWith('<')) {
      return this.parseXmlResponse(responseText)
    }
    else {
      try {
        return JSON.parse(responseText)
      }
      catch {
        return responseText
      }
    }
  }

  /**
   * Build the full URL for the request
   */
  private buildUrl(options: AWSRequestOptions): string {
    const { service, region, path, queryParams } = options

    let host: string
    if (service === 's3') {
      host = `s3.${region}.amazonaws.com`
    }
    else if (service === 'cloudfront') {
      host = 'cloudfront.amazonaws.com'
    }
    else {
      host = `${service}.${region}.amazonaws.com`
    }

    let url = `https://${host}${path}`

    if (queryParams && Object.keys(queryParams).length > 0) {
      const queryString = new URLSearchParams(queryParams).toString()
      url += `?${queryString}`
    }

    return url
  }

  /**
   * Sign the request using AWS Signature Version 4
   */
  private signRequest(options: AWSRequestOptions, credentials: AWSCredentials): Record<string, string> {
    const { service, region, method, path, queryParams, body } = options

    const now = new Date()
    const amzDate = this.getAmzDate(now)
    const dateStamp = this.getDateStamp(now)

    let host: string
    if (service === 's3') {
      host = `s3.${region}.amazonaws.com`
    }
    else if (service === 'cloudfront') {
      host = 'cloudfront.amazonaws.com'
    }
    else {
      host = `${service}.${region}.amazonaws.com`
    }

    // Build canonical headers
    const headers: Record<string, string> = {
      'host': host,
      'x-amz-date': amzDate,
      ...(options.headers || {}),
    }

    if (credentials.sessionToken) {
      headers['x-amz-security-token'] = credentials.sessionToken
    }

    if (body) {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      headers['content-length'] = Buffer.byteLength(body).toString()
    }

    // Create canonical request
    const payloadHash = this.sha256(body || '')
    headers['x-amz-content-sha256'] = payloadHash

    const canonicalUri = path
    const canonicalQueryString = queryParams
      ? new URLSearchParams(queryParams).toString()
      : ''

    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map(key => `${key.toLowerCase()}:${headers[key].trim()}\n`)
      .join('')

    const signedHeaders = Object.keys(headers)
      .sort()
      .map(key => key.toLowerCase())
      .join(';')

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n')

    // Create string to sign
    const algorithm = 'AWS4-HMAC-SHA256'
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
    const stringToSign = [
      algorithm,
      amzDate,
      credentialScope,
      this.sha256(canonicalRequest),
    ].join('\n')

    // Calculate signature
    const signingKey = this.getSignatureKey(credentials.secretAccessKey, dateStamp, region, service)
    const signature = this.hmac(signingKey, stringToSign)

    // Build authorization header
    const authorizationHeader = `${algorithm} Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

    return {
      ...headers,
      'Authorization': authorizationHeader,
    }
  }

  /**
   * Get AMZ date format (YYYYMMDDTHHMMSSZ)
   */
  private getAmzDate(date: Date): string {
    return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  }

  /**
   * Get date stamp (YYYYMMDD)
   */
  private getDateStamp(date: Date): string {
    return date.toISOString().slice(0, 10).replace(/-/g, '')
  }

  /**
   * SHA256 hash
   */
  private sha256(data: string): string {
    return crypto.createHash('sha256').update(data, 'utf8').digest('hex')
  }

  /**
   * HMAC SHA256
   */
  private hmac(key: Buffer | string, data: string): string {
    return crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex')
  }

  /**
   * Get signature key
   */
  private getSignatureKey(key: string, dateStamp: string, region: string, service: string): Buffer {
    const kDate = crypto.createHmac('sha256', `AWS4${key}`).update(dateStamp).digest()
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest()
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest()
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest()
    return kSigning
  }

  /**
   * Parse XML response to JSON
   */
  private parseXmlResponse(xml: string): any {
    // Simple XML parser for AWS responses
    const result: any = {}

    // Remove XML declaration and root tags
    const content = xml.replace(/<\?xml[^>]*\?>/g, '').trim()

    // Extract error information
    const errorMatch = content.match(/<Error>([\s\S]*?)<\/Error>/)
    if (errorMatch) {
      const errorContent = errorMatch[1]
      const codeMatch = errorContent.match(/<Code>(.*?)<\/Code>/)
      const messageMatch = errorContent.match(/<Message>(.*?)<\/Message>/)

      if (codeMatch || messageMatch) {
        throw new Error(`AWS Error: ${codeMatch?.[1] || 'Unknown'} - ${messageMatch?.[1] || 'No message'}`)
      }
    }

    // Parse basic XML structure
    const tagRegex = /<([^/>]+)>([^<]*)<\/\1>/g
    let match: RegExpExecArray | null

    while ((match = tagRegex.exec(content)) !== null) {
      const [, key, value] = match
      if (value.trim()) {
        result[key] = value.trim()
      }
    }

    return result
  }
}

/**
 * Build query string for AWS API calls
 */
export function buildQueryParams(params: Record<string, any>): Record<string, string> {
  const result: Record<string, string> = {}

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        result[`${key}.${index + 1}`] = String(item)
      })
    }
    else if (typeof value === 'object') {
      for (const [subKey, subValue] of Object.entries(value)) {
        result[`${key}.${subKey}`] = String(subValue)
      }
    }
    else {
      result[key] = String(value)
    }
  }

  return result
}
