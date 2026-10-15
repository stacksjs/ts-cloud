import type { FetchLike } from '../../src/drivers/shared/notifications'
import { describe, expect, it } from 'bun:test'
import { buildNotifierScript, resolveNotifications, sendNotifications } from '../../src/drivers/shared/notifications'

function recorder(): { fetchImpl: FetchLike; calls: Array<{ url: string; body?: string; method?: string }> } {
  const calls: Array<{ url: string; body?: string; method?: string }> = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body, method: init?.method })
    return { ok: true, status: 200 }
  }
  return { fetchImpl, calls }
}

describe('sendNotifications', () => {
  it('posts to Slack, Discord, Telegram, and a webhook', async () => {
    const { fetchImpl, calls } = recorder()
    const attempted = await sendNotifications(
      {
        slack: { webhookUrl: 'https://hooks.slack.com/x' },
        discord: { webhookUrl: 'https://discord.com/api/webhooks/y' },
        telegram: { botToken: 'TOK', chatId: '42' },
        webhook: { url: 'https://example.com/hook' },
      },
      'deploy',
      'hello',
      { fetchImpl },
    )

    expect(attempted.sort()).toEqual(['discord', 'slack', 'telegram', 'webhook'])
    expect(calls.find((c) => c.url.includes('slack'))?.body).toContain('"text":"hello"')
    expect(calls.find((c) => c.url.includes('discord'))?.body).toContain('"content":"hello"')
    expect(calls.find((c) => c.url.includes('telegram'))?.url).toContain('/botTOK/sendMessage')
    expect(calls.find((c) => c.url.includes('example.com'))?.body).toContain('"event":"deploy"')
  })

  it('respects the events filter', async () => {
    const { fetchImpl, calls } = recorder()
    const attempted = await sendNotifications(
      {
        slack: { webhookUrl: 'https://hooks.slack.com/x' },
        events: ['deploy-failed'],
      },
      'deploy',
      'hi',
      { fetchImpl },
    )
    expect(attempted).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('sends a GET webhook with query params', async () => {
    const { fetchImpl, calls } = recorder()
    await sendNotifications({ webhook: { url: 'https://example.com/h', method: 'GET' } }, 'ssl', 'renewed', {
      fetchImpl,
    })
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toContain('event=ssl')
    expect(calls[0].url).toContain('message=renewed')
  })

  it('returns nothing for an undefined config', async () => {
    expect(await sendNotifications(undefined, 'deploy', 'x')).toEqual([])
  })
})

describe('resolveNotifications', () => {
  it('prefers the site override over the project default', () => {
    const project = { slack: { webhookUrl: 'p' } }
    const site = { slack: { webhookUrl: 's' } }
    expect(resolveNotifications(project, site)).toBe(site)
    expect(resolveNotifications(project, undefined)).toBe(project)
  })
})

describe('buildNotifierScript', () => {
  it('writes an on-box notifier that curls the webhook channels', () => {
    const script = buildNotifierScript({
      slack: { webhookUrl: 'https://hooks.slack.com/x' },
      discord: { webhookUrl: 'https://discord.com/api/webhooks/y' },
    }).join('\n')
    expect(script).toContain('/usr/local/bin/ts-cloud-notify')
    expect(script).toContain('hooks.slack.com')
    expect(script).toContain('discord.com')
  })

  it('is empty when no webhook-style channel is configured', () => {
    expect(buildNotifierScript({ email: { to: 'a@b.com' } })).toEqual([])
    expect(buildNotifierScript(undefined)).toEqual([])
  })
})

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveNotificationEndpoint } from '../../src/drivers/shared/notifications'

describe('on-box notification delivery', () => {
  it('reads protected env references as data, escapes JSON and propagates delivery failure', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ts-cloud-notifier-'))
    try {
      const capture = join(directory, 'request')
      const envFile = join(directory, 'mail.env')
      const marker = join(directory, 'must-not-exist')
      const url = `https://example.com/hook?token=$(touch ${marker})`
      writeFileSync(envFile, `OTHER=unused\nexport DISCORD_WEBHOOK_URL='${url}'\n`)
      expect(resolveNotificationEndpoint({ envFile, variable: 'DISCORD_WEBHOOK_URL' })).toBe(url)
      const bin = join(directory, 'bin'); mkdirSync(bin)
      writeFileSync(join(bin, 'curl'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\nexit "${CURL_EXIT:-0}"\n', { mode: 0o755 })
      const commands = buildNotifierScript({ discord: { webhookUrl: { envFile, variable: 'DISCORD_WEBHOOK_URL' } } })
      const body = commands.slice(1, commands.indexOf('TS_CLOUD_NOTIFY_EOF')).join('\n')
      const message = 'A "quoted" \\ path\nwith\ttabs\rand emoji ✅'
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture }
      const result = Bun.spawnSync(['bash', '-c', body, 'notify', message], { env })
      expect(result.stderr.toString()).toBe('')
      expect(result.exitCode).toBe(0)
      const args = readFileSync(capture, 'utf8').trimEnd().split('\n')
      expect(JSON.parse(args[args.indexOf('--data') + 1])).toEqual({ content: message })
      expect(args.at(-1)).toBe(url)
      expect(Bun.spawnSync(['test', '-e', marker]).exitCode).toBe(1)
      expect(Bun.spawnSync(['bash', '-c', body, 'notify', message], { env: { ...env, CURL_EXIT: '22' } }).exitCode).toBe(1)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
