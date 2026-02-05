/**
 * AWS Transcribe Client
 * Direct API calls for Transcribe operations
*/

import { AWSClient } from './client'

export interface TranscriptionJob {
  TranscriptionJobName: string
  TranscriptionJobStatus: 'QUEUED' | 'IN_PROGRESS' | 'FAILED' | 'COMPLETED'
  LanguageCode?: string
  MediaSampleRateHertz?: number
  MediaFormat?: string
  Media?: {
    MediaFileUri?: string
  }
  Transcript?: {
    TranscriptFileUri?: string
  }
  StartTime?: string
  CreationTime?: string
  CompletionTime?: string
  FailureReason?: string
}

/**
 * Transcribe client for direct API calls
*/
export class TranscribeClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  private async request<T>(action: string, params: Record<string, any>): Promise<T> {
    return this.client.request({
      service: 'transcribe',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `Transcribe.${action}`,
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * Start a transcription job
  */
  async startTranscriptionJob(params: {
    TranscriptionJobName: string
    LanguageCode: string
    MediaFormat?: 'mp3' | 'mp4' | 'wav' | 'flac' | 'ogg' | 'amr' | 'webm'
    Media: {
      MediaFileUri: string
    }
    OutputBucketName?: string
    OutputKey?: string
    Settings?: {
      ShowSpeakerLabels?: boolean
      MaxSpeakerLabels?: number
      ChannelIdentification?: boolean
      ShowAlternatives?: boolean
      MaxAlternatives?: number
    }
  }): Promise<{ TranscriptionJob: TranscriptionJob }> {
    return this.request('StartTranscriptionJob', params)
  }

  /**
   * Get transcription job details
  */
  async getTranscriptionJob(params: {
    TranscriptionJobName: string
  }): Promise<{ TranscriptionJob: TranscriptionJob }> {
    return this.request('GetTranscriptionJob', params)
  }

  /**
   * List transcription jobs
  */
  async listTranscriptionJobs(params?: {
    Status?: 'QUEUED' | 'IN_PROGRESS' | 'FAILED' | 'COMPLETED'
    JobNameContains?: string
    NextToken?: string
    MaxResults?: number
  }): Promise<{
    Status?: string
    NextToken?: string
    TranscriptionJobSummaries: TranscriptionJob[]
  }> {
    return this.request('ListTranscriptionJobs', params || {})
  }

  /**
   * Delete a transcription job
  */
  async deleteTranscriptionJob(params: {
    TranscriptionJobName: string
  }): Promise<void> {
    return this.request('DeleteTranscriptionJob', params)
  }
}
