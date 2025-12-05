/**
 * Push Notifications Module
 *
 * Provides clients for Apple Push Notification Service (APNs) and
 * Firebase Cloud Messaging (FCM).
 *
 * @example
 * ```ts
 * // Apple Push Notifications
 * import { APNsClient } from 'ts-cloud/push'
 *
 * const apns = new APNsClient({
 *   keyId: 'ABC123DEFG',
 *   teamId: 'DEF456GHIJ',
 *   privateKey: fs.readFileSync('AuthKey.p8', 'utf8'),
 *   bundleId: 'com.example.app',
 * })
 *
 * await apns.send({
 *   deviceToken: '...',
 *   title: 'Hello',
 *   body: 'World',
 * })
 *
 * // Firebase Cloud Messaging
 * import { FCMClient } from 'ts-cloud/push'
 *
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

export * from './apns'
export * from './fcm'

// Re-export types for convenience
export type {
  APNsConfig,
  APNsNotification,
  APNsSendResult,
  APNsBatchResult,
} from './apns'

export type {
  FCMConfig,
  FCMNotification,
  FCMSendResult,
  FCMBatchResult,
} from './fcm'
