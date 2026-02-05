/**
 * Unified Voice Module
 * Provides voice calling and voicemail with S3 storage
 *
 * Similar to the Email and SMS modules, this provides:
 * - Making outbound calls via Connect
 * - Receiving voicemails stored in S3
 * - Voicemail management (list, read, delete)
 * - Call recording storage
 * - Text-to-speech for voice messages
*/

import { ConnectClient } from './connect'
import { S3Client } from './s3'
import { TranscribeClient } from './transcribe'

export interface VoiceClientConfig {
  region?: string
  // S3 bucket for storing voicemails and recordings
  voicemailBucket?: string
  voicemailPrefix?: string
  recordingsPrefix?: string
  // Connect instance for full call center features
  connectInstanceId?: string
  connectContactFlowId?: string
  // Default caller ID
  defaultCallerId?: string
  // Enable automatic transcription of voicemails
  enableTranscription?: boolean
  // Language for transcription
  transcriptionLanguage?: string
}

export interface Voicemail {
  key: string
  from: string
  to: string
  duration: number
  timestamp: Date
  transcription?: string
  transcriptionStatus?: 'pending' | 'processing' | 'completed' | 'failed'
  transcriptionJobName?: string
  audioUrl?: string
  // Read/unread status
  read?: boolean
  readAt?: Date
  // Recording file info
  contentType?: string
  size?: number
  // Raw metadata
  raw?: any
}

export interface CallRecording {
  key: string
  contactId: string
  from?: string
  to?: string
  duration: number
  timestamp: Date
  audioUrl?: string
  contentType?: string
  size?: number
}

export interface MakeCallOptions {
  to: string
  from?: string
  // Text message to speak (TTS)
  message?: string
  // Voice for TTS
  voiceId?: string
  // Audio URL to play
  audioUrl?: string
  // Connect-specific options
  contactFlowId?: string
  attributes?: Record<string, string>
}

export interface SendVoiceMessageOptions {
  to: string
  from?: string
  message: string
  voiceId?: string
  languageCode?: string
}

export interface VoicemailGreeting {
  id: string
  name: string
  type: 'default' | 'busy' | 'unavailable' | 'custom'
  // Text for TTS or audio file key
  text?: string
  audioKey?: string
  audioUrl?: string
  voiceId?: string
  languageCode?: string
  isActive: boolean
  createdAt: Date
  updatedAt?: Date
}

export interface CallForwardingRule {
  id: string
  name: string
  enabled: boolean
  // When to forward
  condition: 'always' | 'busy' | 'no_answer' | 'unreachable' | 'after_hours'
  // Where to forward
  forwardTo: string
  // After how many seconds (for no_answer)
  ringTimeout?: number
  // Business hours (for after_hours condition)
  businessHours?: {
    timezone: string
    schedule: Array<{
      day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
      start: string // HH:MM format
      end: string
    }>
  }
  // Order of priority (lower = higher priority)
  priority: number
  createdAt: Date
  updatedAt?: Date
}

/**
 * Voice Client with S3 voicemail storage
*/
export class VoiceClient {
  private config: VoiceClientConfig
  private connect?: ConnectClient
  private s3?: S3Client
  private transcribe?: TranscribeClient

  constructor(config: VoiceClientConfig = {}) {
    this.config = {
      region: 'us-east-1',
      voicemailPrefix: 'voicemail/',
      recordingsPrefix: 'recordings/',
      transcriptionLanguage: 'en-US',
      ...config,
    }

    if (this.config.connectInstanceId) {
      this.connect = new ConnectClient(this.config.region!)
    }

    if (this.config.voicemailBucket) {
      this.s3 = new S3Client(this.config.region!)
    }

    if (this.config.enableTranscription) {
      this.transcribe = new TranscribeClient(this.config.region!)
    }
  }

  // ============================================
  // Making Calls
  // ============================================

  /**
   * Make an outbound voice call via Connect
  */
  async call(options: MakeCallOptions): Promise<{ callId: string }> {
    if (!this.connect || !this.config.connectInstanceId) {
      throw new Error('Connect instance ID required for voice calls. Set connectInstanceId in config.')
    }

    const from = options.from || this.config.defaultCallerId
    const contactFlowId = options.contactFlowId || this.config.connectContactFlowId

    if (!contactFlowId) {
      throw new Error('Contact flow ID required for Connect calls')
    }

    const result = await this.connect.makeCall({
      instanceId: this.config.connectInstanceId,
      contactFlowId,
      to: options.to,
      from,
      attributes: options.attributes,
    })

    return { callId: result.ContactId || '' }
  }

  /**
   * Send a voice message (one-way TTS call) via Connect
   *
   * Note: This requires a Contact Flow configured for TTS playback.
   * The message is passed as an attribute that the Contact Flow can use.
  */
  async sendVoiceMessage(options: SendVoiceMessageOptions): Promise<{ messageId: string }> {
    const result = await this.call({
      to: options.to,
      from: options.from,
      attributes: {
        message: options.message,
        voiceId: options.voiceId || 'Joanna',
        languageCode: options.languageCode || 'en-US',
      },
    })

    return { messageId: result.callId }
  }

  /**
   * Send a TTS voice message (alias for sendVoiceMessage)
  */
  async speak(to: string, message: string, voiceId?: string): Promise<{ messageId: string }> {
    return this.sendVoiceMessage({ to, message, voiceId })
  }

  // ============================================
  // Voicemail Management (S3 Storage)
  // ============================================

  /**
   * Get voicemails from S3
  */
  async getVoicemails(options: {
    prefix?: string
    maxResults?: number
  } = {}): Promise<Voicemail[]> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Voicemail bucket not configured')
    }

    const prefix = options.prefix || this.config.voicemailPrefix || 'voicemail/'
    const objects = await this.s3.list({
      bucket: this.config.voicemailBucket,
      prefix,
      maxKeys: options.maxResults || 100,
    })

    const voicemails: Voicemail[] = []

    for (const obj of objects || []) {
      if (!obj.Key) continue

      // Skip non-audio files (metadata files, etc.)
      if (obj.Key.endsWith('.json')) {
        continue
      }

      try {
        const voicemail = await this.getVoicemailMetadata(obj.Key)
        if (voicemail) {
          voicemails.push({
            ...voicemail,
            size: obj.Size,
          })
        }
      } catch (err) {
        console.error(`Failed to read voicemail ${obj.Key}:`, err)
      }
    }

    // Sort by timestamp descending (newest first)
    return voicemails.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  }

  /**
   * Get a specific voicemail
  */
  async getVoicemail(key: string): Promise<Voicemail | null> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Voicemail bucket not configured')
    }

    return this.getVoicemailMetadata(key)
  }

  /**
   * Get voicemail audio as a signed URL
  */
  async getVoicemailAudioUrl(key: string, expiresIn: number = 3600): Promise<string> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Voicemail bucket not configured')
    }

    // Generate a presigned URL for the audio file
    return this.s3.getSignedUrl({
      bucket: this.config.voicemailBucket,
      key,
      expiresIn,
    })
  }

  /**
   * Delete a voicemail
  */
  async deleteVoicemail(key: string): Promise<void> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Voicemail bucket not configured')
    }

    // Delete audio file
    await this.s3.deleteObject(this.config.voicemailBucket, key)

    // Delete metadata file if exists
    const metadataKey = key.replace(/\.[^/.]+$/, '.json')
    try {
      await this.s3.deleteObject(this.config.voicemailBucket, metadataKey)
    } catch {
      // Metadata might not exist
    }
  }

  /**
   * Archive a voicemail
  */
  async archiveVoicemail(key: string): Promise<string> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Voicemail bucket not configured')
    }

    const filename = key.split('/').pop() || `${Date.now()}.wav`
    const newKey = `voicemail/archive/${filename}`

    // Copy to archive
    await this.s3.copyObject({
      sourceBucket: this.config.voicemailBucket,
      sourceKey: key,
      destinationBucket: this.config.voicemailBucket,
      destinationKey: newKey,
    })

    // Delete original
    await this.s3.deleteObject(this.config.voicemailBucket, key)

    return newKey
  }

  /**
   * Get voicemail count
  */
  async getVoicemailCount(): Promise<number> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Voicemail bucket not configured')
    }

    const objects = await this.s3.list({
      bucket: this.config.voicemailBucket,
      prefix: this.config.voicemailPrefix || 'voicemail/',
      maxKeys: 1000,
    })

    // Count only audio files, not metadata
    return (objects || []).filter(obj =>
      obj.Key && !obj.Key.endsWith('.json') && !obj.Key.endsWith('/')
    ).length
  }

  /**
   * Get unread voicemail count
  */
  async getUnreadCount(): Promise<number> {
    const voicemails = await this.getVoicemails({ maxResults: 1000 })
    return voicemails.filter(v => !v.read).length
  }

  /**
   * Mark a voicemail as read
  */
  async markAsRead(key: string): Promise<void> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Voicemail bucket not configured')
    }

    const metadataKey = key.replace(/\.[^/.]+$/, '.json')
    try {
      const content = await this.s3.getObject(this.config.voicemailBucket, metadataKey)
      const data = JSON.parse(content)
      data.read = true
      data.readAt = new Date().toISOString()

      await this.s3.putObject({
        bucket: this.config.voicemailBucket,
        key: metadataKey,
        body: JSON.stringify(data, null, 2),
        contentType: 'application/json',
      })
    } catch {
      // Create metadata if it doesn't exist
      await this.s3.putObject({
        bucket: this.config.voicemailBucket,
        key: metadataKey,
        body: JSON.stringify({ read: true, readAt: new Date().toISOString() }, null, 2),
        contentType: 'application/json',
      })
    }
  }

  /**
   * Mark a voicemail as unread
  */
  async markAsUnread(key: string): Promise<void> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Voicemail bucket not configured')
    }

    const metadataKey = key.replace(/\.[^/.]+$/, '.json')
    try {
      const content = await this.s3.getObject(this.config.voicemailBucket, metadataKey)
      const data = JSON.parse(content)
      data.read = false
      delete data.readAt

      await this.s3.putObject({
        bucket: this.config.voicemailBucket,
        key: metadataKey,
        body: JSON.stringify(data, null, 2),
        contentType: 'application/json',
      })
    } catch {
      // Ignore if metadata doesn't exist
    }
  }

  /**
   * Batch mark voicemails as read
  */
  async markManyAsRead(keys: string[]): Promise<void> {
    await Promise.all(keys.map(key => this.markAsRead(key)))
  }

  /**
   * Batch delete voicemails
  */
  async deleteMany(keys: string[]): Promise<void> {
    await Promise.all(keys.map(key => this.deleteVoicemail(key)))
  }

  // ============================================
  // Transcription
  // ============================================

  /**
   * Start transcription for a voicemail
  */
  async transcribeVoicemail(key: string): Promise<{ jobName: string }> {
    if (!this.transcribe) {
      throw new Error('Transcription not enabled. Set enableTranscription: true in config')
    }
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Voicemail bucket not configured')
    }

    const jobName = `voicemail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const mediaUri = `s3://${this.config.voicemailBucket}/${key}`

    // Determine media format from extension
    const ext = key.split('.').pop()?.toLowerCase()
    const mediaFormat = ext === 'mp3' ? 'mp3' : ext === 'wav' ? 'wav' : 'wav'

    await this.transcribe.startTranscriptionJob({
      TranscriptionJobName: jobName,
      LanguageCode: this.config.transcriptionLanguage || 'en-US',
      Media: { MediaFileUri: mediaUri },
      MediaFormat: mediaFormat,
      OutputBucketName: this.config.voicemailBucket,
      OutputKey: key.replace(/\.[^/.]+$/, '-transcript.json'),
    })

    // Update metadata with job info
    const metadataKey = key.replace(/\.[^/.]+$/, '.json')
    try {
      const content = await this.s3.getObject(this.config.voicemailBucket, metadataKey)
      const data = JSON.parse(content)
      data.transcriptionJobName = jobName
      data.transcriptionStatus = 'processing'

      await this.s3.putObject({
        bucket: this.config.voicemailBucket,
        key: metadataKey,
        body: JSON.stringify(data, null, 2),
        contentType: 'application/json',
      })
    } catch {
      // Create metadata if it doesn't exist
      await this.s3.putObject({
        bucket: this.config.voicemailBucket,
        key: metadataKey,
        body: JSON.stringify({
          transcriptionJobName: jobName,
          transcriptionStatus: 'processing',
        }, null, 2),
        contentType: 'application/json',
      })
    }

    return { jobName }
  }

  /**
   * Get transcription status for a voicemail
  */
  async getTranscriptionStatus(jobName: string): Promise<{
    status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED'
    transcription?: string
  }> {
    if (!this.transcribe) {
      throw new Error('Transcription not enabled')
    }

    const job = await this.transcribe.getTranscriptionJob({ TranscriptionJobName: jobName })
    const status = job.TranscriptionJob?.TranscriptionJobStatus

    if (status === 'COMPLETED' && job.TranscriptionJob?.Transcript?.TranscriptFileUri) {
      // Fetch the transcript from S3
      const transcriptUri = job.TranscriptionJob.Transcript.TranscriptFileUri
      // The URI is like s3://bucket/key or https://s3.region.amazonaws.com/bucket/key
      // We need to extract the key
      try {
        if (this.s3 && this.config.voicemailBucket && transcriptUri.includes(this.config.voicemailBucket)) {
          const key = transcriptUri.split(this.config.voicemailBucket + '/')[1]
          if (key) {
            const content = await this.s3.getObject(this.config.voicemailBucket, key)
            const transcript = JSON.parse(content)
            return {
              status: 'COMPLETED',
              transcription: transcript.results?.transcripts?.[0]?.transcript || '',
            }
          }
        }
      } catch {
        // Could not fetch transcript
      }
    }

    return { status: status as 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' }
  }

  /**
   * Update voicemail metadata with completed transcription
  */
  async updateTranscription(key: string, transcription: string): Promise<void> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Voicemail bucket not configured')
    }

    const metadataKey = key.replace(/\.[^/.]+$/, '.json')
    try {
      const content = await this.s3.getObject(this.config.voicemailBucket, metadataKey)
      const data = JSON.parse(content)
      data.transcription = transcription
      data.transcriptionStatus = 'completed'

      await this.s3.putObject({
        bucket: this.config.voicemailBucket,
        key: metadataKey,
        body: JSON.stringify(data, null, 2),
        contentType: 'application/json',
      })
    } catch {
      await this.s3.putObject({
        bucket: this.config.voicemailBucket,
        key: metadataKey,
        body: JSON.stringify({
          transcription,
          transcriptionStatus: 'completed',
        }, null, 2),
        contentType: 'application/json',
      })
    }
  }

  // ============================================
  // Voicemail Greetings
  // ============================================

  /**
   * Create a voicemail greeting
  */
  async createGreeting(greeting: {
    name: string
    type: 'default' | 'busy' | 'unavailable' | 'custom'
    text?: string
    audioData?: Buffer | string
    voiceId?: string
    languageCode?: string
    setActive?: boolean
  }): Promise<VoicemailGreeting> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Voicemail bucket not configured')
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    let audioKey: string | undefined

    // If audio data provided, store it
    if (greeting.audioData) {
      audioKey = `greetings/${id}.wav`
      await this.s3.putObject({
        bucket: this.config.voicemailBucket,
        key: audioKey,
        body: greeting.audioData,
        contentType: 'audio/wav',
      })
    }

    const newGreeting: VoicemailGreeting = {
      id,
      name: greeting.name,
      type: greeting.type,
      text: greeting.text,
      audioKey,
      voiceId: greeting.voiceId || 'Joanna',
      languageCode: greeting.languageCode || 'en-US',
      isActive: greeting.setActive || false,
      createdAt: new Date(),
    }

    // If setting as active, deactivate other greetings of same type
    if (greeting.setActive) {
      await this.deactivateGreetingsOfType(greeting.type)
      newGreeting.isActive = true
    }

    // Store metadata
    await this.s3.putObject({
      bucket: this.config.voicemailBucket,
      key: `greetings/${id}.json`,
      body: JSON.stringify(newGreeting, null, 2),
      contentType: 'application/json',
    })

    return newGreeting
  }

  /**
   * Get all voicemail greetings
  */
  async getGreetings(): Promise<VoicemailGreeting[]> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Voicemail bucket not configured')
    }

    const objects = await this.s3.list({
      bucket: this.config.voicemailBucket,
      prefix: 'greetings/',
      maxKeys: 100,
    })

    const greetings: VoicemailGreeting[] = []
    for (const obj of objects || []) {
      if (!obj.Key || !obj.Key.endsWith('.json')) continue
      try {
        const content = await this.s3.getObject(this.config.voicemailBucket, obj.Key)
        const greeting = JSON.parse(content) as VoicemailGreeting
        greeting.createdAt = new Date(greeting.createdAt)
        if (greeting.updatedAt) greeting.updatedAt = new Date(greeting.updatedAt)
        greetings.push(greeting)
      } catch {
        // Skip invalid
      }
    }

    return greetings.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Get a specific greeting
  */
  async getGreeting(id: string): Promise<VoicemailGreeting | null> {
    if (!this.s3 || !this.config.voicemailBucket) {
      return null
    }

    try {
      const content = await this.s3.getObject(this.config.voicemailBucket, `greetings/${id}.json`)
      const greeting = JSON.parse(content) as VoicemailGreeting
      greeting.createdAt = new Date(greeting.createdAt)
      if (greeting.updatedAt) greeting.updatedAt = new Date(greeting.updatedAt)
      return greeting
    } catch {
      return null
    }
  }

  /**
   * Get the active greeting of a specific type
  */
  async getActiveGreeting(type: 'default' | 'busy' | 'unavailable' | 'custom'): Promise<VoicemailGreeting | null> {
    const greetings = await this.getGreetings()
    return greetings.find(g => g.type === type && g.isActive) || null
  }

  /**
   * Set a greeting as active
  */
  async setActiveGreeting(id: string): Promise<void> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Voicemail bucket not configured')
    }

    const greeting = await this.getGreeting(id)
    if (!greeting) throw new Error(`Greeting ${id} not found`)

    // Deactivate other greetings of same type
    await this.deactivateGreetingsOfType(greeting.type)

    // Activate this greeting
    greeting.isActive = true
    greeting.updatedAt = new Date()

    await this.s3.putObject({
      bucket: this.config.voicemailBucket,
      key: `greetings/${id}.json`,
      body: JSON.stringify(greeting, null, 2),
      contentType: 'application/json',
    })
  }

  /**
   * Deactivate all greetings of a type
  */
  private async deactivateGreetingsOfType(type: string): Promise<void> {
    const greetings = await this.getGreetings()
    for (const g of greetings) {
      if (g.type === type && g.isActive) {
        g.isActive = false
        g.updatedAt = new Date()
        await this.s3!.putObject({
          bucket: this.config.voicemailBucket!,
          key: `greetings/${g.id}.json`,
          body: JSON.stringify(g, null, 2),
          contentType: 'application/json',
        })
      }
    }
  }

  /**
   * Update a greeting
  */
  async updateGreeting(
    id: string,
    updates: { name?: string; text?: string; audioData?: Buffer | string },
  ): Promise<VoicemailGreeting> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Voicemail bucket not configured')
    }

    const greeting = await this.getGreeting(id)
    if (!greeting) throw new Error(`Greeting ${id} not found`)

    if (updates.name) greeting.name = updates.name
    if (updates.text) greeting.text = updates.text
    if (updates.audioData) {
      const audioKey = `greetings/${id}.wav`
      await this.s3.putObject({
        bucket: this.config.voicemailBucket,
        key: audioKey,
        body: updates.audioData,
        contentType: 'audio/wav',
      })
      greeting.audioKey = audioKey
    }
    greeting.updatedAt = new Date()

    await this.s3.putObject({
      bucket: this.config.voicemailBucket,
      key: `greetings/${id}.json`,
      body: JSON.stringify(greeting, null, 2),
      contentType: 'application/json',
    })

    return greeting
  }

  /**
   * Delete a greeting
  */
  async deleteGreeting(id: string): Promise<void> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Voicemail bucket not configured')
    }

    const greeting = await this.getGreeting(id)
    if (greeting?.audioKey) {
      try {
        await this.s3.deleteObject(this.config.voicemailBucket, greeting.audioKey)
      } catch {
        // Audio may not exist
      }
    }

    await this.s3.deleteObject(this.config.voicemailBucket, `greetings/${id}.json`)
  }

  /**
   * Get a signed URL for a greeting audio
  */
  async getGreetingAudioUrl(id: string, expiresIn: number = 3600): Promise<string | null> {
    const greeting = await this.getGreeting(id)
    if (!greeting?.audioKey || !this.s3 || !this.config.voicemailBucket) {
      return null
    }

    return this.s3.getSignedUrl({
      bucket: this.config.voicemailBucket,
      key: greeting.audioKey,
      expiresIn,
    })
  }

  // ============================================
  // Call Forwarding Rules
  // ============================================

  /**
   * Create a call forwarding rule
  */
  async createForwardingRule(rule: {
    name: string
    condition: 'always' | 'busy' | 'no_answer' | 'unreachable' | 'after_hours'
    forwardTo: string
    ringTimeout?: number
    businessHours?: CallForwardingRule['businessHours']
    priority?: number
    enabled?: boolean
  }): Promise<CallForwardingRule> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Voicemail bucket not configured')
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const newRule: CallForwardingRule = {
      id,
      name: rule.name,
      enabled: rule.enabled !== false,
      condition: rule.condition,
      forwardTo: rule.forwardTo,
      ringTimeout: rule.ringTimeout || 20,
      businessHours: rule.businessHours,
      priority: rule.priority || 100,
      createdAt: new Date(),
    }

    await this.s3.putObject({
      bucket: this.config.voicemailBucket,
      key: `forwarding/${id}.json`,
      body: JSON.stringify(newRule, null, 2),
      contentType: 'application/json',
    })

    return newRule
  }

  /**
   * Get all forwarding rules
  */
  async getForwardingRules(): Promise<CallForwardingRule[]> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Voicemail bucket not configured')
    }

    const objects = await this.s3.list({
      bucket: this.config.voicemailBucket,
      prefix: 'forwarding/',
      maxKeys: 100,
    })

    const rules: CallForwardingRule[] = []
    for (const obj of objects || []) {
      if (!obj.Key || !obj.Key.endsWith('.json')) continue
      try {
        const content = await this.s3.getObject(this.config.voicemailBucket, obj.Key)
        const rule = JSON.parse(content) as CallForwardingRule
        rule.createdAt = new Date(rule.createdAt)
        if (rule.updatedAt) rule.updatedAt = new Date(rule.updatedAt)
        rules.push(rule)
      } catch {
        // Skip invalid
      }
    }

    return rules.sort((a, b) => a.priority - b.priority)
  }

  /**
   * Get a specific forwarding rule
  */
  async getForwardingRule(id: string): Promise<CallForwardingRule | null> {
    if (!this.s3 || !this.config.voicemailBucket) {
      return null
    }

    try {
      const content = await this.s3.getObject(this.config.voicemailBucket, `forwarding/${id}.json`)
      const rule = JSON.parse(content) as CallForwardingRule
      rule.createdAt = new Date(rule.createdAt)
      if (rule.updatedAt) rule.updatedAt = new Date(rule.updatedAt)
      return rule
    } catch {
      return null
    }
  }

  /**
   * Update a forwarding rule
  */
  async updateForwardingRule(
    id: string,
    updates: Partial<Omit<CallForwardingRule, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<CallForwardingRule> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Voicemail bucket not configured')
    }

    const rule = await this.getForwardingRule(id)
    if (!rule) throw new Error(`Forwarding rule ${id} not found`)

    if (updates.name !== undefined) rule.name = updates.name
    if (updates.enabled !== undefined) rule.enabled = updates.enabled
    if (updates.condition !== undefined) rule.condition = updates.condition
    if (updates.forwardTo !== undefined) rule.forwardTo = updates.forwardTo
    if (updates.ringTimeout !== undefined) rule.ringTimeout = updates.ringTimeout
    if (updates.businessHours !== undefined) rule.businessHours = updates.businessHours
    if (updates.priority !== undefined) rule.priority = updates.priority
    rule.updatedAt = new Date()

    await this.s3.putObject({
      bucket: this.config.voicemailBucket,
      key: `forwarding/${id}.json`,
      body: JSON.stringify(rule, null, 2),
      contentType: 'application/json',
    })

    return rule
  }

  /**
   * Enable/disable a forwarding rule
  */
  async setForwardingRuleEnabled(id: string, enabled: boolean): Promise<void> {
    await this.updateForwardingRule(id, { enabled })
  }

  /**
   * Delete a forwarding rule
  */
  async deleteForwardingRule(id: string): Promise<void> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Voicemail bucket not configured')
    }

    await this.s3.deleteObject(this.config.voicemailBucket, `forwarding/${id}.json`)
  }

  /**
   * Get the applicable forwarding rule for current conditions
   * Returns the highest priority enabled rule that matches current conditions
  */
  async getApplicableForwardingRule(
    currentConditions: {
      isBusy?: boolean
      isUnreachable?: boolean
      noAnswer?: boolean
    } = {},
  ): Promise<CallForwardingRule | null> {
    const rules = await this.getForwardingRules()
    const now = new Date()

    for (const rule of rules) {
      if (!rule.enabled) continue

      switch (rule.condition) {
        case 'always':
          return rule
        case 'busy':
          if (currentConditions.isBusy) return rule
          break
        case 'no_answer':
          if (currentConditions.noAnswer) return rule
          break
        case 'unreachable':
          if (currentConditions.isUnreachable) return rule
          break
        case 'after_hours':
          if (rule.businessHours && !this.isWithinBusinessHours(now, rule.businessHours)) {
            return rule
          }
          break
      }
    }

    return null
  }

  /**
   * Check if a time is within business hours
  */
  private isWithinBusinessHours(
    date: Date,
    businessHours: NonNullable<CallForwardingRule['businessHours']>,
  ): boolean {
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

    // Convert to business timezone if needed (simplified - uses local time)
    const dayName = days[date.getDay()]
    const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`

    for (const schedule of businessHours.schedule) {
      if (schedule.day === dayName) {
        if (timeStr >= schedule.start && timeStr <= schedule.end) {
          return true
        }
      }
    }

    return false
  }

  // ============================================
  // Call Recordings (Connect)
  // ============================================

  /**
   * Get call recordings from S3
  */
  async getRecordings(options: {
    prefix?: string
    maxResults?: number
  } = {}): Promise<CallRecording[]> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Recordings bucket not configured')
    }

    const prefix = options.prefix || this.config.recordingsPrefix || 'recordings/'
    const objects = await this.s3.list({
      bucket: this.config.voicemailBucket,
      prefix,
      maxKeys: options.maxResults || 100,
    })

    const recordings: CallRecording[] = []

    for (const obj of objects || []) {
      if (!obj.Key || obj.Key.endsWith('.json') || obj.Key.endsWith('/')) continue

      try {
        // Try to get metadata
        const metadataKey = obj.Key.replace(/\.[^/.]+$/, '.json')
        let metadata: any = {}

        try {
          const metadataContent = await this.s3.getObject(this.config.voicemailBucket!, metadataKey)
          metadata = JSON.parse(metadataContent)
        } catch {
          // No metadata file
        }

        recordings.push({
          key: obj.Key,
          contactId: metadata.contactId || obj.Key.split('/').pop()?.split('.')[0] || '',
          from: metadata.from,
          to: metadata.to,
          duration: metadata.duration || 0,
          timestamp: new Date(obj.LastModified || Date.now()),
          contentType: 'audio/wav',
          size: obj.Size,
        })
      } catch (err) {
        console.error(`Failed to read recording ${obj.Key}:`, err)
      }
    }

    return recordings.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  }

  /**
   * Get a recording audio URL
  */
  async getRecordingUrl(key: string, expiresIn: number = 3600): Promise<string> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Recordings bucket not configured')
    }

    return this.s3.getSignedUrl({
      bucket: this.config.voicemailBucket,
      key,
      expiresIn,
    })
  }

  // ============================================
  // Voicemail Ingestion
  // ============================================

  /**
   * Store an incoming voicemail to S3
   * This is typically called from a Lambda handler
  */
  async storeVoicemail(voicemail: {
    from: string
    to: string
    audioData: Buffer | string
    duration?: number
    transcription?: string
    contentType?: string
    timestamp?: Date
  }): Promise<string> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Voicemail bucket not configured')
    }

    const timestamp = voicemail.timestamp || new Date()
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const ext = voicemail.contentType === 'audio/mp3' ? 'mp3' : 'wav'
    const audioKey = `${this.config.voicemailPrefix}${timestamp.toISOString().split('T')[0]}/${id}.${ext}`
    const metadataKey = `${this.config.voicemailPrefix}${timestamp.toISOString().split('T')[0]}/${id}.json`

    // Store audio file
    await this.s3.putObject({
      bucket: this.config.voicemailBucket,
      key: audioKey,
      body: voicemail.audioData,
      contentType: voicemail.contentType || 'audio/wav',
    })

    // Store metadata
    const metadata = {
      from: voicemail.from,
      to: voicemail.to,
      duration: voicemail.duration || 0,
      transcription: voicemail.transcription,
      timestamp: timestamp.toISOString(),
      audioKey,
    }

    await this.s3.putObject({
      bucket: this.config.voicemailBucket,
      key: metadataKey,
      body: JSON.stringify(metadata, null, 2),
      contentType: 'application/json',
    })

    return audioKey
  }

  /**
   * Store a call recording to S3
  */
  async storeRecording(recording: {
    contactId: string
    from?: string
    to?: string
    audioData: Buffer | string
    duration?: number
    contentType?: string
    timestamp?: Date
  }): Promise<string> {
    if (!this.s3 || !this.config.voicemailBucket) {
      throw new Error('Recordings bucket not configured')
    }

    const timestamp = recording.timestamp || new Date()
    const ext = recording.contentType === 'audio/mp3' ? 'mp3' : 'wav'
    const audioKey = `${this.config.recordingsPrefix}${timestamp.toISOString().split('T')[0]}/${recording.contactId}.${ext}`
    const metadataKey = `${this.config.recordingsPrefix}${timestamp.toISOString().split('T')[0]}/${recording.contactId}.json`

    // Store audio file
    await this.s3.putObject({
      bucket: this.config.voicemailBucket,
      key: audioKey,
      body: recording.audioData,
      contentType: recording.contentType || 'audio/wav',
    })

    // Store metadata
    const metadata = {
      contactId: recording.contactId,
      from: recording.from,
      to: recording.to,
      duration: recording.duration || 0,
      timestamp: timestamp.toISOString(),
      audioKey,
    }

    await this.s3.putObject({
      bucket: this.config.voicemailBucket,
      key: metadataKey,
      body: JSON.stringify(metadata, null, 2),
      contentType: 'application/json',
    })

    return audioKey
  }

  // ============================================
  // Private Helpers
  // ============================================

  /**
   * Get voicemail metadata from S3
  */
  private async getVoicemailMetadata(audioKey: string): Promise<Voicemail | null> {
    if (!this.s3 || !this.config.voicemailBucket) {
      return null
    }

    // Try to get metadata file
    const metadataKey = audioKey.replace(/\.[^/.]+$/, '.json')

    try {
      const metadataContent = await this.s3.getObject(this.config.voicemailBucket, metadataKey)
      const metadata = JSON.parse(metadataContent)

      return {
        key: audioKey,
        from: metadata.from || 'unknown',
        to: metadata.to || 'unknown',
        duration: metadata.duration || 0,
        timestamp: new Date(metadata.timestamp || Date.now()),
        transcription: metadata.transcription,
        contentType: audioKey.endsWith('.mp3') ? 'audio/mp3' : 'audio/wav',
        raw: metadata,
      }
    } catch {
      // No metadata file, return basic info
      return {
        key: audioKey,
        from: 'unknown',
        to: 'unknown',
        duration: 0,
        timestamp: new Date(),
        contentType: audioKey.endsWith('.mp3') ? 'audio/mp3' : 'audio/wav',
      }
    }
  }
}

// ============================================
// Lambda Handlers
// ============================================

/**
 * Create a Lambda handler for processing incoming voicemails
 * Use this with Connect's voicemail feature or custom IVR
 *
 * @example
 * ```typescript
 * // lambda.ts
 * import { createVoicemailHandler } from 'ts-cloud/aws/voice'
 *
 * export const handler = createVoicemailHandler({
 *   bucket: 'my-voicemail-bucket',
 *   prefix: 'voicemail/',
 *   region: 'us-east-1',
 * })
 * ```
*/
export function createVoicemailHandler(config: {
  bucket: string
  prefix?: string
  region?: string
  onVoicemail?: (voicemail: Voicemail) => Promise<void>
}) {
  const voiceClient = new VoiceClient({
    region: config.region || 'us-east-1',
    voicemailBucket: config.bucket,
    voicemailPrefix: config.prefix || 'voicemail/',
  })

  return async (event: any): Promise<any> => {
    console.log('Incoming voicemail event:', JSON.stringify(event))

    // Handle S3 event (audio file uploaded)
    if (event.Records) {
      for (const record of event.Records) {
        if (record.s3) {
          const bucket = record.s3.bucket.name
          const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '))

          // Skip metadata files
          if (key.endsWith('.json')) continue

          console.log(`Processing voicemail: ${bucket}/${key}`)

          if (config.onVoicemail) {
            const voicemail = await voiceClient.getVoicemail(key)
            if (voicemail) {
              await config.onVoicemail(voicemail)
            }
          }
        }
      }
    }

    // Handle Connect event (from contact flow)
    if (event.Details?.ContactData) {
      const contactData = event.Details.ContactData
      console.log(`Connect voicemail from: ${contactData.CustomerEndpoint?.Address}`)

      // The actual audio would need to be fetched from Connect's recording API
      // This is triggered after the voicemail is recorded

      if (config.onVoicemail && event.audioData) {
        const key = await voiceClient.storeVoicemail({
          from: contactData.CustomerEndpoint?.Address || 'unknown',
          to: contactData.SystemEndpoint?.Address || 'unknown',
          audioData: event.audioData,
          duration: event.duration,
          transcription: event.transcription,
        })

        const voicemail = await voiceClient.getVoicemail(key)
        if (voicemail) {
          await config.onVoicemail(voicemail)
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Voicemail processed' }),
    }
  }
}

/**
 * Create a Lambda handler for Connect recording events
 * This processes call recordings uploaded to S3 by Connect
*/
export function createRecordingHandler(config: {
  bucket: string
  prefix?: string
  region?: string
  onRecording?: (recording: CallRecording) => Promise<void>
}) {
  const voiceClient = new VoiceClient({
    region: config.region || 'us-east-1',
    voicemailBucket: config.bucket,
    recordingsPrefix: config.prefix || 'recordings/',
  })

  return async (event: any): Promise<any> => {
    console.log('Recording event:', JSON.stringify(event))

    // Handle S3 event
    if (event.Records) {
      for (const record of event.Records) {
        if (record.s3) {
          const bucket = record.s3.bucket.name
          const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '))

          if (key.endsWith('.json')) continue

          console.log(`Processing recording: ${bucket}/${key}`)

          if (config.onRecording) {
            const recordings = await voiceClient.getRecordings({ prefix: key })
            if (recordings.length > 0) {
              await config.onRecording(recordings[0])
            }
          }
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Recording processed' }),
    }
  }
}

/**
 * Convenience function to create a voice client
*/
export function createVoiceClient(config?: VoiceClientConfig): VoiceClient {
  return new VoiceClient(config)
}
