/**
 * Firebase Cloud Messaging (FCM) Client
 * Uses FCM HTTP v1 API with Google OAuth2 authentication
 *
 * Prerequisites:
 * - Firebase project
 * - Service account JSON key from Firebase Console
 *
 * @example
 * ```ts
 * const fcm = new FCMClient({
 *   projectId: 'your-project-id',
 *   clientEmail: 'firebase-adminsdk@project.iam.gserviceaccount.com',
 *   privateKey: '-----BEGIN PRIVATE KEY-----\n...',
 * })
 *
 * await fcm.send({
 *   token: '...',
 *   title: 'Hello',
 *   body: 'World',
 * })
 * ```
 */

import { createSign } from 'node:crypto'

export interface FCMConfig {
  /** Firebase project ID */
  projectId: string
  /** Service account client email */
  clientEmail: string
  /** Service account private key (PEM format) */
  privateKey: string
}

export interface FCMNotification {
  /** Device FCM token */
  token?: string
  /** Topic to send to (instead of token) */
  topic?: string
  /** Condition expression for targeting multiple topics */
  condition?: string
  /** Notification title */
  title?: string
  /** Notification body */
  body?: string
  /** Notification image URL */
  imageUrl?: string
  /** Custom data payload */
  data?: Record<string, string>
  /** Android-specific options */
  android?: {
    /** Channel ID for Android O+ */
    channelId?: string
    /** Notification priority */
    priority?: 'normal' | 'high'
    /** Time to live in seconds */
    ttl?: number
    /** Collapse key for message deduplication */
    collapseKey?: string
    /** Notification icon */
    icon?: string
    /** Notification icon color (hex) */
    color?: string
    /** Sound to play */
    sound?: string
    /** Click action */
    clickAction?: string
    /** Tag for notification replacement */
    tag?: string
    /** Direct boot aware */
    directBootOk?: boolean
    /** Visibility: private, public, secret */
    visibility?: 'private' | 'public' | 'secret'
    /** Notification count */
    notificationCount?: number
  }
  /** Web push options */
  webpush?: {
    /** Web notification options */
    notification?: {
      title?: string
      body?: string
      icon?: string
      badge?: string
      image?: string
      requireInteraction?: boolean
      silent?: boolean
      tag?: string
      actions?: Array<{ action: string; title: string; icon?: string }>
    }
    /** FCM options for web */
    fcmOptions?: {
      link?: string
      analyticsLabel?: string
    }
    /** Custom headers */
    headers?: Record<string, string>
    /** Custom data */
    data?: Record<string, string>
  }
  /** APNS options (for iOS via FCM) */
  apns?: {
    /** APNs headers */
    headers?: Record<string, string>
    /** APNs payload */
    payload?: {
      aps?: Record<string, any>
      [key: string]: any
    }
    /** FCM options */
    fcmOptions?: {
      analyticsLabel?: string
      image?: string
    }
  }
  /** FCM options */
  fcmOptions?: {
    analyticsLabel?: string
  }
}

export interface FCMSendResult {
  success: boolean
  messageId?: string
  error?: string
  errorCode?: string
}

export interface FCMBatchResult {
  sent: number
  failed: number
  results: Array<FCMSendResult & { token?: string }>
}

const FCM_API_URL = 'https://fcm.googleapis.com/v1/projects'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const TOKEN_EXPIRY_MS = 55 * 60 * 1000 // 55 minutes (tokens valid for 1 hour)

/**
 * Firebase Cloud Messaging client
 */
export class FCMClient {
  private config: FCMConfig
  private accessToken: string | null = null
  private tokenExpiresAt: number = 0

  constructor(config: FCMConfig) {
    this.config = config
  }

  /**
   * Load config from service account JSON
   */
  static fromServiceAccount(serviceAccount: {
    project_id: string
    client_email: string
    private_key: string
  }): FCMClient {
    return new FCMClient({
      projectId: serviceAccount.project_id,
      clientEmail: serviceAccount.client_email,
      privateKey: serviceAccount.private_key,
    })
  }

  /**
   * Generate a JWT for Google OAuth2
   */
  private generateJWT(): string {
    const now = Math.floor(Date.now() / 1000)
    const exp = now + 3600 // 1 hour

    const header = {
      alg: 'RS256',
      typ: 'JWT',
    }

    const payload = {
      iss: this.config.clientEmail,
      sub: this.config.clientEmail,
      aud: GOOGLE_TOKEN_URL,
      iat: now,
      exp,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
    }

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url')
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const signatureInput = `${encodedHeader}.${encodedPayload}`

    const sign = createSign('SHA256')
    sign.update(signatureInput)
    const signature = sign.sign(this.config.privateKey, 'base64url')

    return `${signatureInput}.${signature}`
  }

  /**
   * Get a valid access token, refreshing if needed
   */
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken
    }

    const jwt = this.generateJWT()

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }).toString(),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Failed to get access token: ${errorText}`)
    }

    const data = await response.json()
    this.accessToken = data.access_token
    this.tokenExpiresAt = Date.now() + TOKEN_EXPIRY_MS

    return this.accessToken!
  }

  /**
   * Build FCM message payload
   */
  private buildMessage(notification: FCMNotification): object {
    const message: Record<string, any> = {}

    // Target (one of: token, topic, condition)
    if (notification.token) {
      message.token = notification.token
    } else if (notification.topic) {
      message.topic = notification.topic
    } else if (notification.condition) {
      message.condition = notification.condition
    }

    // Notification payload
    if (notification.title || notification.body || notification.imageUrl) {
      message.notification = {}
      if (notification.title) message.notification.title = notification.title
      if (notification.body) message.notification.body = notification.body
      if (notification.imageUrl) message.notification.image = notification.imageUrl
    }

    // Data payload
    if (notification.data && Object.keys(notification.data).length > 0) {
      message.data = notification.data
    }

    // Android options
    if (notification.android) {
      message.android = {
        priority: notification.android.priority || 'high',
      }

      if (notification.android.ttl) {
        message.android.ttl = `${notification.android.ttl}s`
      }

      if (notification.android.collapseKey) {
        message.android.collapse_key = notification.android.collapseKey
      }

      if (notification.android.directBootOk) {
        message.android.direct_boot_ok = notification.android.directBootOk
      }

      // Android notification
      const androidNotification: Record<string, any> = {}
      if (notification.android.channelId) androidNotification.channel_id = notification.android.channelId
      if (notification.android.icon) androidNotification.icon = notification.android.icon
      if (notification.android.color) androidNotification.color = notification.android.color
      if (notification.android.sound) androidNotification.sound = notification.android.sound
      if (notification.android.clickAction) androidNotification.click_action = notification.android.clickAction
      if (notification.android.tag) androidNotification.tag = notification.android.tag
      if (notification.android.visibility) androidNotification.visibility = notification.android.visibility
      if (notification.android.notificationCount !== undefined) {
        androidNotification.notification_count = notification.android.notificationCount
      }

      if (Object.keys(androidNotification).length > 0) {
        message.android.notification = androidNotification
      }
    }

    // Web push options
    if (notification.webpush) {
      message.webpush = notification.webpush
    }

    // APNS options (iOS)
    if (notification.apns) {
      message.apns = notification.apns
    }

    // FCM options
    if (notification.fcmOptions) {
      message.fcm_options = notification.fcmOptions
    }

    return { message }
  }

  /**
   * Send a push notification
   */
  async send(notification: FCMNotification): Promise<FCMSendResult> {
    try {
      const accessToken = await this.getAccessToken()
      const payload = this.buildMessage(notification)

      const response = await fetch(
        `${FCM_API_URL}/${this.config.projectId}/messages:send`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        }
      )

      const data = await response.json()

      if (response.ok) {
        return {
          success: true,
          messageId: data.name,
        }
      } else {
        return {
          success: false,
          error: data.error?.message || 'Unknown error',
          errorCode: data.error?.status,
        }
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
      }
    }
  }

  /**
   * Send to multiple device tokens
   */
  async sendBatch(
    tokens: string[],
    notification: Omit<FCMNotification, 'token' | 'topic' | 'condition'>,
    options?: { concurrency?: number }
  ): Promise<FCMBatchResult> {
    const concurrency = options?.concurrency || 10
    const results: Array<FCMSendResult & { token?: string }> = []

    // Process in batches
    for (let i = 0; i < tokens.length; i += concurrency) {
      const batch = tokens.slice(i, i + concurrency)
      const batchPromises = batch.map(async (token) => {
        const result = await this.send({ ...notification, token })
        return { ...result, token }
      })
      const batchResults = await Promise.all(batchPromises)
      results.push(...batchResults)
    }

    return {
      sent: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    }
  }

  /**
   * Send to a topic
   */
  async sendToTopic(
    topic: string,
    notification: Omit<FCMNotification, 'token' | 'topic' | 'condition'>
  ): Promise<FCMSendResult> {
    return this.send({ ...notification, topic })
  }

  /**
   * Send to topics with a condition
   * @example sendToCondition("'TopicA' in topics && 'TopicB' in topics", {...})
   */
  async sendToCondition(
    condition: string,
    notification: Omit<FCMNotification, 'token' | 'topic' | 'condition'>
  ): Promise<FCMSendResult> {
    return this.send({ ...notification, condition })
  }

  /**
   * Send a simple notification (convenience method)
   */
  async sendSimple(
    token: string,
    title: string,
    body: string,
    data?: Record<string, string>
  ): Promise<FCMSendResult> {
    return this.send({
      token,
      title,
      body,
      data,
    })
  }

  /**
   * Send a data-only (silent) notification
   */
  async sendSilent(
    token: string,
    data: Record<string, string>
  ): Promise<FCMSendResult> {
    return this.send({
      token,
      data,
      android: {
        priority: 'high',
      },
    })
  }

  /**
   * Subscribe a token to a topic
   */
  async subscribeToTopic(tokens: string[], topic: string): Promise<{ success: boolean; error?: string }> {
    try {
      const accessToken = await this.getAccessToken()

      const response = await fetch(
        `https://iid.googleapis.com/iid/v1:batchAdd`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            to: `/topics/${topic}`,
            registration_tokens: tokens,
          }),
        }
      )

      if (response.ok) {
        return { success: true }
      } else {
        const data = await response.json()
        return { success: false, error: data.error?.message || 'Failed to subscribe' }
      }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  /**
   * Unsubscribe a token from a topic
   */
  async unsubscribeFromTopic(tokens: string[], topic: string): Promise<{ success: boolean; error?: string }> {
    try {
      const accessToken = await this.getAccessToken()

      const response = await fetch(
        `https://iid.googleapis.com/iid/v1:batchRemove`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            to: `/topics/${topic}`,
            registration_tokens: tokens,
          }),
        }
      )

      if (response.ok) {
        return { success: true }
      } else {
        const data = await response.json()
        return { success: false, error: data.error?.message || 'Failed to unsubscribe' }
      }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }
}

export default FCMClient
