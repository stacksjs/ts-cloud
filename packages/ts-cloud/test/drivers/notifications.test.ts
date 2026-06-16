import type { FetchLike } from '../../src/drivers/shared/notifications'
import { describe, expect, it } from 'bun:test'
import {
  buildNotifierScript,
  resolveNotifications,
  sendNotifications,
} from '../../src/drivers/shared/notifications'

function recorder(): { fetchImpl: FetchLike, calls: Array<{ url: string, body?: string, method?: string }> } {
  const calls: Array<{ url: string, body?: string, method?: string }> = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body, method: init?.method })
    return { ok: true, status: 200 }
  }
  return { fetchImpl, calls }
}

describe('sendNotifications', () => {
  it('posts to Slack, Discord, Telegram, and a webhook', async () => {
    const { fetchImpl, calls } = recorder()
    const attempted = await sendNotifications({
      slack: { webhookUrl: 'https://hooks.slack.com/x' },
      discord: { webhookUrl: 'https://discord.com/api/webhooks/y' },
      telegram: { botToken: 'TOK', chatId: '42' },
      webhook: { url: 'https://example.com/hook' },
    }, 'deploy', 'hello', { fetchImpl })

    expect(attempted.sort()).toEqual(['discord', 'slack', 'telegram', 'webhook'])
    expect(calls.find(c => c.url.includes('slack'))?.body).toContain('"text":"hello"')
    expect(calls.find(c => c.url.includes('discord'))?.body).toContain('"content":"hello"')
    expect(calls.find(c => c.url.includes('telegram'))?.url).toContain('/botTOK/sendMessage')
    expect(calls.find(c => c.url.includes('example.com'))?.body).toContain('"event":"deploy"')
  })

  it('respects the events filter', async () => {
    const { fetchImpl, calls } = recorder()
    const attempted = await sendNotifications({
      slack: { webhookUrl: 'https://hooks.slack.com/x' },
      events: ['deploy-failed'],
    }, 'deploy', 'hi', { fetchImpl })
    expect(attempted).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('sends a GET webhook with query params', async () => {
    const { fetchImpl, calls } = recorder()
    await sendNotifications({ webhook: { url: 'https://example.com/h', method: 'GET' } }, 'ssl', 'renewed', { fetchImpl })
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
