/**
 * AWS CloudFront Operations
 * Uses AWS CLI (no SDK dependencies) for CloudFront operations
 */

export interface InvalidationOptions {
  distributionId: string
  paths: string[]
  callerReference?: string
}

export interface Distribution {
  Id: string
  ARN: string
  Status: string
  DomainName: string
  Aliases?: string[]
  Enabled: boolean
}

/**
 * CloudFront client using AWS CLI
 */
export class CloudFrontClient {
  private profile?: string

  constructor(profile?: string) {
    this.profile = profile
  }

  /**
   * Build base AWS CLI command
   */
  private buildBaseCommand(): string[] {
    const cmd = ['aws', 'cloudfront']

    if (this.profile) {
      cmd.push('--profile', this.profile)
    }

    cmd.push('--output', 'json')

    return cmd
  }

  /**
   * Execute AWS CLI command
   */
  private async executeCommand(args: string[]): Promise<any> {
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

    return stdout ? JSON.parse(stdout) : null
  }

  /**
   * Create cache invalidation
   */
  async createInvalidation(options: InvalidationOptions): Promise<{
    Id: string
    Status: string
    CreateTime: string
  }> {
    const cmd = [...this.buildBaseCommand(), 'create-invalidation']

    cmd.push('--distribution-id', options.distributionId)

    const invalidationBatch = {
      Paths: {
        Quantity: options.paths.length,
        Items: options.paths,
      },
      CallerReference: options.callerReference || Date.now().toString(),
    }

    cmd.push('--invalidation-batch', JSON.stringify(invalidationBatch))

    const result = await this.executeCommand(cmd)

    return {
      Id: result.Invalidation.Id,
      Status: result.Invalidation.Status,
      CreateTime: result.Invalidation.CreateTime,
    }
  }

  /**
   * Get invalidation status
   */
  async getInvalidation(distributionId: string, invalidationId: string): Promise<{
    Id: string
    Status: string
    CreateTime: string
  }> {
    const cmd = [...this.buildBaseCommand(), 'get-invalidation']

    cmd.push('--distribution-id', distributionId)
    cmd.push('--id', invalidationId)

    const result = await this.executeCommand(cmd)

    return {
      Id: result.Invalidation.Id,
      Status: result.Invalidation.Status,
      CreateTime: result.Invalidation.CreateTime,
    }
  }

  /**
   * List invalidations
   */
  async listInvalidations(distributionId: string): Promise<Array<{
    Id: string
    Status: string
    CreateTime: string
  }>> {
    const cmd = [...this.buildBaseCommand(), 'list-invalidations']

    cmd.push('--distribution-id', distributionId)

    const result = await this.executeCommand(cmd)

    return result.InvalidationList?.Items || []
  }

  /**
   * Wait for invalidation to complete
   */
  async waitForInvalidation(distributionId: string, invalidationId: string): Promise<void> {
    const cmd = [...this.buildBaseCommand(), 'wait', 'invalidation-completed']

    cmd.push('--distribution-id', distributionId)
    cmd.push('--id', invalidationId)

    await this.executeCommand(cmd)
  }

  /**
   * List distributions
   */
  async listDistributions(): Promise<Distribution[]> {
    const cmd = [...this.buildBaseCommand(), 'list-distributions']

    const result = await this.executeCommand(cmd)

    if (!result.DistributionList || !result.DistributionList.Items) {
      return []
    }

    return result.DistributionList.Items.map((item: any) => ({
      Id: item.Id,
      ARN: item.ARN,
      Status: item.Status,
      DomainName: item.DomainName,
      Aliases: item.Aliases?.Items,
      Enabled: item.Enabled,
    }))
  }

  /**
   * Get distribution by ID
   */
  async getDistribution(distributionId: string): Promise<Distribution> {
    const cmd = [...this.buildBaseCommand(), 'get-distribution']

    cmd.push('--id', distributionId)

    const result = await this.executeCommand(cmd)

    const dist = result.Distribution
    return {
      Id: dist.Id,
      ARN: dist.ARN,
      Status: dist.Status,
      DomainName: dist.DomainName,
      Aliases: dist.DistributionConfig?.Aliases?.Items,
      Enabled: dist.DistributionConfig?.Enabled,
    }
  }

  /**
   * Invalidate all files
   */
  async invalidateAll(distributionId: string): Promise<{
    Id: string
    Status: string
    CreateTime: string
  }> {
    return this.createInvalidation({
      distributionId,
      paths: ['/*'],
    })
  }

  /**
   * Invalidate specific paths
   */
  async invalidatePaths(distributionId: string, paths: string[]): Promise<{
    Id: string
    Status: string
    CreateTime: string
  }> {
    // Ensure paths start with /
    const formattedPaths = paths.map(path => path.startsWith('/') ? path : `/${path}`)

    return this.createInvalidation({
      distributionId,
      paths: formattedPaths,
    })
  }

  /**
   * Invalidate by pattern
   */
  async invalidatePattern(distributionId: string, pattern: string): Promise<{
    Id: string
    Status: string
    CreateTime: string
  }> {
    // CloudFront supports wildcards like /images/* or /css/*
    const path = pattern.startsWith('/') ? pattern : `/${pattern}`

    return this.createInvalidation({
      distributionId,
      paths: [path],
    })
  }
}
