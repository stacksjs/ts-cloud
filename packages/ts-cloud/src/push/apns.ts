/**
 * Apple Push Notification Service (APNs) Client
 * Uses HTTP/2 with JWT token authentication
 *
 * Prerequisites:
 * - Apple Developer account
 * - APNs Key (p8 file) from Apple Developer Portal
 * - Key ID and Team ID
 *
 * @example
 * ```ts
 * const apns = new APNsClient({
 *   keyId: 'ABC123DEFG',
 *   teamId: 'DEF456GHIJ',
 *   privateKey: fs.readFileSync('AuthKey_ABC123DEFG.p8', 'utf8'),
 *   bundleId: 'com.example.app',
 *   production: false // true for production, false for sandbox
 * })
 *
 * await apns.send({
 *   deviceToken: '...',
 *   title: 'Hello',
 *   body: 'World',
 * })
 * ```
 */

import { createSign } from 'node:crypto'
import * as http2 from 'node:http2'

export interface APNsConfig {
  /** APNs Key ID from Apple Developer Portal */
  keyId: string
  /** Team ID from Apple Developer Portal */
  teamId: string
  /** Private key content (p8 file content) */
  privateKey: string
  /** iOS app bundle ID (e.g., com.example.app) */
  bundleId: string
  /** Use production APNs server (default: false) */
  production?: boolean
}

export interface APNsNotification {
  /** Device token to send to */
  deviceToken: string
  /** Alert title */
  title?: string
  /** Alert subtitle */
  subtitle?: string
  /** Alert body */
  body?: string
  /** Badge number to display on app icon */
  badge?: number
  /** Sound to play (use 'default' for default sound) */
  sound?: string | { name: string; critical?: number; volume?: number }
  /** Category identifier for actionable notifications */
  category?: string
  /** Thread identifier for grouping notifications */
  threadId?: string
  /** Custom data payload */
  data?: Record<string, any>
  /** Content available flag for background updates */
  contentAvailable?: boolean
  /** Mutable content flag for notification service extension */
  mutableContent?: boolean
  /** Push type (default: 'alert') */
  pushType?: 'alert' | 'background' | 'voip' | 'complication' | 'fileprovider' | 'mdm' | 'liveactivity'
  /** Notification priority (10 = immediate, 5 = can be delayed) */
  priority?: 5 | 10
  /** Expiration timestamp (Unix time in seconds) */
  expiration?: number
  /** Collapse identifier for coalescing notifications */
  collapseId?: string
  /** Target content id for live activities */
  targetContentId?: string
}

export interface APNsSendResult {
  success: boolean
  deviceToken: string
  apnsId?: string
  statusCode?: number
  error?: string
  reason?: string
  timestamp?: number
}

export interface APNsBatchResult {
  sent: number
  failed: number
  results: APNsSendResult[]
}

const APNS_PRODUCTION_HOST = 'api.push.apple.com'
const APNS_SANDBOX_HOST = 'api.sandbox.push.apple.com'
const TOKEN_EXPIRY_MS = 45 * 60 * 1000 // 45 minutes (tokens valid for 1 hour)

/**
 * Apple Push Notification Service client
 */
export class APNsClient {
  private config: APNsConfig
  private token: string | null = null
  private tokenGeneratedAt: number = 0
  private client: http2.ClientHttp2Session | null = null
  private host: string

  constructor(config: APNsConfig) {
    this.config = config
    this.host = config.production ? APNS_PRODUCTION_HOST : APNS_SANDBOX_HOST
  }

  /**
   * Generate a new JWT token for APNs authentication
   */
  private generateToken(): string {
    const now = Math.floor(Date.now() / 1000)

    // Check if current token is still valid
    if (this.token && (Date.now() - this.tokenGeneratedAt) < TOKEN_EXPIRY_MS) {
      return this.token
    }

    // JWT Header
    const header = {
      alg: 'ES256',
      kid: this.config.keyId,
    }

    // JWT Payload
    const payload = {
      iss: this.config.teamId,
      iat: now,
    }

    // Encode header and payload
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url')
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const signatureInput = `${encodedHeader}.${encodedPayload}`

    // Sign with ES256 (ECDSA P-256)
    const sign = createSign('SHA256')
    sign.update(signatureInput)
    const signature = sign.sign(this.config.privateKey)

    // Convert DER signature to raw format (64 bytes)
    const rawSignature = this.derToRaw(signature)
    const encodedSignature = rawSignature.toString('base64url')

    this.token = `${signatureInput}.${encodedSignature}`
    this.tokenGeneratedAt = Date.now()

    return this.token
  }

  /**
   * Convert DER encoded ECDSA signature to raw format
   */
  private derToRaw(derSignature: Buffer): Buffer {
    // DER format: 0x30 [total-length] 0x02 [r-length] [r] 0x02 [s-length] [s]
    let offset = 2 // Skip 0x30 and total length

    // Read R
    if (derSignature[offset] !== 0x02) {
      throw new Error('Invalid DER signature: expected 0x02 for R')
    }
    offset++
    const rLength = derSignature[offset]
    offset++
    let r = derSignature.subarray(offset, offset + rLength)
    offset += rLength

    // Read S
    if (derSignature[offset] !== 0x02) {
      throw new Error('Invalid DER signature: expected 0x02 for S')
    }
    offset++
    const sLength = derSignature[offset]
    offset++
    let s = derSignature.subarray(offset, offset + sLength)

    // Remove leading zeros and pad to 32 bytes
    if (r[0] === 0x00 && r.length === 33) {
      r = r.subarray(1)
    }
    if (s[0] === 0x00 && s.length === 33) {
      s = s.subarray(1)
    }

    // Pad to 32 bytes if needed
    const result = Buffer.alloc(64)
    r.copy(result, 32 - r.length)
    s.copy(result, 64 - s.length)

    return result
  }

  /**
   * Get or create HTTP/2 client connection
   */
  private async getClient(): Promise<http2.ClientHttp2Session> {
    if (this.client && !this.client.destroyed) {
      return this.client
    }

    return new Promise((resolve, reject) => {
      this.client = http2.connect(`https://${this.host}`)

      this.client.on('error', (err) => {
        reject(err)
      })

      this.client.on('connect', () => {
        resolve(this.client!)
      })

      // Set up automatic reconnection on close
      this.client.on('close', () => {
        this.client = null
      })
    })
  }

  /**
   * Build APNs payload from notification options
   */
  private buildPayload(notification: APNsNotification): object {
    const aps: Record<string, any> = {}

    // Alert
    if (notification.title || notification.body || notification.subtitle) {
      aps.alert = {}
      if (notification.title) aps.alert.title = notification.title
      if (notification.subtitle) aps.alert.subtitle = notification.subtitle
      if (notification.body) aps.alert.body = notification.body
    }

    // Badge
    if (notification.badge !== undefined) {
      aps.badge = notification.badge
    }

    // Sound
    if (notification.sound !== undefined) {
      aps.sound = notification.sound
    }

    // Category
    if (notification.category) {
      aps.category = notification.category
    }

    // Thread ID
    if (notification.threadId) {
      aps['thread-id'] = notification.threadId
    }

    // Content available (for background updates)
    if (notification.contentAvailable) {
      aps['content-available'] = 1
    }

    // Mutable content (for notification service extension)
    if (notification.mutableContent) {
      aps['mutable-content'] = 1
    }

    // Target content id (for live activities)
    if (notification.targetContentId) {
      aps['target-content-id'] = notification.targetContentId
    }

    const payload: Record<string, any> = { aps }

    // Add custom data
    if (notification.data) {
      Object.assign(payload, notification.data)
    }

    return payload
  }

  /**
   * Send a push notification to a single device
   */
  async send(notification: APNsNotification): Promise<APNsSendResult> {
    try {
      const client = await this.getClient()
      const token = this.generateToken()
      const payload = JSON.stringify(this.buildPayload(notification))

      const headers: http2.OutgoingHttpHeaders = {
        ':method': 'POST',
        ':path': `/3/device/${notification.deviceToken}`,
        'authorization': `bearer ${token}`,
        'apns-topic': this.config.bundleId,
        'apns-push-type': notification.pushType || 'alert',
        'apns-priority': String(notification.priority || 10),
      }

      if (notification.expiration !== undefined) {
        headers['apns-expiration'] = String(notification.expiration)
      }

      if (notification.collapseId) {
        headers['apns-collapse-id'] = notification.collapseId
      }

      return new Promise((resolve) => {
        const req = client.request(headers)

        let responseData = ''
        let statusCode: number = 0
        let apnsId: string | undefined

        req.on('response', (headers) => {
          statusCode = headers[':status'] as number
          apnsId = headers['apns-id'] as string | undefined
        })

        req.on('data', (chunk) => {
          responseData += chunk.toString()
        })

        req.on('end', () => {
          if (statusCode === 200) {
            resolve({
              success: true,
              deviceToken: notification.deviceToken,
              apnsId,
              statusCode,
            })
          } else {
            let error = 'Unknown error'
            let reason: string | undefined
            let timestamp: number | undefined

            if (responseData) {
              try {
                const parsed = JSON.parse(responseData)
                reason = parsed.reason
                timestamp = parsed.timestamp
                error = reason || error
              } catch {
                error = responseData
              }
            }

            resolve({
              success: false,
              deviceToken: notification.deviceToken,
              apnsId,
              statusCode,
              error,
              reason,
              timestamp,
            })
          }
        })

        req.on('error', (err) => {
          resolve({
            success: false,
            deviceToken: notification.deviceToken,
            error: err.message,
          })
        })

        req.write(payload)
        req.end()
      })
    } catch (error: any) {
      return {
        success: false,
        deviceToken: notification.deviceToken,
        error: error.message,
      }
    }
  }

  /**
   * Send push notifications to multiple devices
   */
  async sendBatch(
    notifications: APNsNotification[],
    options?: { concurrency?: number }
  ): Promise<APNsBatchResult> {
    const concurrency = options?.concurrency || 10
    const results: APNsSendResult[] = []

    // Process in batches
    for (let i = 0; i < notifications.length; i += concurrency) {
      const batch = notifications.slice(i, i + concurrency)
      const batchResults = await Promise.all(batch.map(n => this.send(n)))
      results.push(...batchResults)
    }

    return {
      sent: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    }
  }

  /**
   * Send a simple notification (convenience method)
   */
  async sendSimple(
    deviceToken: string,
    title: string,
    body: string,
    data?: Record<string, any>
  ): Promise<APNsSendResult> {
    return this.send({
      deviceToken,
      title,
      body,
      data,
    })
  }

  /**
   * Send a silent/background notification
   */
  async sendSilent(
    deviceToken: string,
    data?: Record<string, any>
  ): Promise<APNsSendResult> {
    return this.send({
      deviceToken,
      contentAvailable: true,
      pushType: 'background',
      priority: 5,
      data,
    })
  }

  /**
   * Close the HTTP/2 connection
   */
  close(): void {
    if (this.client) {
      this.client.close()
      this.client = null
    }
    this.token = null
    this.tokenGeneratedAt = 0
  }
}

export default APNsClient
