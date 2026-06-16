/**
 * Send deploy / SSL / health-check / backup notifications to the configured
 * channels (Slack, Discord, Telegram, email, generic webhook), mirroring
 * Forge's notification system.
 *
 * Two surfaces:
 *  - {@link sendNotifications} — called from the TS deploy orchestrator for
 *    deploy success/failure (and other events ts-cloud drives locally).
 *  - {@link buildNotifierScript} — generates an on-box `ts-cloud-notify`
 *    helper that cron-driven events (certbot renewal, backups) can call.
 */
import type { NotificationEvent, NotificationsConfig } from '@ts-cloud/core'

/** Should this channel fire for the given event? (no `events` filter ⇒ all). */
function wantsEvent(config: NotificationsConfig, event: NotificationEvent): boolean {
  return !config.events || config.events.includes(event)
}

/** Fetch implementation (injectable for tests). */
export type FetchLike = (input: string, init?: {
  method?: string
  headers?: Record<string, string>
  body?: string
}) => Promise<{ ok: boolean, status: number }>

export interface SendNotificationsOptions {
  /** Override the fetch implementation (default: global `fetch`). */
  fetchImpl?: FetchLike
}

/**
 * Send `message` for `event` to every configured + subscribed channel. Errors
 * on individual channels are swallowed (a flaky webhook must not fail a deploy);
 * returns the list of channels that were attempted.
 */
export async function sendNotifications(
  config: NotificationsConfig | undefined,
  event: NotificationEvent,
  message: string,
  options: SendNotificationsOptions = {},
): Promise<string[]> {
  if (!config)
    return []
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const attempted: string[] = []
  const tasks: Promise<unknown>[] = []

  const post = (url: string, body: unknown): Promise<unknown> =>
    fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .catch(() => undefined)

  if (config.slack?.webhookUrl && wantsEvent(config, event)) {
    attempted.push('slack')
    tasks.push(post(config.slack.webhookUrl, { text: message }))
  }
  if (config.discord?.webhookUrl && wantsEvent(config, event)) {
    attempted.push('discord')
    tasks.push(post(config.discord.webhookUrl, { content: message }))
  }
  if (config.telegram?.botToken && config.telegram.chatId && wantsEvent(config, event)) {
    attempted.push('telegram')
    const url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`
    tasks.push(post(url, { chat_id: config.telegram.chatId, text: message }))
  }
  if (config.webhook?.url && wantsEvent(config, event)) {
    attempted.push('webhook')
    if ((config.webhook.method || 'POST') === 'GET') {
      const sep = config.webhook.url.includes('?') ? '&' : '?'
      const url = `${config.webhook.url}${sep}event=${encodeURIComponent(event)}&message=${encodeURIComponent(message)}`
      tasks.push(fetchImpl(url, { method: 'GET' }).catch(() => undefined))
    }
    else {
      tasks.push(post(config.webhook.url, { event, message }))
    }
  }
  if (config.email?.to && wantsEvent(config, event)) {
    attempted.push('email')
    tasks.push(sendEmailNotification(config.email, event, message))
  }

  await Promise.all(tasks)
  return attempted
}

/** Best-effort email via ts-cloud's SES client (dynamic import to avoid a hard AWS dep). */
async function sendEmailNotification(
  email: NonNullable<NotificationsConfig['email']>,
  event: NotificationEvent,
  message: string,
): Promise<void> {
  try {
    const mod = await import('../../aws/email') as {
      email: { send: (o: { to: string | string[], from?: string, subject: string, text: string }) => Promise<unknown> }
    }
    await mod.email.send({
      to: email.to,
      from: email.from,
      subject: `[ts-cloud] ${event}`,
      text: message,
    })
  }
  catch {
    // Email transport unavailable (no SES config) — skip silently.
  }
}

/** Resolve the effective notifications config for a site (site overrides project). */
export function resolveNotifications(
  project: NotificationsConfig | undefined,
  site: NotificationsConfig | undefined,
): NotificationsConfig | undefined {
  return site ?? project
}

/**
 * Generate an on-box `ts-cloud-notify` script that POSTs `$1` (a message) to
 * the webhook channels. Used by cron-driven hooks (certbot renew, backups) so
 * server-side events also reach Slack/Discord/etc. Returns `[]` when no
 * webhook-style channel is configured.
 */
export function buildNotifierScript(config: NotificationsConfig | undefined): string[] {
  if (!config)
    return []
  const curls: string[] = []
  if (config.slack?.webhookUrl)
    curls.push(`curl -fsS -X POST -H 'Content-Type: application/json' -d "{\\"text\\":\\"$MSG\\"}" ${config.slack.webhookUrl} || true`)
  if (config.discord?.webhookUrl)
    curls.push(`curl -fsS -X POST -H 'Content-Type: application/json' -d "{\\"content\\":\\"$MSG\\"}" ${config.discord.webhookUrl} || true`)
  if (config.telegram?.botToken && config.telegram.chatId)
    curls.push(`curl -fsS -X POST "https://api.telegram.org/bot${config.telegram.botToken}/sendMessage" --data-urlencode "chat_id=${config.telegram.chatId}" --data-urlencode "text=$MSG" || true`)
  if (config.webhook?.url)
    curls.push(`curl -fsS -X POST -H 'Content-Type: application/json' -d "{\\"message\\":\\"$MSG\\"}" ${config.webhook.url} || true`)

  if (curls.length === 0)
    return []

  return [
    'cat > /usr/local/bin/ts-cloud-notify <<\'TS_CLOUD_NOTIFY_EOF\'',
    '#!/bin/bash',
    'MSG="$1"',
    ...curls,
    'TS_CLOUD_NOTIFY_EOF',
    'chmod +x /usr/local/bin/ts-cloud-notify',
  ]
}
