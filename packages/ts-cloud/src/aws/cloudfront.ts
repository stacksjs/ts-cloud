/**
 * AWS CloudFront Operations
 * Direct API calls without AWS CLI dependency
 */

import { AWSClient } from './client'

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
 * CloudFront client using direct API calls
 */
export class CloudFrontClient {
  private client: AWSClient

  constructor(profile?: string) {
    this.client = new AWSClient()
  }

  /**
   * Create cache invalidation
   */
  async createInvalidation(options: InvalidationOptions): Promise<{
    Id: string
    Status: string
    CreateTime: string
  }> {
    const callerReference = options.callerReference || Date.now().toString()

    const invalidationBatchXml = `<?xml version="1.0" encoding="UTF-8"?>
<InvalidationBatch>
  <Paths>
    <Quantity>${options.paths.length}</Quantity>
    <Items>
      ${options.paths.map(path => `<Path>${path}</Path>`).join('\n      ')}
    </Items>
  </Paths>
  <CallerReference>${callerReference}</CallerReference>
</InvalidationBatch>`

    const result = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1', // CloudFront is global
      method: 'POST',
      path: `/2020-05-31/distribution/${options.distributionId}/invalidation`,
      body: invalidationBatchXml,
      headers: {
        'Content-Type': 'application/xml',
      },
    })

    return {
      Id: result.Id || result.Invalidation?.Id,
      Status: result.Status || result.Invalidation?.Status || 'InProgress',
      CreateTime: result.CreateTime || result.Invalidation?.CreateTime || new Date().toISOString(),
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
    const result = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'GET',
      path: `/2020-05-31/distribution/${distributionId}/invalidation/${invalidationId}`,
    })

    return {
      Id: result.Id || result.Invalidation?.Id,
      Status: result.Status || result.Invalidation?.Status,
      CreateTime: result.CreateTime || result.Invalidation?.CreateTime,
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
    const result = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'GET',
      path: `/2020-05-31/distribution/${distributionId}/invalidation`,
    })

    // Parse invalidation list
    const invalidations: Array<{ Id: string, Status: string, CreateTime: string }> = []

    // Simple parser - would need proper XML parsing in production
    if (result.InvalidationSummary) {
      const summaries = Array.isArray(result.InvalidationSummary)
        ? result.InvalidationSummary
        : [result.InvalidationSummary]

      invalidations.push(...summaries.map((item: any) => ({
        Id: item.Id,
        Status: item.Status,
        CreateTime: item.CreateTime,
      })))
    }

    return invalidations
  }

  /**
   * Wait for invalidation to complete
   */
  async waitForInvalidation(distributionId: string, invalidationId: string): Promise<void> {
    const maxAttempts = 60 // 5 minutes
    let attempts = 0

    while (attempts < maxAttempts) {
      const invalidation = await this.getInvalidation(distributionId, invalidationId)

      if (invalidation.Status === 'Completed') {
        return
      }

      // Wait 5 seconds before next attempt
      await new Promise(resolve => setTimeout(resolve, 5000))
      attempts++
    }

    throw new Error(`Timeout waiting for invalidation ${invalidationId} to complete`)
  }

  /**
   * List distributions
   */
  async listDistributions(): Promise<Distribution[]> {
    const result = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'GET',
      path: '/2020-05-31/distribution',
    })

    const distributions: Distribution[] = []

    // Simple parser - would need proper XML parsing in production
    if (result.DistributionSummary) {
      const summaries = Array.isArray(result.DistributionSummary)
        ? result.DistributionSummary
        : [result.DistributionSummary]

      distributions.push(...summaries.map((item: any) => ({
        Id: item.Id,
        ARN: item.ARN,
        Status: item.Status,
        DomainName: item.DomainName,
        Aliases: item.Aliases?.Items || [],
        Enabled: item.Enabled === 'true' || item.Enabled === true,
      })))
    }

    return distributions
  }

  /**
   * Get distribution by ID
   */
  async getDistribution(distributionId: string): Promise<Distribution> {
    const result = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'GET',
      path: `/2020-05-31/distribution/${distributionId}`,
    })

    const dist = result.Distribution || result

    return {
      Id: dist.Id,
      ARN: dist.ARN,
      Status: dist.Status,
      DomainName: dist.DomainName,
      Aliases: dist.DistributionConfig?.Aliases?.Items || dist.Aliases?.Items || [],
      Enabled: dist.DistributionConfig?.Enabled === 'true' || dist.DistributionConfig?.Enabled === true,
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
