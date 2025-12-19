/**
 * AWS Bedrock Client
 * Direct API calls for Bedrock AI model invocations and management
 * No external SDK dependencies - implements AWS Signature V4 directly
 */

import { AWSClient } from './client'

// ============================================================================
// Bedrock Runtime Types
// ============================================================================

export interface BedrockMessage {
  role: 'user' | 'assistant'
  content: string | BedrockContentBlock[]
}

export type BedrockContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: BedrockImageSource }
  | { type: 'document'; source: BedrockDocumentSource }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | BedrockContentBlock[] }

export interface BedrockImageSource {
  type: 'base64'
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  data: string
}

export interface BedrockDocumentSource {
  type: 'base64'
  media_type: 'application/pdf'
  data: string
}

export interface BedrockToolDefinition {
  name: string
  description?: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface BedrockResponse {
  id: string
  type: string
  role: string
  content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>
  model: string
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
  usage: {
    input_tokens: number
    output_tokens: number
  }
}

export interface InvokeModelCommandInput {
  modelId: string
  body: string | Uint8Array | Record<string, unknown>
  contentType?: string
  accept?: string
  trace?: 'ENABLED' | 'DISABLED'
  guardrailIdentifier?: string
  guardrailVersion?: string
}

export interface InvokeModelCommandOutput {
  body: Uint8Array
  contentType: string
}

export interface InvokeModelWithResponseStreamCommandInput {
  modelId: string
  body: string | Uint8Array | Record<string, unknown>
  contentType?: string
  accept?: string
  trace?: 'ENABLED' | 'DISABLED'
  guardrailIdentifier?: string
  guardrailVersion?: string
}

export interface InvokeModelWithResponseStreamCommandOutput {
  body: AsyncIterable<BedrockStreamChunk>
  contentType: string
}

export interface BedrockStreamChunk {
  chunk?: {
    bytes: Uint8Array
  }
  internalServerException?: {
    message: string
  }
  modelStreamErrorException?: {
    message: string
    originalStatusCode?: number
    originalMessage?: string
  }
  modelTimeoutException?: {
    message: string
  }
  throttlingException?: {
    message: string
  }
  validationException?: {
    message: string
  }
}

export interface ConverseCommandInput {
  modelId: string
  messages: BedrockMessage[]
  system?: Array<{ text: string }>
  inferenceConfig?: {
    maxTokens?: number
    temperature?: number
    topP?: number
    stopSequences?: string[]
  }
  toolConfig?: {
    tools: Array<{ toolSpec: BedrockToolDefinition }>
    toolChoice?: { auto: Record<string, never> } | { any: Record<string, never> } | { tool: { name: string } }
  }
  guardrailConfig?: {
    guardrailIdentifier: string
    guardrailVersion: string
    trace?: 'enabled' | 'disabled'
  }
}

export interface ConverseCommandOutput {
  output: {
    message?: BedrockMessage
  }
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'guardrail_intervened' | 'content_filtered'
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
  metrics?: {
    latencyMs: number
  }
}

// ============================================================================
// Bedrock Management Types
// ============================================================================

export interface CreateModelCustomizationJobCommandInput {
  jobName: string
  customModelName: string
  roleArn: string
  baseModelIdentifier: string
  trainingDataConfig: {
    s3Uri: string
  }
  validationDataConfig?: {
    validators: Array<{
      s3Uri: string
    }>
  }
  outputDataConfig: {
    s3Uri: string
  }
  hyperParameters?: Record<string, string>
  vpcConfig?: {
    subnetIds: string[]
    securityGroupIds: string[]
  }
  customModelKmsKeyId?: string
  customModelTags?: Array<{ key: string; value: string }>
  customizationType?: 'FINE_TUNING' | 'CONTINUED_PRE_TRAINING'
}

export interface CreateModelCustomizationJobCommandOutput {
  jobArn: string
}

export interface GetModelCustomizationJobCommandInput {
  jobIdentifier: string
}

export interface GetModelCustomizationJobCommandOutput {
  jobArn: string
  jobName: string
  outputModelName: string
  outputModelArn?: string
  clientRequestToken?: string
  roleArn: string
  status: 'InProgress' | 'Completed' | 'Failed' | 'Stopping' | 'Stopped'
  failureMessage?: string
  creationTime: string
  lastModifiedTime?: string
  endTime?: string
  baseModelArn: string
  hyperParameters?: Record<string, string>
  trainingDataConfig: {
    s3Uri: string
  }
  validationDataConfig?: {
    validators: Array<{
      s3Uri: string
    }>
  }
  outputDataConfig: {
    s3Uri: string
  }
  customizationType?: 'FINE_TUNING' | 'CONTINUED_PRE_TRAINING'
  outputModelKmsKeyArn?: string
  trainingMetrics?: {
    trainingLoss?: number
  }
  validationMetrics?: Array<{
    validationLoss?: number
  }>
  vpcConfig?: {
    subnetIds: string[]
    securityGroupIds: string[]
  }
}

export interface ListModelCustomizationJobsCommandInput {
  creationTimeAfter?: string
  creationTimeBefore?: string
  statusEquals?: 'InProgress' | 'Completed' | 'Failed' | 'Stopping' | 'Stopped'
  nameContains?: string
  maxResults?: number
  nextToken?: string
  sortBy?: 'CreationTime'
  sortOrder?: 'Ascending' | 'Descending'
}

export interface ListModelCustomizationJobsCommandOutput {
  nextToken?: string
  modelCustomizationJobSummaries?: Array<{
    jobArn: string
    jobName: string
    status: 'InProgress' | 'Completed' | 'Failed' | 'Stopping' | 'Stopped'
    lastModifiedTime?: string
    creationTime: string
    endTime?: string
    baseModelArn: string
    customModelArn?: string
    customModelName?: string
    customizationType?: 'FINE_TUNING' | 'CONTINUED_PRE_TRAINING'
  }>
}

export interface StopModelCustomizationJobCommandInput {
  jobIdentifier: string
}

export interface StopModelCustomizationJobCommandOutput {
  // Empty response
}

export interface ListFoundationModelsCommandInput {
  byProvider?: string
  byCustomizationType?: 'FINE_TUNING' | 'CONTINUED_PRE_TRAINING'
  byOutputModality?: 'TEXT' | 'IMAGE' | 'EMBEDDING'
  byInferenceType?: 'ON_DEMAND' | 'PROVISIONED'
}

export interface ListFoundationModelsCommandOutput {
  modelSummaries?: FoundationModelSummary[]
}

export interface FoundationModelSummary {
  modelArn: string
  modelId: string
  modelName: string
  providerName: string
  inputModalities: string[]
  outputModalities: string[]
  responseStreamingSupported: boolean
  customizationsSupported?: string[]
  inferenceTypesSupported?: string[]
  modelLifecycle?: {
    status: 'ACTIVE' | 'LEGACY'
  }
}

export interface GetFoundationModelCommandInput {
  modelIdentifier: string
}

export interface GetFoundationModelCommandOutput {
  modelDetails: {
    modelArn: string
    modelId: string
    modelName: string
    providerName: string
    inputModalities: string[]
    outputModalities: string[]
    responseStreamingSupported?: boolean
    customizationsSupported?: string[]
    inferenceTypesSupported?: string[]
    modelLifecycle?: {
      status: 'ACTIVE' | 'LEGACY'
    }
  }
}

export interface ListCustomModelsCommandInput {
  creationTimeBefore?: string
  creationTimeAfter?: string
  nameContains?: string
  baseModelArnEquals?: string
  foundationModelArnEquals?: string
  maxResults?: number
  nextToken?: string
  sortBy?: 'CreationTime'
  sortOrder?: 'Ascending' | 'Descending'
}

export interface ListCustomModelsCommandOutput {
  nextToken?: string
  modelSummaries?: Array<{
    modelArn: string
    modelName: string
    creationTime: string
    baseModelArn: string
    baseModelName: string
    customizationType?: 'FINE_TUNING' | 'CONTINUED_PRE_TRAINING'
  }>
}

export interface DeleteCustomModelCommandInput {
  modelIdentifier: string
}

export interface DeleteCustomModelCommandOutput {
  // Empty response
}

export interface GetCustomModelCommandInput {
  modelIdentifier: string
}

export interface GetCustomModelCommandOutput {
  modelArn: string
  modelName: string
  jobName?: string
  jobArn?: string
  baseModelArn: string
  customizationType?: 'FINE_TUNING' | 'CONTINUED_PRE_TRAINING'
  modelKmsKeyArn?: string
  hyperParameters?: Record<string, string>
  trainingDataConfig?: {
    s3Uri: string
  }
  validationDataConfig?: {
    validators: Array<{
      s3Uri: string
    }>
  }
  outputDataConfig?: {
    s3Uri: string
  }
  trainingMetrics?: {
    trainingLoss?: number
  }
  validationMetrics?: Array<{
    validationLoss?: number
  }>
  creationTime: string
}

// Model entitlement / access request types
export interface CreateFoundationModelEntitlementCommandInput {
  modelId: string
}

export interface CreateFoundationModelEntitlementCommandOutput {
  status: 'PENDING' | 'APPROVED' | 'DENIED'
  modelId: string
}

export interface ListModelInvocationJobsCommandInput {
  submitTimeAfter?: string
  submitTimeBefore?: string
  statusEquals?: 'Submitted' | 'InProgress' | 'Completed' | 'Failed' | 'Stopping' | 'Stopped' | 'PartiallyCompleted' | 'Expired' | 'Validating' | 'Scheduled'
  nameContains?: string
  maxResults?: number
  nextToken?: string
  sortBy?: 'CreationTime'
  sortOrder?: 'Ascending' | 'Descending'
}

export interface ListModelInvocationJobsCommandOutput {
  nextToken?: string
  invocationJobSummaries?: Array<{
    jobArn: string
    jobName: string
    modelId: string
    clientRequestToken?: string
    roleArn: string
    status: string
    message?: string
    submitTime: string
    lastModifiedTime?: string
    endTime?: string
    inputDataConfig: {
      s3InputDataConfig: {
        s3Uri: string
        s3InputFormat?: string
      }
    }
    outputDataConfig: {
      s3OutputDataConfig: {
        s3Uri: string
        s3EncryptionKeyId?: string
      }
    }
    timeoutDurationInHours?: number
    jobExpirationTime?: string
  }>
}

// Guardrails types
export interface CreateGuardrailCommandInput {
  name: string
  description?: string
  topicPolicyConfig?: {
    topicsConfig: Array<{
      name: string
      definition: string
      examples?: string[]
      type: 'DENY'
    }>
  }
  contentPolicyConfig?: {
    filtersConfig: Array<{
      type: 'SEXUAL' | 'VIOLENCE' | 'HATE' | 'INSULTS' | 'MISCONDUCT' | 'PROMPT_ATTACK'
      inputStrength: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH'
      outputStrength: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH'
    }>
  }
  wordPolicyConfig?: {
    wordsConfig?: Array<{
      text: string
    }>
    managedWordListsConfig?: Array<{
      type: 'PROFANITY'
    }>
  }
  sensitiveInformationPolicyConfig?: {
    piiEntitiesConfig?: Array<{
      type: string
      action: 'BLOCK' | 'ANONYMIZE'
    }>
    regexesConfig?: Array<{
      name: string
      description?: string
      pattern: string
      action: 'BLOCK' | 'ANONYMIZE'
    }>
  }
  contextualGroundingPolicyConfig?: {
    filtersConfig: Array<{
      type: 'GROUNDING' | 'RELEVANCE'
      threshold: number
    }>
  }
  blockedInputMessaging: string
  blockedOutputsMessaging: string
  kmsKeyId?: string
  tags?: Array<{ key: string; value: string }>
  clientRequestToken?: string
}

export interface CreateGuardrailCommandOutput {
  guardrailId: string
  guardrailArn: string
  version: string
  createdAt: string
}

export interface GetGuardrailCommandInput {
  guardrailIdentifier: string
  guardrailVersion?: string
}

export interface GetGuardrailCommandOutput {
  name: string
  description?: string
  guardrailId: string
  guardrailArn: string
  version: string
  status: 'CREATING' | 'UPDATING' | 'VERSIONING' | 'READY' | 'FAILED' | 'DELETING'
  topicPolicy?: {
    topics: Array<{
      name: string
      definition: string
      examples?: string[]
      type: 'DENY'
    }>
  }
  contentPolicy?: {
    filters: Array<{
      type: string
      inputStrength: string
      outputStrength: string
    }>
  }
  wordPolicy?: {
    words?: Array<{
      text: string
    }>
    managedWordLists?: Array<{
      type: string
    }>
  }
  sensitiveInformationPolicy?: {
    piiEntities?: Array<{
      type: string
      action: string
    }>
    regexes?: Array<{
      name: string
      description?: string
      pattern: string
      action: string
    }>
  }
  contextualGroundingPolicy?: {
    filters: Array<{
      type: string
      threshold: number
    }>
  }
  createdAt: string
  updatedAt: string
  statusReasons?: string[]
  failureRecommendations?: string[]
  blockedInputMessaging: string
  blockedOutputsMessaging: string
  kmsKeyArn?: string
}

export interface ListGuardrailsCommandInput {
  guardrailIdentifier?: string
  maxResults?: number
  nextToken?: string
}

export interface ListGuardrailsCommandOutput {
  guardrails: Array<{
    id: string
    arn: string
    status: string
    name: string
    description?: string
    version: string
    createdAt: string
    updatedAt: string
  }>
  nextToken?: string
}

export interface DeleteGuardrailCommandInput {
  guardrailIdentifier: string
  guardrailVersion?: string
}

export interface DeleteGuardrailCommandOutput {
  // Empty response
}

// Knowledge Base types
export interface CreateKnowledgeBaseCommandInput {
  clientToken?: string
  name: string
  description?: string
  roleArn: string
  knowledgeBaseConfiguration: {
    type: 'VECTOR'
    vectorKnowledgeBaseConfiguration?: {
      embeddingModelArn: string
      embeddingModelConfiguration?: {
        bedrockEmbeddingModelConfiguration?: {
          dimensions?: number
        }
      }
    }
  }
  storageConfiguration: {
    type: 'OPENSEARCH_SERVERLESS' | 'PINECONE' | 'REDIS_ENTERPRISE_CLOUD' | 'RDS' | 'MONGO_DB_ATLAS'
    opensearchServerlessConfiguration?: {
      collectionArn: string
      vectorIndexName: string
      fieldMapping: {
        vectorField: string
        textField: string
        metadataField: string
      }
    }
    pineconeConfiguration?: {
      connectionString: string
      credentialsSecretArn: string
      namespace?: string
      fieldMapping: {
        textField: string
        metadataField: string
      }
    }
    redisEnterpriseCloudConfiguration?: {
      endpoint: string
      vectorIndexName: string
      credentialsSecretArn: string
      fieldMapping: {
        vectorField: string
        textField: string
        metadataField: string
      }
    }
    rdsConfiguration?: {
      resourceArn: string
      credentialsSecretArn: string
      databaseName: string
      tableName: string
      fieldMapping: {
        primaryKeyField: string
        vectorField: string
        textField: string
        metadataField: string
      }
    }
    mongoDbAtlasConfiguration?: {
      endpoint: string
      databaseName: string
      collectionName: string
      vectorIndexName: string
      credentialsSecretArn: string
      fieldMapping: {
        vectorField: string
        textField: string
        metadataField: string
      }
    }
  }
  tags?: Record<string, string>
}

export interface CreateKnowledgeBaseCommandOutput {
  knowledgeBase: {
    knowledgeBaseId: string
    name: string
    knowledgeBaseArn: string
    description?: string
    roleArn: string
    knowledgeBaseConfiguration: {
      type: string
      vectorKnowledgeBaseConfiguration?: {
        embeddingModelArn: string
      }
    }
    storageConfiguration: {
      type: string
    }
    status: 'CREATING' | 'ACTIVE' | 'DELETING' | 'UPDATING' | 'FAILED' | 'DELETE_UNSUCCESSFUL'
    createdAt: string
    updatedAt: string
    failureReasons?: string[]
  }
}

// Agent types
export interface CreateAgentCommandInput {
  agentName: string
  clientToken?: string
  instruction?: string
  foundationModel?: string
  description?: string
  idleSessionTTLInSeconds?: number
  agentResourceRoleArn: string
  customerEncryptionKeyArn?: string
  tags?: Record<string, string>
  promptOverrideConfiguration?: {
    promptConfigurations: Array<{
      promptType: 'PRE_PROCESSING' | 'ORCHESTRATION' | 'POST_PROCESSING' | 'KNOWLEDGE_BASE_RESPONSE_GENERATION'
      promptCreationMode: 'DEFAULT' | 'OVERRIDDEN'
      promptState?: 'ENABLED' | 'DISABLED'
      basePromptTemplate?: string
      inferenceConfiguration?: {
        temperature?: number
        topP?: number
        topK?: number
        maximumLength?: number
        stopSequences?: string[]
      }
      parserMode?: 'DEFAULT' | 'OVERRIDDEN'
    }>
    overrideLambda?: string
  }
  guardrailConfiguration?: {
    guardrailIdentifier?: string
    guardrailVersion?: string
  }
}

export interface CreateAgentCommandOutput {
  agent: {
    agentId: string
    agentName: string
    agentArn: string
    agentVersion: string
    clientToken?: string
    instruction?: string
    agentStatus: 'CREATING' | 'PREPARING' | 'PREPARED' | 'NOT_PREPARED' | 'DELETING' | 'FAILED' | 'VERSIONING' | 'UPDATING'
    foundationModel?: string
    description?: string
    idleSessionTTLInSeconds: number
    agentResourceRoleArn: string
    customerEncryptionKeyArn?: string
    createdAt: string
    updatedAt: string
    preparedAt?: string
    failureReasons?: string[]
    recommendedActions?: string[]
    promptOverrideConfiguration?: {
      promptConfigurations: Array<{
        promptType: string
        promptCreationMode: string
        promptState?: string
        basePromptTemplate?: string
        inferenceConfiguration?: {
          temperature?: number
          topP?: number
          topK?: number
          maximumLength?: number
          stopSequences?: string[]
        }
        parserMode?: string
      }>
      overrideLambda?: string
    }
    guardrailConfiguration?: {
      guardrailIdentifier?: string
      guardrailVersion?: string
    }
  }
}

export interface InvokeAgentCommandInput {
  agentId: string
  agentAliasId: string
  sessionId: string
  endSession?: boolean
  enableTrace?: boolean
  inputText?: string
  memoryId?: string
  sessionState?: {
    sessionAttributes?: Record<string, string>
    promptSessionAttributes?: Record<string, string>
    returnControlInvocationResults?: Array<{
      functionResult?: {
        actionGroup: string
        function: string
        responseBody?: Record<string, { body: string }>
      }
    }>
    invocationId?: string
    files?: Array<{
      name: string
      source: {
        sourceType: 'S3' | 'BYTE_CONTENT'
        s3Location?: {
          uri: string
        }
        byteContent?: {
          mediaType: string
          data: Uint8Array
        }
      }
      useCase: 'CODE_INTERPRETER' | 'CHAT'
    }>
    knowledgeBaseConfigurations?: Array<{
      knowledgeBaseId: string
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults?: number
          overrideSearchType?: 'HYBRID' | 'SEMANTIC'
          filter?: Record<string, unknown>
        }
      }
    }>
  }
}

export interface InvokeAgentCommandOutput {
  completion: AsyncIterable<{
    chunk?: {
      bytes: Uint8Array
      attribution?: {
        citations: Array<{
          generatedResponsePart?: {
            textResponsePart?: {
              text: string
              span?: {
                start: number
                end: number
              }
            }
          }
          retrievedReferences?: Array<{
            content?: {
              text: string
            }
            location?: {
              type: string
              s3Location?: {
                uri: string
              }
            }
            metadata?: Record<string, unknown>
          }>
        }>
      }
    }
    trace?: {
      agentId?: string
      agentAliasId?: string
      sessionId?: string
      agentVersion?: string
      trace?: Record<string, unknown>
    }
    returnControl?: {
      invocationId: string
      invocationInputs: Array<{
        functionInvocationInput?: {
          actionGroup: string
          function: string
          parameters: Array<{
            name: string
            type: string
            value: string
          }>
        }
      }>
    }
    files?: {
      files: Array<{
        name: string
        type: string
        bytes: Uint8Array
      }>
    }
  }>
  contentType: string
  sessionId: string
  memoryId?: string
}

// ============================================================================
// Bedrock Runtime Client
// ============================================================================

/**
 * Bedrock Runtime client for AI model invocations
 */
export class BedrockRuntimeClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Invoke a Bedrock model (matches AWS SDK InvokeModelCommand)
   */
  async invokeModel(params: InvokeModelCommandInput): Promise<InvokeModelCommandOutput> {
    const body = typeof params.body === 'string'
      ? params.body
      : params.body instanceof Uint8Array
        ? new TextDecoder().decode(params.body)
        : JSON.stringify(params.body)

    const headers: Record<string, string> = {
      'Content-Type': params.contentType || 'application/json',
      'Accept': params.accept || 'application/json',
    }

    if (params.trace) {
      headers['X-Amzn-Bedrock-Trace'] = params.trace
    }
    if (params.guardrailIdentifier) {
      headers['X-Amzn-Bedrock-GuardrailIdentifier'] = params.guardrailIdentifier
    }
    if (params.guardrailVersion) {
      headers['X-Amzn-Bedrock-GuardrailVersion'] = params.guardrailVersion
    }

    const result = await this.client.request({
      service: 'bedrock-runtime',
      region: this.region,
      method: 'POST',
      path: `/model/${encodeURIComponent(params.modelId)}/invoke`,
      headers,
      body,
      rawResponse: true,
      returnHeaders: true,
    })

    return {
      body: new TextEncoder().encode(result.body),
      contentType: result.headers?.['content-type'] || 'application/json',
    }
  }

  /**
   * Invoke model with streaming response (matches AWS SDK InvokeModelWithResponseStreamCommand)
   */
  async invokeModelWithResponseStream(params: InvokeModelWithResponseStreamCommandInput): Promise<InvokeModelWithResponseStreamCommandOutput> {
    const body = typeof params.body === 'string'
      ? params.body
      : params.body instanceof Uint8Array
        ? new TextDecoder().decode(params.body)
        : JSON.stringify(params.body)

    const headers: Record<string, string> = {
      'Content-Type': params.contentType || 'application/json',
      'Accept': params.accept || 'application/vnd.amazon.eventstream',
    }

    if (params.trace) {
      headers['X-Amzn-Bedrock-Trace'] = params.trace
    }
    if (params.guardrailIdentifier) {
      headers['X-Amzn-Bedrock-GuardrailIdentifier'] = params.guardrailIdentifier
    }
    if (params.guardrailVersion) {
      headers['X-Amzn-Bedrock-GuardrailVersion'] = params.guardrailVersion
    }

    // For streaming, we need to make a raw fetch request and handle the event stream
    const stream = await this.makeStreamRequest(params.modelId, headers, body)

    return {
      body: stream,
      contentType: 'application/vnd.amazon.eventstream',
    }
  }

  /**
   * Internal method to make streaming request
   */
  private async makeStreamRequest(
    modelId: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<AsyncIterable<BedrockStreamChunk>> {
    // Get credentials and sign request manually for streaming
    const credentials = this.getCredentialsFromEnv()
    const url = `https://bedrock-runtime.${this.region}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke-with-response-stream`

    const signedHeaders = this.signStreamRequest(
      'POST',
      `/model/${encodeURIComponent(modelId)}/invoke-with-response-stream`,
      headers,
      body,
      credentials,
    )

    const response = await fetch(url, {
      method: 'POST',
      headers: signedHeaders,
      body,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Bedrock streaming error (${response.status}): ${errorText}`)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('No response body for streaming')
    }

    return this.parseEventStream(reader)
  }

  /**
   * Parse AWS event stream format
   */
  private async *parseEventStream(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncIterable<BedrockStreamChunk> {
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Parse event stream messages
        // AWS event stream format has binary headers followed by payload
        // For simplicity, we'll look for JSON chunks in the stream
        const chunks = this.extractJsonChunks(buffer)
        for (const chunk of chunks.parsed) {
          yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(chunk)) } }
        }
        buffer = chunks.remaining
      }
    } finally {
      reader.releaseLock()
    }
  }

  /**
   * Extract JSON chunks from event stream buffer
   */
  private extractJsonChunks(buffer: string): { parsed: unknown[]; remaining: string } {
    const parsed: unknown[] = []
    let remaining = buffer

    // Look for complete JSON objects
    // This is a simplified parser - the actual AWS event stream format is more complex
    let braceCount = 0
    let start = -1

    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i] === '{') {
        if (braceCount === 0) start = i
        braceCount++
      } else if (remaining[i] === '}') {
        braceCount--
        if (braceCount === 0 && start !== -1) {
          try {
            const json = JSON.parse(remaining.slice(start, i + 1))
            parsed.push(json)
            remaining = remaining.slice(i + 1)
            i = -1 // Reset to search from beginning of new remaining
            start = -1
          } catch {
            // Not valid JSON, continue
          }
        }
      }
    }

    return { parsed, remaining }
  }

  /**
   * Get credentials from environment
   */
  private getCredentialsFromEnv(): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
    const sessionToken = process.env.AWS_SESSION_TOKEN

    if (!accessKeyId || !secretAccessKey) {
      throw new Error('AWS credentials not found in environment variables')
    }

    return { accessKeyId, secretAccessKey, sessionToken }
  }

  /**
   * Sign request for streaming (simplified SigV4)
   */
  private signStreamRequest(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string,
    credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
  ): Record<string, string> {
    const crypto = require('node:crypto')
    const service = 'bedrock-runtime'
    const region = this.region
    const host = `${service}.${region}.amazonaws.com`

    const now = new Date()
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
    const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '')

    const allHeaders: Record<string, string> = {
      'host': host,
      'x-amz-date': amzDate,
      ...headers,
    }

    if (credentials.sessionToken) {
      allHeaders['x-amz-security-token'] = credentials.sessionToken
    }

    const payloadHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex')
    allHeaders['x-amz-content-sha256'] = payloadHash
    allHeaders['content-length'] = Buffer.byteLength(body).toString()

    const sortedHeaderKeys = Object.keys(allHeaders).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    )

    const canonicalHeaders = sortedHeaderKeys
      .map(key => `${key.toLowerCase()}:${allHeaders[key].trim()}\n`)
      .join('')

    const signedHeaders = sortedHeaderKeys
      .map(key => key.toLowerCase())
      .join(';')

    const canonicalRequest = [
      method,
      path,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n')

    const algorithm = 'AWS4-HMAC-SHA256'
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
    const stringToSign = [
      algorithm,
      amzDate,
      credentialScope,
      crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n')

    const kDate = crypto.createHmac('sha256', `AWS4${credentials.secretAccessKey}`).update(dateStamp).digest()
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest()
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest()
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest()
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex')

    const authorizationHeader = `${algorithm} Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

    return {
      ...allHeaders,
      'Authorization': authorizationHeader,
    }
  }

  /**
   * Invoke Claude model with messages API (convenience method)
   */
  async invokeClaudeMessages(params: {
    modelId?: string
    messages: BedrockMessage[]
    maxTokens?: number
    temperature?: number
    topP?: number
    topK?: number
    stopSequences?: string[]
    system?: string
    tools?: BedrockToolDefinition[]
    toolChoice?: { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string }
  }): Promise<BedrockResponse> {
    const modelId = params.modelId || 'anthropic.claude-3-haiku-20240307-v1:0'

    const requestBody: Record<string, unknown> = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: params.maxTokens || 1024,
      messages: params.messages,
    }

    if (params.temperature !== undefined) requestBody.temperature = params.temperature
    if (params.topP !== undefined) requestBody.top_p = params.topP
    if (params.topK !== undefined) requestBody.top_k = params.topK
    if (params.stopSequences) requestBody.stop_sequences = params.stopSequences
    if (params.system) requestBody.system = params.system
    if (params.tools) requestBody.tools = params.tools
    if (params.toolChoice) requestBody.tool_choice = params.toolChoice

    const result = await this.client.request({
      service: 'bedrock-runtime',
      region: this.region,
      method: 'POST',
      path: `/model/${encodeURIComponent(modelId)}/invoke`,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(requestBody),
    })

    return result
  }

  /**
   * Converse API - unified conversation interface for all models
   */
  async converse(params: ConverseCommandInput): Promise<ConverseCommandOutput> {
    const requestBody: Record<string, unknown> = {
      modelId: params.modelId,
      messages: params.messages,
    }

    if (params.system) requestBody.system = params.system
    if (params.inferenceConfig) requestBody.inferenceConfig = params.inferenceConfig
    if (params.toolConfig) requestBody.toolConfig = params.toolConfig
    if (params.guardrailConfig) requestBody.guardrailConfig = params.guardrailConfig

    const result = await this.client.request({
      service: 'bedrock-runtime',
      region: this.region,
      method: 'POST',
      path: `/model/${encodeURIComponent(params.modelId)}/converse`,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(requestBody),
    })

    return result
  }

  /**
   * Generate embeddings using a Bedrock model
   */
  async generateEmbeddings(params: {
    modelId?: string
    inputText: string | string[]
    dimensions?: number
    normalize?: boolean
  }): Promise<{ embedding?: number[]; embeddings?: number[][] }> {
    const modelId = params.modelId || 'amazon.titan-embed-text-v1'

    let requestBody: Record<string, unknown>

    // Different models have different input formats
    if (modelId.includes('cohere')) {
      requestBody = {
        texts: Array.isArray(params.inputText) ? params.inputText : [params.inputText],
        input_type: 'search_document',
      }
    } else if (modelId.includes('titan')) {
      requestBody = {
        inputText: Array.isArray(params.inputText) ? params.inputText[0] : params.inputText,
      }
      if (params.dimensions) requestBody.dimensions = params.dimensions
      if (params.normalize !== undefined) requestBody.normalize = params.normalize
    } else {
      // Default format
      requestBody = {
        inputText: Array.isArray(params.inputText) ? params.inputText[0] : params.inputText,
      }
    }

    const result = await this.client.request({
      service: 'bedrock-runtime',
      region: this.region,
      method: 'POST',
      path: `/model/${encodeURIComponent(modelId)}/invoke`,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(requestBody),
    })

    return result
  }

  /**
   * Apply guardrail to content
   */
  async applyGuardrail(params: {
    guardrailIdentifier: string
    guardrailVersion: string
    source: 'INPUT' | 'OUTPUT'
    content: Array<{ text: { text: string } }>
  }): Promise<{
    action: 'NONE' | 'GUARDRAIL_INTERVENED'
    outputs: Array<{ text: string }>
    assessments: Array<{
      topicPolicy?: { topics: Array<{ name: string; type: string; action: string }> }
      contentPolicy?: { filters: Array<{ type: string; confidence: string; action: string }> }
      wordPolicy?: { customWords: Array<{ match: string; action: string }>; managedWordLists: Array<{ match: string; type: string; action: string }> }
      sensitiveInformationPolicy?: { piiEntities: Array<{ type: string; match: string; action: string }>; regexes: Array<{ name: string; match: string; action: string }> }
    }>
  }> {
    const result = await this.client.request({
      service: 'bedrock-runtime',
      region: this.region,
      method: 'POST',
      path: `/guardrail/${encodeURIComponent(params.guardrailIdentifier)}/version/${encodeURIComponent(params.guardrailVersion)}/apply`,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        source: params.source,
        content: params.content,
      }),
    })

    return result
  }
}

// ============================================================================
// Bedrock Client (Management API)
// ============================================================================

/**
 * Bedrock client for model management (not runtime)
 */
export class BedrockClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  // -------------------------------------------------------------------------
  // Foundation Models
  // -------------------------------------------------------------------------

  /**
   * List available foundation models
   */
  async listFoundationModels(params?: ListFoundationModelsCommandInput): Promise<ListFoundationModelsCommandOutput> {
    const queryParams: Record<string, string> = {}
    if (params?.byProvider) queryParams.byProvider = params.byProvider
    if (params?.byCustomizationType) queryParams.byCustomizationType = params.byCustomizationType
    if (params?.byOutputModality) queryParams.byOutputModality = params.byOutputModality
    if (params?.byInferenceType) queryParams.byInferenceType = params.byInferenceType

    return this.client.request({
      service: 'bedrock',
      region: this.region,
      method: 'GET',
      path: '/foundation-models',
      queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    })
  }

  /**
   * Get details about a foundation model
   */
  async getFoundationModel(params: GetFoundationModelCommandInput): Promise<GetFoundationModelCommandOutput> {
    return this.client.request({
      service: 'bedrock',
      region: this.region,
      method: 'GET',
      path: `/foundation-models/${encodeURIComponent(params.modelIdentifier)}`,
    })
  }

  // -------------------------------------------------------------------------
  // Model Customization Jobs
  // -------------------------------------------------------------------------

  /**
   * Create a model customization job (fine-tuning)
   */
  async createModelCustomizationJob(params: CreateModelCustomizationJobCommandInput): Promise<CreateModelCustomizationJobCommandOutput> {
    return this.client.request({
      service: 'bedrock',
      region: this.region,
      method: 'POST',
      path: '/model-customization-jobs',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * Get model customization job details
   */
  async getModelCustomizationJob(params: GetModelCustomizationJobCommandInput): Promise<GetModelCustomizationJobCommandOutput> {
    return this.client.request({
      service: 'bedrock',
      region: this.region,
      method: 'GET',
      path: `/model-customization-jobs/${encodeURIComponent(params.jobIdentifier)}`,
    })
  }

  /**
   * List model customization jobs
   */
  async listModelCustomizationJobs(params?: ListModelCustomizationJobsCommandInput): Promise<ListModelCustomizationJobsCommandOutput> {
    const queryParams: Record<string, string> = {}
    if (params?.creationTimeAfter) queryParams.creationTimeAfter = params.creationTimeAfter
    if (params?.creationTimeBefore) queryParams.creationTimeBefore = params.creationTimeBefore
    if (params?.statusEquals) queryParams.statusEquals = params.statusEquals
    if (params?.nameContains) queryParams.nameContains = params.nameContains
    if (params?.maxResults) queryParams.maxResults = params.maxResults.toString()
    if (params?.nextToken) queryParams.nextToken = params.nextToken
    if (params?.sortBy) queryParams.sortBy = params.sortBy
    if (params?.sortOrder) queryParams.sortOrder = params.sortOrder

    return this.client.request({
      service: 'bedrock',
      region: this.region,
      method: 'GET',
      path: '/model-customization-jobs',
      queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    })
  }

  /**
   * Stop a model customization job
   */
  async stopModelCustomizationJob(params: StopModelCustomizationJobCommandInput): Promise<StopModelCustomizationJobCommandOutput> {
    return this.client.request({
      service: 'bedrock',
      region: this.region,
      method: 'POST',
      path: `/model-customization-jobs/${encodeURIComponent(params.jobIdentifier)}/stop`,
      headers: {
        'Content-Type': 'application/json',
      },
    })
  }

  // -------------------------------------------------------------------------
  // Custom Models
  // -------------------------------------------------------------------------

  /**
   * List custom models
   */
  async listCustomModels(params?: ListCustomModelsCommandInput): Promise<ListCustomModelsCommandOutput> {
    const queryParams: Record<string, string> = {}
    if (params?.creationTimeBefore) queryParams.creationTimeBefore = params.creationTimeBefore
    if (params?.creationTimeAfter) queryParams.creationTimeAfter = params.creationTimeAfter
    if (params?.nameContains) queryParams.nameContains = params.nameContains
    if (params?.baseModelArnEquals) queryParams.baseModelArnEquals = params.baseModelArnEquals
    if (params?.foundationModelArnEquals) queryParams.foundationModelArnEquals = params.foundationModelArnEquals
    if (params?.maxResults) queryParams.maxResults = params.maxResults.toString()
    if (params?.nextToken) queryParams.nextToken = params.nextToken
    if (params?.sortBy) queryParams.sortBy = params.sortBy
    if (params?.sortOrder) queryParams.sortOrder = params.sortOrder

    return this.client.request({
      service: 'bedrock',
      region: this.region,
      method: 'GET',
      path: '/custom-models',
      queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    })
  }

  /**
   * Get custom model details
   */
  async getCustomModel(params: GetCustomModelCommandInput): Promise<GetCustomModelCommandOutput> {
    return this.client.request({
      service: 'bedrock',
      region: this.region,
      method: 'GET',
      path: `/custom-models/${encodeURIComponent(params.modelIdentifier)}`,
    })
  }

  /**
   * Delete a custom model
   */
  async deleteCustomModel(params: DeleteCustomModelCommandInput): Promise<DeleteCustomModelCommandOutput> {
    return this.client.request({
      service: 'bedrock',
      region: this.region,
      method: 'DELETE',
      path: `/custom-models/${encodeURIComponent(params.modelIdentifier)}`,
    })
  }

  // -------------------------------------------------------------------------
  // Model Access / Entitlements
  // -------------------------------------------------------------------------

  /**
   * Request access to a foundation model
   */
  async requestModelAccess(params: CreateFoundationModelEntitlementCommandInput): Promise<CreateFoundationModelEntitlementCommandOutput> {
    return this.client.request({
      service: 'bedrock',
      region: this.region,
      method: 'POST',
      path: '/foundation-model-entitlement',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ modelId: params.modelId }),
    })
  }

  // -------------------------------------------------------------------------
  // Guardrails
  // -------------------------------------------------------------------------

  /**
   * Create a guardrail
   */
  async createGuardrail(params: CreateGuardrailCommandInput): Promise<CreateGuardrailCommandOutput> {
    return this.client.request({
      service: 'bedrock',
      region: this.region,
      method: 'POST',
      path: '/guardrails',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * Get guardrail details
   */
  async getGuardrail(params: GetGuardrailCommandInput): Promise<GetGuardrailCommandOutput> {
    let path = `/guardrails/${encodeURIComponent(params.guardrailIdentifier)}`
    if (params.guardrailVersion) {
      path += `?guardrailVersion=${encodeURIComponent(params.guardrailVersion)}`
    }

    return this.client.request({
      service: 'bedrock',
      region: this.region,
      method: 'GET',
      path,
    })
  }

  /**
   * List guardrails
   */
  async listGuardrails(params?: ListGuardrailsCommandInput): Promise<ListGuardrailsCommandOutput> {
    const queryParams: Record<string, string> = {}
    if (params?.guardrailIdentifier) queryParams.guardrailIdentifier = params.guardrailIdentifier
    if (params?.maxResults) queryParams.maxResults = params.maxResults.toString()
    if (params?.nextToken) queryParams.nextToken = params.nextToken

    return this.client.request({
      service: 'bedrock',
      region: this.region,
      method: 'GET',
      path: '/guardrails',
      queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    })
  }

  /**
   * Delete a guardrail
   */
  async deleteGuardrail(params: DeleteGuardrailCommandInput): Promise<DeleteGuardrailCommandOutput> {
    let path = `/guardrails/${encodeURIComponent(params.guardrailIdentifier)}`
    if (params.guardrailVersion) {
      path += `?guardrailVersion=${encodeURIComponent(params.guardrailVersion)}`
    }

    return this.client.request({
      service: 'bedrock',
      region: this.region,
      method: 'DELETE',
      path,
    })
  }

  // -------------------------------------------------------------------------
  // Batch Inference Jobs
  // -------------------------------------------------------------------------

  /**
   * List model invocation jobs (batch inference)
   */
  async listModelInvocationJobs(params?: ListModelInvocationJobsCommandInput): Promise<ListModelInvocationJobsCommandOutput> {
    const queryParams: Record<string, string> = {}
    if (params?.submitTimeAfter) queryParams.submitTimeAfter = params.submitTimeAfter
    if (params?.submitTimeBefore) queryParams.submitTimeBefore = params.submitTimeBefore
    if (params?.statusEquals) queryParams.statusEquals = params.statusEquals
    if (params?.nameContains) queryParams.nameContains = params.nameContains
    if (params?.maxResults) queryParams.maxResults = params.maxResults.toString()
    if (params?.nextToken) queryParams.nextToken = params.nextToken
    if (params?.sortBy) queryParams.sortBy = params.sortBy
    if (params?.sortOrder) queryParams.sortOrder = params.sortOrder

    return this.client.request({
      service: 'bedrock',
      region: this.region,
      method: 'GET',
      path: '/model-invocation-jobs',
      queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    })
  }

  // -------------------------------------------------------------------------
  // Convenience Methods
  // -------------------------------------------------------------------------

  /**
   * Wait for a model customization job to complete
   */
  async waitForModelCustomizationJob(
    jobIdentifier: string,
    options?: { maxWaitMs?: number; pollIntervalMs?: number },
  ): Promise<GetModelCustomizationJobCommandOutput> {
    const maxWaitMs = options?.maxWaitMs ?? 3600000 // 1 hour default
    const pollIntervalMs = options?.pollIntervalMs ?? 30000 // 30 seconds default
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      const job = await this.getModelCustomizationJob({ jobIdentifier })

      if (job.status === 'Completed' || job.status === 'Failed' || job.status === 'Stopped') {
        return job
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }

    throw new Error(`Timeout waiting for model customization job ${jobIdentifier}`)
  }

  /**
   * Request access to multiple models
   */
  async requestAccessToModels(modelIds: string[]): Promise<Array<{ modelId: string; status: string; error?: string }>> {
    const results: Array<{ modelId: string; status: string; error?: string }> = []

    for (const modelId of modelIds) {
      try {
        const result = await this.requestModelAccess({ modelId })
        results.push({ modelId, status: result.status })
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        results.push({ modelId, status: 'ERROR', error: errorMessage })
      }
    }

    return results
  }

  /**
   * List all foundation models from a specific provider
   */
  async listModelsByProvider(provider: string): Promise<FoundationModelSummary[]> {
    const result = await this.listFoundationModels({ byProvider: provider })
    return result.modelSummaries || []
  }

  /**
   * List all Claude models
   */
  async listClaudeModels(): Promise<FoundationModelSummary[]> {
    return this.listModelsByProvider('Anthropic')
  }

  /**
   * List all embedding models
   */
  async listEmbeddingModels(): Promise<FoundationModelSummary[]> {
    const result = await this.listFoundationModels({ byOutputModality: 'EMBEDDING' })
    return result.modelSummaries || []
  }
}

// ============================================================================
// Bedrock Agent Runtime Client
// ============================================================================

/**
 * Bedrock Agent Runtime client for invoking agents
 */
export class BedrockAgentRuntimeClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Invoke a Bedrock agent
   */
  async invokeAgent(params: InvokeAgentCommandInput): Promise<{
    completion: string
    sessionId: string
    memoryId?: string
    citations?: Array<{
      generatedResponsePart?: { textResponsePart?: { text: string } }
      retrievedReferences?: Array<{ content?: { text: string }; location?: { s3Location?: { uri: string } } }>
    }>
  }> {
    const requestBody: Record<string, unknown> = {
      inputText: params.inputText,
    }

    if (params.endSession !== undefined) requestBody.endSession = params.endSession
    if (params.enableTrace !== undefined) requestBody.enableTrace = params.enableTrace
    if (params.memoryId) requestBody.memoryId = params.memoryId
    if (params.sessionState) requestBody.sessionState = params.sessionState

    const result = await this.client.request({
      service: 'bedrock-agent-runtime',
      region: this.region,
      method: 'POST',
      path: `/agents/${encodeURIComponent(params.agentId)}/agentAliases/${encodeURIComponent(params.agentAliasId)}/sessions/${encodeURIComponent(params.sessionId)}/text`,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(requestBody),
    })

    return result
  }

  /**
   * Retrieve from a knowledge base
   */
  async retrieve(params: {
    knowledgeBaseId: string
    retrievalQuery: {
      text: string
    }
    retrievalConfiguration?: {
      vectorSearchConfiguration: {
        numberOfResults?: number
        overrideSearchType?: 'HYBRID' | 'SEMANTIC'
        filter?: Record<string, unknown>
      }
    }
    nextToken?: string
  }): Promise<{
    retrievalResults: Array<{
      content: { text: string }
      location?: {
        type: string
        s3Location?: { uri: string }
      }
      score?: number
      metadata?: Record<string, unknown>
    }>
    nextToken?: string
  }> {
    return this.client.request({
      service: 'bedrock-agent-runtime',
      region: this.region,
      method: 'POST',
      path: `/knowledgebases/${encodeURIComponent(params.knowledgeBaseId)}/retrieve`,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        retrievalQuery: params.retrievalQuery,
        retrievalConfiguration: params.retrievalConfiguration,
        nextToken: params.nextToken,
      }),
    })
  }

  /**
   * Retrieve and generate using a knowledge base
   */
  async retrieveAndGenerate(params: {
    input: {
      text: string
    }
    retrieveAndGenerateConfiguration: {
      type: 'KNOWLEDGE_BASE'
      knowledgeBaseConfiguration: {
        knowledgeBaseId: string
        modelArn: string
        retrievalConfiguration?: {
          vectorSearchConfiguration: {
            numberOfResults?: number
            overrideSearchType?: 'HYBRID' | 'SEMANTIC'
            filter?: Record<string, unknown>
          }
        }
        generationConfiguration?: {
          promptTemplate?: {
            textPromptTemplate: string
          }
          inferenceConfig?: {
            textInferenceConfig?: {
              temperature?: number
              topP?: number
              maxTokens?: number
              stopSequences?: string[]
            }
          }
          guardrailConfiguration?: {
            guardrailId: string
            guardrailVersion: string
          }
        }
      }
    }
    sessionConfiguration?: {
      kmsKeyArn?: string
    }
    sessionId?: string
  }): Promise<{
    sessionId: string
    output: {
      text: string
    }
    citations?: Array<{
      generatedResponsePart?: {
        textResponsePart?: {
          text: string
          span?: { start: number; end: number }
        }
      }
      retrievedReferences?: Array<{
        content: { text: string }
        location?: {
          type: string
          s3Location?: { uri: string }
        }
        metadata?: Record<string, unknown>
      }>
    }>
    guardrailAction?: 'INTERVENED' | 'NONE'
  }> {
    return this.client.request({
      service: 'bedrock-agent-runtime',
      region: this.region,
      method: 'POST',
      path: '/retrieveAndGenerate',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(params),
    })
  }
}

// ============================================================================
// Bedrock Agent Client (Management)
// ============================================================================

/**
 * Bedrock Agent client for agent management
 */
export class BedrockAgentClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Create an agent
   */
  async createAgent(params: CreateAgentCommandInput): Promise<CreateAgentCommandOutput> {
    return this.client.request({
      service: 'bedrock-agent',
      region: this.region,
      method: 'PUT',
      path: '/agents/',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * Get agent details
   */
  async getAgent(params: { agentId: string }): Promise<{ agent: CreateAgentCommandOutput['agent'] }> {
    return this.client.request({
      service: 'bedrock-agent',
      region: this.region,
      method: 'GET',
      path: `/agents/${encodeURIComponent(params.agentId)}/`,
    })
  }

  /**
   * List agents
   */
  async listAgents(params?: {
    maxResults?: number
    nextToken?: string
  }): Promise<{
    agentSummaries: Array<{
      agentId: string
      agentName: string
      agentStatus: string
      description?: string
      updatedAt: string
      latestAgentVersion: string
    }>
    nextToken?: string
  }> {
    const queryParams: Record<string, string> = {}
    if (params?.maxResults) queryParams.maxResults = params.maxResults.toString()
    if (params?.nextToken) queryParams.nextToken = params.nextToken

    return this.client.request({
      service: 'bedrock-agent',
      region: this.region,
      method: 'GET',
      path: '/agents/',
      queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    })
  }

  /**
   * Delete an agent
   */
  async deleteAgent(params: { agentId: string; skipResourceInUseCheck?: boolean }): Promise<{ agentId: string; agentStatus: string }> {
    const queryParams: Record<string, string> = {}
    if (params.skipResourceInUseCheck !== undefined) {
      queryParams.skipResourceInUseCheck = params.skipResourceInUseCheck.toString()
    }

    return this.client.request({
      service: 'bedrock-agent',
      region: this.region,
      method: 'DELETE',
      path: `/agents/${encodeURIComponent(params.agentId)}/`,
      queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    })
  }

  /**
   * Prepare an agent for invocation
   */
  async prepareAgent(params: { agentId: string }): Promise<{
    agentId: string
    agentStatus: string
    agentVersion: string
    preparedAt: string
  }> {
    return this.client.request({
      service: 'bedrock-agent',
      region: this.region,
      method: 'POST',
      path: `/agents/${encodeURIComponent(params.agentId)}/`,
      headers: {
        'Content-Type': 'application/json',
      },
    })
  }

  /**
   * Create a knowledge base
   */
  async createKnowledgeBase(params: CreateKnowledgeBaseCommandInput): Promise<CreateKnowledgeBaseCommandOutput> {
    return this.client.request({
      service: 'bedrock-agent',
      region: this.region,
      method: 'PUT',
      path: '/knowledgebases/',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * Get knowledge base details
   */
  async getKnowledgeBase(params: { knowledgeBaseId: string }): Promise<{ knowledgeBase: CreateKnowledgeBaseCommandOutput['knowledgeBase'] }> {
    return this.client.request({
      service: 'bedrock-agent',
      region: this.region,
      method: 'GET',
      path: `/knowledgebases/${encodeURIComponent(params.knowledgeBaseId)}`,
    })
  }

  /**
   * List knowledge bases
   */
  async listKnowledgeBases(params?: {
    maxResults?: number
    nextToken?: string
  }): Promise<{
    knowledgeBaseSummaries: Array<{
      knowledgeBaseId: string
      name: string
      description?: string
      status: string
      updatedAt: string
    }>
    nextToken?: string
  }> {
    const queryParams: Record<string, string> = {}
    if (params?.maxResults) queryParams.maxResults = params.maxResults.toString()
    if (params?.nextToken) queryParams.nextToken = params.nextToken

    return this.client.request({
      service: 'bedrock-agent',
      region: this.region,
      method: 'GET',
      path: '/knowledgebases/',
      queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    })
  }

  /**
   * Delete a knowledge base
   */
  async deleteKnowledgeBase(params: { knowledgeBaseId: string }): Promise<{ knowledgeBaseId: string; status: string }> {
    return this.client.request({
      service: 'bedrock-agent',
      region: this.region,
      method: 'DELETE',
      path: `/knowledgebases/${encodeURIComponent(params.knowledgeBaseId)}`,
    })
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Request access to multiple Bedrock models
 * Convenience function matching the pattern from the user's example
 */
export async function requestModelAccess(
  models: string[],
  region: string = 'us-east-1',
): Promise<Array<{ modelId: string; status: string; error?: string }>> {
  const client = new BedrockClient(region)
  return client.requestAccessToModels(models)
}

/**
 * List all available Claude models in the region
 */
export async function listClaudeModels(region: string = 'us-east-1'): Promise<FoundationModelSummary[]> {
  const client = new BedrockClient(region)
  return client.listClaudeModels()
}

/**
 * Create a simple text completion using Claude
 */
export async function completeWithClaude(
  prompt: string,
  options?: {
    modelId?: string
    maxTokens?: number
    temperature?: number
    region?: string
  },
): Promise<string> {
  const client = new BedrockRuntimeClient(options?.region || 'us-east-1')

  const response = await client.invokeClaudeMessages({
    modelId: options?.modelId || 'anthropic.claude-3-haiku-20240307-v1:0',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: options?.maxTokens || 1024,
    temperature: options?.temperature,
  })

  const textContent = response.content.find(c => c.type === 'text')
  return textContent?.type === 'text' ? textContent.text : ''
}

/**
 * Generate embeddings for text
 */
export async function generateEmbeddings(
  text: string | string[],
  options?: {
    modelId?: string
    region?: string
  },
): Promise<number[] | number[][]> {
  const client = new BedrockRuntimeClient(options?.region || 'us-east-1')

  const result = await client.generateEmbeddings({
    modelId: options?.modelId || 'amazon.titan-embed-text-v1',
    inputText: text,
  })

  return result.embeddings || result.embedding || []
}
