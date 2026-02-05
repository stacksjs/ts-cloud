/**
 * AWS Kendra Client
 * Enterprise search service
 * No external SDK dependencies - implements AWS Signature V4 directly
*/

import { AWSClient } from './client'

// ============================================================================
// Types
// ============================================================================

export interface CreateIndexCommandInput {
  Name: string
  Edition?: 'DEVELOPER_EDITION' | 'ENTERPRISE_EDITION'
  RoleArn: string
  ServerSideEncryptionConfiguration?: {
    KmsKeyId?: string
  }
  Description?: string
  ClientToken?: string
  Tags?: Array<{ Key: string; Value: string }>
  UserTokenConfigurations?: Array<{
    JwtTokenTypeConfiguration?: {
      KeyLocation: 'URL' | 'SECRET_MANAGER'
      URL?: string
      SecretManagerArn?: string
      UserNameAttributeField?: string
      GroupAttributeField?: string
      Issuer?: string
      ClaimRegex?: string
    }
    JsonTokenTypeConfiguration?: {
      UserNameAttributeField: string
      GroupAttributeField: string
    }
  }>
  UserContextPolicy?: 'ATTRIBUTE_FILTER' | 'USER_TOKEN'
  UserGroupResolutionConfiguration?: {
    UserGroupResolutionMode: 'AWS_SSO' | 'NONE'
  }
}

export interface CreateIndexCommandOutput {
  Id?: string
}

export interface DescribeIndexCommandInput {
  Id: string
}

export interface Index {
  Name?: string
  Id?: string
  Edition?: 'DEVELOPER_EDITION' | 'ENTERPRISE_EDITION'
  RoleArn?: string
  ServerSideEncryptionConfiguration?: {
    KmsKeyId?: string
  }
  Status?: 'CREATING' | 'ACTIVE' | 'DELETING' | 'FAILED' | 'UPDATING' | 'SYSTEM_UPDATING'
  Description?: string
  CreatedAt?: string
  UpdatedAt?: string
  DocumentMetadataConfigurations?: Array<{
    Name?: string
    Type?: 'STRING_VALUE' | 'STRING_LIST_VALUE' | 'LONG_VALUE' | 'DATE_VALUE'
    Relevance?: {
      Freshness?: boolean
      Importance?: number
      Duration?: string
      RankOrder?: 'ASCENDING' | 'DESCENDING'
      ValueImportanceMap?: Record<string, number>
    }
    Search?: {
      Facetable?: boolean
      Searchable?: boolean
      Displayable?: boolean
      Sortable?: boolean
    }
  }>
  IndexStatistics?: {
    FaqStatistics?: {
      IndexedQuestionAnswersCount?: number
    }
    TextDocumentStatistics?: {
      IndexedTextDocumentsCount?: number
      IndexedTextBytes?: number
    }
  }
  ErrorMessage?: string
  CapacityUnits?: {
    StorageCapacityUnits: number
    QueryCapacityUnits: number
  }
  UserTokenConfigurations?: Array<{
    JwtTokenTypeConfiguration?: {
      KeyLocation?: string
      URL?: string
      SecretManagerArn?: string
      UserNameAttributeField?: string
      GroupAttributeField?: string
      Issuer?: string
      ClaimRegex?: string
    }
    JsonTokenTypeConfiguration?: {
      UserNameAttributeField?: string
      GroupAttributeField?: string
    }
  }>
  UserContextPolicy?: 'ATTRIBUTE_FILTER' | 'USER_TOKEN'
  UserGroupResolutionConfiguration?: {
    UserGroupResolutionMode?: 'AWS_SSO' | 'NONE'
  }
}

export interface DescribeIndexCommandOutput {
  Name?: string
  Id?: string
  Edition?: 'DEVELOPER_EDITION' | 'ENTERPRISE_EDITION'
  RoleArn?: string
  ServerSideEncryptionConfiguration?: {
    KmsKeyId?: string
  }
  Status?: 'CREATING' | 'ACTIVE' | 'DELETING' | 'FAILED' | 'UPDATING' | 'SYSTEM_UPDATING'
  Description?: string
  CreatedAt?: string
  UpdatedAt?: string
  DocumentMetadataConfigurations?: Index['DocumentMetadataConfigurations']
  IndexStatistics?: Index['IndexStatistics']
  ErrorMessage?: string
  CapacityUnits?: Index['CapacityUnits']
}

export interface ListIndicesCommandInput {
  NextToken?: string
  MaxResults?: number
}

export interface IndexSummary {
  Name?: string
  Id?: string
  Edition?: 'DEVELOPER_EDITION' | 'ENTERPRISE_EDITION'
  CreatedAt?: string
  UpdatedAt?: string
  Status?: 'CREATING' | 'ACTIVE' | 'DELETING' | 'FAILED' | 'UPDATING' | 'SYSTEM_UPDATING'
}

export interface ListIndicesCommandOutput {
  IndexConfigurationSummaryItems?: IndexSummary[]
  NextToken?: string
}

export interface DeleteIndexCommandInput {
  Id: string
}

export interface DeleteIndexCommandOutput {
  // Empty
}

export interface CreateDataSourceCommandInput {
  Name: string
  IndexId: string
  Type: 'S3' | 'SHAREPOINT' | 'DATABASE' | 'SALESFORCE' | 'ONEDRIVE' | 'SERVICENOW' | 'CUSTOM' | 'CONFLUENCE' | 'GOOGLEDRIVE' | 'WEBCRAWLER' | 'WORKDOCS' | 'FSX' | 'SLACK' | 'BOX' | 'QUIP' | 'JIRA' | 'GITHUB' | 'ALFRESCO' | 'TEMPLATE'
  Configuration?: {
    S3Configuration?: {
      BucketName: string
      InclusionPrefixes?: string[]
      InclusionPatterns?: string[]
      ExclusionPatterns?: string[]
      DocumentsMetadataConfiguration?: {
        S3Prefix?: string
      }
      AccessControlListConfiguration?: {
        KeyPath?: string
      }
    }
    WebCrawlerConfiguration?: {
      Urls: {
        SeedUrlConfiguration?: {
          SeedUrls: string[]
          WebCrawlerMode?: 'HOST_ONLY' | 'SUBDOMAINS' | 'EVERYTHING'
        }
        SiteMapsConfiguration?: {
          SiteMaps: string[]
        }
      }
      CrawlDepth?: number
      MaxLinksPerPage?: number
      MaxContentSizePerPageInMegaBytes?: number
      MaxUrlsPerMinuteCrawlRate?: number
      UrlInclusionPatterns?: string[]
      UrlExclusionPatterns?: string[]
      ProxyConfiguration?: {
        Host: string
        Port: number
        Credentials?: string
      }
      AuthenticationConfiguration?: {
        BasicAuthentication?: Array<{
          Host: string
          Port: number
          Credentials: string
        }>
      }
    }
    ConfluenceConfiguration?: {
      ServerUrl: string
      SecretArn: string
      Version: 'CLOUD' | 'SERVER'
      SpaceConfiguration?: {
        CrawlPersonalSpaces?: boolean
        CrawlArchivedSpaces?: boolean
        IncludeSpaces?: string[]
        ExcludeSpaces?: string[]
        SpaceFieldMappings?: Array<{
          DataSourceFieldName?: string
          DateFieldFormat?: string
          IndexFieldName?: string
        }>
      }
      PageConfiguration?: {
        PageFieldMappings?: Array<{
          DataSourceFieldName?: string
          DateFieldFormat?: string
          IndexFieldName?: string
        }>
      }
      BlogConfiguration?: {
        BlogFieldMappings?: Array<{
          DataSourceFieldName?: string
          DateFieldFormat?: string
          IndexFieldName?: string
        }>
      }
      AttachmentConfiguration?: {
        CrawlAttachments?: boolean
        AttachmentFieldMappings?: Array<{
          DataSourceFieldName?: string
          DateFieldFormat?: string
          IndexFieldName?: string
        }>
      }
      VpcConfiguration?: {
        SubnetIds: string[]
        SecurityGroupIds: string[]
      }
      InclusionPatterns?: string[]
      ExclusionPatterns?: string[]
      ProxyConfiguration?: {
        Host: string
        Port: number
        Credentials?: string
      }
      AuthenticationType?: 'HTTP_BASIC' | 'PAT'
    }
  }
  VpcConfiguration?: {
    SubnetIds: string[]
    SecurityGroupIds: string[]
  }
  Description?: string
  Schedule?: string
  RoleArn?: string
  Tags?: Array<{ Key: string; Value: string }>
  ClientToken?: string
  LanguageCode?: string
  CustomDocumentEnrichmentConfiguration?: {
    InlineConfigurations?: Array<{
      Condition?: {
        ConditionDocumentAttributeKey: string
        Operator: 'GreaterThan' | 'GreaterThanOrEquals' | 'LessThan' | 'LessThanOrEquals' | 'Equals' | 'NotEquals' | 'Contains' | 'NotContains' | 'Exists' | 'NotExists' | 'BeginsWith'
        ConditionOnValue?: {
          StringValue?: string
          StringListValue?: string[]
          LongValue?: number
          DateValue?: string
        }
      }
      Target?: {
        TargetDocumentAttributeKey?: string
        TargetDocumentAttributeValueDeletion?: boolean
        TargetDocumentAttributeValue?: {
          StringValue?: string
          StringListValue?: string[]
          LongValue?: number
          DateValue?: string
        }
      }
      DocumentContentDeletion?: boolean
    }>
    PreExtractionHookConfiguration?: {
      InvocationCondition?: {
        ConditionDocumentAttributeKey: string
        Operator: string
        ConditionOnValue?: {
          StringValue?: string
          StringListValue?: string[]
          LongValue?: number
          DateValue?: string
        }
      }
      LambdaArn: string
      S3Bucket: string
    }
    PostExtractionHookConfiguration?: {
      InvocationCondition?: {
        ConditionDocumentAttributeKey: string
        Operator: string
        ConditionOnValue?: {
          StringValue?: string
          StringListValue?: string[]
          LongValue?: number
          DateValue?: string
        }
      }
      LambdaArn: string
      S3Bucket: string
    }
    RoleArn?: string
  }
}

export interface CreateDataSourceCommandOutput {
  Id?: string
}

export interface DescribeDataSourceCommandInput {
  Id: string
  IndexId: string
}

export interface DataSource {
  Id?: string
  IndexId?: string
  Name?: string
  Type?: string
  Configuration?: Record<string, unknown>
  VpcConfiguration?: {
    SubnetIds?: string[]
    SecurityGroupIds?: string[]
  }
  CreatedAt?: string
  UpdatedAt?: string
  Description?: string
  Status?: 'CREATING' | 'DELETING' | 'FAILED' | 'UPDATING' | 'ACTIVE'
  Schedule?: string
  RoleArn?: string
  ErrorMessage?: string
  LanguageCode?: string
  CustomDocumentEnrichmentConfiguration?: Record<string, unknown>
}

export interface DescribeDataSourceCommandOutput extends DataSource {}

export interface ListDataSourcesCommandInput {
  IndexId: string
  NextToken?: string
  MaxResults?: number
}

export interface DataSourceSummary {
  Name?: string
  Id?: string
  Type?: string
  CreatedAt?: string
  UpdatedAt?: string
  Status?: 'CREATING' | 'DELETING' | 'FAILED' | 'UPDATING' | 'ACTIVE'
  LanguageCode?: string
}

export interface ListDataSourcesCommandOutput {
  SummaryItems?: DataSourceSummary[]
  NextToken?: string
}

export interface StartDataSourceSyncJobCommandInput {
  Id: string
  IndexId: string
}

export interface StartDataSourceSyncJobCommandOutput {
  ExecutionId?: string
}

export interface StopDataSourceSyncJobCommandInput {
  Id: string
  IndexId: string
}

export interface StopDataSourceSyncJobCommandOutput {
  // Empty
}

export interface QueryCommandInput {
  IndexId: string
  QueryText?: string
  AttributeFilter?: {
    AndAllFilters?: QueryCommandInput['AttributeFilter'][]
    OrAllFilters?: QueryCommandInput['AttributeFilter'][]
    NotFilter?: QueryCommandInput['AttributeFilter']
    EqualsTo?: {
      Key: string
      Value: {
        StringValue?: string
        StringListValue?: string[]
        LongValue?: number
        DateValue?: string
      }
    }
    ContainsAll?: {
      Key: string
      Value: {
        StringValue?: string
        StringListValue?: string[]
        LongValue?: number
        DateValue?: string
      }
    }
    ContainsAny?: {
      Key: string
      Value: {
        StringValue?: string
        StringListValue?: string[]
        LongValue?: number
        DateValue?: string
      }
    }
    GreaterThan?: {
      Key: string
      Value: {
        StringValue?: string
        StringListValue?: string[]
        LongValue?: number
        DateValue?: string
      }
    }
    GreaterThanOrEquals?: {
      Key: string
      Value: {
        StringValue?: string
        StringListValue?: string[]
        LongValue?: number
        DateValue?: string
      }
    }
    LessThan?: {
      Key: string
      Value: {
        StringValue?: string
        StringListValue?: string[]
        LongValue?: number
        DateValue?: string
      }
    }
    LessThanOrEquals?: {
      Key: string
      Value: {
        StringValue?: string
        StringListValue?: string[]
        LongValue?: number
        DateValue?: string
      }
    }
  }
  Facets?: Array<{
    DocumentAttributeKey?: string
    Facets?: QueryCommandInput['Facets']
    MaxResults?: number
  }>
  RequestedDocumentAttributes?: string[]
  QueryResultTypeFilter?: 'DOCUMENT' | 'QUESTION_ANSWER' | 'ANSWER'
  DocumentRelevanceOverrideConfigurations?: Array<{
    Name: string
    Relevance: {
      Freshness?: boolean
      Importance?: number
      Duration?: string
      RankOrder?: 'ASCENDING' | 'DESCENDING'
      ValueImportanceMap?: Record<string, number>
    }
  }>
  PageNumber?: number
  PageSize?: number
  SortingConfiguration?: {
    DocumentAttributeKey: string
    SortOrder: 'DESC' | 'ASC'
  }
  SortingConfigurations?: Array<{
    DocumentAttributeKey: string
    SortOrder: 'DESC' | 'ASC'
  }>
  UserContext?: {
    Token?: string
    UserId?: string
    Groups?: string[]
    DataSourceGroups?: Array<{
      GroupId: string
      DataSourceId: string
    }>
  }
  VisitorId?: string
  SpellCorrectionConfiguration?: {
    IncludeQuerySpellCheckSuggestions: boolean
  }
  CollapseConfiguration?: {
    DocumentAttributeKey: string
    SortingConfigurations?: Array<{
      DocumentAttributeKey: string
      SortOrder: 'DESC' | 'ASC'
    }>
    MissingAttributeKeyStrategy?: 'IGNORE' | 'COLLAPSE' | 'EXPAND'
    Expand?: boolean
    ExpandConfiguration?: {
      MaxResultItemsToExpand?: number
      MaxExpandedResultsPerItem?: number
    }
  }
}

export interface QueryResultItem {
  Id?: string
  Type?: 'DOCUMENT' | 'QUESTION_ANSWER' | 'ANSWER'
  Format?: 'TABLE' | 'TEXT'
  AdditionalAttributes?: Array<{
    Key?: string
    ValueType?: 'TEXT_WITH_HIGHLIGHTS_VALUE' | 'ANSWER_VALUE'
    Value?: {
      TextWithHighlightsValue?: {
        Text?: string
        Highlights?: Array<{
          BeginOffset?: number
          EndOffset?: number
          TopAnswer?: boolean
          Type?: 'STANDARD' | 'THESAURUS_SYNONYM'
        }>
      }
    }
  }>
  DocumentId?: string
  DocumentTitle?: {
    Text?: string
    Highlights?: Array<{
      BeginOffset?: number
      EndOffset?: number
      TopAnswer?: boolean
      Type?: 'STANDARD' | 'THESAURUS_SYNONYM'
    }>
  }
  DocumentExcerpt?: {
    Text?: string
    Highlights?: Array<{
      BeginOffset?: number
      EndOffset?: number
      TopAnswer?: boolean
      Type?: 'STANDARD' | 'THESAURUS_SYNONYM'
    }>
  }
  DocumentURI?: string
  DocumentAttributes?: Array<{
    Key?: string
    Value?: {
      StringValue?: string
      StringListValue?: string[]
      LongValue?: number
      DateValue?: string
    }
  }>
  ScoreAttributes?: {
    ScoreConfidence?: 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NOT_AVAILABLE'
  }
  FeedbackToken?: string
  TableExcerpt?: {
    Rows?: Array<{
      Cells?: Array<{
        Value?: string
        TopAnswer?: boolean
        Highlighted?: boolean
        Header?: boolean
      }>
    }>
    TotalNumberOfRows?: number
  }
  CollapsedResultDetail?: {
    DocumentAttribute?: {
      Key?: string
      Value?: {
        StringValue?: string
        StringListValue?: string[]
        LongValue?: number
        DateValue?: string
      }
    }
    ExpandedResults?: QueryResultItem[]
  }
}

export interface FacetResult {
  DocumentAttributeKey?: string
  DocumentAttributeValueType?: 'STRING_VALUE' | 'STRING_LIST_VALUE' | 'LONG_VALUE' | 'DATE_VALUE'
  DocumentAttributeValueCountPairs?: Array<{
    DocumentAttributeValue?: {
      StringValue?: string
      StringListValue?: string[]
      LongValue?: number
      DateValue?: string
    }
    Count?: number
    FacetResults?: FacetResult[]
  }>
}

export interface QueryCommandOutput {
  QueryId?: string
  ResultItems?: QueryResultItem[]
  FacetResults?: FacetResult[]
  TotalNumberOfResults?: number
  Warnings?: Array<{
    Message?: string
    Code?: 'QUERY_LANGUAGE_INVALID_SYNTAX'
  }>
  SpellCorrectedQueries?: Array<{
    SuggestedQueryText?: string
    Corrections?: Array<{
      BeginOffset?: number
      EndOffset?: number
      Term?: string
      CorrectedTerm?: string
    }>
  }>
  FeaturedResultsItems?: Array<{
    Id?: string
    Type?: 'DOCUMENT' | 'QUESTION_ANSWER' | 'ANSWER'
    AdditionalAttributes?: Array<{
      Key?: string
      ValueType?: string
      Value?: Record<string, unknown>
    }>
    DocumentId?: string
    DocumentTitle?: {
      Text?: string
      Highlights?: Array<{
        BeginOffset?: number
        EndOffset?: number
        TopAnswer?: boolean
        Type?: string
      }>
    }
    DocumentExcerpt?: {
      Text?: string
      Highlights?: Array<{
        BeginOffset?: number
        EndOffset?: number
        TopAnswer?: boolean
        Type?: string
      }>
    }
    DocumentURI?: string
    DocumentAttributes?: Array<{
      Key?: string
      Value?: Record<string, unknown>
    }>
    FeedbackToken?: string
  }>
}

export interface RetrieveCommandInput {
  IndexId: string
  QueryText: string
  AttributeFilter?: QueryCommandInput['AttributeFilter']
  RequestedDocumentAttributes?: string[]
  DocumentRelevanceOverrideConfigurations?: QueryCommandInput['DocumentRelevanceOverrideConfigurations']
  PageNumber?: number
  PageSize?: number
  UserContext?: QueryCommandInput['UserContext']
}

export interface RetrieveResultItem {
  Id?: string
  DocumentId?: string
  DocumentTitle?: string
  Content?: string
  DocumentURI?: string
  DocumentAttributes?: Array<{
    Key?: string
    Value?: {
      StringValue?: string
      StringListValue?: string[]
      LongValue?: number
      DateValue?: string
    }
  }>
  ScoreAttributes?: {
    ScoreConfidence?: 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NOT_AVAILABLE'
  }
}

export interface RetrieveCommandOutput {
  QueryId?: string
  ResultItems?: RetrieveResultItem[]
}

export interface BatchPutDocumentCommandInput {
  IndexId: string
  RoleArn?: string
  Documents: Array<{
    Id: string
    Title?: string
    Blob?: Uint8Array
    S3Path?: {
      Bucket: string
      Key: string
    }
    Attributes?: Array<{
      Key: string
      Value: {
        StringValue?: string
        StringListValue?: string[]
        LongValue?: number
        DateValue?: string
      }
    }>
    AccessControlList?: Array<{
      Name: string
      Type: 'USER' | 'GROUP'
      Access: 'ALLOW' | 'DENY'
      DataSourceId?: string
    }>
    HierarchicalAccessControlList?: Array<{
      PrincipalList: Array<{
        Name: string
        Type: 'USER' | 'GROUP'
        Access: 'ALLOW' | 'DENY'
        DataSourceId?: string
      }>
    }>
    ContentType?: 'PDF' | 'HTML' | 'MS_WORD' | 'PLAIN_TEXT' | 'PPT' | 'RTF' | 'XML' | 'XSLT' | 'MS_EXCEL' | 'CSV' | 'JSON' | 'MD'
    AccessControlConfigurationId?: string
  }>
  CustomDocumentEnrichmentConfiguration?: CreateDataSourceCommandInput['CustomDocumentEnrichmentConfiguration']
}

export interface BatchPutDocumentCommandOutput {
  FailedDocuments?: Array<{
    Id?: string
    ErrorCode?: 'InternalError' | 'InvalidRequest'
    ErrorMessage?: string
  }>
}

export interface BatchDeleteDocumentCommandInput {
  IndexId: string
  DocumentIdList: string[]
  DataSourceSyncJobMetricTarget?: {
    DataSourceId: string
    DataSourceSyncJobId?: string
  }
}

export interface BatchDeleteDocumentCommandOutput {
  FailedDocuments?: Array<{
    Id?: string
    ErrorCode?: 'InternalError' | 'InvalidRequest'
    ErrorMessage?: string
  }>
}

// ============================================================================
// Kendra Client
// ============================================================================

export class KendraClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  private async request<T>(action: string, params: Record<string, unknown>): Promise<T> {
    return this.client.request({
      service: 'kendra',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSKendraFrontendService.${action}`,
      },
      body: JSON.stringify(params),
    })
  }

  // -------------------------------------------------------------------------
  // Index Management
  // -------------------------------------------------------------------------

  async createIndex(params: CreateIndexCommandInput): Promise<CreateIndexCommandOutput> {
    return this.request('CreateIndex', params as unknown as Record<string, unknown>)
  }

  async describeIndex(params: DescribeIndexCommandInput): Promise<DescribeIndexCommandOutput> {
    return this.request('DescribeIndex', params as unknown as Record<string, unknown>)
  }

  async listIndices(params?: ListIndicesCommandInput): Promise<ListIndicesCommandOutput> {
    return this.request('ListIndices', (params || {}) as unknown as Record<string, unknown>)
  }

  async deleteIndex(params: DeleteIndexCommandInput): Promise<DeleteIndexCommandOutput> {
    return this.request('DeleteIndex', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Data Source Management
  // -------------------------------------------------------------------------

  async createDataSource(params: CreateDataSourceCommandInput): Promise<CreateDataSourceCommandOutput> {
    return this.request('CreateDataSource', params as unknown as Record<string, unknown>)
  }

  async describeDataSource(params: DescribeDataSourceCommandInput): Promise<DescribeDataSourceCommandOutput> {
    return this.request('DescribeDataSource', params as unknown as Record<string, unknown>)
  }

  async listDataSources(params: ListDataSourcesCommandInput): Promise<ListDataSourcesCommandOutput> {
    return this.request('ListDataSources', params as unknown as Record<string, unknown>)
  }

  async startDataSourceSyncJob(params: StartDataSourceSyncJobCommandInput): Promise<StartDataSourceSyncJobCommandOutput> {
    return this.request('StartDataSourceSyncJob', params as unknown as Record<string, unknown>)
  }

  async stopDataSourceSyncJob(params: StopDataSourceSyncJobCommandInput): Promise<StopDataSourceSyncJobCommandOutput> {
    return this.request('StopDataSourceSyncJob', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  async query(params: QueryCommandInput): Promise<QueryCommandOutput> {
    return this.request('Query', params as unknown as Record<string, unknown>)
  }

  async retrieve(params: RetrieveCommandInput): Promise<RetrieveCommandOutput> {
    return this.request('Retrieve', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Document Management
  // -------------------------------------------------------------------------

  async batchPutDocument(params: BatchPutDocumentCommandInput): Promise<BatchPutDocumentCommandOutput> {
    return this.request('BatchPutDocument', params as unknown as Record<string, unknown>)
  }

  async batchDeleteDocument(params: BatchDeleteDocumentCommandInput): Promise<BatchDeleteDocumentCommandOutput> {
    return this.request('BatchDeleteDocument', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Convenience Methods
  // -------------------------------------------------------------------------

  /**
   * Simple search query
  */
  async search(indexId: string, queryText: string, options?: {
    pageSize?: number
    pageNumber?: number
    attributeFilter?: QueryCommandInput['AttributeFilter']
  }): Promise<QueryResultItem[]> {
    const result = await this.query({
      IndexId: indexId,
      QueryText: queryText,
      PageSize: options?.pageSize,
      PageNumber: options?.pageNumber,
      AttributeFilter: options?.attributeFilter,
    })
    return result.ResultItems || []
  }

  /**
   * Retrieve documents (for RAG)
  */
  async retrieveDocuments(indexId: string, queryText: string, options?: {
    pageSize?: number
    pageNumber?: number
  }): Promise<RetrieveResultItem[]> {
    const result = await this.retrieve({
      IndexId: indexId,
      QueryText: queryText,
      PageSize: options?.pageSize,
      PageNumber: options?.pageNumber,
    })
    return result.ResultItems || []
  }

  /**
   * Add a text document to the index
  */
  async addDocument(indexId: string, document: {
    id: string
    title?: string
    content: string
    attributes?: Record<string, string | string[] | number>
  }): Promise<void> {
    const attributes = document.attributes
      ? Object.entries(document.attributes).map(([key, value]) => ({
          Key: key,
          Value: typeof value === 'number'
            ? { LongValue: value }
            : Array.isArray(value)
              ? { StringListValue: value }
              : { StringValue: value },
        }))
      : undefined

    const result = await this.batchPutDocument({
      IndexId: indexId,
      Documents: [
        {
          Id: document.id,
          Title: document.title,
          Blob: new TextEncoder().encode(document.content),
          ContentType: 'PLAIN_TEXT',
          Attributes: attributes,
        },
      ],
    })

    if (result.FailedDocuments?.length) {
      throw new Error(`Failed to add document: ${result.FailedDocuments[0].ErrorMessage}`)
    }
  }

  /**
   * Add multiple documents
  */
  async addDocuments(indexId: string, documents: Array<{
    id: string
    title?: string
    content: string
    attributes?: Record<string, string | string[] | number>
  }>): Promise<{ succeeded: number; failed: Array<{ id: string; error: string }> }> {
    const docs = documents.map(doc => {
      const attributes = doc.attributes
        ? Object.entries(doc.attributes).map(([key, value]) => ({
            Key: key,
            Value: typeof value === 'number'
              ? { LongValue: value }
              : Array.isArray(value)
                ? { StringListValue: value }
                : { StringValue: value },
          }))
        : undefined

      return {
        Id: doc.id,
        Title: doc.title,
        Blob: new TextEncoder().encode(doc.content),
        ContentType: 'PLAIN_TEXT' as const,
        Attributes: attributes,
      }
    })

    const result = await this.batchPutDocument({
      IndexId: indexId,
      Documents: docs,
    })

    const failed = result.FailedDocuments?.map(f => ({
      id: f.Id || 'unknown',
      error: f.ErrorMessage || 'Unknown error',
    })) || []

    return {
      succeeded: documents.length - failed.length,
      failed,
    }
  }

  /**
   * Delete documents
  */
  async deleteDocuments(indexId: string, documentIds: string[]): Promise<void> {
    const result = await this.batchDeleteDocument({
      IndexId: indexId,
      DocumentIdList: documentIds,
    })

    if (result.FailedDocuments?.length) {
      throw new Error(`Failed to delete documents: ${result.FailedDocuments.map(f => f.Id).join(', ')}`)
    }
  }

  /**
   * Wait for index to be active
  */
  async waitForIndex(
    indexId: string,
    options?: { maxWaitMs?: number; pollIntervalMs?: number },
  ): Promise<Index> {
    const maxWaitMs = options?.maxWaitMs ?? 3600000 // 1 hour
    const pollIntervalMs = options?.pollIntervalMs ?? 30000
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      const result = await this.describeIndex({ Id: indexId })

      if (result.Status === 'ACTIVE') {
        return result as Index
      }
      if (result.Status === 'FAILED') {
        throw new Error(`Index creation failed: ${result.ErrorMessage}`)
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }

    throw new Error(`Timeout waiting for index ${indexId}`)
  }

  /**
   * Wait for data source to be active
  */
  async waitForDataSource(
    indexId: string,
    dataSourceId: string,
    options?: { maxWaitMs?: number; pollIntervalMs?: number },
  ): Promise<DataSource> {
    const maxWaitMs = options?.maxWaitMs ?? 1800000 // 30 minutes
    const pollIntervalMs = options?.pollIntervalMs ?? 30000
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      const result = await this.describeDataSource({
        Id: dataSourceId,
        IndexId: indexId,
      })

      if (result.Status === 'ACTIVE') {
        return result
      }
      if (result.Status === 'FAILED') {
        throw new Error(`Data source creation failed: ${result.ErrorMessage}`)
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }

    throw new Error(`Timeout waiting for data source ${dataSourceId}`)
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Quick search
*/
export async function search(
  indexId: string,
  query: string,
  options?: { region?: string; pageSize?: number },
): Promise<Array<{ title: string; excerpt: string; uri: string; score: string }>> {
  const client = new KendraClient(options?.region || 'us-east-1')
  const results = await client.search(indexId, query, { pageSize: options?.pageSize })

  return results.map(r => ({
    title: r.DocumentTitle?.Text || '',
    excerpt: r.DocumentExcerpt?.Text || '',
    uri: r.DocumentURI || '',
    score: r.ScoreAttributes?.ScoreConfidence || 'NOT_AVAILABLE',
  }))
}

/**
 * Retrieve for RAG
*/
export async function retrieveForRag(
  indexId: string,
  query: string,
  options?: { region?: string; pageSize?: number },
): Promise<Array<{ content: string; uri: string; score: string }>> {
  const client = new KendraClient(options?.region || 'us-east-1')
  const results = await client.retrieveDocuments(indexId, query, { pageSize: options?.pageSize })

  return results.map(r => ({
    content: r.Content || '',
    uri: r.DocumentURI || '',
    score: r.ScoreAttributes?.ScoreConfidence || 'NOT_AVAILABLE',
  }))
}
