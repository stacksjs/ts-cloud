/**
 * AWS CloudFront Operations
 * Direct API calls without AWS CLI dependency
 */

import type { AWSRequestOptions } from './client'
import { AWSClient } from './client'

interface CloudFrontTransport { request: (options: AWSRequestOptions) => Promise<any> }

export interface ExistingDistributionOriginInput {
  id: string
  domainName: string
  pathPattern: string
  originPath?: string
  protocolPolicy?: 'https-only' | 'http-only' | 'match-viewer'
  customHeaders?: Record<string, string>
  originAccessControlId?: string
  replaceExisting?: boolean
  dryRun?: boolean
}

export interface ExistingDistributionOriginResult {
  distributionId: string
  originId: string
  domainName: string
  pathPattern: string
  changed: boolean
  applied: boolean
  originRemoved?: boolean
  etag: string
}

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
  Aliases?: { Quantity?: number; Items?: string[] }
  Enabled: boolean
}

/**
 * CloudFront client using direct API calls
 */
export class CloudFrontClient {
  private client: CloudFrontTransport

  constructor(profile?: string, transport?: CloudFrontTransport) {
    this.client = transport ?? new AWSClient(undefined, { profile })
  }

  private collectionItems(value: any, child: string): any[] {
    const items = value?.Items ?? value?.[child]
    if (!items) return []
    if (Array.isArray(items)) return items
    const nested = items[child] ?? items.Item
    if (nested === undefined) return typeof items === 'object' && (items.Id || items.PathPattern) ? [items] : []
    return Array.isArray(nested) ? nested : [nested]
  }

  private validateExistingOriginInput(distributionId: string, input: ExistingDistributionOriginInput): ExistingDistributionOriginInput {
    if (!/^[A-Z0-9]{8,32}$/.test(distributionId)) throw new Error('CloudFront distribution ID is invalid')
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.id)) throw new Error('CloudFront origin ID is invalid')
    if (!/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(input.domainName)) throw new Error('CloudFront origin must be a hostname without a scheme or path')
    const pathPattern = input.pathPattern.startsWith('/') ? input.pathPattern : `/${input.pathPattern}`
    if (pathPattern === '/' || pathPattern === '/*' || !/^\/[A-Za-z0-9_.*?~!$&'()+,;=:@%/-]{1,255}$/.test(pathPattern)) throw new Error('CloudFront path pattern must be a non-default absolute pattern')
    if (input.originPath && (!input.originPath.startsWith('/') || input.originPath.includes('..'))) throw new Error('CloudFront origin path must be absolute and traversal-free')
    if (Object.entries(input.customHeaders ?? {}).some(([name, value]) => !/^[A-Za-z0-9-]{1,64}$/.test(name) || !value || value.length > 1024)) throw new Error('CloudFront custom origin headers are invalid')
    return { ...input, pathPattern }
  }

  /**
   * Add a custom backend origin and path behavior to a live distribution while
   * preserving the existing default S3 origin and every unrelated field.
   */
  async upsertExistingDistributionOrigin(distributionId: string, rawInput: ExistingDistributionOriginInput): Promise<ExistingDistributionOriginResult> {
    const input = this.validateExistingOriginInput(distributionId, rawInput)
    const getResult = await this.client.request({ service: 'cloudfront', region: 'us-east-1', method: 'GET', path: `/2020-05-31/distribution/${distributionId}/config`, returnHeaders: true })
    const etag = getResult.headers?.etag || getResult.headers?.ETag || getResult.ETag || ''
    const config = getResult.body?.DistributionConfig || getResult.DistributionConfig || getResult.body
    if (!config || config.Enabled === undefined || !etag) throw new Error('Failed to read an ETag-protected CloudFront distribution config')
    const origins = this.collectionItems(config.Origins, 'Origin')
    const behaviors = this.collectionItems(config.CacheBehaviors, 'CacheBehavior')
    const existingOrigin = origins.find(value => String(value.Id) === input.id)
    const existingBehavior = behaviors.find(value => String(value.PathPattern) === input.pathPattern)
    if (existingOrigin && String(existingOrigin.DomainName) !== input.domainName && !input.replaceExisting) throw new Error(`Origin ${input.id} already targets ${existingOrigin.DomainName}; pass replaceExisting only after reviewing the live config`)
    if (existingBehavior && String(existingBehavior.TargetOriginId) !== input.id && !input.replaceExisting) throw new Error(`Path ${input.pathPattern} already targets ${existingBehavior.TargetOriginId}; pass replaceExisting only after reviewing the live config`)
    const origin = { Id: input.id, DomainName: input.domainName, OriginPath: input.originPath ?? '', CustomHeaders: { Quantity: Object.keys(input.customHeaders ?? {}).length, ...(Object.keys(input.customHeaders ?? {}).length ? { Items: { OriginCustomHeader: Object.entries(input.customHeaders!).map(([HeaderName, HeaderValue]) => ({ HeaderName, HeaderValue })) } } : {}) }, CustomOriginConfig: { HTTPPort: 80, HTTPSPort: 443, OriginProtocolPolicy: input.protocolPolicy ?? 'https-only', OriginSslProtocols: { Quantity: 1, Items: { SslProtocol: ['TLSv1.2'] } }, OriginReadTimeout: 30, OriginKeepaliveTimeout: 5 }, ConnectionAttempts: 3, ConnectionTimeout: 10, ...(input.originAccessControlId ? { OriginAccessControlId: input.originAccessControlId } : {}) }
    const methods = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE']
    const behavior = { PathPattern: input.pathPattern, TargetOriginId: input.id, ViewerProtocolPolicy: 'redirect-to-https', Compress: true, CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac', AllowedMethods: { Quantity: methods.length, Items: { Method: methods }, CachedMethods: { Quantity: 2, Items: { Method: ['GET', 'HEAD'] } } }, SmoothStreaming: false, FieldLevelEncryptionId: '', TrustedSigners: { Enabled: false, Quantity: 0 }, TrustedKeyGroups: { Enabled: false, Quantity: 0 }, LambdaFunctionAssociations: { Quantity: 0 }, FunctionAssociations: { Quantity: 0 } }
    const nextOrigins = existingOrigin ? origins.map(value => String(value.Id) === input.id ? origin : value) : [...origins, origin]
    const nextBehaviors = existingBehavior ? behaviors.map(value => String(value.PathPattern) === input.pathPattern ? behavior : value) : [...behaviors, behavior]
    const changed = JSON.stringify(origins) !== JSON.stringify(nextOrigins) || JSON.stringify(behaviors) !== JSON.stringify(nextBehaviors)
    if (!changed || input.dryRun) return { distributionId, originId: input.id, domainName: input.domainName, pathPattern: input.pathPattern, changed, applied: false, etag }
    config.Origins = { Quantity: nextOrigins.length, Items: { Origin: nextOrigins } }
    config.CacheBehaviors = { Quantity: nextBehaviors.length, ...(nextBehaviors.length ? { Items: { CacheBehavior: nextBehaviors } } : {}) }
    const result = await this.client.request({ service: 'cloudfront', region: 'us-east-1', method: 'PUT', path: `/2020-05-31/distribution/${distributionId}/config`, body: this.buildDistributionConfigXml(config), headers: { 'Content-Type': 'application/xml', 'If-Match': etag } })
    return { distributionId, originId: input.id, domainName: input.domainName, pathPattern: input.pathPattern, changed: true, applied: true, etag: result.ETag || result.headers?.etag || '' }
  }

  /** Remove only the named path behavior and remove its origin if now unused. */
  async removeExistingDistributionOrigin(distributionId: string, rawInput: Pick<ExistingDistributionOriginInput, 'id' | 'domainName' | 'pathPattern' | 'dryRun'>): Promise<ExistingDistributionOriginResult> {
    const input = this.validateExistingOriginInput(distributionId, rawInput)
    const getResult = await this.client.request({ service: 'cloudfront', region: 'us-east-1', method: 'GET', path: `/2020-05-31/distribution/${distributionId}/config`, returnHeaders: true })
    const etag = getResult.headers?.etag || getResult.headers?.ETag || getResult.ETag || ''; const config = getResult.body?.DistributionConfig || getResult.DistributionConfig || getResult.body
    if (!config || config.Enabled === undefined || !etag) throw new Error('Failed to read an ETag-protected CloudFront distribution config')
    const origins = this.collectionItems(config.Origins, 'Origin'); const behaviors = this.collectionItems(config.CacheBehaviors, 'CacheBehavior'); const origin = origins.find(value => String(value.Id) === input.id); const behavior = behaviors.find(value => String(value.PathPattern) === input.pathPattern)
    if (origin && String(origin.DomainName) !== input.domainName) throw new Error(`Origin ${input.id} no longer targets ${input.domainName}; refusing ambiguous removal`)
    if (behavior && String(behavior.TargetOriginId) !== input.id) throw new Error(`Path ${input.pathPattern} no longer targets ${input.id}; refusing ambiguous removal`)
    if (!behavior) return { distributionId, originId: input.id, domainName: input.domainName, pathPattern: input.pathPattern, changed: false, applied: false, originRemoved: false, etag }
    const nextBehaviors = behaviors.filter(value => String(value.PathPattern) !== input.pathPattern); const stillReferenced = String(config.DefaultCacheBehavior?.TargetOriginId) === input.id || nextBehaviors.some(value => String(value.TargetOriginId) === input.id); const nextOrigins = stillReferenced ? origins : origins.filter(value => String(value.Id) !== input.id)
    if (input.dryRun) return { distributionId, originId: input.id, domainName: input.domainName, pathPattern: input.pathPattern, changed: true, applied: false, originRemoved: !stillReferenced && !!origin, etag }
    config.Origins = { Quantity: nextOrigins.length, Items: { Origin: nextOrigins } }; config.CacheBehaviors = { Quantity: nextBehaviors.length, ...(nextBehaviors.length ? { Items: { CacheBehavior: nextBehaviors } } : {}) }
    const result = await this.client.request({ service: 'cloudfront', region: 'us-east-1', method: 'PUT', path: `/2020-05-31/distribution/${distributionId}/config`, body: this.buildDistributionConfigXml(config), headers: { 'Content-Type': 'application/xml', 'If-Match': etag } })
    return { distributionId, originId: input.id, domainName: input.domainName, pathPattern: input.pathPattern, changed: true, applied: true, originRemoved: !stillReferenced && !!origin, etag: result.ETag || result.headers?.etag || '' }
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

    // The response structure is: DistributionList.Items.DistributionSummary
    const distList = result.DistributionList || result
    const items = distList.Items

    let summaries: any[] = []
    if (Array.isArray(items)) {
      summaries = items
    }
    else if (items?.DistributionSummary) {
      summaries = Array.isArray(items.DistributionSummary)
        ? items.DistributionSummary
        : [items.DistributionSummary]
    }

    distributions.push(...summaries.map((item: any) => ({
      Id: item.Id,
      ARN: item.ARN,
      Status: item.Status,
      DomainName: item.DomainName,
      Aliases: item.Aliases || undefined,
      Enabled: item.Enabled === 'true' || item.Enabled === true,
    })))

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
   * Get distribution configuration (full config including origins and cache behaviors)
   */
  async getDistributionConfig(distributionId: string): Promise<{
    ETag: string
    DistributionConfig: {
      Origins: {
        Quantity: number
        Items: any
      }
      DefaultCacheBehavior: {
        TargetOriginId: string
        ViewerProtocolPolicy: string
        AllowedMethods?: { Quantity: number, Items: string[] }
        CachedMethods?: { Quantity: number, Items: string[] }
        ForwardedValues?: any
        TrustedSigners?: any
        MinTTL?: number
        DefaultTTL?: number
        MaxTTL?: number
      }
      CacheBehaviors?: {
        Quantity: number
        Items: Array<{
          PathPattern: string
          TargetOriginId: string
          ViewerProtocolPolicy: string
          AllowedMethods?: { Quantity: number, Items: string[] }
          CachedMethods?: { Quantity: number, Items: string[] }
          ForwardedValues?: any
          MinTTL?: number
          DefaultTTL?: number
          MaxTTL?: number
        }>
      }
      Aliases?: { Quantity: number, Items: string[] }
      Comment?: string
      Enabled: boolean
    }
  }> {
    const result = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'GET',
      path: `/2020-05-31/distribution/${distributionId}/config`,
    })

    return {
      ETag: result.ETag || '',
      DistributionConfig: result.DistributionConfig || result,
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

  /**
   * Invalidate after deployment
   * Useful for CI/CD pipelines
   */
  async invalidateAfterDeployment(options: {
    distributionId: string
    changedPaths?: string[]
    invalidateAll?: boolean
    wait?: boolean
  }): Promise<{
    invalidationId: string
    status: string
  }> {
    const { distributionId, changedPaths, invalidateAll = false, wait = false } = options

    let result

    if (invalidateAll || !changedPaths || changedPaths.length === 0) {
      result = await this.invalidateAll(distributionId)
    }
    else {
      result = await this.invalidatePaths(distributionId, changedPaths)
    }

    if (wait) {
      await this.waitForInvalidation(distributionId, result.Id)
    }

    return {
      invalidationId: result.Id,
      status: result.Status,
    }
  }

  /**
   * Find distribution by domain name or alias
   */
  async findDistributionByDomain(domain: string): Promise<Distribution | null> {
    const distributions = await this.listDistributions()

    // Check both CloudFront domain and aliases
    const found = distributions.find((dist) => {
      if (dist.DomainName === domain) {
        return true
      }
      if (dist.Aliases?.Items && dist.Aliases.Items.includes(domain)) {
        return true
      }
      return false
    })

    return found || null
  }

  /**
   * Batch invalidate multiple distributions
   * Useful for multi-region or blue/green deployments
   */
  async batchInvalidate(distributionIds: string[], paths: string[] = ['/*']): Promise<Array<{
    distributionId: string
    invalidationId: string
    status: string
  }>> {
    const results = await Promise.all(
      distributionIds.map(async (distributionId) => {
        const result = await this.createInvalidation({
          distributionId,
          paths,
        })
        return {
          distributionId,
          invalidationId: result.Id,
          status: result.Status,
        }
      }),
    )

    return results
  }

  /**
   * Update custom error responses for a distribution
   * Use this to configure how CloudFront handles 4xx/5xx errors from origins
   */
  async updateCustomErrorResponses(options: {
    distributionId: string
    customErrorResponses: Array<{
      errorCode: number
      responsePagePath?: string
      responseCode?: number
      errorCachingMinTTL?: number
    }>
  }): Promise<{
    Distribution: Distribution
    ETag: string
  }> {
    const { distributionId, customErrorResponses } = options

    // First, get the current config with ETag
    const getResult = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'GET',
      path: `/2020-05-31/distribution/${distributionId}/config`,
      returnHeaders: true,
    })

    const etag = getResult.headers?.etag || getResult.headers?.ETag || ''
    // The `/config` endpoint's root element IS <DistributionConfig>, so the XML
    // parser yields the config directly as `body` (no wrapping key). Older code
    // only looked for a `.DistributionConfig` wrapper and always threw.
    const currentConfig = getResult.body?.DistributionConfig || (getResult.body?.Enabled !== undefined ? getResult.body : undefined) || getResult.DistributionConfig

    if (!currentConfig || currentConfig.Enabled === undefined) {
      throw new Error('Failed to get current distribution config')
    }

    // Update custom error responses
    if (customErrorResponses.length === 0) {
      currentConfig.CustomErrorResponses = {
        Quantity: 0,
      }
    }
    else {
      currentConfig.CustomErrorResponses = {
        Quantity: customErrorResponses.length,
        Items: {
          CustomErrorResponse: customErrorResponses.map(err => ({
            ErrorCode: err.errorCode,
            ...(err.responsePagePath && { ResponsePagePath: err.responsePagePath }),
            ...(err.responseCode && { ResponseCode: err.responseCode }),
            ...(err.errorCachingMinTTL !== undefined && { ErrorCachingMinTTL: err.errorCachingMinTTL }),
          })),
        },
      }
    }

    // Build the XML for the update request
    const configXml = this.buildDistributionConfigXml(currentConfig)

    // Update the distribution
    const result = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'PUT',
      path: `/2020-05-31/distribution/${distributionId}/config`,
      body: configXml,
      headers: {
        'Content-Type': 'application/xml',
        'If-Match': etag,
      },
    })

    const dist = result.Distribution || result

    return {
      Distribution: {
        Id: dist.Id,
        ARN: dist.ARN,
        Status: dist.Status,
        DomainName: dist.DomainName,
        Aliases: dist.DistributionConfig?.Aliases?.Items || [],
        Enabled: dist.DistributionConfig?.Enabled === 'true' || dist.DistributionConfig?.Enabled === true,
      },
      ETag: result.ETag || '',
    }
  }

  /**
   * Remove all custom error responses from a distribution
   * This will make CloudFront return actual 4xx/5xx errors instead of custom pages
   */
  async removeCustomErrorResponses(distributionId: string): Promise<{
    Distribution: Distribution
    ETag: string
  }> {
    return this.updateCustomErrorResponses({
      distributionId,
      customErrorResponses: [],
    })
  }

  /**
   * Update distribution configuration
   * This method updates the CloudFront distribution with new settings like aliases and certificates
   */
  async updateDistribution(options: {
    distributionId: string
    aliases?: string[]
    certificateArn?: string
    comment?: string
  }): Promise<{
    Distribution: Distribution
    ETag: string
  }> {
    const { distributionId, aliases, certificateArn, comment } = options

    // First, get the current config with ETag
    const getResult = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'GET',
      path: `/2020-05-31/distribution/${distributionId}/config`,
      returnHeaders: true,
    })

    const etag = getResult.headers?.etag || getResult.headers?.ETag || ''
    // The `/config` endpoint's root element IS <DistributionConfig>, so the XML
    // parser yields the config directly as `body` (no wrapping key). Older code
    // only looked for a `.DistributionConfig` wrapper and always threw.
    const currentConfig = getResult.body?.DistributionConfig || (getResult.body?.Enabled !== undefined ? getResult.body : undefined) || getResult.DistributionConfig

    if (!currentConfig || currentConfig.Enabled === undefined) {
      throw new Error('Failed to get current distribution config')
    }

    // Update the config with new values
    if (aliases && aliases.length > 0) {
      currentConfig.Aliases = {
        Quantity: aliases.length,
        Items: { Item: aliases },
      }
    }

    if (certificateArn) {
      currentConfig.ViewerCertificate = {
        ACMCertificateArn: certificateArn,
        SSLSupportMethod: 'sni-only',
        MinimumProtocolVersion: 'TLSv1.2_2021',
        CertificateSource: 'acm',
      }
    }

    if (comment) {
      currentConfig.Comment = comment
    }

    // Build the XML for the update request
    const configXml = this.buildDistributionConfigXml(currentConfig)

    // Update the distribution
    const result = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'PUT',
      path: `/2020-05-31/distribution/${distributionId}/config`,
      body: configXml,
      headers: {
        'Content-Type': 'application/xml',
        'If-Match': etag,
      },
    })

    const dist = result.Distribution || result

    return {
      Distribution: {
        Id: dist.Id,
        ARN: dist.ARN,
        Status: dist.Status,
        DomainName: dist.DomainName,
        Aliases: aliases ? { Quantity: aliases.length, Items: aliases } : { Quantity: 0, Items: [] },
        Enabled: dist.DistributionConfig?.Enabled === 'true' || dist.DistributionConfig?.Enabled === true,
      },
      ETag: result.ETag || '',
    }
  }

  /**
   * Helper to build XML from distribution config object
   * CloudFront requires specific XML structures - this method handles the complex nesting
   */
  private buildDistributionConfigXml(config: any): string {
    const escapeXml = (str: string): string => {
      return str.replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
    }

    // Map of parent element names to their child element names for array items
    const arrayChildNames: Record<string, string> = {
      Items: '', // Will be determined by context
      Methods: 'Method',
      Headers: 'Name',
      Cookies: 'Name',
      QueryStringCacheKeys: 'Name',
      TrustedKeyGroups: 'KeyGroup',
      TrustedSigners: 'AwsAccountNumber',
      LambdaFunctionAssociations: 'LambdaFunctionAssociation',
      FunctionAssociations: 'FunctionAssociation',
      CacheBehaviors: 'CacheBehavior',
      CustomErrorResponses: 'CustomErrorResponse',
      GeoRestriction: 'Location',
    }

    // Elements inside Items that have specific child names
    const itemsChildNames: Record<string, string> = {
      Origins: 'Origin',
      Aliases: 'CNAME',
      AllowedMethods: 'Method',
      CachedMethods: 'Method',
      CustomErrorResponses: 'CustomErrorResponse',
      CacheBehaviors: 'CacheBehavior',
    }

    const buildXmlElement = (name: string, value: any, indent: string = '', parentContext: string = ''): string => {
      if (value === null || value === undefined) {
        return ''
      }

      // Skip XML metadata attributes
      if (name.startsWith('@_') || name === '?xml') {
        return ''
      }

      if (typeof value === 'boolean') {
        return `${indent}<${name}>${value}</${name}>\n`
      }

      if (typeof value === 'number' || typeof value === 'string') {
        return `${indent}<${name}>${escapeXml(String(value))}</${name}>\n`
      }

      if (Array.isArray(value)) {
        // For arrays, we need to output each item with the appropriate element name
        const childName = arrayChildNames[name] || name.replace(/s$/, '')
        return value.map(item => buildXmlElement(childName, item, indent, name)).join('')
      }

      if (typeof value === 'object') {
        // Handle Items specially - they contain the actual array items
        if (name === 'Items') {
          // Figure out what type of items these are based on parent context
          const childElementName = itemsChildNames[parentContext] || ''

          // Check if Items has named children (like CNAME, Origin, etc.)
          const keys = Object.keys(value).filter(k => !k.startsWith('@_'))

          if (keys.length === 1 && !Array.isArray(value[keys[0]])) {
            // Single named child that's not an array - could be a single item
            const childKey = keys[0]
            const childValue = value[childKey]
            if (typeof childValue === 'string') {
              // Single item like {CNAME: "domain.com"}
              return `${indent}<Items>\n${indent}  <${childKey}>${escapeXml(childValue)}</${childKey}>\n${indent}</Items>\n`
            }
            else if (typeof childValue === 'object' && !Array.isArray(childValue)) {
              // Single complex item like {Origin: {...}}
              return `${indent}<Items>\n${buildXmlElement(childKey, childValue, indent + '  ', name)}${indent}</Items>\n`
            }
          }

          if (keys.length === 1 && Array.isArray(value[keys[0]])) {
            // Named array child like {CNAME: ["a.com", "b.com"]} or {Origin: [{...}, {...}]}
            const childKey = keys[0]
            const childArray = value[childKey]
            let children = ''
            for (const item of childArray) {
              if (typeof item === 'string') {
                children += `${indent}  <${childKey}>${escapeXml(item)}</${childKey}>\n`
              }
              else {
                children += buildXmlElement(childKey, item, indent + '  ', name)
              }
            }
            return `${indent}<Items>\n${children}${indent}</Items>\n`
          }

          // Check if Items is an array directly passed in
          if (Array.isArray(value)) {
            let children = ''
            const childName = childElementName || 'Item'
            for (const item of value) {
              if (typeof item === 'string') {
                children += `${indent}  <${childName}>${escapeXml(item)}</${childName}>\n`
              }
              else {
                children += buildXmlElement(childName, item, indent + '  ', name)
              }
            }
            return `${indent}<Items>\n${children}${indent}</Items>\n`
          }

          // Fall through to regular object handling if none of the special cases match
        }

        let children = ''
        for (const [key, val] of Object.entries(value)) {
          if (!key.startsWith('@_')) {
            children += buildXmlElement(key, val, indent + '  ', name)
          }
        }

        if (children === '') {
          return `${indent}<${name}/>\n`
        }

        return `${indent}<${name}>\n${children}${indent}</${name}>\n`
      }

      return ''
    }

    return `<?xml version="1.0" encoding="UTF-8"?>\n<DistributionConfig xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/">\n${Object.entries(config).filter(([k]) => !k.startsWith('@_')).map(([key, val]) => buildXmlElement(key, val, '  ', 'DistributionConfig')).join('')}</DistributionConfig>`
  }

  /**
   * Allow POST/PUT/PATCH/DELETE on the default cache behavior (and API cache behaviors).
   * Required when CloudFront fronts a Bun/Node app on EC2 instead of a static S3 site.
   */
  async ensureDynamicHttpMethods(distributionId: string): Promise<boolean> {
    const getResult = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'GET',
      path: `/2020-05-31/distribution/${distributionId}/config`,
      returnHeaders: true,
    })

    const etag = getResult.headers?.etag || getResult.headers?.ETag || ''
    const currentConfig = getResult.body?.DistributionConfig
      || getResult.DistributionConfig
      || getResult.body

    if (!currentConfig) {
      throw new Error('Failed to get current distribution config')
    }

    let changed = false
    const dynamicMethods = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE']

    const parseAllowedMethods = (allowedMethods: any): string[] => {
      if (!allowedMethods) return []
      const items = allowedMethods.Items
      if (!items) return []
      if (Array.isArray(items)) return items.map(String)
      if (typeof items === 'object' && items.Method) {
        const method = items.Method
        return Array.isArray(method) ? method.map(String) : [String(method)]
      }
      if (items.Item) {
        return Array.isArray(items.Item) ? items.Item.map(String) : [String(items.Item)]
      }
      return []
    }

    const defaultBehavior = currentConfig.DefaultCacheBehavior
    if (defaultBehavior) {
      const allowed = parseAllowedMethods(defaultBehavior.AllowedMethods)

      if (!allowed.includes('POST')) {
        defaultBehavior.AllowedMethods = {
          Quantity: dynamicMethods.length,
          Items: { Method: dynamicMethods },
          CachedMethods: {
            Quantity: 2,
            Items: { Method: ['GET', 'HEAD'] },
          },
        }
        changed = true
      }
    }

    // Only widen methods on the default (compute) behavior — leave S3 path behaviors GET-only.

    if (!changed) {
      return false
    }

    const configXml = this.buildDistributionConfigXml(currentConfig)

    await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'PUT',
      path: `/2020-05-31/distribution/${distributionId}/config`,
      body: configXml,
      headers: {
        'Content-Type': 'application/xml',
        'If-Match': etag,
      },
    })

    return true
  }

  /**
   * Add aliases to a distribution
   */
  async addAliases(distributionId: string, aliases: string[], certificateArn: string): Promise<{
    Distribution: Distribution
    ETag: string
  }> {
    return this.updateDistribution({
      distributionId,
      aliases,
      certificateArn,
    })
  }

  /**
   * Create a CloudFront Function
   * CloudFront Functions are lightweight JavaScript functions for viewer request/response manipulation
   */
  async createFunction(options: {
    name: string
    code: string
    comment?: string
    runtime?: 'cloudfront-js-1.0' | 'cloudfront-js-2.0'
  }): Promise<{
    FunctionARN: string
    Name: string
    Stage: string
    ETag: string
  }> {
    const { name, code, comment = '', runtime = 'cloudfront-js-2.0' } = options

    const functionXml = `<?xml version="1.0" encoding="UTF-8"?>
<CreateFunctionRequest xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/">
  <Name>${name}</Name>
  <FunctionConfig>
    <Comment>${comment}</Comment>
    <Runtime>${runtime}</Runtime>
  </FunctionConfig>
  <FunctionCode>${Buffer.from(code).toString('base64')}</FunctionCode>
</CreateFunctionRequest>`

    const result = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'POST',
      path: '/2020-05-31/function',
      body: functionXml,
      headers: {
        'Content-Type': 'application/xml',
      },
    })

    const func = result.FunctionSummary || result

    return {
      FunctionARN: func.FunctionMetadata?.FunctionARN || func.FunctionARN,
      Name: func.Name || name,
      Stage: func.FunctionMetadata?.Stage || 'DEVELOPMENT',
      ETag: result.ETag || '',
    }
  }

  /**
   * List CloudFront Functions
   */
  async listFunctions(): Promise<Array<{
    Name: string
    FunctionARN: string
    Stage: string
    CreatedTime: string
    LastModifiedTime: string
  }>> {
    const result = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'GET',
      path: '/2020-05-31/function',
    })

    const functions: Array<{
      Name: string
      FunctionARN: string
      Stage: string
      CreatedTime: string
      LastModifiedTime: string
    }> = []

    const items = result.FunctionList?.Items?.FunctionSummary
    if (items) {
      const list = Array.isArray(items) ? items : [items]
      for (const item of list) {
        functions.push({
          Name: item.Name,
          FunctionARN: item.FunctionMetadata?.FunctionARN,
          Stage: item.FunctionMetadata?.Stage,
          CreatedTime: item.FunctionMetadata?.CreatedTime,
          LastModifiedTime: item.FunctionMetadata?.LastModifiedTime,
        })
      }
    }

    return functions
  }

  /**
   * Get a CloudFront Function
   */
  async getFunction(name: string, stage: 'DEVELOPMENT' | 'LIVE' = 'LIVE'): Promise<{
    FunctionARN: string
    Name: string
    Stage: string
    ETag: string
    FunctionCode?: string
  } | null> {
    try {
      const result = await this.client.request({
        service: 'cloudfront',
        region: 'us-east-1',
        method: 'GET',
        path: `/2020-05-31/function/${name}`,
        queryParams: { Stage: stage },
        returnHeaders: true,
      })

      const func = result.body?.FunctionSummary || result.FunctionSummary || result.body || result

      return {
        FunctionARN: func.FunctionMetadata?.FunctionARN,
        Name: func.Name || name,
        Stage: func.FunctionMetadata?.Stage || stage,
        ETag: result.headers?.etag || result.ETag || '',
        FunctionCode: func.FunctionCode,
      }
    }
    catch (err: any) {
      if (err.message?.includes('404') || err.message?.includes('NoSuchFunctionExists')) {
        return null
      }
      throw err
    }
  }

  /**
   * Publish a CloudFront Function (move from DEVELOPMENT to LIVE stage)
   * Can be called with just the name (will auto-fetch ETag) or with options object
   */
  async publishFunction(nameOrOptions: string | { Name: string, IfMatch: string }, etag?: string): Promise<{
    FunctionARN: string
    Stage: string
    FunctionSummary?: {
      Name: string
      FunctionMetadata: {
        FunctionARN: string
        Stage: string
      }
    }
  }> {
    let name: string
    let functionETag: string | undefined

    if (typeof nameOrOptions === 'object') {
      name = nameOrOptions.Name
      functionETag = nameOrOptions.IfMatch
    }
    else {
      name = nameOrOptions
      functionETag = etag
    }

    // Get the current ETag if not provided
    if (!functionETag) {
      const func = await this.getFunction(name, 'DEVELOPMENT')
      if (!func) {
        throw new Error(`Function ${name} not found`)
      }
      functionETag = func.ETag
    }

    const result = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'POST',
      path: `/2020-05-31/function/${name}/publish`,
      headers: {
        'If-Match': functionETag,
      },
    })

    const func = result.FunctionSummary || result

    return {
      FunctionARN: func.FunctionMetadata?.FunctionARN,
      Stage: func.FunctionMetadata?.Stage || 'LIVE',
      FunctionSummary: func,
    }
  }

  /**
   * Describe a CloudFront Function (get metadata including ETag)
   */
  async describeFunction(options: { Name: string, Stage?: 'DEVELOPMENT' | 'LIVE' }): Promise<{
    ETag: string
    FunctionSummary: {
      Name: string
      Status: string
      FunctionConfig: {
        Comment: string
        Runtime: string
      }
      FunctionMetadata: {
        FunctionARN: string
        Stage: string
        CreatedTime: string
        LastModifiedTime: string
      }
    }
  }> {
    const { Name, Stage = 'DEVELOPMENT' } = options

    const result = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'GET',
      path: `/2020-05-31/function/${Name}/describe`,
      queryParams: { Stage },
      returnHeaders: true,
    })

    return {
      ETag: result.headers?.etag || result.ETag || '',
      FunctionSummary: result.body?.FunctionSummary || result.FunctionSummary || result.body || result,
    }
  }

  /**
   * Update a CloudFront Function
   */
  async updateFunction(options: {
    Name: string
    FunctionCode: string
    FunctionConfig: {
      Comment: string
      Runtime: 'cloudfront-js-1.0' | 'cloudfront-js-2.0'
    }
    IfMatch: string
  }): Promise<{
    ETag: string
    FunctionSummary: {
      Name: string
      FunctionMetadata: {
        FunctionARN: string
        Stage: string
      }
    }
  }> {
    const { Name, FunctionCode, FunctionConfig, IfMatch } = options

    const functionXml = `<?xml version="1.0" encoding="UTF-8"?>
<UpdateFunctionRequest xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/">
  <FunctionConfig>
    <Comment>${FunctionConfig.Comment}</Comment>
    <Runtime>${FunctionConfig.Runtime}</Runtime>
  </FunctionConfig>
  <FunctionCode>${Buffer.from(FunctionCode).toString('base64')}</FunctionCode>
</UpdateFunctionRequest>`

    const result = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'PUT',
      path: `/2020-05-31/function/${Name}`,
      body: functionXml,
      headers: {
        'Content-Type': 'application/xml',
        'If-Match': IfMatch,
      },
      returnHeaders: true,
    })

    return {
      ETag: result.headers?.etag || result.ETag || '',
      FunctionSummary: result.body?.FunctionSummary || result.FunctionSummary || result.body || result,
    }
  }

  /**
   * Delete a CloudFront Function
   */
  async deleteFunction(name: string, etag?: string): Promise<void> {
    // Get the current ETag if not provided
    let functionETag = etag
    if (!functionETag) {
      const func = await this.getFunction(name, 'DEVELOPMENT')
      if (!func) {
        // Function doesn't exist, nothing to delete
        return
      }
      functionETag = func.ETag
    }

    await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'DELETE',
      path: `/2020-05-31/function/${name}`,
      headers: {
        'If-Match': functionETag,
      },
    })
  }

  /**
   * Create a standard index.html rewrite function for S3 static sites
   * This function rewrites directory requests to index.html
   */
  async createIndexRewriteFunction(name: string): Promise<{
    FunctionARN: string
    Name: string
    Stage: string
    ETag: string
  }> {
    const code = `function handler(event) {
    const request = event.request;
    var uri = request.uri;

    // Check if the request is for a directory (ends with /)
    if (uri.endsWith('/')) {
        request.uri += 'index.html';
    }
    // Check if the request doesn't have a file extension
    else if (!uri.includes('.')) {
        // Add trailing slash to redirect to directory
        request.uri += '/index.html';
    }

    return request;
}`

    return this.createFunction({
      name,
      code,
      comment: 'Rewrite directory requests to index.html for S3 static sites',
      runtime: 'cloudfront-js-2.0',
    })
  }

  /**
   * Get origin access control configurations
   */
  async listOriginAccessControls(): Promise<Array<{
    Id: string
    Name: string
    Description?: string
    SigningProtocol: string
    SigningBehavior: string
    OriginAccessControlOriginType: string
  }>> {
    const result = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'GET',
      path: '/2020-05-31/origin-access-control',
    })

    const items: any[] = []

    if (result.OriginAccessControlList?.Items?.OriginAccessControlSummary) {
      const summaries = Array.isArray(result.OriginAccessControlList.Items.OriginAccessControlSummary)
        ? result.OriginAccessControlList.Items.OriginAccessControlSummary
        : [result.OriginAccessControlList.Items.OriginAccessControlSummary]

      items.push(...summaries.map((item: any) => ({
        Id: item.Id,
        Name: item.Name,
        Description: item.Description,
        SigningProtocol: item.SigningProtocol,
        SigningBehavior: item.SigningBehavior,
        OriginAccessControlOriginType: item.OriginAccessControlOriginType,
      })))
    }

    return items
  }

  /**
   * Create an Origin Access Control for S3
   */
  async createOriginAccessControl(options: {
    name: string
    description?: string
    signingProtocol?: 'sigv4'
    signingBehavior?: 'always' | 'never' | 'no-override'
    originType?: 's3' | 'mediastore' | 'mediapackagev2' | 'lambda'
  }): Promise<{
    Id: string
    Name: string
    Description: string
    SigningProtocol: string
    SigningBehavior: string
    OriginAccessControlOriginType: string
    ETag: string
  }> {
    const {
      name,
      description = `OAC for ${name}`,
      signingProtocol = 'sigv4',
      signingBehavior = 'always',
      originType = 's3',
    } = options

    const body = `<?xml version="1.0" encoding="UTF-8"?>
<OriginAccessControlConfig xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/">
  <Name>${name}</Name>
  <Description>${description}</Description>
  <SigningProtocol>${signingProtocol}</SigningProtocol>
  <SigningBehavior>${signingBehavior}</SigningBehavior>
  <OriginAccessControlOriginType>${originType}</OriginAccessControlOriginType>
</OriginAccessControlConfig>`

    const result = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'POST',
      path: '/2020-05-31/origin-access-control',
      body,
      headers: {
        'Content-Type': 'application/xml',
      },
      returnHeaders: true,
    })

    const oac = result.body?.OriginAccessControl || result.OriginAccessControl || result.body || result

    return {
      Id: oac.Id,
      Name: oac.OriginAccessControlConfig?.Name || name,
      Description: oac.OriginAccessControlConfig?.Description || description,
      SigningProtocol: oac.OriginAccessControlConfig?.SigningProtocol || signingProtocol,
      SigningBehavior: oac.OriginAccessControlConfig?.SigningBehavior || signingBehavior,
      OriginAccessControlOriginType: oac.OriginAccessControlConfig?.OriginAccessControlOriginType || originType,
      ETag: result.headers?.etag || result.ETag || '',
    }
  }

  /**
   * Find or create an Origin Access Control
   */
  async findOrCreateOriginAccessControl(name: string, originType: 's3' | 'mediastore' | 'mediapackagev2' | 'lambda' = 's3'): Promise<{
    Id: string
    Name: string
    isNew: boolean
  }> {
    const oacs = await this.listOriginAccessControls()
    const existing = oacs.find(oac => oac.Name === name && oac.OriginAccessControlOriginType === originType)

    if (existing) {
      return { Id: existing.Id, Name: existing.Name, isNew: false }
    }

    const created = await this.createOriginAccessControl({ name, originType })
    return { Id: created.Id, Name: created.Name, isNew: true }
  }

  /**
   * Create a CloudFront distribution for a static S3 website
   */
  async createDistributionForS3(options: {
    bucketName: string
    bucketRegion: string
    originAccessControlId: string
    aliases?: string[]
    certificateArn?: string
    defaultRootObject?: string
    comment?: string
    priceClass?: 'PriceClass_100' | 'PriceClass_200' | 'PriceClass_All'
    enabled?: boolean
  }): Promise<{
    Id: string
    ARN: string
    DomainName: string
    Status: string
    ETag: string
  }> {
    const {
      bucketName,
      bucketRegion,
      originAccessControlId,
      aliases = [],
      certificateArn,
      defaultRootObject = 'index.html',
      comment = `Distribution for ${bucketName}`,
      priceClass = 'PriceClass_100',
      enabled = true,
    } = options

    const originId = `S3-${bucketName}`
    const s3DomainName = `${bucketName}.s3.${bucketRegion}.amazonaws.com`
    const callerReference = `${Date.now()}-${Math.random().toString(36).slice(2)}`

    // Build aliases XML
    let aliasesXml = '<Aliases><Quantity>0</Quantity></Aliases>'
    if (aliases.length > 0) {
      aliasesXml = `<Aliases>
    <Quantity>${aliases.length}</Quantity>
    <Items>
      ${aliases.map(a => `<CNAME>${a}</CNAME>`).join('\n      ')}
    </Items>
  </Aliases>`
    }

    // Build viewer certificate XML
    let viewerCertificateXml = `<ViewerCertificate>
    <CloudFrontDefaultCertificate>true</CloudFrontDefaultCertificate>
  </ViewerCertificate>`

    if (certificateArn && aliases.length > 0) {
      viewerCertificateXml = `<ViewerCertificate>
    <ACMCertificateArn>${certificateArn}</ACMCertificateArn>
    <SSLSupportMethod>sni-only</SSLSupportMethod>
    <MinimumProtocolVersion>TLSv1.2_2021</MinimumProtocolVersion>
    <CertificateSource>acm</CertificateSource>
  </ViewerCertificate>`
    }

    const body = `<?xml version="1.0" encoding="UTF-8"?>
<DistributionConfig xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/">
  <CallerReference>${callerReference}</CallerReference>
  <Comment>${comment}</Comment>
  <DefaultRootObject>${defaultRootObject}</DefaultRootObject>
  <Origins>
    <Quantity>1</Quantity>
    <Items>
      <Origin>
        <Id>${originId}</Id>
        <DomainName>${s3DomainName}</DomainName>
        <OriginPath></OriginPath>
        <S3OriginConfig>
          <OriginAccessIdentity></OriginAccessIdentity>
        </S3OriginConfig>
        <OriginAccessControlId>${originAccessControlId}</OriginAccessControlId>
      </Origin>
    </Items>
  </Origins>
  <DefaultCacheBehavior>
    <TargetOriginId>${originId}</TargetOriginId>
    <ViewerProtocolPolicy>redirect-to-https</ViewerProtocolPolicy>
    <AllowedMethods>
      <Quantity>2</Quantity>
      <Items>
        <Method>GET</Method>
        <Method>HEAD</Method>
      </Items>
      <CachedMethods>
        <Quantity>2</Quantity>
        <Items>
          <Method>GET</Method>
          <Method>HEAD</Method>
        </Items>
      </CachedMethods>
    </AllowedMethods>
    <Compress>true</Compress>
    <CachePolicyId>658327ea-f89d-4fab-a63d-7e88639e58f6</CachePolicyId>
  </DefaultCacheBehavior>
  ${aliasesXml}
  ${viewerCertificateXml}
  <PriceClass>${priceClass}</PriceClass>
  <Enabled>${enabled}</Enabled>
  <HttpVersion>http2and3</HttpVersion>
  <IsIPV6Enabled>true</IsIPV6Enabled>
  <CustomErrorResponses>
    <Quantity>1</Quantity>
    <Items>
      <CustomErrorResponse>
        <ErrorCode>403</ErrorCode>
        <ResponsePagePath>/index.html</ResponsePagePath>
        <ResponseCode>200</ResponseCode>
        <ErrorCachingMinTTL>300</ErrorCachingMinTTL>
      </CustomErrorResponse>
    </Items>
  </CustomErrorResponses>
</DistributionConfig>`

    const result = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'POST',
      path: '/2020-05-31/distribution',
      body,
      headers: {
        'Content-Type': 'application/xml',
      },
      returnHeaders: true,
    })

    const dist = result.body?.Distribution || result.Distribution || result.body || result

    return {
      Id: dist.Id,
      ARN: dist.ARN,
      DomainName: dist.DomainName,
      Status: dist.Status,
      ETag: result.headers?.etag || result.ETag || '',
    }
  }

  /**
   * Get S3 bucket policy for CloudFront OAC access
   */
  static getS3BucketPolicyForCloudFront(bucketName: string, distributionArn: string): object {
    return {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'AllowCloudFrontServicePrincipal',
          Effect: 'Allow',
          Principal: {
            Service: 'cloudfront.amazonaws.com',
          },
          Action: 's3:GetObject',
          Resource: `arn:aws:s3:::${bucketName}/*`,
          Condition: {
            StringEquals: {
              'AWS:SourceArn': distributionArn,
            },
          },
        },
      ],
    }
  }

  /**
   * Wait for distribution to be deployed
   */
  async waitForDistributionDeployed(distributionId: string, maxAttempts = 60): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      const dist = await this.getDistribution(distributionId)

      if (dist.Status === 'Deployed') {
        return true
      }

      // Wait 30 seconds between checks
      await new Promise(resolve => setTimeout(resolve, 30000))
    }

    return false
  }

  /**
   * Disable a CloudFront distribution
   * Must be disabled before it can be deleted
   */
  async disableDistribution(distributionId: string): Promise<{ ETag: string }> {
    // Get current config with ETag
    const getResult = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'GET',
      path: `/2020-05-31/distribution/${distributionId}/config`,
      returnHeaders: true,
    })

    const etag = getResult.headers?.etag || getResult.headers?.ETag || ''
    // The `/config` endpoint's root element IS <DistributionConfig>, so the XML
    // parser yields the config directly as `body` (no wrapping key). Older code
    // only looked for a `.DistributionConfig` wrapper and always threw.
    const currentConfig = getResult.body?.DistributionConfig || (getResult.body?.Enabled !== undefined ? getResult.body : undefined) || getResult.DistributionConfig

    if (!currentConfig || currentConfig.Enabled === undefined) {
      throw new Error('Failed to get current distribution config')
    }

    // Set enabled to false
    currentConfig.Enabled = false

    // Build the XML for the update request
    const configXml = this.buildDistributionConfigXml(currentConfig)

    // Update the distribution
    const result = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'PUT',
      path: `/2020-05-31/distribution/${distributionId}/config`,
      body: configXml,
      headers: {
        'Content-Type': 'application/xml',
        'If-Match': etag,
      },
      returnHeaders: true,
    })

    return { ETag: result.headers?.etag || result.headers?.ETag || result.ETag || '' }
  }

  /**
   * Delete a CloudFront distribution
   * Distribution must be disabled first
   */
  async deleteDistribution(distributionId: string, etag?: string): Promise<void> {
    // If no ETag provided, get it first
    let etagToUse = etag || ''
    if (!etagToUse) {
      const getResult = await this.client.request({
        service: 'cloudfront',
        region: 'us-east-1',
        method: 'GET',
        path: `/2020-05-31/distribution/${distributionId}`,
        returnHeaders: true,
      })
      etagToUse = getResult.headers?.etag || getResult.headers?.ETag || ''
    }

    await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'DELETE',
      path: `/2020-05-31/distribution/${distributionId}`,
      headers: {
        'If-Match': etagToUse,
      },
    })
  }

  /**
   * Wait for distribution to be disabled (ready for deletion)
   */
  async waitForDistributionDisabled(distributionId: string, maxAttempts = 60): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      const dist = await this.getDistribution(distributionId)

      if (dist.Status === 'Deployed' && !dist.Enabled) {
        return true
      }

      // Wait 30 seconds between checks
      await new Promise(resolve => setTimeout(resolve, 30000))
    }

    return false
  }

  /**
   * Remove a specific alias (CNAME) from a CloudFront distribution
   * This allows the alias to be used by another distribution
   */
  async removeAlias(distributionId: string, alias: string): Promise<{ ETag: string }> {
    // Get current config with ETag
    const getResult = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'GET',
      path: `/2020-05-31/distribution/${distributionId}/config`,
      returnHeaders: true,
    })

    const etag = getResult.headers?.etag || getResult.headers?.ETag || ''
    // The `/config` endpoint's root element IS <DistributionConfig>, so the XML
    // parser yields the config directly as `body` (no wrapping key). Older code
    // only looked for a `.DistributionConfig` wrapper and always threw.
    const currentConfig = getResult.body?.DistributionConfig || (getResult.body?.Enabled !== undefined ? getResult.body : undefined) || getResult.DistributionConfig

    if (!currentConfig || currentConfig.Enabled === undefined) {
      throw new Error('Failed to get current distribution config')
    }

    // Remove the alias from the Aliases list
    // Handle various structures: Items can be an array, or Items.CNAME can be a string or array
    let items: string[] = []
    if (currentConfig.Aliases?.Items) {
      if (Array.isArray(currentConfig.Aliases.Items)) {
        items = currentConfig.Aliases.Items
      }
      else if (typeof currentConfig.Aliases.Items === 'object') {
        const cname = currentConfig.Aliases.Items.CNAME
        if (typeof cname === 'string') {
          items = [cname]
        }
        else if (Array.isArray(cname)) {
          items = cname
        }
      }
    }

    if (items.length === 0) {
      throw new Error(`Distribution has no aliases to remove`)
    }

    const newItems = items.filter((a: string) => a !== alias)

    if (newItems.length === items.length) {
      throw new Error(`Alias ${alias} not found in distribution`)
    }

    currentConfig.Aliases.Quantity = newItems.length
    // CloudFront expects Items to be an array, not Items.CNAME
    currentConfig.Aliases.Items = newItems.length > 0 ? newItems : undefined

    // If removing the last alias, we need to also remove the ViewerCertificate ACM config
    if (newItems.length === 0) {
      currentConfig.ViewerCertificate = {
        CloudFrontDefaultCertificate: true,
        MinimumProtocolVersion: 'TLSv1.2_2021',
      }
    }

    // Build the XML for the update request
    const configXml = this.buildDistributionConfigXml(currentConfig)

    // Update the distribution
    const result = await this.client.request({
      service: 'cloudfront',
      region: 'us-east-1',
      method: 'PUT',
      path: `/2020-05-31/distribution/${distributionId}/config`,
      body: configXml,
      headers: {
        'Content-Type': 'application/xml',
        'If-Match': etag,
      },
      returnHeaders: true,
    })

    return { ETag: result.headers?.etag || result.headers?.ETag || result.ETag || '' }
  }
}
