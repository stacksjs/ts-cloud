/**
 * AWS S3 Operations
 * Uses AWS CLI (no SDK dependencies) for S3 operations
 */

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

/**
 * S3 client using AWS CLI
 */
export class S3Client {
  private region: string
  private profile?: string

  constructor(region: string, profile?: string) {
    this.region = region
    this.profile = profile
  }

  /**
   * Build base AWS CLI command
   */
  private buildBaseCommand(): string[] {
    const cmd = ['aws', 's3']

    if (this.region) {
      cmd.push('--region', this.region)
    }

    if (this.profile) {
      cmd.push('--profile', this.profile)
    }

    return cmd
  }

  /**
   * Execute AWS CLI command
   */
  private async executeCommand(args: string[]): Promise<string> {
    const proc = Bun.spawn(args, {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()

    await proc.exited

    if (proc.exitCode !== 0) {
      throw new Error(`AWS CLI Error: ${stderr || stdout}`)
    }

    return stdout
  }

  /**
   * Sync local directory to S3 bucket
   */
  async sync(options: S3SyncOptions): Promise<void> {
    const cmd = [...this.buildBaseCommand(), 'sync', options.source]

    const s3Path = options.prefix
      ? `s3://${options.bucket}/${options.prefix}`
      : `s3://${options.bucket}`

    cmd.push(s3Path)

    if (options.delete) {
      cmd.push('--delete')
    }

    if (options.acl) {
      cmd.push('--acl', options.acl)
    }

    if (options.cacheControl) {
      cmd.push('--cache-control', options.cacheControl)
    }

    if (options.contentType) {
      cmd.push('--content-type', options.contentType)
    }

    if (options.metadata) {
      const metadataStr = Object.entries(options.metadata)
        .map(([key, value]) => `${key}=${value}`)
        .join(',')
      cmd.push('--metadata', metadataStr)
    }

    if (options.exclude) {
      for (const pattern of options.exclude) {
        cmd.push('--exclude', pattern)
      }
    }

    if (options.include) {
      for (const pattern of options.include) {
        cmd.push('--include', pattern)
      }
    }

    if (options.dryRun) {
      cmd.push('--dryrun')
    }

    await this.executeCommand(cmd)
  }

  /**
   * Copy file to S3
   */
  async copy(options: S3CopyOptions): Promise<void> {
    const cmd = [...this.buildBaseCommand(), 'cp', options.source]

    const s3Path = `s3://${options.bucket}/${options.key}`
    cmd.push(s3Path)

    if (options.acl) {
      cmd.push('--acl', options.acl)
    }

    if (options.cacheControl) {
      cmd.push('--cache-control', options.cacheControl)
    }

    if (options.contentType) {
      cmd.push('--content-type', options.contentType)
    }

    if (options.metadata) {
      const metadataStr = Object.entries(options.metadata)
        .map(([key, value]) => `${key}=${value}`)
        .join(',')
      cmd.push('--metadata', metadataStr)
    }

    await this.executeCommand(cmd)
  }

  /**
   * List objects in S3 bucket
   */
  async list(options: S3ListOptions): Promise<Array<{
    Key: string
    LastModified: string
    Size: number
  }>> {
    const cmd = ['aws', 's3api', 'list-objects-v2']

    if (this.region) {
      cmd.push('--region', this.region)
    }

    if (this.profile) {
      cmd.push('--profile', this.profile)
    }

    cmd.push('--bucket', options.bucket)

    if (options.prefix) {
      cmd.push('--prefix', options.prefix)
    }

    if (options.maxKeys) {
      cmd.push('--max-keys', options.maxKeys.toString())
    }

    cmd.push('--output', 'json')

    const output = await this.executeCommand(cmd)
    const result = JSON.parse(output)

    return result.Contents || []
  }

  /**
   * Delete object from S3
   */
  async delete(bucket: string, key: string): Promise<void> {
    const cmd = [...this.buildBaseCommand(), 'rm', `s3://${bucket}/${key}`]
    await this.executeCommand(cmd)
  }

  /**
   * Delete all objects in a prefix
   */
  async deletePrefix(bucket: string, prefix: string): Promise<void> {
    const cmd = [...this.buildBaseCommand(), 'rm', `s3://${bucket}/${prefix}`, '--recursive']
    await this.executeCommand(cmd)
  }

  /**
   * Get bucket size
   */
  async getBucketSize(bucket: string, prefix?: string): Promise<number> {
    const objects = await this.list({ bucket, prefix })
    return objects.reduce((total, obj) => total + obj.Size, 0)
  }

  /**
   * Check if bucket exists
   */
  async bucketExists(bucket: string): Promise<boolean> {
    try {
      const cmd = ['aws', 's3api', 'head-bucket']

      if (this.region) {
        cmd.push('--region', this.region)
      }

      if (this.profile) {
        cmd.push('--profile', this.profile)
      }

      cmd.push('--bucket', bucket)

      await this.executeCommand(cmd)
      return true
    }
    catch {
      return false
    }
  }
}
