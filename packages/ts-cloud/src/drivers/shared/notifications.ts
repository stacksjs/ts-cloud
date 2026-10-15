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
import type { NotificationEndpoint, NotificationsConfig, NotifyEvent } from '@ts-cloud/core'
import { readFileSync } from 'node:fs'

/** Read a literal env assignment; never source, interpolate or execute a file. */
export function resolveNotificationEndpoint(endpoint: NotificationEndpoint): string {
  if (typeof endpoint === 'string') return endpoint
  if (!/^\/[\w./-]+$/.test(endpoint.envFile) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(endpoint.variable))
    throw new Error('Invalid notification env-file reference')
  const lines = readFileSync(endpoint.envFile, 'utf8').split(/\r?\n/)
  const value = lines.map(line => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/))
    .find(match => match?.[1] === endpoint.variable)?.[2]
  if (!value) throw new Error(`Notification variable ${endpoint.variable} is missing`)
  return value.replace(/^(['"])(.*)\1$/, '$2')
}

/** Should this channel fire for the given event? (no `events` filter ⇒ all). */
function wantsEvent(config: NotificationsConfig, event: NotifyEvent): boolean {
  return !config.events || config.events.includes(event)
}

/** Fetch implementation (injectable for tests). */
export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  },
) => Promise<{ ok: boolean; status: number }>

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
  event: NotifyEvent,
  message: string,
  options: SendNotificationsOptions = {},
): Promise<string[]> {
  if (!config) return []
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const attempted: string[] = []
  const tasks: Promise<unknown>[] = []

  const post = async (endpoint: NotificationEndpoint, body: unknown): Promise<unknown> => {
    try { return await fetchImpl(resolveNotificationEndpoint(endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) } catch { return undefined }
  }

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
    } else {
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
  event: NotifyEvent,
  message: string,
): Promise<void> {
  try {
    const mod = (await import('../../aws/email')) as {
      email: { send: (o: { to: string | string[]; from?: string; subject: string; text: string }) => Promise<unknown> }
    }
    await mod.email.send({
      to: email.to,
      from: email.from,
      subject: `[ts-cloud] ${event}`,
      text: message,
    })
  } catch {
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
  if (!config) return []
  const quote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  const endpoint = (value: NotificationEndpoint): string => {
    if (typeof value === 'string') return quote(value)
    if (!/^\/[\w./-]+$/.test(value.envFile) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.variable))
      throw new Error('Invalid notification env-file reference')
    return '"$(read_env ' + quote(value.envFile) + ' ' + quote(value.variable) + ')"'
  }
  const curls: string[] = []
  for (const [channel, key] of [['slack', 'text'], ['discord', 'content']] as const) {
    const url = config[channel]?.webhookUrl
    if (url) curls.push('URL=' + endpoint(url), 'post "$URL" ' + quote(key))
  }
  if (config.telegram?.botToken && config.telegram.chatId) curls.push(
    'curl -fsS --max-time 30 -X POST ' + quote('https://api.telegram.org/bot' + config.telegram.botToken + '/sendMessage')
      + ' --data-urlencode ' + quote('chat_id=' + config.telegram.chatId) + ' --data-urlencode "text=$MSG" >/dev/null || FAILED=1',
  )
  if (config.webhook?.url) {
    if (config.webhook.method === 'GET') curls.push('curl -fsS --max-time 30 -G ' + quote(config.webhook.url) + ' --data-urlencode "message=$MSG" >/dev/null || FAILED=1')
    else curls.push('post ' + quote(config.webhook.url) + ' message')
  }
  if (!curls.length) return []
  return [
    "cat > /usr/local/bin/ts-cloud-notify.new <<'TS_CLOUD_NOTIFY_EOF'",
    '#!/bin/bash',
    'set -uo pipefail',
    'MSG="${1:-}"; FAILED=0',
    // Read assignments as data, without executing shell syntax in the file.
    String.raw`read_env(){ awk -v key="$2" '$0 ~ "^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=" { sub("^[^=]*=[[:space:]]*", ""); sub(/[\r[:space:]]+$/, ""); if (($0 ~ /^".*"$/) || ($0 ~ /^\047.*\047$/)) $0=substr($0,2,length($0)-2); print; exit }' "$1"; }`,
    // Escape JSON control characters while preserving UTF-8 bytes.
    String.raw`ESCAPED=$(printf %s "$MSG" | LC_ALL=C awk 'BEGIN{ORS=""; for(i=1;i<32;i++) esc[sprintf("%c",i)]=sprintf("\\u%04x",i)} {if(NR>1) printf "\\n"; for(i=1;i<=length($0);i++){ c=substr($0,i,1); if(c=="\\") printf "\\\\"; else if(c=="\"") printf "\\\""; else if(c in esc) printf "%s",esc[c]; else printf "%s",c }}')`,
    String.raw`post(){ if [ -z "$1" ]; then FAILED=1; return; fi; curl -fsS --max-time 30 -X POST -H 'Content-Type: application/json' --data "{\"$2\":\"$ESCAPED\"}" "$1" >/dev/null || FAILED=1; }`,
    ...curls,
    'exit "$FAILED"',
    'TS_CLOUD_NOTIFY_EOF',
    'chmod 0700 /usr/local/bin/ts-cloud-notify.new',
    'mv -f /usr/local/bin/ts-cloud-notify.new /usr/local/bin/ts-cloud-notify',
  ]
}
