/**
 * AWS Translate Client
 * Machine translation service
 * No external SDK dependencies - implements AWS Signature V4 directly
*/

import { AWSClient } from './client'

// ============================================================================
// Types
// ============================================================================

export interface TranslateTextCommandInput {
  Text: string
  SourceLanguageCode: string
  TargetLanguageCode: string
  TerminologyNames?: string[]
  Settings?: {
    Formality?: 'FORMAL' | 'INFORMAL'
    Profanity?: 'MASK'
    Brevity?: 'ON'
  }
}

export interface TranslatedDocument {
  Content: Uint8Array
}

export interface AppliedTerminology {
  Name?: string
  Terms?: Array<{
    SourceText?: string
    TargetText?: string
  }>
}

export interface TranslateTextCommandOutput {
  TranslatedText: string
  SourceLanguageCode: string
  TargetLanguageCode: string
  AppliedTerminologies?: AppliedTerminology[]
  AppliedSettings?: {
    Formality?: 'FORMAL' | 'INFORMAL'
    Profanity?: 'MASK'
    Brevity?: 'ON'
  }
}

export interface TranslateDocumentCommandInput {
  Document: {
    Content: Uint8Array
    ContentType: 'text/html' | 'text/plain' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
  SourceLanguageCode: string
  TargetLanguageCode: string
  TerminologyNames?: string[]
  Settings?: {
    Formality?: 'FORMAL' | 'INFORMAL'
    Profanity?: 'MASK'
    Brevity?: 'ON'
  }
}

export interface TranslateDocumentCommandOutput {
  TranslatedDocument: TranslatedDocument
  SourceLanguageCode: string
  TargetLanguageCode: string
  AppliedTerminologies?: AppliedTerminology[]
  AppliedSettings?: {
    Formality?: 'FORMAL' | 'INFORMAL'
    Profanity?: 'MASK'
    Brevity?: 'ON'
  }
}

export interface StartTextTranslationJobCommandInput {
  JobName?: string
  InputDataConfig: {
    S3Uri: string
    ContentType: 'text/html' | 'text/plain' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' | 'application/vnd.openxmlformats-officedocument.presentationml.presentation' | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' | 'application/x-xliff+xml'
  }
  OutputDataConfig: {
    S3Uri: string
    EncryptionKey?: {
      Type: 'KMS'
      Id: string
    }
  }
  DataAccessRoleArn: string
  SourceLanguageCode: string
  TargetLanguageCodes: string[]
  TerminologyNames?: string[]
  ParallelDataNames?: string[]
  ClientToken?: string
  Settings?: {
    Formality?: 'FORMAL' | 'INFORMAL'
    Profanity?: 'MASK'
    Brevity?: 'ON'
  }
}

export interface StartTextTranslationJobCommandOutput {
  JobId?: string
  JobStatus?: 'SUBMITTED' | 'IN_PROGRESS' | 'COMPLETED' | 'COMPLETED_WITH_ERROR' | 'FAILED' | 'STOP_REQUESTED' | 'STOPPED'
}

export interface DescribeTextTranslationJobCommandInput {
  JobId: string
}

export interface TextTranslationJobProperties {
  JobId?: string
  JobName?: string
  JobStatus?: 'SUBMITTED' | 'IN_PROGRESS' | 'COMPLETED' | 'COMPLETED_WITH_ERROR' | 'FAILED' | 'STOP_REQUESTED' | 'STOPPED'
  JobDetails?: {
    TranslatedDocumentsCount?: number
    DocumentsWithErrorsCount?: number
    InputDocumentsCount?: number
  }
  SourceLanguageCode?: string
  TargetLanguageCodes?: string[]
  TerminologyNames?: string[]
  ParallelDataNames?: string[]
  Message?: string
  SubmittedTime?: string
  EndTime?: string
  InputDataConfig?: {
    S3Uri?: string
    ContentType?: string
  }
  OutputDataConfig?: {
    S3Uri?: string
    EncryptionKey?: {
      Type?: string
      Id?: string
    }
  }
  DataAccessRoleArn?: string
  Settings?: {
    Formality?: 'FORMAL' | 'INFORMAL'
    Profanity?: 'MASK'
    Brevity?: 'ON'
  }
}

export interface DescribeTextTranslationJobCommandOutput {
  TextTranslationJobProperties?: TextTranslationJobProperties
}

export interface ListTextTranslationJobsCommandInput {
  Filter?: {
    JobName?: string
    JobStatus?: 'SUBMITTED' | 'IN_PROGRESS' | 'COMPLETED' | 'COMPLETED_WITH_ERROR' | 'FAILED' | 'STOP_REQUESTED' | 'STOPPED'
    SubmittedBeforeTime?: string
    SubmittedAfterTime?: string
  }
  NextToken?: string
  MaxResults?: number
}

export interface ListTextTranslationJobsCommandOutput {
  TextTranslationJobPropertiesList?: TextTranslationJobProperties[]
  NextToken?: string
}

export interface StopTextTranslationJobCommandInput {
  JobId: string
}

export interface StopTextTranslationJobCommandOutput {
  JobId?: string
  JobStatus?: 'SUBMITTED' | 'IN_PROGRESS' | 'COMPLETED' | 'COMPLETED_WITH_ERROR' | 'FAILED' | 'STOP_REQUESTED' | 'STOPPED'
}

export interface ListLanguagesCommandInput {
  DisplayLanguageCode?: string
  NextToken?: string
  MaxResults?: number
}

export interface Language {
  LanguageName?: string
  LanguageCode?: string
}

export interface ListLanguagesCommandOutput {
  Languages?: Language[]
  DisplayLanguageCode?: string
  NextToken?: string
}

export interface ImportTerminologyCommandInput {
  Name: string
  MergeStrategy: 'OVERWRITE'
  Description?: string
  TerminologyData: {
    File: Uint8Array
    Format: 'CSV' | 'TMX' | 'TSV'
    Directionality?: 'UNI' | 'MULTI'
  }
  EncryptionKey?: {
    Type: 'KMS'
    Id: string
  }
  Tags?: Array<{ Key: string; Value: string }>
}

export interface TerminologyProperties {
  Name?: string
  Description?: string
  Arn?: string
  SourceLanguageCode?: string
  TargetLanguageCodes?: string[]
  EncryptionKey?: {
    Type?: string
    Id?: string
  }
  SizeBytes?: number
  TermCount?: number
  CreatedAt?: string
  LastUpdatedAt?: string
  Directionality?: 'UNI' | 'MULTI'
  Message?: string
  SkippedTermCount?: number
  Format?: 'CSV' | 'TMX' | 'TSV'
}

export interface ImportTerminologyCommandOutput {
  TerminologyProperties?: TerminologyProperties
  AuxiliaryDataLocation?: {
    RepositoryType?: string
    Location?: string
  }
}

export interface GetTerminologyCommandInput {
  Name: string
  TerminologyDataFormat?: 'CSV' | 'TMX' | 'TSV'
}

export interface GetTerminologyCommandOutput {
  TerminologyProperties?: TerminologyProperties
  TerminologyDataLocation?: {
    RepositoryType?: string
    Location?: string
  }
  AuxiliaryDataLocation?: {
    RepositoryType?: string
    Location?: string
  }
}

export interface ListTerminologiesCommandInput {
  NextToken?: string
  MaxResults?: number
}

export interface ListTerminologiesCommandOutput {
  TerminologyPropertiesList?: TerminologyProperties[]
  NextToken?: string
}

export interface DeleteTerminologyCommandInput {
  Name: string
}

export interface DeleteTerminologyCommandOutput {
  // Empty
}

export interface CreateParallelDataCommandInput {
  Name: string
  Description?: string
  ParallelDataConfig: {
    S3Uri: string
    Format: 'TSV' | 'CSV' | 'TMX'
  }
  EncryptionKey?: {
    Type: 'KMS'
    Id: string
  }
  ClientToken?: string
  Tags?: Array<{ Key: string; Value: string }>
}

export interface ParallelDataProperties {
  Name?: string
  Arn?: string
  Description?: string
  Status?: 'CREATING' | 'UPDATING' | 'ACTIVE' | 'DELETING' | 'FAILED'
  SourceLanguageCode?: string
  TargetLanguageCodes?: string[]
  ParallelDataConfig?: {
    S3Uri?: string
    Format?: 'TSV' | 'CSV' | 'TMX'
  }
  Message?: string
  ImportedDataSize?: number
  ImportedRecordCount?: number
  FailedRecordCount?: number
  SkippedRecordCount?: number
  EncryptionKey?: {
    Type?: string
    Id?: string
  }
  CreatedAt?: string
  LastUpdatedAt?: string
  LatestUpdateAttemptStatus?: 'CREATING' | 'UPDATING' | 'ACTIVE' | 'DELETING' | 'FAILED'
  LatestUpdateAttemptAt?: string
}

export interface CreateParallelDataCommandOutput {
  Name?: string
  Status?: 'CREATING' | 'UPDATING' | 'ACTIVE' | 'DELETING' | 'FAILED'
}

export interface GetParallelDataCommandInput {
  Name: string
}

export interface GetParallelDataCommandOutput {
  ParallelDataProperties?: ParallelDataProperties
  DataLocation?: {
    RepositoryType?: string
    Location?: string
  }
  AuxiliaryDataLocation?: {
    RepositoryType?: string
    Location?: string
  }
  LatestUpdateAttemptAuxiliaryDataLocation?: {
    RepositoryType?: string
    Location?: string
  }
}

export interface ListParallelDataCommandInput {
  NextToken?: string
  MaxResults?: number
}

export interface ListParallelDataCommandOutput {
  ParallelDataPropertiesList?: ParallelDataProperties[]
  NextToken?: string
}

export interface DeleteParallelDataCommandInput {
  Name: string
}

export interface DeleteParallelDataCommandOutput {
  Name?: string
  Status?: 'CREATING' | 'UPDATING' | 'ACTIVE' | 'DELETING' | 'FAILED'
}

// ============================================================================
// Translate Client
// ============================================================================

export class TranslateClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  private async request<T>(action: string, params: Record<string, unknown>): Promise<T> {
    return this.client.request({
      service: 'translate',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSShineFrontendService_20170701.${action}`,
      },
      body: JSON.stringify(params),
    })
  }

  // -------------------------------------------------------------------------
  // Real-time Translation
  // -------------------------------------------------------------------------

  /**
   * Translate text
  */
  async translateText(params: TranslateTextCommandInput): Promise<TranslateTextCommandOutput> {
    return this.request('TranslateText', params as unknown as Record<string, unknown>)
  }

  /**
   * Translate a document
  */
  async translateDocument(params: TranslateDocumentCommandInput): Promise<TranslateDocumentCommandOutput> {
    return this.request('TranslateDocument', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Batch Translation
  // -------------------------------------------------------------------------

  /**
   * Start a batch translation job
  */
  async startTextTranslationJob(params: StartTextTranslationJobCommandInput): Promise<StartTextTranslationJobCommandOutput> {
    return this.request('StartTextTranslationJob', params as unknown as Record<string, unknown>)
  }

  /**
   * Describe a batch translation job
  */
  async describeTextTranslationJob(params: DescribeTextTranslationJobCommandInput): Promise<DescribeTextTranslationJobCommandOutput> {
    return this.request('DescribeTextTranslationJob', params as unknown as Record<string, unknown>)
  }

  /**
   * List batch translation jobs
  */
  async listTextTranslationJobs(params?: ListTextTranslationJobsCommandInput): Promise<ListTextTranslationJobsCommandOutput> {
    return this.request('ListTextTranslationJobs', (params || {}) as unknown as Record<string, unknown>)
  }

  /**
   * Stop a batch translation job
  */
  async stopTextTranslationJob(params: StopTextTranslationJobCommandInput): Promise<StopTextTranslationJobCommandOutput> {
    return this.request('StopTextTranslationJob', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Languages
  // -------------------------------------------------------------------------

  /**
   * List supported languages
  */
  async listLanguages(params?: ListLanguagesCommandInput): Promise<ListLanguagesCommandOutput> {
    return this.request('ListLanguages', (params || {}) as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Terminologies
  // -------------------------------------------------------------------------

  /**
   * Import a custom terminology
  */
  async importTerminology(params: ImportTerminologyCommandInput): Promise<ImportTerminologyCommandOutput> {
    return this.request('ImportTerminology', params as unknown as Record<string, unknown>)
  }

  /**
   * Get a terminology
  */
  async getTerminology(params: GetTerminologyCommandInput): Promise<GetTerminologyCommandOutput> {
    return this.request('GetTerminology', params as unknown as Record<string, unknown>)
  }

  /**
   * List terminologies
  */
  async listTerminologies(params?: ListTerminologiesCommandInput): Promise<ListTerminologiesCommandOutput> {
    return this.request('ListTerminologies', (params || {}) as unknown as Record<string, unknown>)
  }

  /**
   * Delete a terminology
  */
  async deleteTerminology(params: DeleteTerminologyCommandInput): Promise<DeleteTerminologyCommandOutput> {
    return this.request('DeleteTerminology', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Parallel Data
  // -------------------------------------------------------------------------

  /**
   * Create parallel data for custom translation
  */
  async createParallelData(params: CreateParallelDataCommandInput): Promise<CreateParallelDataCommandOutput> {
    return this.request('CreateParallelData', params as unknown as Record<string, unknown>)
  }

  /**
   * Get parallel data
  */
  async getParallelData(params: GetParallelDataCommandInput): Promise<GetParallelDataCommandOutput> {
    return this.request('GetParallelData', params as unknown as Record<string, unknown>)
  }

  /**
   * List parallel data
  */
  async listParallelData(params?: ListParallelDataCommandInput): Promise<ListParallelDataCommandOutput> {
    return this.request('ListParallelData', (params || {}) as unknown as Record<string, unknown>)
  }

  /**
   * Delete parallel data
  */
  async deleteParallelData(params: DeleteParallelDataCommandInput): Promise<DeleteParallelDataCommandOutput> {
    return this.request('DeleteParallelData', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Convenience Methods
  // -------------------------------------------------------------------------

  /**
   * Simple translation
  */
  async translate(
    text: string,
    targetLanguage: string,
    sourceLanguage: string = 'auto',
  ): Promise<string> {
    const result = await this.translateText({
      Text: text,
      SourceLanguageCode: sourceLanguage,
      TargetLanguageCode: targetLanguage,
    })
    return result.TranslatedText
  }

  /**
   * Translate with formality setting
  */
  async translateFormal(
    text: string,
    targetLanguage: string,
    sourceLanguage: string = 'auto',
    formality: 'FORMAL' | 'INFORMAL' = 'FORMAL',
  ): Promise<string> {
    const result = await this.translateText({
      Text: text,
      SourceLanguageCode: sourceLanguage,
      TargetLanguageCode: targetLanguage,
      Settings: { Formality: formality },
    })
    return result.TranslatedText
  }

  /**
   * Translate to multiple languages
  */
  async translateToMultiple(
    text: string,
    targetLanguages: string[],
    sourceLanguage: string = 'auto',
  ): Promise<Record<string, string>> {
    const results: Record<string, string> = {}

    for (const targetLang of targetLanguages) {
      results[targetLang] = await this.translate(text, targetLang, sourceLanguage)
    }

    return results
  }

  /**
   * Wait for batch translation job to complete
  */
  async waitForJob(
    jobId: string,
    options?: { maxWaitMs?: number; pollIntervalMs?: number },
  ): Promise<TextTranslationJobProperties> {
    const maxWaitMs = options?.maxWaitMs ?? 3600000 // 1 hour
    const pollIntervalMs = options?.pollIntervalMs ?? 30000
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      const result = await this.describeTextTranslationJob({ JobId: jobId })
      const job = result.TextTranslationJobProperties

      if (job?.JobStatus === 'COMPLETED' || job?.JobStatus === 'COMPLETED_WITH_ERROR') {
        return job
      }
      if (job?.JobStatus === 'FAILED' || job?.JobStatus === 'STOPPED') {
        throw new Error(`Translation job ${jobId} failed: ${job.Message}`)
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }

    throw new Error(`Timeout waiting for translation job ${jobId}`)
  }

  /**
   * Get all supported language codes
  */
  async getSupportedLanguages(): Promise<string[]> {
    const result = await this.listLanguages()
    return result.Languages?.map(l => l.LanguageCode || '').filter(Boolean) || []
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Quick translation
*/
export async function translate(
  text: string,
  targetLanguage: string,
  options?: {
    sourceLanguage?: string
    region?: string
  },
): Promise<string> {
  const client = new TranslateClient(options?.region || 'us-east-1')
  return client.translate(text, targetLanguage, options?.sourceLanguage || 'auto')
}

/**
 * Translate to multiple languages
*/
export async function translateToMultiple(
  text: string,
  targetLanguages: string[],
  options?: {
    sourceLanguage?: string
    region?: string
  },
): Promise<Record<string, string>> {
  const client = new TranslateClient(options?.region || 'us-east-1')
  return client.translateToMultiple(text, targetLanguages, options?.sourceLanguage || 'auto')
}

/**
 * List supported languages
*/
export async function listLanguages(region?: string): Promise<Language[]> {
  const client = new TranslateClient(region || 'us-east-1')
  const result = await client.listLanguages()
  return result.Languages || []
}
