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
   * Get distribution configuration (full config including origins and cache behaviors)
   */
  async getDistributionConfig(distributionId: string): Promise<{
    ETag: string
    DistributionConfig: {
      Origins: {
        Quantity: number
        Items: Array<{
          Id: string
          DomainName: string
          OriginPath?: string
          S3OriginConfig?: { OriginAccessIdentity: string }
          CustomOriginConfig?: {
            HTTPPort: number
            HTTPSPort: number
            OriginProtocolPolicy: string
          }
        }>
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
      if (dist.Aliases && dist.Aliases.includes(domain)) {
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
    const currentConfig = getResult.body?.DistributionConfig || getResult.DistributionConfig

    if (!currentConfig) {
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
    const currentConfig = getResult.body?.DistributionConfig || getResult.DistributionConfig

    if (!currentConfig) {
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
        Aliases: aliases || [],
        Enabled: dist.DistributionConfig?.Enabled === 'true' || dist.DistributionConfig?.Enabled === true,
      },
      ETag: result.ETag || '',
    }
  }

  /**
   * Helper to build XML from distribution config object
   */
  private buildDistributionConfigXml(config: any): string {
    const buildXmlElement = (name: string, value: any, indent: string = ''): string => {
      if (value === null || value === undefined) {
        return ''
      }

      if (typeof value === 'boolean') {
        return `${indent}<${name}>${value}<//${name}>\n`
      }

      if (typeof value === 'number' || typeof value === 'string') {
        return `${indent}<${name}>${value}<//${name}>\n`
      }

      if (Array.isArray(value)) {
        return value.map(item => buildXmlElement(name, item, indent)).join('')
      }

      if (typeof value === 'object') {
        // Skip XML metadata attributes
        if (name.startsWith('@_') || name === '?xml') {
          return ''
        }

        let children = ''
        for (const [key, val] of Object.entries(value)) {
          if (!key.startsWith('@_')) {
            children += buildXmlElement(key, val, indent + '  ')
          }
        }
        return `${indent}<${name}>\n${children}${indent}</${name}>\n`
      }

      return ''
    }

    return `<?xml version="1.0" encoding="UTF-8"?>\n${buildXmlElement('DistributionConfig', { ...config, '@_xmlns': 'http://cloudfront.amazonaws.com/doc/2020-05-31/' })}`
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
    var request = event.request;
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
}
