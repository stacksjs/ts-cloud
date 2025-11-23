/**
 * AWS S3 Operations
 * Direct API calls without AWS CLI dependency
 */

import { AWSClient } from './client'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

export interface S3SyncOptions {
  source: string
  bucket: string
  prefix?: string
  delete?: boolean
  acl?: 'private' | 'public-read' | 'public-read-write' | 'authenticated-read'
  cacheControl?: string
  contentType?: string
  metadata?: Record<string, string>
  exclude?: string[]
  include?: string[]
  dryRun?: boolean
}

export interface S3CopyOptions {
  source: string
  bucket: string
  key: string
  acl?: 'private' | 'public-read' | 'public-read-write' | 'authenticated-read'
  cacheControl?: string
  contentType?: string
  metadata?: Record<string, string>
}

export interface S3ListOptions {
  bucket: string
  prefix?: string
  maxKeys?: number
}

export interface S3Object {
  Key: string
  LastModified: string
  Size: number
  ETag?: string
}

/**
 * S3 client using direct API calls
 */
export class S3Client {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1', profile?: string) {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * List all S3 buckets in the account
   */
  async listBuckets(): Promise<{ Buckets: Array<{ Name: string, CreationDate?: string }> }> {
    const result = await this.client.request({
      service: 's3',
      region: this.region,
      method: 'GET',
      path: '/',
    })

    const buckets: Array<{ Name: string, CreationDate?: string }> = []
    const bucketList = result?.ListAllMyBucketsResult?.Buckets?.Bucket

    if (bucketList) {
      const list = Array.isArray(bucketList) ? bucketList : [bucketList]
      for (const b of list) {
        buckets.push({
          Name: b.Name,
          CreationDate: b.CreationDate,
        })
      }
    }

    return { Buckets: buckets }
  }

  /**
   * Create an S3 bucket
   */
  async createBucket(bucket: string, options?: { acl?: string }): Promise<void> {
    const headers: Record<string, string> = {}
    if (options?.acl) {
      headers['x-amz-acl'] = options.acl
    }

    // For us-east-1, don't include LocationConstraint
    // For other regions, include it in the body
    let body: string | undefined
    if (this.region !== 'us-east-1') {
      body = `<?xml version="1.0" encoding="UTF-8"?>
<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <LocationConstraint>${this.region}</LocationConstraint>
</CreateBucketConfiguration>`
      headers['Content-Type'] = 'application/xml'
    }

    await this.client.request({
      service: 's3',
      region: this.region,
      method: 'PUT',
      path: `/${bucket}`,
      headers,
      body,
    })
  }

  /**
   * Delete an S3 bucket (must be empty)
   */
  async deleteBucket(bucket: string): Promise<void> {
    await this.client.request({
      service: 's3',
      region: this.region,
      method: 'DELETE',
      path: `/${bucket}`,
    })
  }

  /**
   * Empty and delete an S3 bucket
   */
  async emptyAndDeleteBucket(bucket: string): Promise<void> {
    // First list and delete all objects
    let hasMore = true
    while (hasMore) {
      const objects = await this.listAllObjects({ bucket })
      if (objects.length === 0) {
        hasMore = false
        break
      }

      // Delete in batches of 1000 (S3 limit)
      const keys = objects.map(obj => obj.Key)
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000)
        await this.deleteObjects(bucket, batch)
      }
    }

    // Now delete the bucket
    await this.deleteBucket(bucket)
  }

  /**
   * List all objects in a bucket (handles pagination)
   */
  async listAllObjects(options: S3ListOptions): Promise<S3Object[]> {
    const allObjects: S3Object[] = []
    let continuationToken: string | undefined

    do {
      const params: Record<string, any> = {
        'list-type': '2',
        'max-keys': '1000',
      }

      if (options.prefix) {
        params.prefix = options.prefix
      }

      if (continuationToken) {
        params['continuation-token'] = continuationToken
      }

      const result = await this.client.request({
        service: 's3',
        region: this.region,
        method: 'GET',
        path: `/${options.bucket}`,
        queryParams: params,
      })

      const contents = result?.ListBucketResult?.Contents
      if (contents) {
        const list = Array.isArray(contents) ? contents : [contents]
        for (const obj of list) {
          allObjects.push({
            Key: obj.Key,
            LastModified: obj.LastModified || '',
            Size: Number.parseInt(obj.Size || '0'),
            ETag: obj.ETag,
          })
        }
      }

      // Check for more results
      const isTruncated = result?.ListBucketResult?.IsTruncated
      continuationToken = isTruncated === 'true' || isTruncated === true
        ? result?.ListBucketResult?.NextContinuationToken
        : undefined

    } while (continuationToken)

    return allObjects
  }

  /**
   * List objects in S3 bucket
   */
  async list(options: S3ListOptions): Promise<S3Object[]> {
    const params: Record<string, any> = {
      'list-type': '2',
    }

    if (options.prefix) {
      params.prefix = options.prefix
    }

    if (options.maxKeys) {
      params['max-keys'] = options.maxKeys.toString()
    }

    const result = await this.client.request({
      service: 's3',
      region: this.region,
      method: 'GET',
      path: `/${options.bucket}`,
      queryParams: params,
    })

    // Parse S3 XML response
    const objects: S3Object[] = []

    // Simple parsing - in production would use proper XML parser
    if (result.Key) {
      objects.push({
        Key: result.Key,
        LastModified: result.LastModified || '',
        Size: Number.parseInt(result.Size || '0'),
        ETag: result.ETag,
      })
    }

    return objects
  }

  /**
   * Put object to S3 bucket
   */
  async putObject(options: {
    bucket: string
    key: string
    body: string | Buffer
    acl?: string
    cacheControl?: string
    contentType?: string
    metadata?: Record<string, string>
  }): Promise<void> {
    const headers: Record<string, string> = {}

    if (options.acl) {
      headers['x-amz-acl'] = options.acl
    }

    if (options.cacheControl) {
      headers['Cache-Control'] = options.cacheControl
    }

    if (options.contentType) {
      headers['Content-Type'] = options.contentType
    }

    if (options.metadata) {
      for (const [key, value] of Object.entries(options.metadata)) {
        headers[`x-amz-meta-${key}`] = value
      }
    }

    await this.client.request({
      service: 's3',
      region: this.region,
      method: 'PUT',
      path: `/${options.bucket}/${options.key}`,
      headers,
      body: typeof options.body === 'string' ? options.body : options.body.toString(),
    })
  }

  /**
   * Get object from S3 bucket
   */
  async getObject(bucket: string, key: string): Promise<string> {
    const result = await this.client.request({
      service: 's3',
      region: this.region,
      method: 'GET',
      path: `/${bucket}/${key}`,
    })

    return result
  }

  /**
   * Delete object from S3
   */
  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.client.request({
      service: 's3',
      region: this.region,
      method: 'DELETE',
      path: `/${bucket}/${key}`,
    })
  }

  /**
   * Delete multiple objects from S3
   */
  async deleteObjects(bucket: string, keys: string[]): Promise<void> {
    const deleteXml = `<?xml version="1.0" encoding="UTF-8"?>
<Delete>
  ${keys.map(key => `<Object><Key>${key}</Key></Object>`).join('\n  ')}
</Delete>`

    await this.client.request({
      service: 's3',
      region: this.region,
      method: 'POST',
      path: `/${bucket}`,
      queryParams: { delete: '' },
      body: deleteXml,
      headers: {
        'Content-Type': 'application/xml',
      },
    })
  }

  /**
   * Check if bucket exists
   */
  async bucketExists(bucket: string): Promise<boolean> {
    try {
      await this.client.request({
        service: 's3',
        region: this.region,
        method: 'HEAD',
        path: `/${bucket}`,
      })
      return true
    }
    catch {
      return false
    }
  }

  /**
   * Copy file to S3
   */
  async copy(options: S3CopyOptions): Promise<void> {
    // Read file and upload
    const fileContent = readFileSync(options.source)

    await this.putObject({
      bucket: options.bucket,
      key: options.key,
      body: fileContent,
      acl: options.acl,
      cacheControl: options.cacheControl,
      contentType: options.contentType,
      metadata: options.metadata,
    })
  }

  /**
   * Sync local directory to S3 bucket
   * Note: This is a simplified version. For production use, implement proper sync logic
   */
  async sync(options: S3SyncOptions): Promise<void> {
    const files = await this.listFilesRecursive(options.source)

    for (const file of files) {
      // Skip excluded files
      if (options.exclude && options.exclude.some(pattern => file.includes(pattern))) {
        continue
      }

      // Check included files
      if (options.include && !options.include.some(pattern => file.includes(pattern))) {
        continue
      }

      const relativePath = file.substring(options.source.length + 1)
      const s3Key = options.prefix ? `${options.prefix}/${relativePath}` : relativePath

      if (!options.dryRun) {
        const fileContent = readFileSync(file)

        await this.putObject({
          bucket: options.bucket,
          key: s3Key,
          body: fileContent,
          acl: options.acl,
          cacheControl: options.cacheControl,
          contentType: options.contentType,
          metadata: options.metadata,
        })
      }
    }
  }

  /**
   * Delete object from S3 (alias for deleteObject)
   */
  async delete(bucket: string, key: string): Promise<void> {
    await this.deleteObject(bucket, key)
  }

  /**
   * Delete all objects in a prefix
   */
  async deletePrefix(bucket: string, prefix: string): Promise<void> {
    const objects = await this.list({ bucket, prefix })
    const keys = objects.map(obj => obj.Key)

    if (keys.length > 0) {
      await this.deleteObjects(bucket, keys)
    }
  }

  /**
   * Get bucket size
   */
  async getBucketSize(bucket: string, prefix?: string): Promise<number> {
    const objects = await this.list({ bucket, prefix })
    return objects.reduce((total, obj) => total + obj.Size, 0)
  }

  /**
   * List files recursively in a directory
   */
  private async listFilesRecursive(dir: string): Promise<string[]> {
    const files: string[] = []
    const entries = await readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        const subFiles = await this.listFilesRecursive(fullPath)
        files.push(...subFiles)
      }
      else {
        files.push(fullPath)
      }
    }

    return files
  }
}
