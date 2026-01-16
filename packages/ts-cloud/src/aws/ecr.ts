/**
 * AWS ECR (Elastic Container Registry) Client
 * Manages Docker container image repositories using direct API calls
 */

import { AWSClient } from './client'

export interface Repository {
  repositoryArn?: string
  registryId?: string
  repositoryName?: string
  repositoryUri?: string
  createdAt?: string
  imageTagMutability?: 'MUTABLE' | 'IMMUTABLE'
  imageScanningConfiguration?: {
    scanOnPush?: boolean
  }
  encryptionConfiguration?: {
    encryptionType?: 'AES256' | 'KMS'
    kmsKey?: string
  }
}

export interface AuthorizationData {
  authorizationToken?: string
  expiresAt?: string
  proxyEndpoint?: string
}

export interface ImageDetail {
  registryId?: string
  repositoryName?: string
  imageDigest?: string
  imageTags?: string[]
  imageSizeInBytes?: number
  imagePushedAt?: string
  imageScanStatus?: {
    status?: string
    description?: string
  }
  imageScanFindingsSummary?: {
    findingSeverityCounts?: Record<string, number>
  }
}

export interface CreateRepositoryOptions {
  repositoryName: string
  tags?: { Key: string, Value: string }[]
  imageTagMutability?: 'MUTABLE' | 'IMMUTABLE'
  imageScanningConfiguration?: {
    scanOnPush?: boolean
  }
  encryptionConfiguration?: {
    encryptionType?: 'AES256' | 'KMS'
    kmsKey?: string
  }
}

export interface LifecyclePolicy {
  rulePriority: number
  description?: string
  selection: {
    tagStatus: 'tagged' | 'untagged' | 'any'
    tagPrefixList?: string[]
    countType: 'imageCountMoreThan' | 'sinceImagePushed'
    countNumber?: number
    countUnit?: 'days'
  }
  action: {
    type: 'expire'
  }
}

/**
 * ECR service management using direct API calls
 */
export class ECRClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1', profile?: string) {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Create a new ECR repository
   */
  async createRepository(options: CreateRepositoryOptions): Promise<{ repository?: Repository }> {
    const params: Record<string, any> = {
      repositoryName: options.repositoryName,
    }

    if (options.imageTagMutability) {
      params.imageTagMutability = options.imageTagMutability
    }

    if (options.imageScanningConfiguration) {
      params.imageScanningConfiguration = options.imageScanningConfiguration
    }

    if (options.encryptionConfiguration) {
      params.encryptionConfiguration = options.encryptionConfiguration
    }

    if (options.tags && options.tags.length > 0) {
      params.tags = options.tags
    }

    const result = await this.client.request({
      service: 'ecr',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerRegistry_V20150921.CreateRepository',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      repository: result.repository ? this.parseRepository(result.repository) : undefined,
    }
  }

  /**
   * Describe ECR repositories
   */
  async describeRepositories(options?: {
    repositoryNames?: string[]
    registryId?: string
    maxResults?: number
    nextToken?: string
  }): Promise<{ repositories?: Repository[], nextToken?: string }> {
    const params: Record<string, any> = {}

    if (options?.repositoryNames && options.repositoryNames.length > 0) {
      params.repositoryNames = options.repositoryNames
    }

    if (options?.registryId) {
      params.registryId = options.registryId
    }

    if (options?.maxResults) {
      params.maxResults = options.maxResults
    }

    if (options?.nextToken) {
      params.nextToken = options.nextToken
    }

    const result = await this.client.request({
      service: 'ecr',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerRegistry_V20150921.DescribeRepositories',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      repositories: result.repositories?.map((repo: any) => this.parseRepository(repo)),
      nextToken: result.nextToken,
    }
  }

  /**
   * Get authorization token for Docker login
   */
  async getAuthorizationToken(registryIds?: string[]): Promise<{
    authorizationData?: AuthorizationData[]
  }> {
    const params: Record<string, any> = {}

    if (registryIds && registryIds.length > 0) {
      params.registryIds = registryIds
    }

    const result = await this.client.request({
      service: 'ecr',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      authorizationData: result.authorizationData?.map((auth: any) => ({
        authorizationToken: auth.authorizationToken,
        expiresAt: auth.expiresAt,
        proxyEndpoint: auth.proxyEndpoint,
      })),
    }
  }

  /**
   * Delete an ECR repository
   */
  async deleteRepository(options: {
    repositoryName: string
    registryId?: string
    force?: boolean
  }): Promise<{ repository?: Repository }> {
    const params: Record<string, any> = {
      repositoryName: options.repositoryName,
    }

    if (options.registryId) {
      params.registryId = options.registryId
    }

    if (options.force !== undefined) {
      params.force = options.force
    }

    const result = await this.client.request({
      service: 'ecr',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerRegistry_V20150921.DeleteRepository',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      repository: result.repository ? this.parseRepository(result.repository) : undefined,
    }
  }

  /**
   * Describe images in a repository
   */
  async describeImages(options: {
    repositoryName: string
    registryId?: string
    imageIds?: { imageTag?: string, imageDigest?: string }[]
    filter?: { tagStatus?: 'TAGGED' | 'UNTAGGED' | 'ANY' }
    maxResults?: number
    nextToken?: string
  }): Promise<{ imageDetails?: ImageDetail[], nextToken?: string }> {
    const params: Record<string, any> = {
      repositoryName: options.repositoryName,
    }

    if (options.registryId) {
      params.registryId = options.registryId
    }

    if (options.imageIds && options.imageIds.length > 0) {
      params.imageIds = options.imageIds
    }

    if (options.filter) {
      params.filter = options.filter
    }

    if (options.maxResults) {
      params.maxResults = options.maxResults
    }

    if (options.nextToken) {
      params.nextToken = options.nextToken
    }

    const result = await this.client.request({
      service: 'ecr',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerRegistry_V20150921.DescribeImages',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      imageDetails: result.imageDetails?.map((img: any) => this.parseImageDetail(img)),
      nextToken: result.nextToken,
    }
  }

  /**
   * Batch delete images from a repository
   */
  async batchDeleteImage(options: {
    repositoryName: string
    registryId?: string
    imageIds: { imageTag?: string, imageDigest?: string }[]
  }): Promise<{
    imageIds?: { imageTag?: string, imageDigest?: string }[]
    failures?: { imageId?: { imageTag?: string, imageDigest?: string }, failureCode?: string, failureReason?: string }[]
  }> {
    const params: Record<string, any> = {
      repositoryName: options.repositoryName,
      imageIds: options.imageIds,
    }

    if (options.registryId) {
      params.registryId = options.registryId
    }

    const result = await this.client.request({
      service: 'ecr',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerRegistry_V20150921.BatchDeleteImage',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      imageIds: result.imageIds,
      failures: result.failures,
    }
  }

  /**
   * Put lifecycle policy on a repository
   */
  async putLifecyclePolicy(options: {
    repositoryName: string
    registryId?: string
    lifecyclePolicyText: string
  }): Promise<{
    registryId?: string
    repositoryName?: string
    lifecyclePolicyText?: string
  }> {
    const params: Record<string, any> = {
      repositoryName: options.repositoryName,
      lifecyclePolicyText: options.lifecyclePolicyText,
    }

    if (options.registryId) {
      params.registryId = options.registryId
    }

    const result = await this.client.request({
      service: 'ecr',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerRegistry_V20150921.PutLifecyclePolicy',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      registryId: result.registryId,
      repositoryName: result.repositoryName,
      lifecyclePolicyText: result.lifecyclePolicyText,
    }
  }

  /**
   * Get lifecycle policy for a repository
   */
  async getLifecyclePolicy(options: {
    repositoryName: string
    registryId?: string
  }): Promise<{
    registryId?: string
    repositoryName?: string
    lifecyclePolicyText?: string
    lastEvaluatedAt?: string
  }> {
    const params: Record<string, any> = {
      repositoryName: options.repositoryName,
    }

    if (options.registryId) {
      params.registryId = options.registryId
    }

    const result = await this.client.request({
      service: 'ecr',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerRegistry_V20150921.GetLifecyclePolicy',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      registryId: result.registryId,
      repositoryName: result.repositoryName,
      lifecyclePolicyText: result.lifecyclePolicyText,
      lastEvaluatedAt: result.lastEvaluatedAt,
    }
  }

  /**
   * Set repository policy
   */
  async setRepositoryPolicy(options: {
    repositoryName: string
    policyText: string
    registryId?: string
    force?: boolean
  }): Promise<{
    registryId?: string
    repositoryName?: string
    policyText?: string
  }> {
    const params: Record<string, any> = {
      repositoryName: options.repositoryName,
      policyText: options.policyText,
    }

    if (options.registryId) {
      params.registryId = options.registryId
    }

    if (options.force !== undefined) {
      params.force = options.force
    }

    const result = await this.client.request({
      service: 'ecr',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerRegistry_V20150921.SetRepositoryPolicy',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      registryId: result.registryId,
      repositoryName: result.repositoryName,
      policyText: result.policyText,
    }
  }

  /**
   * Get repository policy
   */
  async getRepositoryPolicy(options: {
    repositoryName: string
    registryId?: string
  }): Promise<{
    registryId?: string
    repositoryName?: string
    policyText?: string
  }> {
    const params: Record<string, any> = {
      repositoryName: options.repositoryName,
    }

    if (options.registryId) {
      params.registryId = options.registryId
    }

    const result = await this.client.request({
      service: 'ecr',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerRegistry_V20150921.GetRepositoryPolicy',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      registryId: result.registryId,
      repositoryName: result.repositoryName,
      policyText: result.policyText,
    }
  }

  /**
   * Tag a repository resource
   */
  async tagResource(options: {
    resourceArn: string
    tags: { Key: string, Value: string }[]
  }): Promise<void> {
    const params: Record<string, any> = {
      resourceArn: options.resourceArn,
      tags: options.tags,
    }

    await this.client.request({
      service: 'ecr',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerRegistry_V20150921.TagResource',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * List tags for a resource
   */
  async listTagsForResource(resourceArn: string): Promise<{
    tags?: { Key: string, Value: string }[]
  }> {
    const params: Record<string, any> = {
      resourceArn,
    }

    const result = await this.client.request({
      service: 'ecr',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerRegistry_V20150921.ListTagsForResource',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      tags: result.tags,
    }
  }

  /**
   * Helper: Create a standard lifecycle policy to keep only N images
   */
  createLifecyclePolicyText(rules: LifecyclePolicy[]): string {
    return JSON.stringify({
      rules: rules.map(rule => ({
        rulePriority: rule.rulePriority,
        description: rule.description,
        selection: rule.selection,
        action: rule.action,
      })),
    })
  }

  /**
   * Helper: Get docker login command
   */
  async getDockerLoginCommand(): Promise<string> {
    const authResult = await this.getAuthorizationToken()

    if (!authResult.authorizationData?.[0]) {
      throw new Error('Failed to get authorization token')
    }

    const auth = authResult.authorizationData[0]
    const token = auth.authorizationToken || ''
    const endpoint = auth.proxyEndpoint || ''

    // Token is base64 encoded "AWS:password"
    const decoded = Buffer.from(token, 'base64').toString('utf8')
    const password = decoded.split(':')[1]

    return `echo "${password}" | docker login --username AWS --password-stdin ${endpoint}`
  }

  /**
   * Helper: Get the registry URI for this region
   */
  getRegistryUri(accountId: string): string {
    return `${accountId}.dkr.ecr.${this.region}.amazonaws.com`
  }

  /**
   * Parse repository response
   */
  private parseRepository(repo: any): Repository {
    return {
      repositoryArn: repo.repositoryArn,
      registryId: repo.registryId,
      repositoryName: repo.repositoryName,
      repositoryUri: repo.repositoryUri,
      createdAt: repo.createdAt,
      imageTagMutability: repo.imageTagMutability,
      imageScanningConfiguration: repo.imageScanningConfiguration,
      encryptionConfiguration: repo.encryptionConfiguration,
    }
  }

  /**
   * Parse image detail response
   */
  private parseImageDetail(img: any): ImageDetail {
    return {
      registryId: img.registryId,
      repositoryName: img.repositoryName,
      imageDigest: img.imageDigest,
      imageTags: img.imageTags,
      imageSizeInBytes: img.imageSizeInBytes,
      imagePushedAt: img.imagePushedAt,
      imageScanStatus: img.imageScanStatus,
      imageScanFindingsSummary: img.imageScanFindingsSummary,
    }
  }
}
