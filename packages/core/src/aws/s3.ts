/**
 * S3 High-Level API
 *
 * Simple, intuitive interface for S3 operations:
 * - get, put, delete, list, head, copy
 * - Streaming uploads/downloads
 * - Multipart uploads for large files
 * - Automatic content type detection
 */

import { signRequest, signRequestAsync, createPresignedUrl, createPresignedUrlAsync, type RetryOptions } from './signature'
import { getCredentials, type AWSCredentials, type CredentialProviderOptions } from './credentials'

export interface S3ClientOptions {
  /** AWS region (default: 'us-east-1') */
  region?: string
  /** Custom endpoint URL (for MinIO, LocalStack, etc.) */
  endpoint?: string
  /** Force path-style URLs instead of virtual-hosted-style */
  forcePathStyle?: boolean
  /** AWS credentials (if not provided, uses credential chain) */
  credentials?: AWSCredentials
  /** Credential provider options */
  credentialOptions?: CredentialProviderOptions
  /** Retry options for requests */
  retryOptions?: RetryOptions
}

export interface GetObjectOptions {
  /** Byte range to fetch (e.g., 'bytes=0-1023') */
  range?: string
  /** Only return if modified since this date */
  ifModifiedSince?: Date
  /** Only return if ETag matches */
  ifMatch?: string
  /** Only return if ETag doesn't match */
  ifNoneMatch?: string
  /** Response content-type override */
  responseContentType?: string
  /** Response content-disposition override */
  responseContentDisposition?: string
}

export interface PutObjectOptions {
  /** Content type (auto-detected if not provided) */
  contentType?: string
  /** Content encoding (e.g., 'gzip') */
  contentEncoding?: string
  /** Cache-Control header */
  cacheControl?: string
  /** Content-Disposition header */
  contentDisposition?: string
  /** Custom metadata (x-amz-meta-*) */
  metadata?: Record<string, string>
  /** Storage class (STANDARD, REDUCED_REDUNDANCY, GLACIER, etc.) */
  storageClass?: string
  /** Server-side encryption (AES256, aws:kms) */
  serverSideEncryption?: string
  /** ACL (private, public-read, etc.) */
  acl?: string
  /** Tagging (URL-encoded key=value pairs) */
  tagging?: string
}

export interface ListObjectsOptions {
  /** Prefix to filter objects */
  prefix?: string
  /** Delimiter for grouping (usually '/') */
  delimiter?: string
  /** Maximum number of keys to return (default: 1000) */
  maxKeys?: number
  /** Continuation token for pagination */
  continuationToken?: string
  /** Start listing after this key */
  startAfter?: string
}

export interface ListObjectsResult {
  contents: S3Object[]
  commonPrefixes: string[]
  isTruncated: boolean
  continuationToken?: string
  nextContinuationToken?: string
  keyCount: number
  maxKeys: number
  prefix?: string
  delimiter?: string
}

export interface S3Object {
  key: string
  lastModified: Date
  etag: string
  size: number
  storageClass: string
}

export interface HeadObjectResult {
  contentLength: number
  contentType: string
  etag: string
  lastModified: Date
  metadata: Record<string, string>
  storageClass?: string
  serverSideEncryption?: string
}

export interface CopyObjectOptions {
  /** Metadata directive (COPY or REPLACE) */
  metadataDirective?: 'COPY' | 'REPLACE'
  /** New metadata (only used if metadataDirective is REPLACE) */
  metadata?: Record<string, string>
  /** Content type (only used if metadataDirective is REPLACE) */
  contentType?: string
  /** Storage class for the copy */
  storageClass?: string
  /** ACL for the copy */
  acl?: string
}

export interface MultipartUploadOptions extends PutObjectOptions {
  /** Part size in bytes (default: 5MB, minimum: 5MB) */
  partSize?: number
  /** Maximum concurrent uploads (default: 4) */
  concurrency?: number
  /** Progress callback */
  onProgress?: (progress: MultipartProgress) => void
}

export interface MultipartProgress {
  loaded: number
  total: number
  part: number
  totalParts: number
}

export interface PresignedUrlOptions {
  /** Expiration time in seconds (default: 3600 = 1 hour) */
  expiresIn?: number
  /** HTTP method (default: 'GET') */
  method?: string
}

// Minimum part size for multipart upload (5MB)
const MIN_PART_SIZE = 5 * 1024 * 1024
// Default part size (5MB)
const DEFAULT_PART_SIZE = 5 * 1024 * 1024
// Maximum parts in a multipart upload
const _MAX_PARTS = 10000
// Threshold for using multipart upload (5MB)
const MULTIPART_THRESHOLD = 5 * 1024 * 1024

/**
 * S3 Client for high-level S3 operations
 */
export class S3Client {
  private region: string
  private endpoint: string
  private forcePathStyle: boolean
  private credentials?: AWSCredentials
  private credentialOptions?: CredentialProviderOptions
  private retryOptions: RetryOptions

  constructor(options: S3ClientOptions = {}) {
    this.region = options.region || process.env.AWS_REGION || 'us-east-1'
    this.endpoint = options.endpoint || `https://s3.${this.region}.amazonaws.com`
    this.forcePathStyle = options.forcePathStyle || false
    this.credentials = options.credentials
    this.credentialOptions = options.credentialOptions
    this.retryOptions = options.retryOptions || {}
  }

  /**
   * Get credentials (cached or from provider chain)
   */
  private async getCredentials(): Promise<AWSCredentials> {
    if (this.credentials) {
      return this.credentials
    }
    return getCredentials(this.credentialOptions)
  }

  /**
   * Build S3 URL for a bucket/key
   */
  private buildUrl(bucket: string, key?: string): string {
    const encodedKey = key ? encodeURIComponent(key).replace(/%2F/g, '/') : ''

    if (this.forcePathStyle) {
      return key
        ? `${this.endpoint}/${bucket}/${encodedKey}`
        : `${this.endpoint}/${bucket}`
    }

    // Virtual-hosted style
    const url = new URL(this.endpoint)
    url.hostname = `${bucket}.${url.hostname}`
    return key ? `${url.origin}/${encodedKey}` : url.origin
  }

  /**
   * Get an object from S3
   */
  async get(bucket: string, key: string, options: GetObjectOptions = {}): Promise<Response> {
    const credentials = await this.getCredentials()
    const url = this.buildUrl(bucket, key)

    const headers: Record<string, string> = {}
    if (options.range) headers['Range'] = options.range
    if (options.ifModifiedSince) headers['If-Modified-Since'] = options.ifModifiedSince.toUTCString()
    if (options.ifMatch) headers['If-Match'] = options.ifMatch
    if (options.ifNoneMatch) headers['If-None-Match'] = options.ifNoneMatch

    // Add response overrides as query params
    const urlObj = new URL(url)
    if (options.responseContentType) urlObj.searchParams.set('response-content-type', options.responseContentType)
    if (options.responseContentDisposition) urlObj.searchParams.set('response-content-disposition', options.responseContentDisposition)

    const signed = signRequest({
      method: 'GET',
      url: urlObj.toString(),
      headers,
      ...credentials,
      service: 's3',
      region: this.region,
    })

    const response = await fetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
    })

    if (!response.ok && response.status !== 304) {
      const error = await response.text()
      throw new S3Error(`Failed to get object: ${error}`, response.status, bucket, key)
    }

    return response
  }

  /**
   * Get object as text
   */
  async getText(bucket: string, key: string, options: GetObjectOptions = {}): Promise<string> {
    const response = await this.get(bucket, key, options)
    return response.text()
  }

  /**
   * Get object as JSON
   */
  async getJSON<T = unknown>(bucket: string, key: string, options: GetObjectOptions = {}): Promise<T> {
    const response = await this.get(bucket, key, options)
    return response.json() as Promise<T>
  }

  /**
   * Get object as ArrayBuffer
   */
  async getBuffer(bucket: string, key: string, options: GetObjectOptions = {}): Promise<ArrayBuffer> {
    const response = await this.get(bucket, key, options)
    return response.arrayBuffer()
  }

  /**
   * Put an object to S3
   * Automatically uses multipart upload for large files (>5MB)
   */
  async put(
    bucket: string,
    key: string,
    body: string | ArrayBuffer | Uint8Array | Blob | ReadableStream,
    options: PutObjectOptions = {},
  ): Promise<{ etag: string }> {
    // Get body size
    let size: number
    let bodyToUpload: string | ArrayBuffer | Uint8Array | Blob

    if (typeof body === 'string') {
      size = new TextEncoder().encode(body).length
      bodyToUpload = body
    } else if (body instanceof ArrayBuffer) {
      size = body.byteLength
      bodyToUpload = body
    } else if (body instanceof Uint8Array) {
      size = body.byteLength
      bodyToUpload = body
    } else if (body instanceof Blob) {
      size = body.size
      bodyToUpload = body
    } else {
      // ReadableStream - use multipart upload
      return this.uploadMultipart(bucket, key, body, {
        ...options,
        partSize: DEFAULT_PART_SIZE,
      })
    }

    // Use multipart for large files
    if (size > MULTIPART_THRESHOLD) {
      const stream = bodyToBlob(bodyToUpload).stream()
      return this.uploadMultipart(bucket, key, stream, {
        ...options,
        partSize: DEFAULT_PART_SIZE,
      })
    }

    // Simple upload for small files
    return this.putSimple(bucket, key, bodyToUpload, size, options)
  }

  /**
   * Simple PUT for small files
   */
  private async putSimple(
    bucket: string,
    key: string,
    body: string | ArrayBuffer | Uint8Array | Blob,
    size: number,
    options: PutObjectOptions,
  ): Promise<{ etag: string }> {
    const credentials = await this.getCredentials()
    const url = this.buildUrl(bucket, key)

    const headers: Record<string, string> = {
      'Content-Length': String(size),
      'Content-Type': options.contentType || detectContentType(key),
    }

    if (options.contentEncoding) headers['Content-Encoding'] = options.contentEncoding
    if (options.cacheControl) headers['Cache-Control'] = options.cacheControl
    if (options.contentDisposition) headers['Content-Disposition'] = options.contentDisposition
    if (options.storageClass) headers['x-amz-storage-class'] = options.storageClass
    if (options.serverSideEncryption) headers['x-amz-server-side-encryption'] = options.serverSideEncryption
    if (options.acl) headers['x-amz-acl'] = options.acl
    if (options.tagging) headers['x-amz-tagging'] = options.tagging

    // Add custom metadata
    if (options.metadata) {
      for (const [k, v] of Object.entries(options.metadata)) {
        headers[`x-amz-meta-${k.toLowerCase()}`] = v
      }
    }

    // Convert body to string for signing
    let bodyString: string
    if (typeof body === 'string') {
      bodyString = body
    } else if (body instanceof Blob) {
      bodyString = await body.text()
    } else {
      bodyString = new TextDecoder().decode(body instanceof ArrayBuffer ? new Uint8Array(body) : body)
    }

    const signed = signRequest({
      method: 'PUT',
      url,
      headers,
      body: bodyString,
      ...credentials,
      service: 's3',
      region: this.region,
    })

    const response = await fetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new S3Error(`Failed to put object: ${error}`, response.status, bucket, key)
    }

    const etag = response.headers.get('ETag') || ''
    return { etag: etag.replace(/"/g, '') }
  }

  /**
   * Delete an object from S3
   */
  async delete(bucket: string, key: string): Promise<void> {
    const credentials = await this.getCredentials()
    const url = this.buildUrl(bucket, key)

    const signed = signRequest({
      method: 'DELETE',
      url,
      ...credentials,
      service: 's3',
      region: this.region,
    })

    const response = await fetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
    })

    if (!response.ok && response.status !== 204) {
      const error = await response.text()
      throw new S3Error(`Failed to delete object: ${error}`, response.status, bucket, key)
    }
  }

  /**
   * Delete multiple objects from S3
   */
  async deleteMany(bucket: string, keys: string[]): Promise<{ deleted: string[], errors: Array<{ key: string, error: string }> }> {
    const credentials = await this.getCredentials()
    const url = `${this.buildUrl(bucket)}?delete`

    // Build XML body
    const objects = keys.map(key => `<Object><Key>${escapeXml(key)}</Key></Object>`).join('')
    const body = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>false</Quiet>${objects}</Delete>`

    const signed = signRequest({
      method: 'POST',
      url,
      headers: {
        'Content-Type': 'application/xml',
      },
      body,
      ...credentials,
      service: 's3',
      region: this.region,
    })

    const response = await fetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new S3Error(`Failed to delete objects: ${error}`, response.status, bucket)
    }

    const xml = await response.text()
    const deleted: string[] = []
    const errors: Array<{ key: string, error: string }> = []

    // Parse deleted keys
    const deletedRegex = /<Deleted><Key>([^<]+)<\/Key>/g
    let match
    while ((match = deletedRegex.exec(xml)) !== null) {
      deleted.push(match[1])
    }

    // Parse errors
    const errorRegex = /<Error><Key>([^<]+)<\/Key><Code>([^<]+)<\/Code><Message>([^<]+)<\/Message>/g
    while ((match = errorRegex.exec(xml)) !== null) {
      errors.push({ key: match[1], error: `${match[2]}: ${match[3]}` })
    }

    return { deleted, errors }
  }

  /**
   * List objects in a bucket
   */
  async list(bucket: string, options: ListObjectsOptions = {}): Promise<ListObjectsResult> {
    const credentials = await this.getCredentials()
    const urlObj = new URL(this.buildUrl(bucket))
    urlObj.searchParams.set('list-type', '2')

    if (options.prefix) urlObj.searchParams.set('prefix', options.prefix)
    if (options.delimiter) urlObj.searchParams.set('delimiter', options.delimiter)
    if (options.maxKeys) urlObj.searchParams.set('max-keys', String(options.maxKeys))
    if (options.continuationToken) urlObj.searchParams.set('continuation-token', options.continuationToken)
    if (options.startAfter) urlObj.searchParams.set('start-after', options.startAfter)

    const signed = signRequest({
      method: 'GET',
      url: urlObj.toString(),
      ...credentials,
      service: 's3',
      region: this.region,
    })

    const response = await fetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new S3Error(`Failed to list objects: ${error}`, response.status, bucket)
    }

    const xml = await response.text()
    return parseListObjectsResponse(xml)
  }

  /**
   * List all objects with automatic pagination
   */
  async *listAll(bucket: string, options: Omit<ListObjectsOptions, 'continuationToken'> = {}): AsyncGenerator<S3Object> {
    let continuationToken: string | undefined

    do {
      const result = await this.list(bucket, { ...options, continuationToken })

      for (const obj of result.contents) {
        yield obj
      }

      continuationToken = result.nextContinuationToken
    } while (continuationToken)
  }

  /**
   * Check if an object exists and get its metadata
   */
  async head(bucket: string, key: string): Promise<HeadObjectResult | null> {
    const credentials = await this.getCredentials()
    const url = this.buildUrl(bucket, key)

    const signed = signRequest({
      method: 'HEAD',
      url,
      ...credentials,
      service: 's3',
      region: this.region,
    })

    const response = await fetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
    })

    if (response.status === 404) {
      return null
    }

    if (!response.ok) {
      const error = await response.text()
      throw new S3Error(`Failed to head object: ${error}`, response.status, bucket, key)
    }

    // Extract metadata
    const metadata: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      if (key.toLowerCase().startsWith('x-amz-meta-')) {
        metadata[key.slice(11)] = value
      }
    })

    return {
      contentLength: Number(response.headers.get('Content-Length') || 0),
      contentType: response.headers.get('Content-Type') || 'application/octet-stream',
      etag: (response.headers.get('ETag') || '').replace(/"/g, ''),
      lastModified: new Date(response.headers.get('Last-Modified') || 0),
      metadata,
      storageClass: response.headers.get('x-amz-storage-class') || undefined,
      serverSideEncryption: response.headers.get('x-amz-server-side-encryption') || undefined,
    }
  }

  /**
   * Check if an object exists
   */
  async exists(bucket: string, key: string): Promise<boolean> {
    const result = await this.head(bucket, key)
    return result !== null
  }

  /**
   * Copy an object
   */
  async copy(
    sourceBucket: string,
    sourceKey: string,
    destBucket: string,
    destKey: string,
    options: CopyObjectOptions = {},
  ): Promise<{ etag: string }> {
    const credentials = await this.getCredentials()
    const url = this.buildUrl(destBucket, destKey)

    const headers: Record<string, string> = {
      'x-amz-copy-source': `/${sourceBucket}/${encodeURIComponent(sourceKey)}`,
    }

    if (options.metadataDirective) headers['x-amz-metadata-directive'] = options.metadataDirective
    if (options.contentType) headers['Content-Type'] = options.contentType
    if (options.storageClass) headers['x-amz-storage-class'] = options.storageClass
    if (options.acl) headers['x-amz-acl'] = options.acl

    if (options.metadata) {
      for (const [k, v] of Object.entries(options.metadata)) {
        headers[`x-amz-meta-${k.toLowerCase()}`] = v
      }
    }

    const signed = signRequest({
      method: 'PUT',
      url,
      headers,
      ...credentials,
      service: 's3',
      region: this.region,
    })

    const response = await fetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new S3Error(`Failed to copy object: ${error}`, response.status, destBucket, destKey)
    }

    const xml = await response.text()
    const etagMatch = xml.match(/<ETag>"?([^"<]+)"?<\/ETag>/)
    const etag = etagMatch ? etagMatch[1] : ''

    return { etag }
  }

  /**
   * Generate a presigned URL for an object
   */
  async getPresignedUrl(
    bucket: string,
    key: string,
    options: PresignedUrlOptions = {},
  ): Promise<string> {
    const credentials = await this.getCredentials()
    const url = this.buildUrl(bucket, key)

    return createPresignedUrl({
      url,
      method: options.method || 'GET',
      expiresIn: options.expiresIn || 3600,
      ...credentials,
      service: 's3',
      region: this.region,
    })
  }

  /**
   * Multipart upload for large files or streams
   */
  async uploadMultipart(
    bucket: string,
    key: string,
    body: ReadableStream | Blob | ArrayBuffer | Uint8Array,
    options: MultipartUploadOptions = {},
  ): Promise<{ etag: string }> {
    const credentials = await this.getCredentials()
    const partSize = Math.max(options.partSize || DEFAULT_PART_SIZE, MIN_PART_SIZE)

    // Convert to ReadableStream
    let stream: ReadableStream<Uint8Array>
    let totalSize: number | undefined

    if (body instanceof ReadableStream) {
      stream = body as ReadableStream<Uint8Array>
    } else if (body instanceof Blob) {
      stream = body.stream()
      totalSize = body.size
    } else {
      const blob = new Blob([body])
      stream = blob.stream()
      totalSize = blob.size
    }

    // Initiate multipart upload
    const uploadId = await this.initiateMultipartUpload(bucket, key, options)

    try {
      // Upload parts
      const parts = await this.uploadParts(
        bucket,
        key,
        uploadId,
        stream,
        partSize,
        credentials,
        totalSize,
        options.concurrency || 4,
        options.onProgress,
      )

      // Complete multipart upload
      return await this.completeMultipartUpload(bucket, key, uploadId, parts)
    } catch (error) {
      // Abort on failure
      await this.abortMultipartUpload(bucket, key, uploadId).catch(() => {})
      throw error
    }
  }

  /**
   * Initiate a multipart upload
   */
  private async initiateMultipartUpload(
    bucket: string,
    key: string,
    options: PutObjectOptions,
  ): Promise<string> {
    const credentials = await this.getCredentials()
    const url = `${this.buildUrl(bucket, key)}?uploads`

    const headers: Record<string, string> = {
      'Content-Type': options.contentType || detectContentType(key),
    }

    if (options.storageClass) headers['x-amz-storage-class'] = options.storageClass
    if (options.serverSideEncryption) headers['x-amz-server-side-encryption'] = options.serverSideEncryption
    if (options.acl) headers['x-amz-acl'] = options.acl

    if (options.metadata) {
      for (const [k, v] of Object.entries(options.metadata)) {
        headers[`x-amz-meta-${k.toLowerCase()}`] = v
      }
    }

    const signed = signRequest({
      method: 'POST',
      url,
      headers,
      ...credentials,
      service: 's3',
      region: this.region,
    })

    const response = await fetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new S3Error(`Failed to initiate multipart upload: ${error}`, response.status, bucket, key)
    }

    const xml = await response.text()
    const uploadIdMatch = xml.match(/<UploadId>([^<]+)<\/UploadId>/)

    if (!uploadIdMatch) {
      throw new S3Error('Failed to parse upload ID from response', 0, bucket, key)
    }

    return uploadIdMatch[1]
  }

  /**
   * Upload parts of a multipart upload
   */
  private async uploadParts(
    bucket: string,
    key: string,
    uploadId: string,
    stream: ReadableStream<Uint8Array>,
    partSize: number,
    credentials: AWSCredentials,
    totalSize: number | undefined,
    concurrency: number,
    onProgress?: (progress: MultipartProgress) => void,
  ): Promise<Array<{ partNumber: number, etag: string }>> {
    const parts: Array<{ partNumber: number, etag: string }> = []
    const reader = stream.getReader()
    let partNumber = 1
    let buffer = new Uint8Array(0)
    let loaded = 0

    const totalParts = totalSize ? Math.ceil(totalSize / partSize) : undefined

    const uploadQueue: Array<Promise<{ partNumber: number, etag: string }>> = []

    const uploadPart = async (data: Uint8Array, num: number): Promise<{ partNumber: number, etag: string }> => {
      const url = `${this.buildUrl(bucket, key)}?partNumber=${num}&uploadId=${encodeURIComponent(uploadId)}`

      // Use UNSIGNED-PAYLOAD for streaming
      const headers: Record<string, string> = {
        'Content-Length': String(data.byteLength),
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      }

      const signed = signRequest({
        method: 'PUT',
        url,
        headers,
        ...credentials,
        service: 's3',
        region: this.region,
      })

      const response = await fetch(signed.url, {
        method: signed.method,
        headers: signed.headers,
        body: data,
      })

      if (!response.ok) {
        const error = await response.text()
        throw new S3Error(`Failed to upload part ${num}: ${error}`, response.status, bucket, key)
      }

      const etag = (response.headers.get('ETag') || '').replace(/"/g, '')
      return { partNumber: num, etag }
    }

    while (true) {
      const { done, value } = await reader.read()

      if (value) {
        // Append to buffer
        const newBuffer = new Uint8Array(buffer.length + value.length)
        newBuffer.set(buffer)
        newBuffer.set(value, buffer.length)
        buffer = newBuffer
      }

      // Upload parts when buffer reaches partSize or stream is done
      while (buffer.length >= partSize || (done && buffer.length > 0)) {
        const partData = buffer.slice(0, partSize)
        buffer = buffer.slice(partSize)

        const currentPartNumber = partNumber++

        // Limit concurrency
        if (uploadQueue.length >= concurrency) {
          const completed = await Promise.race(uploadQueue)
          parts.push(completed)
          uploadQueue.splice(uploadQueue.indexOf(Promise.resolve(completed)), 1)
        }

        const uploadPromise = uploadPart(partData, currentPartNumber)
        uploadQueue.push(uploadPromise)

        loaded += partData.byteLength
        if (onProgress) {
          onProgress({
            loaded,
            total: totalSize || loaded,
            part: currentPartNumber,
            totalParts: totalParts || currentPartNumber,
          })
        }
      }

      if (done) break
    }

    // Wait for remaining uploads
    const remaining = await Promise.all(uploadQueue)
    parts.push(...remaining)

    // Sort by part number
    parts.sort((a, b) => a.partNumber - b.partNumber)

    return parts
  }

  /**
   * Complete a multipart upload
   */
  private async completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number, etag: string }>,
  ): Promise<{ etag: string }> {
    const credentials = await this.getCredentials()
    const url = `${this.buildUrl(bucket, key)}?uploadId=${encodeURIComponent(uploadId)}`

    // Build XML body
    const partsXml = parts
      .map(p => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag}"</ETag></Part>`)
      .join('')
    const body = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`

    const signed = signRequest({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/xml' },
      body,
      ...credentials,
      service: 's3',
      region: this.region,
    })

    const response = await fetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new S3Error(`Failed to complete multipart upload: ${error}`, response.status, bucket, key)
    }

    const xml = await response.text()
    const etagMatch = xml.match(/<ETag>"?([^"<]+)"?<\/ETag>/)
    const etag = etagMatch ? etagMatch[1] : ''

    return { etag }
  }

  /**
   * Abort a multipart upload
   */
  async abortMultipartUpload(bucket: string, key: string, uploadId: string): Promise<void> {
    const credentials = await this.getCredentials()
    const url = `${this.buildUrl(bucket, key)}?uploadId=${encodeURIComponent(uploadId)}`

    const signed = signRequest({
      method: 'DELETE',
      url,
      ...credentials,
      service: 's3',
      region: this.region,
    })

    await fetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
    })
  }

  /**
   * Empty all objects in a bucket and then delete the bucket
   */
  async emptyAndDeleteBucket(bucket: string): Promise<void> {
    // List and delete all objects
    for await (const objects of this.listAll(bucket, {})) {
      if (objects.length > 0) {
        await this.deleteMany(bucket, objects.map(o => o.key))
      }
    }

    // Delete the bucket itself
    const credentials = await this.getCredentials()
    const url = this.buildUrl(bucket)
    const signed = signRequest({
      method: 'DELETE',
      url,
      ...credentials,
      service: 's3',
      region: this.region,
    })

    await fetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
    })
  }
}

/**
 * S3 Error class
 */
export class S3Error extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public bucket: string,
    public key?: string,
  ) {
    super(message)
    this.name = 'S3Error'
  }
}

/**
 * Parse ListObjectsV2 XML response
 */
function parseListObjectsResponse(xml: string): ListObjectsResult {
  const contents: S3Object[] = []
  const commonPrefixes: string[] = []

  // Parse Contents
  const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g
  let match
  while ((match = contentsRegex.exec(xml)) !== null) {
    const content = match[1]
    contents.push({
      key: extractXmlValue(content, 'Key') || '',
      lastModified: new Date(extractXmlValue(content, 'LastModified') || 0),
      etag: (extractXmlValue(content, 'ETag') || '').replace(/"/g, ''),
      size: Number(extractXmlValue(content, 'Size') || 0),
      storageClass: extractXmlValue(content, 'StorageClass') || 'STANDARD',
    })
  }

  // Parse CommonPrefixes
  const prefixRegex = /<CommonPrefixes><Prefix>([^<]+)<\/Prefix><\/CommonPrefixes>/g
  while ((match = prefixRegex.exec(xml)) !== null) {
    commonPrefixes.push(match[1])
  }

  return {
    contents,
    commonPrefixes,
    isTruncated: extractXmlValue(xml, 'IsTruncated') === 'true',
    continuationToken: extractXmlValue(xml, 'ContinuationToken') || undefined,
    nextContinuationToken: extractXmlValue(xml, 'NextContinuationToken') || undefined,
    keyCount: Number(extractXmlValue(xml, 'KeyCount') || 0),
    maxKeys: Number(extractXmlValue(xml, 'MaxKeys') || 1000),
    prefix: extractXmlValue(xml, 'Prefix') || undefined,
    delimiter: extractXmlValue(xml, 'Delimiter') || undefined,
  }
}

/**
 * Extract value from XML element
 */
function extractXmlValue(xml: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}>([^<]*)</${tagName}>`)
  const match = xml.match(regex)
  return match ? match[1] : null
}

/**
 * Escape XML special characters
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Detect content type from file extension
 */
function detectContentType(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase()

  const contentTypes: Record<string, string> = {
    // Text
    'html': 'text/html',
    'htm': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
    'mjs': 'application/javascript',
    'json': 'application/json',
    'xml': 'application/xml',
    'txt': 'text/plain',
    'md': 'text/markdown',
    'csv': 'text/csv',

    // Images
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    'avif': 'image/avif',

    // Video
    'mp4': 'video/mp4',
    'webm': 'video/webm',
    'mov': 'video/quicktime',
    'avi': 'video/x-msvideo',

    // Audio
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'ogg': 'audio/ogg',

    // Documents
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

    // Archives
    'zip': 'application/zip',
    'gz': 'application/gzip',
    'tar': 'application/x-tar',
    'rar': 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',

    // Fonts
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
    'otf': 'font/otf',
    'eot': 'application/vnd.ms-fontobject',

    // Data
    'wasm': 'application/wasm',
  }

  return contentTypes[ext || ''] || 'application/octet-stream'
}

/**
 * Convert various body types to Blob
 */
function bodyToBlob(body: string | ArrayBuffer | Uint8Array | Blob): Blob {
  if (body instanceof Blob) return body
  if (typeof body === 'string') return new Blob([body], { type: 'text/plain' })
  return new Blob([body])
}

/**
 * Convenience function to create an S3 client
 */
export function createS3Client(options?: S3ClientOptions): S3Client {
  return new S3Client(options)
}
