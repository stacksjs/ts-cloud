/**
 * AWS Personalize Client
 * Recommendation engine service
 * No external SDK dependencies - implements AWS Signature V4 directly
*/

import { AWSClient } from './client'

// ============================================================================
// Types
// ============================================================================

export interface CreateDatasetGroupCommandInput {
  name: string
  roleArn?: string
  kmsKeyArn?: string
  domain?: 'ECOMMERCE' | 'VIDEO_ON_DEMAND'
  tags?: Array<{ tagKey: string; tagValue: string }>
}

export interface CreateDatasetGroupCommandOutput {
  datasetGroupArn?: string
  domain?: 'ECOMMERCE' | 'VIDEO_ON_DEMAND'
}

export interface DescribeDatasetGroupCommandInput {
  datasetGroupArn: string
}

export interface DatasetGroup {
  name?: string
  datasetGroupArn?: string
  status?: string
  roleArn?: string
  kmsKeyArn?: string
  creationDateTime?: string
  lastUpdatedDateTime?: string
  failureReason?: string
  domain?: 'ECOMMERCE' | 'VIDEO_ON_DEMAND'
}

export interface DescribeDatasetGroupCommandOutput {
  datasetGroup?: DatasetGroup
}

export interface ListDatasetGroupsCommandInput {
  nextToken?: string
  maxResults?: number
}

export interface DatasetGroupSummary {
  name?: string
  datasetGroupArn?: string
  status?: string
  creationDateTime?: string
  lastUpdatedDateTime?: string
  failureReason?: string
  domain?: 'ECOMMERCE' | 'VIDEO_ON_DEMAND'
}

export interface ListDatasetGroupsCommandOutput {
  datasetGroups?: DatasetGroupSummary[]
  nextToken?: string
}

export interface CreateSchemaCommandInput {
  name: string
  schema: string
  domain?: 'ECOMMERCE' | 'VIDEO_ON_DEMAND'
}

export interface CreateSchemaCommandOutput {
  schemaArn?: string
}

export interface CreateDatasetCommandInput {
  name: string
  schemaArn: string
  datasetGroupArn: string
  datasetType: 'Interactions' | 'Items' | 'Users' | 'Actions' | 'Action_Interactions'
  tags?: Array<{ tagKey: string; tagValue: string }>
}

export interface CreateDatasetCommandOutput {
  datasetArn?: string
}

export interface CreateDatasetImportJobCommandInput {
  jobName: string
  datasetArn: string
  dataSource: {
    dataLocation: string
  }
  roleArn: string
  importMode?: 'FULL' | 'INCREMENTAL'
  publishAttributionMetricsToS3?: boolean
  tags?: Array<{ tagKey: string; tagValue: string }>
}

export interface CreateDatasetImportJobCommandOutput {
  datasetImportJobArn?: string
}

export interface DescribeDatasetImportJobCommandInput {
  datasetImportJobArn: string
}

export interface DatasetImportJob {
  jobName?: string
  datasetImportJobArn?: string
  datasetArn?: string
  dataSource?: {
    dataLocation?: string
  }
  roleArn?: string
  status?: string
  creationDateTime?: string
  lastUpdatedDateTime?: string
  failureReason?: string
  importMode?: 'FULL' | 'INCREMENTAL'
  publishAttributionMetricsToS3?: boolean
}

export interface DescribeDatasetImportJobCommandOutput {
  datasetImportJob?: DatasetImportJob
}

export interface CreateSolutionCommandInput {
  name: string
  datasetGroupArn: string
  recipeArn?: string
  eventType?: string
  solutionConfig?: {
    eventValueThreshold?: string
    hpoConfig?: {
      hpoObjective?: {
        type?: string
        metricName?: string
        metricRegex?: string
      }
      hpoResourceConfig?: {
        maxNumberOfTrainingJobs?: string
        maxParallelTrainingJobs?: string
      }
      algorithmHyperParameterRanges?: {
        integerHyperParameterRanges?: Array<{
          name?: string
          minValue?: number
          maxValue?: number
        }>
        continuousHyperParameterRanges?: Array<{
          name?: string
          minValue?: number
          maxValue?: number
        }>
        categoricalHyperParameterRanges?: Array<{
          name?: string
          values?: string[]
        }>
      }
    }
    algorithmHyperParameters?: Record<string, string>
    featureTransformationParameters?: Record<string, string>
    autoMLConfig?: {
      metricName?: string
      recipeList?: string[]
    }
    optimizationObjective?: {
      itemAttribute?: string
      objectiveSensitivity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'OFF'
    }
    trainingDataConfig?: {
      excludedDatasetColumns?: Record<string, string[]>
    }
  }
  performHPO?: boolean
  performAutoML?: boolean
  tags?: Array<{ tagKey: string; tagValue: string }>
}

export interface CreateSolutionCommandOutput {
  solutionArn?: string
}

export interface CreateSolutionVersionCommandInput {
  name?: string
  solutionArn: string
  trainingMode?: 'FULL' | 'UPDATE' | 'AUTOTRAIN'
  tags?: Array<{ tagKey: string; tagValue: string }>
}

export interface CreateSolutionVersionCommandOutput {
  solutionVersionArn?: string
}

export interface DescribeSolutionVersionCommandInput {
  solutionVersionArn: string
}

export interface SolutionVersion {
  name?: string
  solutionVersionArn?: string
  solutionArn?: string
  performHPO?: boolean
  performAutoML?: boolean
  recipeArn?: string
  eventType?: string
  datasetGroupArn?: string
  solutionConfig?: {
    eventValueThreshold?: string
    hpoConfig?: Record<string, unknown>
    algorithmHyperParameters?: Record<string, string>
    featureTransformationParameters?: Record<string, string>
    autoMLConfig?: Record<string, unknown>
  }
  trainingHours?: number
  trainingMode?: 'FULL' | 'UPDATE' | 'AUTOTRAIN'
  tunedHPOParams?: {
    algorithmHyperParameters?: Record<string, string>
  }
  status?: string
  failureReason?: string
  creationDateTime?: string
  lastUpdatedDateTime?: string
  trainingType?: 'AUTOMATIC' | 'MANUAL'
}

export interface DescribeSolutionVersionCommandOutput {
  solutionVersion?: SolutionVersion
}

export interface CreateCampaignCommandInput {
  name: string
  solutionVersionArn: string
  minProvisionedTPS?: number
  campaignConfig?: {
    itemExplorationConfig?: Record<string, string>
    enableMetadataWithRecommendations?: boolean
    syncWithLatestSolutionVersion?: boolean
  }
  tags?: Array<{ tagKey: string; tagValue: string }>
}

export interface CreateCampaignCommandOutput {
  campaignArn?: string
}

export interface DescribeCampaignCommandInput {
  campaignArn: string
}

export interface Campaign {
  name?: string
  campaignArn?: string
  solutionVersionArn?: string
  minProvisionedTPS?: number
  campaignConfig?: {
    itemExplorationConfig?: Record<string, string>
    enableMetadataWithRecommendations?: boolean
    syncWithLatestSolutionVersion?: boolean
  }
  status?: string
  failureReason?: string
  creationDateTime?: string
  lastUpdatedDateTime?: string
  latestCampaignUpdate?: {
    solutionVersionArn?: string
    minProvisionedTPS?: number
    campaignConfig?: Record<string, unknown>
    status?: string
    failureReason?: string
    creationDateTime?: string
    lastUpdatedDateTime?: string
  }
}

export interface DescribeCampaignCommandOutput {
  campaign?: Campaign
}

export interface GetRecommendationsCommandInput {
  campaignArn?: string
  recommenderArn?: string
  itemId?: string
  userId?: string
  numResults?: number
  context?: Record<string, string>
  filterArn?: string
  filterValues?: Record<string, string>
  promotions?: Array<{
    name?: string
    percentPromotedItems?: number
    filterArn?: string
    filterValues?: Record<string, string>
  }>
  metadataColumns?: Record<string, string[]>
}

export interface PredictedItem {
  itemId?: string
  score?: number
  promotionName?: string
  metadata?: Record<string, string>
  reason?: string[]
}

export interface GetRecommendationsCommandOutput {
  itemList?: PredictedItem[]
  recommendationId?: string
}

export interface GetPersonalizedRankingCommandInput {
  campaignArn: string
  inputList: string[]
  userId: string
  context?: Record<string, string>
  filterArn?: string
  filterValues?: Record<string, string>
  metadataColumns?: Record<string, string[]>
}

export interface GetPersonalizedRankingCommandOutput {
  personalizedRanking?: PredictedItem[]
  recommendationId?: string
}

export interface CreateRecommenderCommandInput {
  name: string
  datasetGroupArn: string
  recipeArn: string
  recommenderConfig?: {
    itemExplorationConfig?: Record<string, string>
    minRecommendationRequestsPerSecond?: number
    trainingDataConfig?: {
      excludedDatasetColumns?: Record<string, string[]>
    }
    enableMetadataWithRecommendations?: boolean
  }
  tags?: Array<{ tagKey: string; tagValue: string }>
}

export interface CreateRecommenderCommandOutput {
  recommenderArn?: string
}

export interface DescribeRecommenderCommandInput {
  recommenderArn: string
}

export interface Recommender {
  recommenderArn?: string
  datasetGroupArn?: string
  name?: string
  recipeArn?: string
  recommenderConfig?: {
    itemExplorationConfig?: Record<string, string>
    minRecommendationRequestsPerSecond?: number
    trainingDataConfig?: {
      excludedDatasetColumns?: Record<string, string[]>
    }
    enableMetadataWithRecommendations?: boolean
  }
  creationDateTime?: string
  lastUpdatedDateTime?: string
  status?: string
  failureReason?: string
  latestRecommenderUpdate?: {
    recommenderConfig?: Record<string, unknown>
    creationDateTime?: string
    lastUpdatedDateTime?: string
    status?: string
    failureReason?: string
  }
  modelMetrics?: Record<string, number>
}

export interface DescribeRecommenderCommandOutput {
  recommender?: Recommender
}

export interface ListRecommendersCommandInput {
  datasetGroupArn?: string
  nextToken?: string
  maxResults?: number
}

export interface RecommenderSummary {
  name?: string
  recommenderArn?: string
  datasetGroupArn?: string
  recipeArn?: string
  recommenderConfig?: Record<string, unknown>
  status?: string
  creationDateTime?: string
  lastUpdatedDateTime?: string
}

export interface ListRecommendersCommandOutput {
  recommenders?: RecommenderSummary[]
  nextToken?: string
}

export interface PutEventsCommandInput {
  trackingId: string
  userId?: string
  sessionId: string
  eventList: Array<{
    eventId?: string
    eventType: string
    eventValue?: number
    itemId?: string
    properties?: string
    sentAt: Date | string
    recommendationId?: string
    impression?: string[]
    metricAttribution?: {
      eventAttributionSource?: string
    }
  }>
}

export interface PutEventsCommandOutput {
  // Empty
}

export interface PutItemsCommandInput {
  datasetArn: string
  items: Array<{
    itemId: string
    properties?: string
  }>
}

export interface PutItemsCommandOutput {
  // Empty
}

export interface PutUsersCommandInput {
  datasetArn: string
  users: Array<{
    userId: string
    properties?: string
  }>
}

export interface PutUsersCommandOutput {
  // Empty
}

export interface CreateEventTrackerCommandInput {
  name: string
  datasetGroupArn: string
  tags?: Array<{ tagKey: string; tagValue: string }>
}

export interface CreateEventTrackerCommandOutput {
  eventTrackerArn?: string
  trackingId?: string
}

export interface DescribeEventTrackerCommandInput {
  eventTrackerArn: string
}

export interface EventTracker {
  name?: string
  eventTrackerArn?: string
  accountId?: string
  trackingId?: string
  datasetGroupArn?: string
  status?: string
  creationDateTime?: string
  lastUpdatedDateTime?: string
}

export interface DescribeEventTrackerCommandOutput {
  eventTracker?: EventTracker
}

export interface CreateFilterCommandInput {
  name: string
  datasetGroupArn: string
  filterExpression: string
  tags?: Array<{ tagKey: string; tagValue: string }>
}

export interface CreateFilterCommandOutput {
  filterArn?: string
}

export interface ListRecipesCommandInput {
  recipeProvider?: 'SERVICE'
  nextToken?: string
  maxResults?: number
  domain?: 'ECOMMERCE' | 'VIDEO_ON_DEMAND'
}

export interface RecipeSummary {
  name?: string
  recipeArn?: string
  status?: string
  creationDateTime?: string
  lastUpdatedDateTime?: string
  domain?: 'ECOMMERCE' | 'VIDEO_ON_DEMAND'
}

export interface ListRecipesCommandOutput {
  recipes?: RecipeSummary[]
  nextToken?: string
}

// ============================================================================
// Personalize Client
// ============================================================================

export class PersonalizeClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  private async request<T>(action: string, params: Record<string, unknown>): Promise<T> {
    return this.client.request({
      service: 'personalize',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AmazonPersonalize.${action}`,
      },
      body: JSON.stringify(params),
    })
  }

  // -------------------------------------------------------------------------
  // Dataset Groups
  // -------------------------------------------------------------------------

  async createDatasetGroup(params: CreateDatasetGroupCommandInput): Promise<CreateDatasetGroupCommandOutput> {
    return this.request('CreateDatasetGroup', params as unknown as Record<string, unknown>)
  }

  async describeDatasetGroup(params: DescribeDatasetGroupCommandInput): Promise<DescribeDatasetGroupCommandOutput> {
    return this.request('DescribeDatasetGroup', params as unknown as Record<string, unknown>)
  }

  async listDatasetGroups(params?: ListDatasetGroupsCommandInput): Promise<ListDatasetGroupsCommandOutput> {
    return this.request('ListDatasetGroups', (params || {}) as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Schemas
  // -------------------------------------------------------------------------

  async createSchema(params: CreateSchemaCommandInput): Promise<CreateSchemaCommandOutput> {
    return this.request('CreateSchema', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Datasets
  // -------------------------------------------------------------------------

  async createDataset(params: CreateDatasetCommandInput): Promise<CreateDatasetCommandOutput> {
    return this.request('CreateDataset', params as unknown as Record<string, unknown>)
  }

  async createDatasetImportJob(params: CreateDatasetImportJobCommandInput): Promise<CreateDatasetImportJobCommandOutput> {
    return this.request('CreateDatasetImportJob', params as unknown as Record<string, unknown>)
  }

  async describeDatasetImportJob(params: DescribeDatasetImportJobCommandInput): Promise<DescribeDatasetImportJobCommandOutput> {
    return this.request('DescribeDatasetImportJob', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Solutions
  // -------------------------------------------------------------------------

  async createSolution(params: CreateSolutionCommandInput): Promise<CreateSolutionCommandOutput> {
    return this.request('CreateSolution', params as unknown as Record<string, unknown>)
  }

  async createSolutionVersion(params: CreateSolutionVersionCommandInput): Promise<CreateSolutionVersionCommandOutput> {
    return this.request('CreateSolutionVersion', params as unknown as Record<string, unknown>)
  }

  async describeSolutionVersion(params: DescribeSolutionVersionCommandInput): Promise<DescribeSolutionVersionCommandOutput> {
    return this.request('DescribeSolutionVersion', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Campaigns
  // -------------------------------------------------------------------------

  async createCampaign(params: CreateCampaignCommandInput): Promise<CreateCampaignCommandOutput> {
    return this.request('CreateCampaign', params as unknown as Record<string, unknown>)
  }

  async describeCampaign(params: DescribeCampaignCommandInput): Promise<DescribeCampaignCommandOutput> {
    return this.request('DescribeCampaign', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Recommenders (Domain Datasets)
  // -------------------------------------------------------------------------

  async createRecommender(params: CreateRecommenderCommandInput): Promise<CreateRecommenderCommandOutput> {
    return this.request('CreateRecommender', params as unknown as Record<string, unknown>)
  }

  async describeRecommender(params: DescribeRecommenderCommandInput): Promise<DescribeRecommenderCommandOutput> {
    return this.request('DescribeRecommender', params as unknown as Record<string, unknown>)
  }

  async listRecommenders(params?: ListRecommendersCommandInput): Promise<ListRecommendersCommandOutput> {
    return this.request('ListRecommenders', (params || {}) as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Events & Real-time Data
  // -------------------------------------------------------------------------

  async createEventTracker(params: CreateEventTrackerCommandInput): Promise<CreateEventTrackerCommandOutput> {
    return this.request('CreateEventTracker', params as unknown as Record<string, unknown>)
  }

  async describeEventTracker(params: DescribeEventTrackerCommandInput): Promise<DescribeEventTrackerCommandOutput> {
    return this.request('DescribeEventTracker', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Filters
  // -------------------------------------------------------------------------

  async createFilter(params: CreateFilterCommandInput): Promise<CreateFilterCommandOutput> {
    return this.request('CreateFilter', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Recipes
  // -------------------------------------------------------------------------

  async listRecipes(params?: ListRecipesCommandInput): Promise<ListRecipesCommandOutput> {
    return this.request('ListRecipes', (params || {}) as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Convenience Methods
  // -------------------------------------------------------------------------

  /**
   * Wait for a solution version to be ready
  */
  async waitForSolutionVersion(
    solutionVersionArn: string,
    options?: { maxWaitMs?: number; pollIntervalMs?: number },
  ): Promise<SolutionVersion> {
    const maxWaitMs = options?.maxWaitMs ?? 7200000 // 2 hours
    const pollIntervalMs = options?.pollIntervalMs ?? 60000 // 1 minute
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      const result = await this.describeSolutionVersion({ solutionVersionArn })
      const sv = result.solutionVersion

      if (sv?.status === 'ACTIVE') {
        return sv
      }
      if (sv?.status === 'CREATE FAILED') {
        throw new Error(`Solution version failed: ${sv.failureReason}`)
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }

    throw new Error(`Timeout waiting for solution version ${solutionVersionArn}`)
  }

  /**
   * Wait for a campaign to be active
  */
  async waitForCampaign(
    campaignArn: string,
    options?: { maxWaitMs?: number; pollIntervalMs?: number },
  ): Promise<Campaign> {
    const maxWaitMs = options?.maxWaitMs ?? 1800000 // 30 minutes
    const pollIntervalMs = options?.pollIntervalMs ?? 30000
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      const result = await this.describeCampaign({ campaignArn })
      const campaign = result.campaign

      if (campaign?.status === 'ACTIVE') {
        return campaign
      }
      if (campaign?.status === 'CREATE FAILED') {
        throw new Error(`Campaign failed: ${campaign.failureReason}`)
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }

    throw new Error(`Timeout waiting for campaign ${campaignArn}`)
  }

  /**
   * Wait for a dataset import job to complete
  */
  async waitForDatasetImportJob(
    jobArn: string,
    options?: { maxWaitMs?: number; pollIntervalMs?: number },
  ): Promise<DatasetImportJob> {
    const maxWaitMs = options?.maxWaitMs ?? 3600000 // 1 hour
    const pollIntervalMs = options?.pollIntervalMs ?? 30000
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      const result = await this.describeDatasetImportJob({ datasetImportJobArn: jobArn })
      const job = result.datasetImportJob

      if (job?.status === 'ACTIVE') {
        return job
      }
      if (job?.status === 'CREATE FAILED') {
        throw new Error(`Dataset import job failed: ${job.failureReason}`)
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }

    throw new Error(`Timeout waiting for dataset import job ${jobArn}`)
  }
}

// ============================================================================
// Personalize Runtime Client (for getting recommendations)
// ============================================================================

export class PersonalizeRuntimeClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  private async request<T>(action: string, params: Record<string, unknown>): Promise<T> {
    return this.client.request({
      service: 'personalize-runtime',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AmazonPersonalizeRuntime.${action}`,
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * Get recommendations for a user
  */
  async getRecommendations(params: GetRecommendationsCommandInput): Promise<GetRecommendationsCommandOutput> {
    return this.request('GetRecommendations', params as unknown as Record<string, unknown>)
  }

  /**
   * Get personalized ranking of items for a user
  */
  async getPersonalizedRanking(params: GetPersonalizedRankingCommandInput): Promise<GetPersonalizedRankingCommandOutput> {
    return this.request('GetPersonalizedRanking', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Convenience Methods
  // -------------------------------------------------------------------------

  /**
   * Simple recommendations for a user
  */
  async recommendForUser(
    campaignArn: string,
    userId: string,
    numResults: number = 10,
  ): Promise<string[]> {
    const result = await this.getRecommendations({
      campaignArn,
      userId,
      numResults,
    })
    return result.itemList?.map(i => i.itemId || '').filter(Boolean) || []
  }

  /**
   * Get similar items
  */
  async getSimilarItems(
    campaignArn: string,
    itemId: string,
    numResults: number = 10,
  ): Promise<string[]> {
    const result = await this.getRecommendations({
      campaignArn,
      itemId,
      numResults,
    })
    return result.itemList?.map(i => i.itemId || '').filter(Boolean) || []
  }

  /**
   * Rank items for a user
  */
  async rankItems(
    campaignArn: string,
    userId: string,
    itemIds: string[],
  ): Promise<string[]> {
    const result = await this.getPersonalizedRanking({
      campaignArn,
      userId,
      inputList: itemIds,
    })
    return result.personalizedRanking?.map(i => i.itemId || '').filter(Boolean) || []
  }
}

// ============================================================================
// Personalize Events Client
// ============================================================================

export class PersonalizeEventsClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  private async request<T>(action: string, params: Record<string, unknown>): Promise<T> {
    return this.client.request({
      service: 'personalize-events',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AmazonPersonalizeEvents.${action}`,
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * Record user events
  */
  async putEvents(params: PutEventsCommandInput): Promise<PutEventsCommandOutput> {
    return this.request('PutEvents', params as unknown as Record<string, unknown>)
  }

  /**
   * Add or update items
  */
  async putItems(params: PutItemsCommandInput): Promise<PutItemsCommandOutput> {
    return this.request('PutItems', params as unknown as Record<string, unknown>)
  }

  /**
   * Add or update users
  */
  async putUsers(params: PutUsersCommandInput): Promise<PutUsersCommandOutput> {
    return this.request('PutUsers', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Convenience Methods
  // -------------------------------------------------------------------------

  /**
   * Track a simple click/view event
  */
  async trackEvent(
    trackingId: string,
    sessionId: string,
    userId: string,
    itemId: string,
    eventType: string = 'click',
  ): Promise<void> {
    await this.putEvents({
      trackingId,
      sessionId,
      userId,
      eventList: [
        {
          eventType,
          itemId,
          sentAt: new Date().toISOString(),
        },
      ],
    })
  }

  /**
   * Track a purchase event with value
  */
  async trackPurchase(
    trackingId: string,
    sessionId: string,
    userId: string,
    itemId: string,
    value: number,
  ): Promise<void> {
    await this.putEvents({
      trackingId,
      sessionId,
      userId,
      eventList: [
        {
          eventType: 'purchase',
          eventValue: value,
          itemId,
          sentAt: new Date().toISOString(),
        },
      ],
    })
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get recommendations for a user
*/
export async function getRecommendations(
  campaignArn: string,
  userId: string,
  options?: { numResults?: number; region?: string },
): Promise<string[]> {
  const client = new PersonalizeRuntimeClient(options?.region || 'us-east-1')
  return client.recommendForUser(campaignArn, userId, options?.numResults)
}

/**
 * Get similar items
*/
export async function getSimilarItems(
  campaignArn: string,
  itemId: string,
  options?: { numResults?: number; region?: string },
): Promise<string[]> {
  const client = new PersonalizeRuntimeClient(options?.region || 'us-east-1')
  return client.getSimilarItems(campaignArn, itemId, options?.numResults)
}

/**
 * Track user event
*/
export async function trackEvent(
  trackingId: string,
  sessionId: string,
  userId: string,
  itemId: string,
  eventType: string = 'click',
  region?: string,
): Promise<void> {
  const client = new PersonalizeEventsClient(region || 'us-east-1')
  await client.trackEvent(trackingId, sessionId, userId, itemId, eventType)
}
