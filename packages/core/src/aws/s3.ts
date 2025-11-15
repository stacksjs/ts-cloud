/**
 * AWS S3 API Client
 * Direct API calls for S3 operations without AWS SDK
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type { AWSCredentials } from './credentials'
import { resolveCredentials } from './credentials'
import { makeAWSRequest, parseXMLResponse, signRequest } from './signature'

export interface S3UploadOptions {
  bucket: string
  key: string
  body: string | Buffer
  contentType?: string
  acl?: 'private' | 'public-read' | 'public-read-write' | 'authenticated-read'
  metadata?: Record<string, string>
  cacheControl?: string
  contentEncoding?: string
}

export interface S3MultipartUploadOptions {
  bucket: string
  key: string
  filePath: string
  partSize?: number
  contentType?: string
  metadata?: Record<string, string>
}

/**
 * S3 API Client
 */
export class S3Client {
  private credentials: AWSCredentials | null = null

  constructor(
    private readonly region: string = 'us-east-1',
    private readonly profile: string = 'default',
  ) {}

  /**
   * Initialize client with credentials
   */
  async init(): Promise<void> {
    this.credentials = await resolveCredentials(this.profile)
    if (this.credentials.region) {
      this.region = this.credentials.region
    }
  }

  /**
   * Ensure credentials are loaded
   */
  private async ensureCredentials(): Promise<AWSCredentials> {
    if (!this.credentials) {
      await this.init()
    }
    return this.credentials!
  }

  /**
   * Upload a file to S3 (PutObject)
   */
  async putObject(options: S3UploadOptions): Promise<void> {
    const credentials = await this.ensureCredentials()

    const headers: Record<string, string> = {
      'Content-Type': options.contentType || 'application/octet-stream',
    }

    if (options.acl) {
      headers['x-amz-acl'] = options.acl
    }

    if (options.cacheControl) {
      headers['Cache-Control'] = options.cacheControl
    }

    if (options.contentEncoding) {
      headers['Content-Encoding'] = options.contentEncoding
    }

    // Add metadata
    if (options.metadata) {
      for (const [key, value] of Object.entries(options.metadata)) {
        headers[`x-amz-meta-${key}`] = value
      }
    }

    // Calculate Content-MD5
    const body = typeof options.body === 'string' ? Buffer.from(options.body) : options.body
    const md5 = createHash('md5').update(body).digest('base64')
    headers['Content-MD5'] = md5

    const url = `https://${options.bucket}.s3.${this.region}.amazonaws.com/${encodeURIComponent(options.key)}`

    await makeAWSRequest({
      method: 'PUT',
      url,
      service: 's3',
      region: this.region,
      headers,
      body: body.toString('base64'), // S3 expects base64 for binary data
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    })
  }

  /**
   * Download a file from S3 (GetObject)
   */
  async getObject(bucket: string, key: string): Promise<Buffer> {
    const credentials = await this.ensureCredentials()

    const url = `https://${bucket}.s3.${this.region}.amazonaws.com/${encodeURIComponent(key)}`

    const response = await makeAWSRequest({
      method: 'GET',
      url,
      service: 's3',
      region: this.region,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    })

    return Buffer.from(await response.arrayBuffer())
  }

  /**
   * Delete a file from S3
   */
  async deleteObject(bucket: string, key: string): Promise<void> {
    const credentials = await this.ensureCredentials()

    const url = `https://${bucket}.s3.${this.region}.amazonaws.com/${encodeURIComponent(key)}`

    await makeAWSRequest({
      method: 'DELETE',
      url,
      service: 's3',
      region: this.region,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    })
  }

  /**
   * List objects in a bucket
   */
  async listObjects(bucket: string, prefix?: string, maxKeys: number = 1000): Promise<any[]> {
    const credentials = await this.ensureCredentials()

    const params = new URLSearchParams({
      'list-type': '2',
      'max-keys': maxKeys.toString(),
    })

    if (prefix) {
      params.set('prefix', prefix)
    }

    const url = `https://${bucket}.s3.${this.region}.amazonaws.com/?${params.toString()}`

    const response = await makeAWSRequest({
      method: 'GET',
      url,
      service: 's3',
      region: this.region,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    })

    const data = await parseXMLResponse(response)
    return data.Contents || []
  }

  /**
   * Upload a large file using multipart upload
   */
  async multipartUpload(options: S3MultipartUploadOptions): Promise<void> {
    const credentials = await this.ensureCredentials()

    const partSize = options.partSize || 5 * 1024 * 1024 // 5MB default
    const fileStats = statSync(options.filePath)
    const fileSize = fileStats.size

    // Step 1: Initiate multipart upload
    const uploadId = await this.initiateMultipartUpload(
      options.bucket,
      options.key,
      options.contentType,
      options.metadata,
    )

    try {
      // Step 2: Upload parts
      const parts: Array<{ PartNumber: number, ETag: string }> = []
      const numParts = Math.ceil(fileSize / partSize)

      for (let partNumber = 1; partNumber <= numParts; partNumber++) {
        const start = (partNumber - 1) * partSize
        const end = Math.min(start + partSize, fileSize)
        const partData = readFileSync(options.filePath, {
          start,
          end: end - 1,
        })

        const etag = await this.uploadPart(
          options.bucket,
          options.key,
          uploadId,
          partNumber,
          partData,
        )

        parts.push({ PartNumber: partNumber, ETag: etag })
      }

      // Step 3: Complete multipart upload
      await this.completeMultipartUpload(
        options.bucket,
        options.key,
        uploadId,
        parts,
      )
    }
    catch (error) {
      // Abort multipart upload on error
      await this.abortMultipartUpload(options.bucket, options.key, uploadId)
      throw error
    }
  }

  /**
   * Initiate multipart upload
   */
  private async initiateMultipartUpload(
    bucket: string,
    key: string,
    contentType?: string,
    metadata?: Record<string, string>,
  ): Promise<string> {
    const credentials = await this.ensureCredentials()

    const headers: Record<string, string> = {}

    if (contentType) {
      headers['Content-Type'] = contentType
    }

    if (metadata) {
      for (const [k, v] of Object.entries(metadata)) {
        headers[`x-amz-meta-${k}`] = v
      }
    }

    const url = `https://${bucket}.s3.${this.region}.amazonaws.com/${encodeURIComponent(key)}?uploads`

    const response = await makeAWSRequest({
      method: 'POST',
      url,
      service: 's3',
      region: this.region,
      headers,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    })

    const data = await parseXMLResponse(response)
    return data.UploadId
  }

  /**
   * Upload a part
   */
  private async uploadPart(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    data: Buffer,
  ): Promise<string> {
    const credentials = await this.ensureCredentials()

    const url = `https://${bucket}.s3.${this.region}.amazonaws.com/${encodeURIComponent(key)}?partNumber=${partNumber}&uploadId=${uploadId}`

    const response = await makeAWSRequest({
      method: 'PUT',
      url,
      service: 's3',
      region: this.region,
      body: data.toString('base64'),
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    })

    // ETag is returned in the response headers
    return response.headers.get('ETag') || ''
  }

  /**
   * Complete multipart upload
   */
  private async completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: Array<{ PartNumber: number, ETag: string }>,
  ): Promise<void> {
    const credentials = await this.ensureCredentials()

    const body = `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUpload>
  ${parts.map(part => `<Part><PartNumber>${part.PartNumber}</PartNumber><ETag>${part.ETag}</ETag></Part>`).join('')}
</CompleteMultipartUpload>`

    const url = `https://${bucket}.s3.${this.region}.amazonaws.com/${encodeURIComponent(key)}?uploadId=${uploadId}`

    await makeAWSRequest({
      method: 'POST',
      url,
      service: 's3',
      region: this.region,
      headers: {
        'Content-Type': 'application/xml',
      },
      body,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    })
  }

  /**
   * Abort multipart upload
   */
  private async abortMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
  ): Promise<void> {
    const credentials = await this.ensureCredentials()

    const url = `https://${bucket}.s3.${this.region}.amazonaws.com/${encodeURIComponent(key)}?uploadId=${uploadId}`

    await makeAWSRequest({
      method: 'DELETE',
      url,
      service: 's3',
      region: this.region,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    })
  }

  /**
   * Sync a directory to S3 (similar to aws s3 sync)
   */
  async syncDirectory(
    localDir: string,
    bucket: string,
    prefix: string = '',
  ): Promise<void> {
    const { readdirSync } = await import('node:fs')
    const { join, relative } = await import('node:path')

    const uploadFile = async (filePath: string): Promise<void> => {
      const relativePath = relative(localDir, filePath)
      const s3Key = prefix ? `${prefix}/${relativePath}` : relativePath

      const content = readFileSync(filePath)

      await this.putObject({
        bucket,
        key: s3Key,
        body: content,
        contentType: getContentType(filePath),
      })
    }

    const walkDir = async (dir: string): Promise<void> => {
      const files = readdirSync(dir, { withFileTypes: true })

      for (const file of files) {
        const fullPath = join(dir, file.name)

        if (file.isDirectory()) {
          await walkDir(fullPath)
        }
        else {
          await uploadFile(fullPath)
        }
      }
    }

    await walkDir(localDir)
  }
}

/**
 * Get content type based on file extension
 */
function getContentType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()

  const contentTypes: Record<string, string> = {
    'html': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    'txt': 'text/plain',
    'pdf': 'application/pdf',
    'zip': 'application/zip',
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
    'eot': 'application/vnd.ms-fontobject',
  }

  return contentTypes[ext || ''] || 'application/octet-stream'
}
