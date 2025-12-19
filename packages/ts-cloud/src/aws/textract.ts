/**
 * AWS Textract Client
 * Document OCR, form extraction, table extraction
 * No external SDK dependencies - implements AWS Signature V4 directly
 */

import { AWSClient } from './client'

// ============================================================================
// Types
// ============================================================================

export interface S3Object {
  Bucket?: string
  Name?: string
  Version?: string
}

export interface Document {
  Bytes?: Uint8Array
  S3Object?: S3Object
}

export interface BoundingBox {
  Width?: number
  Height?: number
  Left?: number
  Top?: number
}

export interface Point {
  X?: number
  Y?: number
}

export interface Geometry {
  BoundingBox?: BoundingBox
  Polygon?: Point[]
}

export interface Relationship {
  Type?: 'VALUE' | 'CHILD' | 'COMPLEX_FEATURES' | 'MERGED_CELL' | 'TITLE' | 'ANSWER' | 'TABLE' | 'TABLE_TITLE' | 'TABLE_FOOTER'
  Ids?: string[]
}

export interface Block {
  BlockType?: 'KEY_VALUE_SET' | 'PAGE' | 'LINE' | 'WORD' | 'TABLE' | 'CELL' | 'SELECTION_ELEMENT' | 'MERGED_CELL' | 'TITLE' | 'QUERY' | 'QUERY_RESULT' | 'SIGNATURE' | 'TABLE_TITLE' | 'TABLE_FOOTER' | 'LAYOUT_TEXT' | 'LAYOUT_TITLE' | 'LAYOUT_HEADER' | 'LAYOUT_FOOTER' | 'LAYOUT_SECTION_HEADER' | 'LAYOUT_PAGE_NUMBER' | 'LAYOUT_LIST' | 'LAYOUT_FIGURE' | 'LAYOUT_TABLE' | 'LAYOUT_KEY_VALUE'
  Confidence?: number
  Text?: string
  TextType?: 'HANDWRITING' | 'PRINTED'
  RowIndex?: number
  ColumnIndex?: number
  RowSpan?: number
  ColumnSpan?: number
  Geometry?: Geometry
  Id?: string
  Relationships?: Relationship[]
  EntityTypes?: ('KEY' | 'VALUE' | 'COLUMN_HEADER' | 'TABLE_TITLE' | 'TABLE_FOOTER' | 'TABLE_SECTION_TITLE' | 'TABLE_SUMMARY' | 'STRUCTURED_TABLE' | 'SEMI_STRUCTURED_TABLE')[]
  SelectionStatus?: 'SELECTED' | 'NOT_SELECTED'
  Page?: number
  Query?: {
    Text: string
    Alias?: string
    Pages?: string[]
  }
}

export interface DocumentMetadata {
  Pages?: number
}

export interface Warning {
  ErrorCode?: string
  Pages?: number[]
}

export interface DetectDocumentTextCommandInput {
  Document: Document
}

export interface DetectDocumentTextCommandOutput {
  DocumentMetadata?: DocumentMetadata
  Blocks?: Block[]
  DetectDocumentTextModelVersion?: string
}

export interface AnalyzeDocumentCommandInput {
  Document: Document
  FeatureTypes: ('TABLES' | 'FORMS' | 'QUERIES' | 'SIGNATURES' | 'LAYOUT')[]
  HumanLoopConfig?: {
    HumanLoopName: string
    FlowDefinitionArn: string
    DataAttributes?: {
      ContentClassifiers?: ('FreeOfPersonallyIdentifiableInformation' | 'FreeOfAdultContent')[]
    }
  }
  QueriesConfig?: {
    Queries: Array<{
      Text: string
      Alias?: string
      Pages?: string[]
    }>
  }
  AdaptersConfig?: {
    Adapters: Array<{
      AdapterId: string
      Pages?: string[]
      Version: string
    }>
  }
}

export interface AnalyzeDocumentCommandOutput {
  DocumentMetadata?: DocumentMetadata
  Blocks?: Block[]
  HumanLoopActivationOutput?: {
    HumanLoopArn?: string
    HumanLoopActivationReasons?: string[]
    HumanLoopActivationConditionsEvaluationResults?: string
  }
  AnalyzeDocumentModelVersion?: string
}

export interface AnalyzeExpenseCommandInput {
  Document: Document
}

export interface ExpenseField {
  Type?: {
    Text?: string
    Confidence?: number
  }
  LabelDetection?: {
    Text?: string
    Geometry?: Geometry
    Confidence?: number
  }
  ValueDetection?: {
    Text?: string
    Geometry?: Geometry
    Confidence?: number
  }
  PageNumber?: number
  Currency?: {
    Code?: string
    Confidence?: number
  }
  GroupProperties?: Array<{
    Types?: string[]
    Id?: string
  }>
}

export interface LineItemGroup {
  LineItemGroupIndex?: number
  LineItems?: Array<{
    LineItemExpenseFields?: ExpenseField[]
  }>
}

export interface ExpenseDocument {
  ExpenseIndex?: number
  SummaryFields?: ExpenseField[]
  LineItemGroups?: LineItemGroup[]
  Blocks?: Block[]
}

export interface AnalyzeExpenseCommandOutput {
  DocumentMetadata?: DocumentMetadata
  ExpenseDocuments?: ExpenseDocument[]
}

export interface AnalyzeIDCommandInput {
  DocumentPages: Document[]
}

export interface IdentityDocument {
  DocumentIndex?: number
  IdentityDocumentFields?: Array<{
    Type?: {
      Text?: string
      Confidence?: number
    }
    ValueDetection?: {
      Text?: string
      NormalizedValue?: {
        Value?: string
        ValueType?: 'DATE'
      }
      Confidence?: number
    }
  }>
  Blocks?: Block[]
}

export interface AnalyzeIDCommandOutput {
  IdentityDocuments?: IdentityDocument[]
  DocumentMetadata?: DocumentMetadata
  AnalyzeIDModelVersion?: string
}

export interface StartDocumentTextDetectionCommandInput {
  DocumentLocation: {
    S3Object?: S3Object
  }
  ClientRequestToken?: string
  JobTag?: string
  NotificationChannel?: {
    SNSTopicArn: string
    RoleArn: string
  }
  OutputConfig?: {
    S3Bucket: string
    S3Prefix?: string
  }
  KMSKeyId?: string
}

export interface StartDocumentTextDetectionCommandOutput {
  JobId?: string
}

export interface GetDocumentTextDetectionCommandInput {
  JobId: string
  MaxResults?: number
  NextToken?: string
}

export interface GetDocumentTextDetectionCommandOutput {
  DocumentMetadata?: DocumentMetadata
  JobStatus?: 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'PARTIAL_SUCCESS'
  NextToken?: string
  Blocks?: Block[]
  Warnings?: Warning[]
  StatusMessage?: string
  DetectDocumentTextModelVersion?: string
}

export interface StartDocumentAnalysisCommandInput {
  DocumentLocation: {
    S3Object?: S3Object
  }
  FeatureTypes: ('TABLES' | 'FORMS' | 'QUERIES' | 'SIGNATURES' | 'LAYOUT')[]
  ClientRequestToken?: string
  JobTag?: string
  NotificationChannel?: {
    SNSTopicArn: string
    RoleArn: string
  }
  OutputConfig?: {
    S3Bucket: string
    S3Prefix?: string
  }
  KMSKeyId?: string
  QueriesConfig?: {
    Queries: Array<{
      Text: string
      Alias?: string
      Pages?: string[]
    }>
  }
  AdaptersConfig?: {
    Adapters: Array<{
      AdapterId: string
      Pages?: string[]
      Version: string
    }>
  }
}

export interface StartDocumentAnalysisCommandOutput {
  JobId?: string
}

export interface GetDocumentAnalysisCommandInput {
  JobId: string
  MaxResults?: number
  NextToken?: string
}

export interface GetDocumentAnalysisCommandOutput {
  DocumentMetadata?: DocumentMetadata
  JobStatus?: 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'PARTIAL_SUCCESS'
  NextToken?: string
  Blocks?: Block[]
  Warnings?: Warning[]
  StatusMessage?: string
  AnalyzeDocumentModelVersion?: string
}

export interface StartExpenseAnalysisCommandInput {
  DocumentLocation: {
    S3Object?: S3Object
  }
  ClientRequestToken?: string
  JobTag?: string
  NotificationChannel?: {
    SNSTopicArn: string
    RoleArn: string
  }
  OutputConfig?: {
    S3Bucket: string
    S3Prefix?: string
  }
  KMSKeyId?: string
}

export interface StartExpenseAnalysisCommandOutput {
  JobId?: string
}

export interface GetExpenseAnalysisCommandInput {
  JobId: string
  MaxResults?: number
  NextToken?: string
}

export interface GetExpenseAnalysisCommandOutput {
  DocumentMetadata?: DocumentMetadata
  JobStatus?: 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'PARTIAL_SUCCESS'
  NextToken?: string
  ExpenseDocuments?: ExpenseDocument[]
  Warnings?: Warning[]
  StatusMessage?: string
  AnalyzeExpenseModelVersion?: string
}

export interface StartLendingAnalysisCommandInput {
  DocumentLocation: {
    S3Object?: S3Object
  }
  ClientRequestToken?: string
  JobTag?: string
  NotificationChannel?: {
    SNSTopicArn: string
    RoleArn: string
  }
  OutputConfig?: {
    S3Bucket: string
    S3Prefix?: string
  }
  KMSKeyId?: string
}

export interface StartLendingAnalysisCommandOutput {
  JobId?: string
}

export interface GetLendingAnalysisCommandInput {
  JobId: string
  MaxResults?: number
  NextToken?: string
}

export interface LendingDocument {
  LendingFields?: Array<{
    Type?: string
    KeyDetection?: {
      Text?: string
      Geometry?: Geometry
      Confidence?: number
    }
    ValueDetections?: Array<{
      Text?: string
      Geometry?: Geometry
      Confidence?: number
      SelectionStatus?: 'SELECTED' | 'NOT_SELECTED'
    }>
  }>
  SignatureDetections?: Array<{
    Confidence?: number
    Geometry?: Geometry
  }>
}

export interface LendingResult {
  Page?: number
  PageClassification?: {
    PageType?: Array<{
      Value?: string
      Confidence?: number
    }>
    PageNumber?: Array<{
      Value?: string
      Confidence?: number
    }>
  }
  Extractions?: Array<{
    LendingDocument?: LendingDocument
    ExpenseDocument?: ExpenseDocument
    IdentityDocument?: IdentityDocument
  }>
}

export interface GetLendingAnalysisCommandOutput {
  DocumentMetadata?: DocumentMetadata
  JobStatus?: 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'PARTIAL_SUCCESS'
  NextToken?: string
  Results?: LendingResult[]
  Warnings?: Warning[]
  StatusMessage?: string
  AnalyzeLendingModelVersion?: string
}

// ============================================================================
// Textract Client
// ============================================================================

export class TextractClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  private async request<T>(action: string, params: Record<string, unknown>): Promise<T> {
    return this.client.request({
      service: 'textract',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `Textract.${action}`,
      },
      body: JSON.stringify(params),
    })
  }

  // -------------------------------------------------------------------------
  // Synchronous Operations
  // -------------------------------------------------------------------------

  /**
   * Detect text in a document (OCR)
   */
  async detectDocumentText(params: DetectDocumentTextCommandInput): Promise<DetectDocumentTextCommandOutput> {
    return this.request('DetectDocumentText', params)
  }

  /**
   * Analyze a document (forms, tables, queries)
   */
  async analyzeDocument(params: AnalyzeDocumentCommandInput): Promise<AnalyzeDocumentCommandOutput> {
    return this.request('AnalyzeDocument', params)
  }

  /**
   * Analyze expense document (receipts, invoices)
   */
  async analyzeExpense(params: AnalyzeExpenseCommandInput): Promise<AnalyzeExpenseCommandOutput> {
    return this.request('AnalyzeExpense', params)
  }

  /**
   * Analyze ID document (driver's license, passport)
   */
  async analyzeID(params: AnalyzeIDCommandInput): Promise<AnalyzeIDCommandOutput> {
    return this.request('AnalyzeID', params)
  }

  // -------------------------------------------------------------------------
  // Asynchronous Operations
  // -------------------------------------------------------------------------

  /**
   * Start async text detection job
   */
  async startDocumentTextDetection(params: StartDocumentTextDetectionCommandInput): Promise<StartDocumentTextDetectionCommandOutput> {
    return this.request('StartDocumentTextDetection', params)
  }

  /**
   * Get results of text detection job
   */
  async getDocumentTextDetection(params: GetDocumentTextDetectionCommandInput): Promise<GetDocumentTextDetectionCommandOutput> {
    return this.request('GetDocumentTextDetection', params)
  }

  /**
   * Start async document analysis job
   */
  async startDocumentAnalysis(params: StartDocumentAnalysisCommandInput): Promise<StartDocumentAnalysisCommandOutput> {
    return this.request('StartDocumentAnalysis', params)
  }

  /**
   * Get results of document analysis job
   */
  async getDocumentAnalysis(params: GetDocumentAnalysisCommandInput): Promise<GetDocumentAnalysisCommandOutput> {
    return this.request('GetDocumentAnalysis', params)
  }

  /**
   * Start async expense analysis job
   */
  async startExpenseAnalysis(params: StartExpenseAnalysisCommandInput): Promise<StartExpenseAnalysisCommandOutput> {
    return this.request('StartExpenseAnalysis', params)
  }

  /**
   * Get results of expense analysis job
   */
  async getExpenseAnalysis(params: GetExpenseAnalysisCommandInput): Promise<GetExpenseAnalysisCommandOutput> {
    return this.request('GetExpenseAnalysis', params)
  }

  /**
   * Start async lending analysis job
   */
  async startLendingAnalysis(params: StartLendingAnalysisCommandInput): Promise<StartLendingAnalysisCommandOutput> {
    return this.request('StartLendingAnalysis', params)
  }

  /**
   * Get results of lending analysis job
   */
  async getLendingAnalysis(params: GetLendingAnalysisCommandInput): Promise<GetLendingAnalysisCommandOutput> {
    return this.request('GetLendingAnalysis', params)
  }

  // -------------------------------------------------------------------------
  // Convenience Methods
  // -------------------------------------------------------------------------

  /**
   * Extract all text from a document
   */
  async extractText(document: Document): Promise<string[]> {
    const result = await this.detectDocumentText({ Document: document })
    return result.Blocks?.filter(b => b.BlockType === 'LINE').map(b => b.Text || '') || []
  }

  /**
   * Extract text from S3 document
   */
  async extractTextFromS3(bucket: string, key: string): Promise<string[]> {
    return this.extractText({ S3Object: { Bucket: bucket, Name: key } })
  }

  /**
   * Extract key-value pairs (forms) from a document
   */
  async extractForms(document: Document): Promise<Array<{ key: string; value: string; confidence: number }>> {
    const result = await this.analyzeDocument({
      Document: document,
      FeatureTypes: ['FORMS'],
    })

    const blocks = result.Blocks || []
    const blockMap = new Map<string, Block>()
    blocks.forEach(b => b.Id && blockMap.set(b.Id, b))

    const forms: Array<{ key: string; value: string; confidence: number }> = []

    for (const block of blocks) {
      if (block.BlockType === 'KEY_VALUE_SET' && block.EntityTypes?.includes('KEY')) {
        const keyText = this.getBlockText(block, blockMap)
        const valueBlock = block.Relationships?.find(r => r.Type === 'VALUE')
        let valueText = ''
        if (valueBlock?.Ids) {
          for (const id of valueBlock.Ids) {
            const vb = blockMap.get(id)
            if (vb) valueText += this.getBlockText(vb, blockMap) + ' '
          }
        }
        forms.push({
          key: keyText.trim(),
          value: valueText.trim(),
          confidence: block.Confidence || 0,
        })
      }
    }

    return forms
  }

  /**
   * Extract tables from a document
   */
  async extractTables(document: Document): Promise<Array<{ rows: string[][] }>> {
    const result = await this.analyzeDocument({
      Document: document,
      FeatureTypes: ['TABLES'],
    })

    const blocks = result.Blocks || []
    const blockMap = new Map<string, Block>()
    blocks.forEach(b => b.Id && blockMap.set(b.Id, b))

    const tables: Array<{ rows: string[][] }> = []

    for (const block of blocks) {
      if (block.BlockType === 'TABLE') {
        const cellIds = block.Relationships?.find(r => r.Type === 'CHILD')?.Ids || []
        const cells: Block[] = cellIds.map(id => blockMap.get(id)).filter(Boolean) as Block[]

        // Find max row and column
        let maxRow = 0
        let maxCol = 0
        for (const cell of cells) {
          if (cell.RowIndex && cell.RowIndex > maxRow) maxRow = cell.RowIndex
          if (cell.ColumnIndex && cell.ColumnIndex > maxCol) maxCol = cell.ColumnIndex
        }

        // Build 2D array
        const rows: string[][] = Array.from({ length: maxRow }, () => Array.from({ length: maxCol }, () => ''))

        for (const cell of cells) {
          if (cell.RowIndex && cell.ColumnIndex) {
            rows[cell.RowIndex - 1][cell.ColumnIndex - 1] = this.getBlockText(cell, blockMap)
          }
        }

        tables.push({ rows })
      }
    }

    return tables
  }

  /**
   * Extract expense summary from receipt/invoice
   */
  async extractExpenseSummary(document: Document): Promise<{
    vendor?: string
    total?: string
    date?: string
    items: Array<{ description?: string; quantity?: string; price?: string }>
  }> {
    const result = await this.analyzeExpense({ Document: document })
    const expense = result.ExpenseDocuments?.[0]

    if (!expense) {
      return { items: [] }
    }

    const summary: { vendor?: string; total?: string; date?: string } = {}

    for (const field of expense.SummaryFields || []) {
      const type = field.Type?.Text?.toUpperCase()
      const value = field.ValueDetection?.Text

      if (type === 'VENDOR_NAME') summary.vendor = value
      if (type === 'TOTAL') summary.total = value
      if (type === 'INVOICE_RECEIPT_DATE') summary.date = value
    }

    const items: Array<{ description?: string; quantity?: string; price?: string }> = []

    for (const group of expense.LineItemGroups || []) {
      for (const lineItem of group.LineItems || []) {
        const item: { description?: string; quantity?: string; price?: string } = {}
        for (const field of lineItem.LineItemExpenseFields || []) {
          const type = field.Type?.Text?.toUpperCase()
          const value = field.ValueDetection?.Text

          if (type === 'ITEM') item.description = value
          if (type === 'QUANTITY') item.quantity = value
          if (type === 'PRICE') item.price = value
        }
        if (item.description || item.price) items.push(item)
      }
    }

    return { ...summary, items }
  }

  /**
   * Answer questions about a document
   */
  async queryDocument(document: Document, questions: string[]): Promise<Array<{ question: string; answer: string; confidence: number }>> {
    const result = await this.analyzeDocument({
      Document: document,
      FeatureTypes: ['QUERIES'],
      QueriesConfig: {
        Queries: questions.map(q => ({ Text: q })),
      },
    })

    const blocks = result.Blocks || []
    const answers: Array<{ question: string; answer: string; confidence: number }> = []

    for (const block of blocks) {
      if (block.BlockType === 'QUERY_RESULT' && block.Text) {
        // Find the corresponding query
        const queryBlock = blocks.find(b =>
          b.BlockType === 'QUERY' && b.Relationships?.some(r =>
            r.Type === 'ANSWER' && r.Ids?.includes(block.Id || ''),
          ),
        )
        answers.push({
          question: queryBlock?.Query?.Text || '',
          answer: block.Text,
          confidence: block.Confidence || 0,
        })
      }
    }

    return answers
  }

  /**
   * Wait for async job to complete
   */
  async waitForJob(
    jobId: string,
    getJob: (jobId: string) => Promise<{ JobStatus?: string }>,
    options?: { maxWaitMs?: number; pollIntervalMs?: number },
  ): Promise<void> {
    const maxWaitMs = options?.maxWaitMs ?? 300000 // 5 minutes
    const pollIntervalMs = options?.pollIntervalMs ?? 5000
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      const result = await getJob(jobId)
      if (result.JobStatus === 'SUCCEEDED' || result.JobStatus === 'PARTIAL_SUCCESS') {
        return
      }
      if (result.JobStatus === 'FAILED') {
        throw new Error(`Textract job ${jobId} failed`)
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }

    throw new Error(`Timeout waiting for Textract job ${jobId}`)
  }

  private getBlockText(block: Block, blockMap: Map<string, Block>): string {
    if (block.Text) return block.Text

    const childIds = block.Relationships?.find(r => r.Type === 'CHILD')?.Ids || []
    return childIds.map(id => blockMap.get(id)?.Text || '').join(' ')
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Quick text extraction from S3 document
 */
export async function extractTextFromS3(
  bucket: string,
  key: string,
  region?: string,
): Promise<string> {
  const client = new TextractClient(region || 'us-east-1')
  const lines = await client.extractTextFromS3(bucket, key)
  return lines.join('\n')
}

/**
 * Quick form extraction from S3 document
 */
export async function extractFormsFromS3(
  bucket: string,
  key: string,
  region?: string,
): Promise<Record<string, string>> {
  const client = new TextractClient(region || 'us-east-1')
  const forms = await client.extractForms({ S3Object: { Bucket: bucket, Name: key } })
  return Object.fromEntries(forms.map(f => [f.key, f.value]))
}

/**
 * Quick table extraction from S3 document
 */
export async function extractTablesFromS3(
  bucket: string,
  key: string,
  region?: string,
): Promise<string[][][]> {
  const client = new TextractClient(region || 'us-east-1')
  const tables = await client.extractTables({ S3Object: { Bucket: bucket, Name: key } })
  return tables.map(t => t.rows)
}
