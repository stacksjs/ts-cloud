/**
 * AWS Bedrock Runtime Client
 * Direct API calls for Bedrock AI model invocations
 */

import { AWSClient } from './client'

export interface BedrockMessage {
  role: 'user' | 'assistant'
  content: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>
}

export interface BedrockResponse {
  id: string
  type: string
  role: string
  content: Array<{ type: 'text'; text: string }>
  model: string
  stop_reason: string
  usage: {
    input_tokens: number
    output_tokens: number
  }
}

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
   * Invoke a Bedrock model
   */
  async invokeModel(params: {
    modelId: string
    body: string | Record<string, any>
    contentType?: string
    accept?: string
  }): Promise<{ body: Uint8Array; contentType: string }> {
    const body = typeof params.body === 'string' ? params.body : JSON.stringify(params.body)

    const result = await this.client.request({
      service: 'bedrock-runtime',
      region: this.region,
      method: 'POST',
      path: `/model/${params.modelId}/invoke`,
      headers: {
        'Content-Type': params.contentType || 'application/json',
        'Accept': params.accept || 'application/json',
      },
      body,
      rawResponse: true,
    })

    return result
  }

  /**
   * Invoke Claude model with messages API
   */
  async invokeClaudeMessages(params: {
    modelId?: string
    messages: BedrockMessage[]
    maxTokens?: number
    temperature?: number
    topP?: number
    stopSequences?: string[]
    system?: string
  }): Promise<BedrockResponse> {
    const modelId = params.modelId || 'anthropic.claude-3-haiku-20240307-v1:0'

    const requestBody = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: params.maxTokens || 1024,
      messages: params.messages,
      ...(params.temperature !== undefined && { temperature: params.temperature }),
      ...(params.topP !== undefined && { top_p: params.topP }),
      ...(params.stopSequences && { stop_sequences: params.stopSequences }),
      ...(params.system && { system: params.system }),
    }

    const result = await this.client.request({
      service: 'bedrock-runtime',
      region: this.region,
      method: 'POST',
      path: `/model/${modelId}/invoke`,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(requestBody),
    })

    return result
  }

  /**
   * Invoke model with streaming response
   */
  async invokeModelWithResponseStream(params: {
    modelId: string
    body: string | Record<string, any>
    contentType?: string
    accept?: string
  }): Promise<ReadableStream> {
    const body = typeof params.body === 'string' ? params.body : JSON.stringify(params.body)

    const result = await this.client.request({
      service: 'bedrock-runtime',
      region: this.region,
      method: 'POST',
      path: `/model/${params.modelId}/invoke-with-response-stream`,
      headers: {
        'Content-Type': params.contentType || 'application/json',
        'Accept': params.accept || 'application/json',
      },
      body,
      rawResponse: true,
    })

    return result
  }

  /**
   * Generate embeddings using a Bedrock model
   */
  async generateEmbeddings(params: {
    modelId?: string
    inputText: string
  }): Promise<{ embedding: number[] }> {
    const modelId = params.modelId || 'amazon.titan-embed-text-v1'

    const result = await this.client.request({
      service: 'bedrock-runtime',
      region: this.region,
      method: 'POST',
      path: `/model/${modelId}/invoke`,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ inputText: params.inputText }),
    })

    return result
  }
}

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

  /**
   * List available foundation models
   */
  async listFoundationModels(params?: {
    byProvider?: string
    byCustomizationType?: string
    byOutputModality?: string
    byInferenceType?: string
  }): Promise<{
    modelSummaries: Array<{
      modelArn: string
      modelId: string
      modelName: string
      providerName: string
      inputModalities: string[]
      outputModalities: string[]
      responseStreamingSupported: boolean
      customizationsSupported: string[]
      inferenceTypesSupported: string[]
    }>
  }> {
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
  async getFoundationModel(modelIdentifier: string): Promise<{
    modelDetails: {
      modelArn: string
      modelId: string
      modelName: string
      providerName: string
      inputModalities: string[]
      outputModalities: string[]
    }
  }> {
    return this.client.request({
      service: 'bedrock',
      region: this.region,
      method: 'GET',
      path: `/foundation-models/${modelIdentifier}`,
    })
  }
}
