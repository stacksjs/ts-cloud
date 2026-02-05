/**
 * AWS Comprehend Client
 * Natural Language Processing - sentiment, entities, key phrases, language detection, PII
 * No external SDK dependencies - implements AWS Signature V4 directly
*/

import { AWSClient } from './client'

// ============================================================================
// Types
// ============================================================================

export interface DetectSentimentCommandInput {
  Text: string
  LanguageCode: 'en' | 'es' | 'fr' | 'de' | 'it' | 'pt' | 'ar' | 'hi' | 'ja' | 'ko' | 'zh' | 'zh-TW'
}

export interface DetectSentimentCommandOutput {
  Sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'MIXED'
  SentimentScore: {
    Positive: number
    Negative: number
    Neutral: number
    Mixed: number
  }
}

export interface DetectEntitiesCommandInput {
  Text: string
  LanguageCode: string
  EndpointArn?: string
  Bytes?: Uint8Array
  DocumentReaderConfig?: {
    DocumentReadAction: 'TEXTRACT_DETECT_DOCUMENT_TEXT' | 'TEXTRACT_ANALYZE_DOCUMENT'
    DocumentReadMode?: 'SERVICE_DEFAULT' | 'FORCE_DOCUMENT_READ_ACTION'
    FeatureTypes?: ('TABLES' | 'FORMS')[]
  }
}

export interface Entity {
  Score?: number
  Type?: 'PERSON' | 'LOCATION' | 'ORGANIZATION' | 'COMMERCIAL_ITEM' | 'EVENT' | 'DATE' | 'QUANTITY' | 'TITLE' | 'OTHER'
  Text?: string
  BeginOffset?: number
  EndOffset?: number
  BlockReferences?: Array<{
    BlockId?: string
    BeginOffset?: number
    EndOffset?: number
    ChildBlocks?: Array<{
      ChildBlockId?: string
      BeginOffset?: number
      EndOffset?: number
    }>
  }>
}

export interface DetectEntitiesCommandOutput {
  Entities: Entity[]
  DocumentMetadata?: {
    Pages?: number
    ExtractedCharacters?: Array<{
      Page?: number
      Count?: number
    }>
  }
  DocumentType?: Array<{
    Page?: number
    Type?: 'NATIVE_PDF' | 'SCANNED_PDF' | 'MS_WORD' | 'IMAGE' | 'PLAIN_TEXT' | 'TEXTRACT_DETECT_DOCUMENT_TEXT_JSON' | 'TEXTRACT_ANALYZE_DOCUMENT_JSON'
  }>
  Blocks?: Array<{
    Id?: string
    BlockType?: 'LINE' | 'WORD'
    Text?: string
    Page?: number
    Geometry?: {
      BoundingBox?: {
        Height?: number
        Left?: number
        Top?: number
        Width?: number
      }
      Polygon?: Array<{
        X?: number
        Y?: number
      }>
    }
    Relationships?: Array<{
      Ids?: string[]
      Type?: 'CHILD'
    }>
  }>
  Errors?: Array<{
    Page?: number
    ErrorCode?: 'TEXTRACT_BAD_PAGE' | 'TEXTRACT_PROVISIONED_THROUGHPUT_EXCEEDED' | 'PAGE_CHARACTERS_EXCEEDED' | 'PAGE_SIZE_EXCEEDED' | 'INTERNAL_SERVER_ERROR'
    ErrorMessage?: string
  }>
}

export interface DetectKeyPhrasesCommandInput {
  Text: string
  LanguageCode: string
}

export interface KeyPhrase {
  Score?: number
  Text?: string
  BeginOffset?: number
  EndOffset?: number
}

export interface DetectKeyPhrasesCommandOutput {
  KeyPhrases: KeyPhrase[]
}

export interface DetectDominantLanguageCommandInput {
  Text: string
}

export interface DominantLanguage {
  LanguageCode?: string
  Score?: number
}

export interface DetectDominantLanguageCommandOutput {
  Languages: DominantLanguage[]
}

export interface DetectPiiEntitiesCommandInput {
  Text: string
  LanguageCode: string
}

export interface PiiEntity {
  Score?: number
  Type?: 'BANK_ACCOUNT_NUMBER' | 'BANK_ROUTING' | 'CREDIT_DEBIT_NUMBER' | 'CREDIT_DEBIT_CVV' | 'CREDIT_DEBIT_EXPIRY' | 'PIN' | 'EMAIL' | 'ADDRESS' | 'NAME' | 'PHONE' | 'SSN' | 'DATE_TIME' | 'PASSPORT_NUMBER' | 'DRIVER_ID' | 'URL' | 'AGE' | 'USERNAME' | 'PASSWORD' | 'AWS_ACCESS_KEY' | 'AWS_SECRET_KEY' | 'IP_ADDRESS' | 'MAC_ADDRESS' | 'LICENSE_PLATE' | 'VEHICLE_IDENTIFICATION_NUMBER' | 'UK_NATIONAL_INSURANCE_NUMBER' | 'CA_SOCIAL_INSURANCE_NUMBER' | 'US_INDIVIDUAL_TAX_IDENTIFICATION_NUMBER' | 'UK_UNIQUE_TAXPAYER_REFERENCE_NUMBER' | 'IN_PERMANENT_ACCOUNT_NUMBER' | 'IN_NREGA' | 'INTERNATIONAL_BANK_ACCOUNT_NUMBER' | 'SWIFT_CODE' | 'UK_NATIONAL_HEALTH_SERVICE_NUMBER' | 'CA_HEALTH_NUMBER' | 'IN_AADHAAR' | 'IN_VOTER_NUMBER'
  BeginOffset?: number
  EndOffset?: number
}

export interface DetectPiiEntitiesCommandOutput {
  Entities: PiiEntity[]
}

export interface ContainsPiiEntitiesCommandInput {
  Text: string
  LanguageCode: string
}

export interface ContainsPiiEntitiesCommandOutput {
  Labels: Array<{
    Name?: string
    Score?: number
  }>
}

export interface DetectSyntaxCommandInput {
  Text: string
  LanguageCode: 'en' | 'es' | 'fr' | 'de' | 'it' | 'pt'
}

export interface SyntaxToken {
  TokenId?: number
  Text?: string
  BeginOffset?: number
  EndOffset?: number
  PartOfSpeech?: {
    Tag?: 'ADJ' | 'ADP' | 'ADV' | 'AUX' | 'CONJ' | 'CCONJ' | 'DET' | 'INTJ' | 'NOUN' | 'NUM' | 'O' | 'PART' | 'PRON' | 'PROPN' | 'PUNCT' | 'SCONJ' | 'SYM' | 'VERB'
    Score?: number
  }
}

export interface DetectSyntaxCommandOutput {
  SyntaxTokens: SyntaxToken[]
}

export interface DetectTargetedSentimentCommandInput {
  Text: string
  LanguageCode: string
}

export interface TargetedSentimentEntity {
  DescriptiveMentionIndex?: number[]
  Mentions?: Array<{
    Score?: number
    GroupScore?: number
    Text?: string
    Type?: 'PERSON' | 'LOCATION' | 'ORGANIZATION' | 'FACILITY' | 'BRAND' | 'COMMERCIAL_ITEM' | 'MOVIE' | 'MUSIC' | 'BOOK' | 'SOFTWARE' | 'GAME' | 'PERSONAL_TITLE' | 'EVENT' | 'DATE' | 'QUANTITY' | 'ATTRIBUTE' | 'OTHER'
    MentionSentiment?: {
      Sentiment?: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'MIXED'
      SentimentScore?: {
        Positive?: number
        Negative?: number
        Neutral?: number
        Mixed?: number
      }
    }
    BeginOffset?: number
    EndOffset?: number
  }>
}

export interface DetectTargetedSentimentCommandOutput {
  Entities: TargetedSentimentEntity[]
}

export interface ClassifyDocumentCommandInput {
  Text?: string
  EndpointArn: string
  Bytes?: Uint8Array
  DocumentReaderConfig?: {
    DocumentReadAction: 'TEXTRACT_DETECT_DOCUMENT_TEXT' | 'TEXTRACT_ANALYZE_DOCUMENT'
    DocumentReadMode?: 'SERVICE_DEFAULT' | 'FORCE_DOCUMENT_READ_ACTION'
    FeatureTypes?: ('TABLES' | 'FORMS')[]
  }
}

export interface ClassifyDocumentCommandOutput {
  Classes?: Array<{
    Name?: string
    Score?: number
    Page?: number
  }>
  Labels?: Array<{
    Name?: string
    Score?: number
    Page?: number
  }>
  DocumentMetadata?: {
    Pages?: number
    ExtractedCharacters?: Array<{
      Page?: number
      Count?: number
    }>
  }
  DocumentType?: Array<{
    Page?: number
    Type?: string
  }>
  Errors?: Array<{
    Page?: number
    ErrorCode?: string
    ErrorMessage?: string
  }>
  Warnings?: Array<{
    Page?: number
    WarnCode?: string
    WarnMessage?: string
  }>
}

export interface BatchDetectSentimentCommandInput {
  TextList: string[]
  LanguageCode: string
}

export interface BatchDetectSentimentCommandOutput {
  ResultList: Array<{
    Index?: number
    Sentiment?: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'MIXED'
    SentimentScore?: {
      Positive?: number
      Negative?: number
      Neutral?: number
      Mixed?: number
    }
  }>
  ErrorList: Array<{
    Index?: number
    ErrorCode?: string
    ErrorMessage?: string
  }>
}

export interface BatchDetectEntitiesCommandInput {
  TextList: string[]
  LanguageCode: string
}

export interface BatchDetectEntitiesCommandOutput {
  ResultList: Array<{
    Index?: number
    Entities?: Entity[]
  }>
  ErrorList: Array<{
    Index?: number
    ErrorCode?: string
    ErrorMessage?: string
  }>
}

export interface BatchDetectKeyPhrasesCommandInput {
  TextList: string[]
  LanguageCode: string
}

export interface BatchDetectKeyPhrasesCommandOutput {
  ResultList: Array<{
    Index?: number
    KeyPhrases?: KeyPhrase[]
  }>
  ErrorList: Array<{
    Index?: number
    ErrorCode?: string
    ErrorMessage?: string
  }>
}

export interface BatchDetectDominantLanguageCommandInput {
  TextList: string[]
}

export interface BatchDetectDominantLanguageCommandOutput {
  ResultList: Array<{
    Index?: number
    Languages?: DominantLanguage[]
  }>
  ErrorList: Array<{
    Index?: number
    ErrorCode?: string
    ErrorMessage?: string
  }>
}

export interface BatchDetectSyntaxCommandInput {
  TextList: string[]
  LanguageCode: string
}

export interface BatchDetectSyntaxCommandOutput {
  ResultList: Array<{
    Index?: number
    SyntaxTokens?: SyntaxToken[]
  }>
  ErrorList: Array<{
    Index?: number
    ErrorCode?: string
    ErrorMessage?: string
  }>
}

export interface StartSentimentDetectionJobCommandInput {
  InputDataConfig: {
    S3Uri: string
    InputFormat?: 'ONE_DOC_PER_FILE' | 'ONE_DOC_PER_LINE'
    DocumentReaderConfig?: {
      DocumentReadAction: 'TEXTRACT_DETECT_DOCUMENT_TEXT' | 'TEXTRACT_ANALYZE_DOCUMENT'
      DocumentReadMode?: 'SERVICE_DEFAULT' | 'FORCE_DOCUMENT_READ_ACTION'
      FeatureTypes?: ('TABLES' | 'FORMS')[]
    }
  }
  OutputDataConfig: {
    S3Uri: string
    KmsKeyId?: string
  }
  DataAccessRoleArn: string
  JobName?: string
  LanguageCode: string
  ClientRequestToken?: string
  VolumeKmsKeyId?: string
  VpcConfig?: {
    SecurityGroupIds: string[]
    Subnets: string[]
  }
  Tags?: Array<{ Key: string; Value: string }>
}

export interface StartSentimentDetectionJobCommandOutput {
  JobId?: string
  JobArn?: string
  JobStatus?: 'SUBMITTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'STOP_REQUESTED' | 'STOPPED'
}

export interface StartEntitiesDetectionJobCommandInput {
  InputDataConfig: {
    S3Uri: string
    InputFormat?: 'ONE_DOC_PER_FILE' | 'ONE_DOC_PER_LINE'
    DocumentReaderConfig?: {
      DocumentReadAction: 'TEXTRACT_DETECT_DOCUMENT_TEXT' | 'TEXTRACT_ANALYZE_DOCUMENT'
      DocumentReadMode?: 'SERVICE_DEFAULT' | 'FORCE_DOCUMENT_READ_ACTION'
      FeatureTypes?: ('TABLES' | 'FORMS')[]
    }
  }
  OutputDataConfig: {
    S3Uri: string
    KmsKeyId?: string
  }
  DataAccessRoleArn: string
  JobName?: string
  EntityRecognizerArn?: string
  LanguageCode: string
  ClientRequestToken?: string
  VolumeKmsKeyId?: string
  VpcConfig?: {
    SecurityGroupIds: string[]
    Subnets: string[]
  }
  Tags?: Array<{ Key: string; Value: string }>
  FlywheelArn?: string
}

export interface StartEntitiesDetectionJobCommandOutput {
  JobId?: string
  JobArn?: string
  JobStatus?: 'SUBMITTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'STOP_REQUESTED' | 'STOPPED'
  EntityRecognizerArn?: string
}

export interface StartKeyPhrasesDetectionJobCommandInput {
  InputDataConfig: {
    S3Uri: string
    InputFormat?: 'ONE_DOC_PER_FILE' | 'ONE_DOC_PER_LINE'
  }
  OutputDataConfig: {
    S3Uri: string
    KmsKeyId?: string
  }
  DataAccessRoleArn: string
  JobName?: string
  LanguageCode: string
  ClientRequestToken?: string
  VolumeKmsKeyId?: string
  VpcConfig?: {
    SecurityGroupIds: string[]
    Subnets: string[]
  }
  Tags?: Array<{ Key: string; Value: string }>
}

export interface StartKeyPhrasesDetectionJobCommandOutput {
  JobId?: string
  JobArn?: string
  JobStatus?: 'SUBMITTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'STOP_REQUESTED' | 'STOPPED'
}

export interface StartPiiEntitiesDetectionJobCommandInput {
  InputDataConfig: {
    S3Uri: string
    InputFormat?: 'ONE_DOC_PER_FILE' | 'ONE_DOC_PER_LINE'
  }
  OutputDataConfig: {
    S3Uri: string
    KmsKeyId?: string
  }
  Mode: 'ONLY_REDACTION' | 'ONLY_OFFSETS'
  RedactionConfig?: {
    PiiEntityTypes?: string[]
    MaskMode?: 'MASK' | 'REPLACE_WITH_PII_ENTITY_TYPE'
    MaskCharacter?: string
  }
  DataAccessRoleArn: string
  JobName?: string
  LanguageCode: string
  ClientRequestToken?: string
  Tags?: Array<{ Key: string; Value: string }>
}

export interface StartPiiEntitiesDetectionJobCommandOutput {
  JobId?: string
  JobArn?: string
  JobStatus?: 'SUBMITTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'STOP_REQUESTED' | 'STOPPED'
}

export interface DescribeSentimentDetectionJobCommandInput {
  JobId: string
}

export interface DescribeSentimentDetectionJobCommandOutput {
  SentimentDetectionJobProperties?: {
    JobId?: string
    JobArn?: string
    JobName?: string
    JobStatus?: 'SUBMITTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'STOP_REQUESTED' | 'STOPPED'
    Message?: string
    SubmitTime?: string
    EndTime?: string
    InputDataConfig?: {
      S3Uri?: string
      InputFormat?: string
    }
    OutputDataConfig?: {
      S3Uri?: string
      KmsKeyId?: string
    }
    LanguageCode?: string
    DataAccessRoleArn?: string
    VolumeKmsKeyId?: string
    VpcConfig?: {
      SecurityGroupIds?: string[]
      Subnets?: string[]
    }
  }
}

// ============================================================================
// Comprehend Client
// ============================================================================

export class ComprehendClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  private async request<T>(action: string, params: Record<string, unknown>): Promise<T> {
    return this.client.request({
      service: 'comprehend',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `Comprehend_20171127.${action}`,
      },
      body: JSON.stringify(params),
    })
  }

  // -------------------------------------------------------------------------
  // Detect Operations (Synchronous)
  // -------------------------------------------------------------------------

  /**
   * Detect sentiment in text
  */
  async detectSentiment(params: DetectSentimentCommandInput): Promise<DetectSentimentCommandOutput> {
    return this.request('DetectSentiment', params as unknown as Record<string, unknown>)
  }

  /**
   * Detect entities in text
  */
  async detectEntities(params: DetectEntitiesCommandInput): Promise<DetectEntitiesCommandOutput> {
    return this.request('DetectEntities', params as unknown as Record<string, unknown>)
  }

  /**
   * Detect key phrases in text
  */
  async detectKeyPhrases(params: DetectKeyPhrasesCommandInput): Promise<DetectKeyPhrasesCommandOutput> {
    return this.request('DetectKeyPhrases', params as unknown as Record<string, unknown>)
  }

  /**
   * Detect the dominant language of text
  */
  async detectDominantLanguage(params: DetectDominantLanguageCommandInput): Promise<DetectDominantLanguageCommandOutput> {
    return this.request('DetectDominantLanguage', params as unknown as Record<string, unknown>)
  }

  /**
   * Detect PII entities in text
  */
  async detectPiiEntities(params: DetectPiiEntitiesCommandInput): Promise<DetectPiiEntitiesCommandOutput> {
    return this.request('DetectPiiEntities', params as unknown as Record<string, unknown>)
  }

  /**
   * Check if text contains PII
  */
  async containsPiiEntities(params: ContainsPiiEntitiesCommandInput): Promise<ContainsPiiEntitiesCommandOutput> {
    return this.request('ContainsPiiEntities', params as unknown as Record<string, unknown>)
  }

  /**
   * Detect syntax (parts of speech) in text
  */
  async detectSyntax(params: DetectSyntaxCommandInput): Promise<DetectSyntaxCommandOutput> {
    return this.request('DetectSyntax', params as unknown as Record<string, unknown>)
  }

  /**
   * Detect targeted sentiment (sentiment per entity)
  */
  async detectTargetedSentiment(params: DetectTargetedSentimentCommandInput): Promise<DetectTargetedSentimentCommandOutput> {
    return this.request('DetectTargetedSentiment', params as unknown as Record<string, unknown>)
  }

  /**
   * Classify a document using a custom endpoint
  */
  async classifyDocument(params: ClassifyDocumentCommandInput): Promise<ClassifyDocumentCommandOutput> {
    return this.request('ClassifyDocument', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Batch Operations
  // -------------------------------------------------------------------------

  /**
   * Batch detect sentiment
  */
  async batchDetectSentiment(params: BatchDetectSentimentCommandInput): Promise<BatchDetectSentimentCommandOutput> {
    return this.request('BatchDetectSentiment', params as unknown as Record<string, unknown>)
  }

  /**
   * Batch detect entities
  */
  async batchDetectEntities(params: BatchDetectEntitiesCommandInput): Promise<BatchDetectEntitiesCommandOutput> {
    return this.request('BatchDetectEntities', params as unknown as Record<string, unknown>)
  }

  /**
   * Batch detect key phrases
  */
  async batchDetectKeyPhrases(params: BatchDetectKeyPhrasesCommandInput): Promise<BatchDetectKeyPhrasesCommandOutput> {
    return this.request('BatchDetectKeyPhrases', params as unknown as Record<string, unknown>)
  }

  /**
   * Batch detect dominant language
  */
  async batchDetectDominantLanguage(params: BatchDetectDominantLanguageCommandInput): Promise<BatchDetectDominantLanguageCommandOutput> {
    return this.request('BatchDetectDominantLanguage', params as unknown as Record<string, unknown>)
  }

  /**
   * Batch detect syntax
  */
  async batchDetectSyntax(params: BatchDetectSyntaxCommandInput): Promise<BatchDetectSyntaxCommandOutput> {
    return this.request('BatchDetectSyntax', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Async Job Operations
  // -------------------------------------------------------------------------

  /**
   * Start an async sentiment detection job
  */
  async startSentimentDetectionJob(params: StartSentimentDetectionJobCommandInput): Promise<StartSentimentDetectionJobCommandOutput> {
    return this.request('StartSentimentDetectionJob', params as unknown as Record<string, unknown>)
  }

  /**
   * Start an async entities detection job
  */
  async startEntitiesDetectionJob(params: StartEntitiesDetectionJobCommandInput): Promise<StartEntitiesDetectionJobCommandOutput> {
    return this.request('StartEntitiesDetectionJob', params as unknown as Record<string, unknown>)
  }

  /**
   * Start an async key phrases detection job
  */
  async startKeyPhrasesDetectionJob(params: StartKeyPhrasesDetectionJobCommandInput): Promise<StartKeyPhrasesDetectionJobCommandOutput> {
    return this.request('StartKeyPhrasesDetectionJob', params as unknown as Record<string, unknown>)
  }

  /**
   * Start an async PII entities detection job
  */
  async startPiiEntitiesDetectionJob(params: StartPiiEntitiesDetectionJobCommandInput): Promise<StartPiiEntitiesDetectionJobCommandOutput> {
    return this.request('StartPiiEntitiesDetectionJob', params as unknown as Record<string, unknown>)
  }

  /**
   * Describe a sentiment detection job
  */
  async describeSentimentDetectionJob(params: DescribeSentimentDetectionJobCommandInput): Promise<DescribeSentimentDetectionJobCommandOutput> {
    return this.request('DescribeSentimentDetectionJob', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Convenience Methods
  // -------------------------------------------------------------------------

  /**
   * Simple sentiment analysis
  */
  async analyzeSentiment(text: string, languageCode: string = 'en'): Promise<{
    sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'MIXED'
    scores: { positive: number; negative: number; neutral: number; mixed: number }
  }> {
    const result = await this.detectSentiment({
      Text: text,
      LanguageCode: languageCode as DetectSentimentCommandInput['LanguageCode'],
    })
    return {
      sentiment: result.Sentiment,
      scores: {
        positive: result.SentimentScore.Positive,
        negative: result.SentimentScore.Negative,
        neutral: result.SentimentScore.Neutral,
        mixed: result.SentimentScore.Mixed,
      },
    }
  }

  /**
   * Extract entities from text
  */
  async extractEntities(text: string, languageCode: string = 'en'): Promise<Array<{
    text: string
    type: string
    score: number
  }>> {
    const result = await this.detectEntities({
      Text: text,
      LanguageCode: languageCode,
    })
    return result.Entities.map(e => ({
      text: e.Text || '',
      type: e.Type || 'UNKNOWN',
      score: e.Score || 0,
    }))
  }

  /**
   * Extract key phrases from text
  */
  async extractKeyPhrases(text: string, languageCode: string = 'en'): Promise<string[]> {
    const result = await this.detectKeyPhrases({
      Text: text,
      LanguageCode: languageCode,
    })
    return result.KeyPhrases.map(kp => kp.Text || '').filter(Boolean)
  }

  /**
   * Detect language of text
  */
  async detectLanguage(text: string): Promise<{ languageCode: string; confidence: number }> {
    const result = await this.detectDominantLanguage({ Text: text })
    const dominant = result.Languages[0]
    return {
      languageCode: dominant?.LanguageCode || 'unknown',
      confidence: dominant?.Score || 0,
    }
  }

  /**
   * Find PII in text
  */
  async findPii(text: string, languageCode: string = 'en'): Promise<Array<{
    type: string
    beginOffset: number
    endOffset: number
    score: number
  }>> {
    const result = await this.detectPiiEntities({
      Text: text,
      LanguageCode: languageCode,
    })
    return result.Entities.map(e => ({
      type: e.Type || 'UNKNOWN',
      beginOffset: e.BeginOffset || 0,
      endOffset: e.EndOffset || 0,
      score: e.Score || 0,
    }))
  }

  /**
   * Check if text contains any PII
  */
  async hasPii(text: string, languageCode: string = 'en'): Promise<boolean> {
    const result = await this.detectPiiEntities({
      Text: text,
      LanguageCode: languageCode,
    })
    return result.Entities.length > 0
  }

  /**
   * Redact PII from text (replaces PII with [TYPE])
  */
  async redactPii(text: string, languageCode: string = 'en'): Promise<string> {
    const result = await this.detectPiiEntities({
      Text: text,
      LanguageCode: languageCode,
    })

    // Sort by end offset descending to replace from end to start
    const sorted = [...result.Entities].sort((a, b) => (b.EndOffset || 0) - (a.EndOffset || 0))

    let redacted = text
    for (const entity of sorted) {
      if (entity.BeginOffset !== undefined && entity.EndOffset !== undefined) {
        redacted = redacted.slice(0, entity.BeginOffset) + `[${entity.Type}]` + redacted.slice(entity.EndOffset)
      }
    }

    return redacted
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Quick sentiment analysis
*/
export async function analyzeSentiment(
  text: string,
  options?: { languageCode?: string; region?: string },
): Promise<{ sentiment: string; confidence: number }> {
  const client = new ComprehendClient(options?.region || 'us-east-1')
  const result = await client.analyzeSentiment(text, options?.languageCode || 'en')
  const maxScore = Math.max(result.scores.positive, result.scores.negative, result.scores.neutral, result.scores.mixed)
  return { sentiment: result.sentiment, confidence: maxScore }
}

/**
 * Quick entity extraction
*/
export async function extractEntities(
  text: string,
  options?: { languageCode?: string; region?: string },
): Promise<Array<{ text: string; type: string }>> {
  const client = new ComprehendClient(options?.region || 'us-east-1')
  return client.extractEntities(text, options?.languageCode || 'en')
}

/**
 * Quick language detection
*/
export async function detectLanguage(
  text: string,
  region?: string,
): Promise<string> {
  const client = new ComprehendClient(region || 'us-east-1')
  const result = await client.detectLanguage(text)
  return result.languageCode
}

/**
 * Quick PII check
*/
export async function containsPii(
  text: string,
  options?: { languageCode?: string; region?: string },
): Promise<boolean> {
  const client = new ComprehendClient(options?.region || 'us-east-1')
  return client.hasPii(text, options?.languageCode || 'en')
}
