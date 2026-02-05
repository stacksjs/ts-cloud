/**
 * AWS Polly Client
 * Text-to-Speech service
 * No external SDK dependencies - implements AWS Signature V4 directly
*/

import { AWSClient } from './client'

// ============================================================================
// Types
// ============================================================================

export type VoiceId =
  | 'Aditi' | 'Amy' | 'Aria' | 'Arlet' | 'Arthur' | 'Astrid'
  | 'Ayanda' | 'Bianca' | 'Brian' | 'Camila' | 'Carla' | 'Carmen'
  | 'Celine' | 'Chantal' | 'Conchita' | 'Cristiano' | 'Daniel' | 'Dora'
  | 'Elin' | 'Emma' | 'Enrique' | 'Ewa' | 'Filiz' | 'Gabrielle'
  | 'Geraint' | 'Giorgio' | 'Gwyneth' | 'Hala' | 'Hannah' | 'Hans'
  | 'Hiujin' | 'Ida' | 'Ines' | 'Ivy' | 'Jacek' | 'Jan'
  | 'Joanna' | 'Joey' | 'Justin' | 'Kajal' | 'Karl' | 'Kazuha'
  | 'Kendra' | 'Kevin' | 'Kimberly' | 'Laura' | 'Lea' | 'Liam'
  | 'Lisa' | 'Liv' | 'Lotte' | 'Lucia' | 'Lupe' | 'Mads'
  | 'Maja' | 'Marlene' | 'Mathieu' | 'Matthew' | 'Maxim' | 'Mia'
  | 'Miguel' | 'Mizuki' | 'Naja' | 'Niamh' | 'Nicole' | 'Ola'
  | 'Olivia' | 'Pedro' | 'Penelope' | 'Raveena' | 'Remi' | 'Ricardo'
  | 'Ruben' | 'Russell' | 'Ruth' | 'Salli' | 'Seoyeon' | 'Sergio'
  | 'Sofie' | 'Stephen' | 'Suvi' | 'Takumi' | 'Tatyana' | 'Thiago'
  | 'Tomoko' | 'Vicki' | 'Vitoria' | 'Zayd' | 'Zeina' | 'Zhiyu'

export type LanguageCode =
  | 'arb' | 'ca-ES' | 'cmn-CN' | 'cy-GB' | 'da-DK' | 'de-AT' | 'de-DE'
  | 'en-AU' | 'en-GB' | 'en-GB-WLS' | 'en-IE' | 'en-IN' | 'en-NZ' | 'en-US' | 'en-ZA'
  | 'es-ES' | 'es-MX' | 'es-US' | 'fi-FI' | 'fr-BE' | 'fr-CA' | 'fr-FR'
  | 'hi-IN' | 'is-IS' | 'it-IT' | 'ja-JP' | 'ko-KR' | 'nb-NO' | 'nl-BE' | 'nl-NL'
  | 'pl-PL' | 'pt-BR' | 'pt-PT' | 'ro-RO' | 'ru-RU' | 'sv-SE' | 'tr-TR' | 'yue-CN'

export type Engine = 'standard' | 'neural' | 'long-form' | 'generative'

export type OutputFormat = 'json' | 'mp3' | 'ogg_vorbis' | 'pcm'

export type TextType = 'ssml' | 'text'

export type SpeechMarkType = 'sentence' | 'ssml' | 'viseme' | 'word'

export interface Voice {
  Gender?: 'Female' | 'Male'
  Id?: VoiceId
  LanguageCode?: LanguageCode
  LanguageName?: string
  Name?: string
  AdditionalLanguageCodes?: LanguageCode[]
  SupportedEngines?: Engine[]
}

export interface SynthesizeSpeechCommandInput {
  Engine?: Engine
  LanguageCode?: LanguageCode
  LexiconNames?: string[]
  OutputFormat: OutputFormat
  SampleRate?: string
  SpeechMarkTypes?: SpeechMarkType[]
  Text: string
  TextType?: TextType
  VoiceId: VoiceId
}

export interface SynthesizeSpeechCommandOutput {
  AudioStream?: Uint8Array
  ContentType?: string
  RequestCharacters?: number
}

export interface DescribeVoicesCommandInput {
  Engine?: Engine
  LanguageCode?: LanguageCode
  IncludeAdditionalLanguageCodes?: boolean
  NextToken?: string
}

export interface DescribeVoicesCommandOutput {
  Voices?: Voice[]
  NextToken?: string
}

export interface StartSpeechSynthesisTaskCommandInput {
  Engine?: Engine
  LanguageCode?: LanguageCode
  LexiconNames?: string[]
  OutputFormat: OutputFormat
  OutputS3BucketName: string
  OutputS3KeyPrefix?: string
  SampleRate?: string
  SnsTopicArn?: string
  SpeechMarkTypes?: SpeechMarkType[]
  Text: string
  TextType?: TextType
  VoiceId: VoiceId
}

export interface SynthesisTask {
  Engine?: Engine
  TaskId?: string
  TaskStatus?: 'scheduled' | 'inProgress' | 'completed' | 'failed'
  TaskStatusReason?: string
  OutputUri?: string
  CreationTime?: string
  RequestCharacters?: number
  SnsTopicArn?: string
  LexiconNames?: string[]
  OutputFormat?: OutputFormat
  SampleRate?: string
  SpeechMarkTypes?: SpeechMarkType[]
  TextType?: TextType
  VoiceId?: VoiceId
  LanguageCode?: LanguageCode
}

export interface StartSpeechSynthesisTaskCommandOutput {
  SynthesisTask?: SynthesisTask
}

export interface GetSpeechSynthesisTaskCommandInput {
  TaskId: string
}

export interface GetSpeechSynthesisTaskCommandOutput {
  SynthesisTask?: SynthesisTask
}

export interface ListSpeechSynthesisTasksCommandInput {
  MaxResults?: number
  NextToken?: string
  Status?: 'scheduled' | 'inProgress' | 'completed' | 'failed'
}

export interface ListSpeechSynthesisTasksCommandOutput {
  NextToken?: string
  SynthesisTasks?: SynthesisTask[]
}

export interface PutLexiconCommandInput {
  Name: string
  Content: string
}

export interface PutLexiconCommandOutput {
  // Empty
}

export interface GetLexiconCommandInput {
  Name: string
}

export interface Lexicon {
  Content?: string
  Name?: string
}

export interface LexiconAttributes {
  Alphabet?: string
  LanguageCode?: LanguageCode
  LastModified?: string
  LexemesCount?: number
  LexiconArn?: string
  Size?: number
}

export interface GetLexiconCommandOutput {
  Lexicon?: Lexicon
  LexiconAttributes?: LexiconAttributes
}

export interface DeleteLexiconCommandInput {
  Name: string
}

export interface DeleteLexiconCommandOutput {
  // Empty
}

export interface ListLexiconsCommandInput {
  NextToken?: string
}

export interface ListLexiconsCommandOutput {
  Lexicons?: Array<{
    Name?: string
    Attributes?: LexiconAttributes
  }>
  NextToken?: string
}

// ============================================================================
// Polly Client
// ============================================================================

export class PollyClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  // -------------------------------------------------------------------------
  // Speech Synthesis
  // -------------------------------------------------------------------------

  /**
   * Synthesize speech from text (synchronous)
  */
  async synthesizeSpeech(params: SynthesizeSpeechCommandInput): Promise<SynthesizeSpeechCommandOutput> {
    const result = await this.client.request({
      service: 'polly',
      region: this.region,
      method: 'POST',
      path: '/v1/speech',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        Engine: params.Engine,
        LanguageCode: params.LanguageCode,
        LexiconNames: params.LexiconNames,
        OutputFormat: params.OutputFormat,
        SampleRate: params.SampleRate,
        SpeechMarkTypes: params.SpeechMarkTypes,
        Text: params.Text,
        TextType: params.TextType,
        VoiceId: params.VoiceId,
      }),
      rawResponse: true,
      returnHeaders: true,
    })

    return {
      AudioStream: new TextEncoder().encode(result.body),
      ContentType: result.headers?.['content-type'],
      RequestCharacters: result.headers?.['x-amzn-requestcharacters']
        ? Number.parseInt(result.headers['x-amzn-requestcharacters'])
        : undefined,
    }
  }

  /**
   * Start async speech synthesis task
  */
  async startSpeechSynthesisTask(params: StartSpeechSynthesisTaskCommandInput): Promise<StartSpeechSynthesisTaskCommandOutput> {
    return this.client.request({
      service: 'polly',
      region: this.region,
      method: 'POST',
      path: '/v1/synthesisTasks',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * Get speech synthesis task status
  */
  async getSpeechSynthesisTask(params: GetSpeechSynthesisTaskCommandInput): Promise<GetSpeechSynthesisTaskCommandOutput> {
    return this.client.request({
      service: 'polly',
      region: this.region,
      method: 'GET',
      path: `/v1/synthesisTasks/${encodeURIComponent(params.TaskId)}`,
    })
  }

  /**
   * List speech synthesis tasks
  */
  async listSpeechSynthesisTasks(params?: ListSpeechSynthesisTasksCommandInput): Promise<ListSpeechSynthesisTasksCommandOutput> {
    const queryParams: Record<string, string> = {}
    if (params?.MaxResults) queryParams.MaxResults = params.MaxResults.toString()
    if (params?.NextToken) queryParams.NextToken = params.NextToken
    if (params?.Status) queryParams.Status = params.Status

    return this.client.request({
      service: 'polly',
      region: this.region,
      method: 'GET',
      path: '/v1/synthesisTasks',
      queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    })
  }

  // -------------------------------------------------------------------------
  // Voices
  // -------------------------------------------------------------------------

  /**
   * List available voices
  */
  async describeVoices(params?: DescribeVoicesCommandInput): Promise<DescribeVoicesCommandOutput> {
    const queryParams: Record<string, string> = {}
    if (params?.Engine) queryParams.Engine = params.Engine
    if (params?.LanguageCode) queryParams.LanguageCode = params.LanguageCode
    if (params?.IncludeAdditionalLanguageCodes !== undefined) {
      queryParams.IncludeAdditionalLanguageCodes = params.IncludeAdditionalLanguageCodes.toString()
    }
    if (params?.NextToken) queryParams.NextToken = params.NextToken

    return this.client.request({
      service: 'polly',
      region: this.region,
      method: 'GET',
      path: '/v1/voices',
      queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    })
  }

  // -------------------------------------------------------------------------
  // Lexicons
  // -------------------------------------------------------------------------

  /**
   * Store a pronunciation lexicon
  */
  async putLexicon(params: PutLexiconCommandInput): Promise<PutLexiconCommandOutput> {
    return this.client.request({
      service: 'polly',
      region: this.region,
      method: 'PUT',
      path: `/v1/lexicons/${encodeURIComponent(params.Name)}`,
      headers: {
        'Content-Type': 'application/pls+xml',
      },
      body: params.Content,
    })
  }

  /**
   * Get a lexicon
  */
  async getLexicon(params: GetLexiconCommandInput): Promise<GetLexiconCommandOutput> {
    return this.client.request({
      service: 'polly',
      region: this.region,
      method: 'GET',
      path: `/v1/lexicons/${encodeURIComponent(params.Name)}`,
    })
  }

  /**
   * Delete a lexicon
  */
  async deleteLexicon(params: DeleteLexiconCommandInput): Promise<DeleteLexiconCommandOutput> {
    return this.client.request({
      service: 'polly',
      region: this.region,
      method: 'DELETE',
      path: `/v1/lexicons/${encodeURIComponent(params.Name)}`,
    })
  }

  /**
   * List lexicons
  */
  async listLexicons(params?: ListLexiconsCommandInput): Promise<ListLexiconsCommandOutput> {
    const queryParams: Record<string, string> = {}
    if (params?.NextToken) queryParams.NextToken = params.NextToken

    return this.client.request({
      service: 'polly',
      region: this.region,
      method: 'GET',
      path: '/v1/lexicons',
      queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    })
  }

  // -------------------------------------------------------------------------
  // Convenience Methods
  // -------------------------------------------------------------------------

  /**
   * Simple text to speech - returns MP3 audio bytes
  */
  async textToSpeech(
    text: string,
    options?: {
      voiceId?: VoiceId
      engine?: Engine
      languageCode?: LanguageCode
    },
  ): Promise<Uint8Array> {
    const result = await this.synthesizeSpeech({
      Text: text,
      VoiceId: options?.voiceId || 'Joanna',
      Engine: options?.engine || 'neural',
      LanguageCode: options?.languageCode,
      OutputFormat: 'mp3',
    })
    return result.AudioStream || new Uint8Array()
  }

  /**
   * Text to speech with SSML support
  */
  async ssmlToSpeech(
    ssml: string,
    options?: {
      voiceId?: VoiceId
      engine?: Engine
      languageCode?: LanguageCode
    },
  ): Promise<Uint8Array> {
    const result = await this.synthesizeSpeech({
      Text: ssml,
      TextType: 'ssml',
      VoiceId: options?.voiceId || 'Joanna',
      Engine: options?.engine || 'neural',
      LanguageCode: options?.languageCode,
      OutputFormat: 'mp3',
    })
    return result.AudioStream || new Uint8Array()
  }

  /**
   * Save speech to S3 (for longer texts)
  */
  async saveToS3(
    text: string,
    bucket: string,
    keyPrefix: string,
    options?: {
      voiceId?: VoiceId
      engine?: Engine
      languageCode?: LanguageCode
      textType?: TextType
    },
  ): Promise<{ taskId: string; outputUri: string }> {
    const result = await this.startSpeechSynthesisTask({
      Text: text,
      TextType: options?.textType || 'text',
      VoiceId: options?.voiceId || 'Joanna',
      Engine: options?.engine || 'neural',
      LanguageCode: options?.languageCode,
      OutputFormat: 'mp3',
      OutputS3BucketName: bucket,
      OutputS3KeyPrefix: keyPrefix,
    })

    return {
      taskId: result.SynthesisTask?.TaskId || '',
      outputUri: result.SynthesisTask?.OutputUri || '',
    }
  }

  /**
   * List voices for a specific language
  */
  async listVoicesForLanguage(languageCode: LanguageCode): Promise<Voice[]> {
    const result = await this.describeVoices({ LanguageCode: languageCode })
    return result.Voices || []
  }

  /**
   * List neural voices
  */
  async listNeuralVoices(): Promise<Voice[]> {
    const result = await this.describeVoices({ Engine: 'neural' })
    return result.Voices || []
  }

  /**
   * Wait for synthesis task to complete
  */
  async waitForTask(
    taskId: string,
    options?: { maxWaitMs?: number; pollIntervalMs?: number },
  ): Promise<SynthesisTask> {
    const maxWaitMs = options?.maxWaitMs ?? 300000 // 5 minutes
    const pollIntervalMs = options?.pollIntervalMs ?? 5000
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      const result = await this.getSpeechSynthesisTask({ TaskId: taskId })
      const task = result.SynthesisTask

      if (task?.TaskStatus === 'completed') {
        return task
      }
      if (task?.TaskStatus === 'failed') {
        throw new Error(`Polly task ${taskId} failed: ${task.TaskStatusReason}`)
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }

    throw new Error(`Timeout waiting for Polly task ${taskId}`)
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Quick text to speech
*/
export async function textToSpeech(
  text: string,
  options?: {
    voiceId?: VoiceId
    engine?: Engine
    region?: string
  },
): Promise<Uint8Array> {
  const client = new PollyClient(options?.region || 'us-east-1')
  return client.textToSpeech(text, options)
}

/**
 * List available voices
*/
export async function listVoices(
  options?: {
    languageCode?: LanguageCode
    engine?: Engine
    region?: string
  },
): Promise<Voice[]> {
  const client = new PollyClient(options?.region || 'us-east-1')
  const result = await client.describeVoices({
    LanguageCode: options?.languageCode,
    Engine: options?.engine,
  })
  return result.Voices || []
}

/**
 * Create SSML with speech marks (pauses, emphasis, etc.)
*/
export function createSSML(text: string, options?: {
  rate?: 'x-slow' | 'slow' | 'medium' | 'fast' | 'x-fast'
  pitch?: 'x-low' | 'low' | 'medium' | 'high' | 'x-high'
  volume?: 'silent' | 'x-soft' | 'soft' | 'medium' | 'loud' | 'x-loud'
}): string {
  let ssml = '<speak>'

  if (options?.rate || options?.pitch || options?.volume) {
    ssml += '<prosody'
    if (options.rate) ssml += ` rate="${options.rate}"`
    if (options.pitch) ssml += ` pitch="${options.pitch}"`
    if (options.volume) ssml += ` volume="${options.volume}"`
    ssml += `>${text}</prosody>`
  } else {
    ssml += text
  }

  ssml += '</speak>'
  return ssml
}
