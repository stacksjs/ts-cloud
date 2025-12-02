/**
 * AWS Lambda Operations
 * Direct API calls without AWS SDK dependency
 */

import { AWSClient } from './client'
import { deflateRawSync } from 'zlib'

/**
 * Create a minimal ZIP file containing a single file
 * This is a pure implementation without external dependencies
 */
function createZipFile(filename: string, content: string | Buffer): Buffer {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content
  const compressedData = deflateRawSync(data)

  // Calculate CRC32
  const crc32 = calculateCrc32(data)

  // Current date/time in DOS format
  const now = new Date()
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff

  const filenameBuffer = Buffer.from(filename, 'utf-8')

  // Local file header
  const localHeader = Buffer.alloc(30 + filenameBuffer.length)
  localHeader.writeUInt32LE(0x04034b50, 0) // Local file header signature
  localHeader.writeUInt16LE(20, 4) // Version needed to extract
  localHeader.writeUInt16LE(0, 6) // General purpose bit flag
  localHeader.writeUInt16LE(8, 8) // Compression method (deflate)
  localHeader.writeUInt16LE(dosTime, 10) // Last mod file time
  localHeader.writeUInt16LE(dosDate, 12) // Last mod file date
  localHeader.writeUInt32LE(crc32, 14) // CRC-32
  localHeader.writeUInt32LE(compressedData.length, 18) // Compressed size
  localHeader.writeUInt32LE(data.length, 22) // Uncompressed size
  localHeader.writeUInt16LE(filenameBuffer.length, 26) // File name length
  localHeader.writeUInt16LE(0, 28) // Extra field length
  filenameBuffer.copy(localHeader, 30)

  // Central directory header
  const centralHeader = Buffer.alloc(46 + filenameBuffer.length)
  centralHeader.writeUInt32LE(0x02014b50, 0) // Central directory signature
  centralHeader.writeUInt16LE(20, 4) // Version made by
  centralHeader.writeUInt16LE(20, 6) // Version needed to extract
  centralHeader.writeUInt16LE(0, 8) // General purpose bit flag
  centralHeader.writeUInt16LE(8, 10) // Compression method
  centralHeader.writeUInt16LE(dosTime, 12) // Last mod file time
  centralHeader.writeUInt16LE(dosDate, 14) // Last mod file date
  centralHeader.writeUInt32LE(crc32, 16) // CRC-32
  centralHeader.writeUInt32LE(compressedData.length, 20) // Compressed size
  centralHeader.writeUInt32LE(data.length, 24) // Uncompressed size
  centralHeader.writeUInt16LE(filenameBuffer.length, 28) // File name length
  centralHeader.writeUInt16LE(0, 30) // Extra field length
  centralHeader.writeUInt16LE(0, 32) // File comment length
  centralHeader.writeUInt16LE(0, 34) // Disk number start
  centralHeader.writeUInt16LE(0, 36) // Internal file attributes
  centralHeader.writeUInt32LE(0, 38) // External file attributes
  centralHeader.writeUInt32LE(0, 42) // Relative offset of local header
  filenameBuffer.copy(centralHeader, 46)

  // End of central directory record
  const centralDirOffset = localHeader.length + compressedData.length
  const centralDirSize = centralHeader.length
  const endRecord = Buffer.alloc(22)
  endRecord.writeUInt32LE(0x06054b50, 0) // End of central directory signature
  endRecord.writeUInt16LE(0, 4) // Number of this disk
  endRecord.writeUInt16LE(0, 6) // Disk where central directory starts
  endRecord.writeUInt16LE(1, 8) // Number of central directory records on this disk
  endRecord.writeUInt16LE(1, 10) // Total number of central directory records
  endRecord.writeUInt32LE(centralDirSize, 12) // Size of central directory
  endRecord.writeUInt32LE(centralDirOffset, 16) // Offset of start of central directory
  endRecord.writeUInt16LE(0, 20) // Comment length

  return Buffer.concat([localHeader, compressedData, centralHeader, endRecord])
}

/**
 * Calculate CRC32 checksum
 */
function calculateCrc32(data: Buffer): number {
  // CRC32 lookup table
  const table: number[] = []
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c
  }

  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export interface LambdaFunctionConfiguration {
  FunctionName?: string
  FunctionArn?: string
  Runtime?: string
  Role?: string
  Handler?: string
  CodeSize?: number
  Description?: string
  Timeout?: number
  MemorySize?: number
  LastModified?: string
  CodeSha256?: string
  Version?: string
  State?: 'Pending' | 'Active' | 'Inactive' | 'Failed'
  StateReason?: string
  StateReasonCode?: string
  Environment?: {
    Variables?: Record<string, string>
  }
  Architectures?: ('x86_64' | 'arm64')[]
}

export interface InvokeResult {
  StatusCode?: number
  FunctionError?: string
  LogResult?: string
  Payload?: string
  ExecutedVersion?: string
}

export interface CreateFunctionParams {
  FunctionName: string
  Runtime: 'nodejs18.x' | 'nodejs20.x' | 'python3.11' | 'python3.12' | string
  Role: string
  Handler: string
  Code: {
    ZipFile?: string // Base64 encoded
    S3Bucket?: string
    S3Key?: string
    S3ObjectVersion?: string
  }
  Description?: string
  Timeout?: number
  MemorySize?: number
  Environment?: {
    Variables: Record<string, string>
  }
  Tags?: Record<string, string>
  Architectures?: ('x86_64' | 'arm64')[]
  EphemeralStorage?: {
    Size: number
  }
}

export interface UpdateFunctionCodeParams {
  FunctionName: string
  ZipFile?: string // Base64 encoded
  S3Bucket?: string
  S3Key?: string
  S3ObjectVersion?: string
  Publish?: boolean
  Architectures?: ('x86_64' | 'arm64')[]
}

export interface AddPermissionParams {
  FunctionName: string
  StatementId: string
  Action: string
  Principal: string
  SourceArn?: string
  SourceAccount?: string
}

/**
 * Lambda service management using direct API calls
 */
export class LambdaClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Create a new Lambda function
   */
  async createFunction(params: CreateFunctionParams): Promise<LambdaFunctionConfiguration> {
    const result = await this.client.request({
      service: 'lambda',
      region: this.region,
      method: 'POST',
      path: '/2015-03-31/functions',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    })

    return result
  }

  /**
   * Get function configuration
   */
  async getFunction(functionName: string): Promise<{
    Configuration?: LambdaFunctionConfiguration
    Code?: {
      RepositoryType?: string
      Location?: string
    }
    Tags?: Record<string, string>
  }> {
    const result = await this.client.request({
      service: 'lambda',
      region: this.region,
      method: 'GET',
      path: `/2015-03-31/functions/${encodeURIComponent(functionName)}`,
      headers: {
        'Content-Type': 'application/json',
      },
    })

    return result
  }

  /**
   * Update function code
   */
  async updateFunctionCode(params: UpdateFunctionCodeParams): Promise<LambdaFunctionConfiguration> {
    const { FunctionName, ...rest } = params
    const result = await this.client.request({
      service: 'lambda',
      region: this.region,
      method: 'PUT',
      path: `/2015-03-31/functions/${encodeURIComponent(FunctionName)}/code`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(rest),
    })

    return result
  }

  /**
   * Update function code with inline JavaScript/TypeScript code
   * Automatically creates a zip file with the code as index.js
   */
  async updateFunctionCodeInline(functionName: string, code: string, filename: string = 'index.js'): Promise<LambdaFunctionConfiguration> {
    const zipBuffer = createZipFile(filename, code)
    return this.updateFunctionCode({
      FunctionName: functionName,
      ZipFile: zipBuffer.toString('base64'),
    })
  }

  /**
   * Update function configuration
   */
  async updateFunctionConfiguration(params: {
    FunctionName: string
    Runtime?: string
    Role?: string
    Handler?: string
    Description?: string
    Timeout?: number
    MemorySize?: number
    Environment?: { Variables: Record<string, string> }
  }): Promise<LambdaFunctionConfiguration> {
    const { FunctionName, ...rest } = params
    const result = await this.client.request({
      service: 'lambda',
      region: this.region,
      method: 'PUT',
      path: `/2015-03-31/functions/${encodeURIComponent(FunctionName)}/configuration`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(rest),
    })

    return result
  }

  /**
   * Delete a Lambda function
   */
  async deleteFunction(functionName: string): Promise<void> {
    await this.client.request({
      service: 'lambda',
      region: this.region,
      method: 'DELETE',
      path: `/2015-03-31/functions/${encodeURIComponent(functionName)}`,
      headers: {
        'Content-Type': 'application/json',
      },
    })
  }

  /**
   * Invoke a Lambda function
   */
  async invoke(params: {
    FunctionName: string
    InvocationType?: 'RequestResponse' | 'Event' | 'DryRun'
    Payload?: string | object
    LogType?: 'None' | 'Tail'
  }): Promise<InvokeResult> {
    const { FunctionName, InvocationType = 'RequestResponse', Payload, LogType } = params

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Amz-Invocation-Type': InvocationType,
    }

    if (LogType) {
      headers['X-Amz-Log-Type'] = LogType
    }

    const body = Payload
      ? typeof Payload === 'string'
        ? Payload
        : JSON.stringify(Payload)
      : undefined

    const result = await this.client.request({
      service: 'lambda',
      region: this.region,
      method: 'POST',
      path: `/2015-03-31/functions/${encodeURIComponent(FunctionName)}/invocations`,
      headers,
      body,
      returnHeaders: true,
    })

    return {
      StatusCode: result.statusCode || 200,
      FunctionError: result.headers?.['x-amz-function-error'],
      LogResult: result.headers?.['x-amz-log-result'],
      Payload: typeof result.body === 'string' ? result.body : JSON.stringify(result.body),
      ExecutedVersion: result.headers?.['x-amz-executed-version'],
    }
  }

  /**
   * List Lambda functions
   */
  async listFunctions(params?: {
    MaxItems?: number
    Marker?: string
    FunctionVersion?: 'ALL'
  }): Promise<{
    Functions?: LambdaFunctionConfiguration[]
    NextMarker?: string
  }> {
    const queryParams: Record<string, string> = {}
    if (params?.MaxItems) queryParams.MaxItems = String(params.MaxItems)
    if (params?.Marker) queryParams.Marker = params.Marker
    if (params?.FunctionVersion) queryParams.FunctionVersion = params.FunctionVersion

    const result = await this.client.request({
      service: 'lambda',
      region: this.region,
      method: 'GET',
      path: '/2015-03-31/functions',
      queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
      headers: {
        'Content-Type': 'application/json',
      },
    })

    return result
  }

  /**
   * Add permission to Lambda function (resource-based policy)
   */
  async addPermission(params: AddPermissionParams): Promise<{ Statement?: string }> {
    const { FunctionName, ...rest } = params
    const result = await this.client.request({
      service: 'lambda',
      region: this.region,
      method: 'POST',
      path: `/2015-03-31/functions/${encodeURIComponent(FunctionName)}/policy`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(rest),
    })

    return result
  }

  /**
   * Remove permission from Lambda function
   */
  async removePermission(functionName: string, statementId: string): Promise<void> {
    await this.client.request({
      service: 'lambda',
      region: this.region,
      method: 'DELETE',
      path: `/2015-03-31/functions/${encodeURIComponent(functionName)}/policy/${encodeURIComponent(statementId)}`,
      headers: {
        'Content-Type': 'application/json',
      },
    })
  }

  /**
   * Publish a version of the function
   */
  async publishVersion(params: {
    FunctionName: string
    Description?: string
    CodeSha256?: string
  }): Promise<LambdaFunctionConfiguration> {
    const { FunctionName, ...rest } = params
    const result = await this.client.request({
      service: 'lambda',
      region: this.region,
      method: 'POST',
      path: `/2015-03-31/functions/${encodeURIComponent(FunctionName)}/versions`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(rest),
    })

    return result
  }

  /**
   * Create an alias for a function version
   */
  async createAlias(params: {
    FunctionName: string
    Name: string
    FunctionVersion: string
    Description?: string
  }): Promise<{
    AliasArn?: string
    Name?: string
    FunctionVersion?: string
    Description?: string
  }> {
    const { FunctionName, ...rest } = params
    const result = await this.client.request({
      service: 'lambda',
      region: this.region,
      method: 'POST',
      path: `/2015-03-31/functions/${encodeURIComponent(FunctionName)}/aliases`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(rest),
    })

    return result
  }

  /**
   * Wait for function to become active
   */
  async waitForFunctionActive(functionName: string, maxWaitSeconds: number = 60): Promise<LambdaFunctionConfiguration> {
    const startTime = Date.now()
    const maxWaitMs = maxWaitSeconds * 1000

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const response = await this.getFunction(functionName)
        const state = response.Configuration?.State

        if (state === 'Active') {
          return response.Configuration!
        }

        if (state === 'Failed') {
          throw new Error(`Function ${functionName} failed: ${response.Configuration?.StateReason}`)
        }

        // Wait 2 seconds before checking again
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
      catch (error: any) {
        if (error.code === 'ResourceNotFoundException') {
          await new Promise(resolve => setTimeout(resolve, 2000))
          continue
        }
        throw error
      }
    }

    throw new Error(`Timeout waiting for function ${functionName} to become active`)
  }

  /**
   * Check if function exists
   */
  async functionExists(functionName: string): Promise<boolean> {
    try {
      await this.getFunction(functionName)
      return true
    }
    catch (error: any) {
      if (error.code === 'ResourceNotFoundException' || error.statusCode === 404) {
        return false
      }
      throw error
    }
  }
}
