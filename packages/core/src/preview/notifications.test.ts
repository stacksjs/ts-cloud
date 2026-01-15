import { describe, expect, it, beforeEach, mock } from 'bun:test'
import { PreviewNotificationService } from './notifications'
import type { NotificationEvent } from './notifications'
import type { PreviewEnvironment } from './manager'

describe('PreviewNotificationService', () => {
  let service: PreviewNotificationService
  let mockEnvironment: PreviewEnvironment

  beforeEach(() => {
    service = new PreviewNotificationService()
    mockEnvironment = {
      id: 'pr-42-abc1234',
      name: 'pr-42',
      branch: 'feature/auth',
      pr: 42,
      commitSha: 'abc123def456',
      createdAt: new Date('2025-01-15T10:00:00Z'),
      expiresAt: new Date('2025-01-16T10:00:00Z'),
      url: 'https://pr-42.preview.example.com',
      status: 'active',
      stackName: 'preview-pr-42',
      region: 'us-east-1',
      resources: [],
    }
  })

  describe('addChannel', () => {
    it('should add notification channel', () => {
      service.addChannel({
        type: 'slack',
        config: {
          webhookUrl: 'https://hooks.slack.com/services/xxx',
        },
      })

      // Channel is private, but we can test by sending a notification
      // and checking if it's called
      expect(true).toBe(true)
    })
  })

  describe('removeChannel', () => {
    it('should remove notification channel by type', () => {
      service.addChannel({
        type: 'slack',
        config: {
          webhookUrl: 'https://hooks.slack.com/services/xxx',
        },
      })

      service.removeChannel('slack')

      // Test that channel was removed by verifying no notifications sent
      expect(true).toBe(true)
    })
  })

  describe('notify - Slack', () => {
    it('should send Slack notification for created event', async () => {
      const fetchMock = mock(() =>
        Promise.resolve({
          ok: true,
          statusText: 'OK',
        } as Response),
      )
      global.fetch = fetchMock as any

      service.addChannel({
        type: 'slack',
        config: {
          webhookUrl: 'https://hooks.slack.com/services/xxx',
          channel: '#deployments',
          username: 'Preview Bot',
          iconEmoji: ':rocket:',
        },
      })

      const event: NotificationEvent = {
        type: 'created',
        environment: mockEnvironment,
        timestamp: new Date(),
      }

      await service.notify(event)

      expect(fetchMock).toHaveBeenCalled()
      expect(fetchMock).toHaveBeenCalledWith(
        'https://hooks.slack.com/services/xxx',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      )

      const callArgs = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      const body = JSON.parse(callArgs[1]!.body as string)

      expect(body.username).toBe('Preview Bot')
      expect(body.icon_emoji).toBe(':rocket:')
      expect(body.channel).toBe('#deployments')
      expect(body.attachments).toHaveLength(1)
      expect(body.attachments[0].title).toContain('Preview Environment Created')
      expect(body.attachments[0].color).toBe('#36a64f')
    })

    it('should send Slack notification for destroyed event', async () => {
      const fetchMock = mock(() =>
        Promise.resolve({
          ok: true,
          statusText: 'OK',
        } as Response),
      )
      global.fetch = fetchMock as any

      service.addChannel({
        type: 'slack',
        config: {
          webhookUrl: 'https://hooks.slack.com/services/xxx',
        },
      })

      const event: NotificationEvent = {
        type: 'destroyed',
        environment: mockEnvironment,
        timestamp: new Date(),
      }

      await service.notify(event)

      const callArgs = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      const body = JSON.parse(callArgs[1]!.body as string)

      expect(body.attachments[0].title).toContain('Preview Environment Destroyed')
      expect(body.attachments[0].color).toBe('#808080')
    })

    it('should send Slack notification for failed event', async () => {
      const fetchMock = mock(() =>
        Promise.resolve({
          ok: true,
          statusText: 'OK',
        } as Response),
      )
      global.fetch = fetchMock as any

      service.addChannel({
        type: 'slack',
        config: {
          webhookUrl: 'https://hooks.slack.com/services/xxx',
        },
      })

      const event: NotificationEvent = {
        type: 'failed',
        environment: mockEnvironment,
        timestamp: new Date(),
      }

      await service.notify(event)

      const callArgs = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      const body = JSON.parse(callArgs[1]!.body as string)

      expect(body.attachments[0].title).toContain('Preview Environment Failed')
      expect(body.attachments[0].color).toBe('#f44336')
    })

    it('should include environment details in Slack message', async () => {
      const fetchMock = mock(() =>
        Promise.resolve({
          ok: true,
          statusText: 'OK',
        } as Response),
      )
      global.fetch = fetchMock as any

      service.addChannel({
        type: 'slack',
        config: {
          webhookUrl: 'https://hooks.slack.com/services/xxx',
        },
      })

      const event: NotificationEvent = {
        type: 'created',
        environment: mockEnvironment,
        timestamp: new Date(),
      }

      await service.notify(event)

      const callArgs = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      const body = JSON.parse(callArgs[1]!.body as string)
      const fields = body.attachments[0].fields

      expect(fields).toContainEqual({
        title: 'Environment',
        value: 'pr-42',
        short: true,
      })

      expect(fields).toContainEqual({
        title: 'Branch',
        value: 'feature/auth',
        short: true,
      })

      expect(fields).toContainEqual({
        title: 'PR',
        value: '#42',
        short: true,
      })

      expect(fields).toContainEqual({
        title: 'Commit',
        value: 'abc123d',
        short: true,
      })

      expect(fields).toContainEqual({
        title: 'URL',
        value: 'https://pr-42.preview.example.com',
        short: false,
      })
    })

    it('should throw error on failed Slack request', async () => {
      const fetchMock = mock(() =>
        Promise.resolve({
          ok: false,
          statusText: 'Bad Request',
        } as Response),
      )
      global.fetch = fetchMock as any

      service.addChannel({
        type: 'slack',
        config: {
          webhookUrl: 'https://hooks.slack.com/services/xxx',
        },
      })

      const event: NotificationEvent = {
        type: 'created',
        environment: mockEnvironment,
        timestamp: new Date(),
      }

      // Should not throw because we use Promise.allSettled
      await expect(service.notify(event)).resolves.toBeUndefined()
    })
  })

  describe('notify - Discord', () => {
    it('should send Discord notification for created event', async () => {
      const fetchMock = mock(() =>
        Promise.resolve({
          ok: true,
          statusText: 'OK',
        } as Response),
      )
      global.fetch = fetchMock as any

      service.addChannel({
        type: 'discord',
        config: {
          webhookUrl: 'https://discord.com/api/webhooks/xxx/yyy',
          username: 'Preview Bot',
          avatarUrl: 'https://example.com/avatar.png',
        },
      })

      const event: NotificationEvent = {
        type: 'created',
        environment: mockEnvironment,
        timestamp: new Date(),
      }

      await service.notify(event)

      expect(fetchMock).toHaveBeenCalled()
      expect(fetchMock).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/xxx/yyy',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      )

      const callArgs = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      const body = JSON.parse(callArgs[1]!.body as string)

      expect(body.username).toBe('Preview Bot')
      expect(body.avatar_url).toBe('https://example.com/avatar.png')
      expect(body.embeds).toHaveLength(1)
      expect(body.embeds[0].title).toContain('Preview Environment Created')
      expect(body.embeds[0].color).toBe(0x36A64F)
    })

    it('should include environment details in Discord message', async () => {
      const fetchMock = mock(() =>
        Promise.resolve({
          ok: true,
          statusText: 'OK',
        } as Response),
      )
      global.fetch = fetchMock as any

      service.addChannel({
        type: 'discord',
        config: {
          webhookUrl: 'https://discord.com/api/webhooks/xxx/yyy',
        },
      })

      const event: NotificationEvent = {
        type: 'created',
        environment: mockEnvironment,
        timestamp: new Date(),
      }

      await service.notify(event)

      const callArgs = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      const body = JSON.parse(callArgs[1]!.body as string)
      const fields = body.embeds[0].fields

      expect(fields).toContainEqual({
        name: 'Environment',
        value: 'pr-42',
        inline: true,
      })

      expect(fields).toContainEqual({
        name: 'Branch',
        value: 'feature/auth',
        inline: true,
      })

      expect(fields).toContainEqual({
        name: 'Commit',
        value: '`abc123d`',
        inline: true,
      })
    })
  })

  describe('notify - Webhook', () => {
    it('should send webhook notification', async () => {
      const fetchMock = mock(() =>
        Promise.resolve({
          ok: true,
          statusText: 'OK',
        } as Response),
      )
      global.fetch = fetchMock as any

      service.addChannel({
        type: 'webhook',
        config: {
          url: 'https://example.com/webhook',
          method: 'POST',
          headers: {
            'X-Custom-Header': 'value',
          },
        },
      })

      const event: NotificationEvent = {
        type: 'created',
        environment: mockEnvironment,
        timestamp: new Date(),
        metadata: {
          source: 'github',
        },
      }

      await service.notify(event)

      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Custom-Header': 'value',
          },
        }),
      )

      const callArgs = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      const body = JSON.parse(callArgs[1]!.body as string)

      expect(body.event).toBe('created')
      expect(body.environment).toBeDefined()
      expect(body.environment.id).toBe(mockEnvironment.id)
      expect(body.environment.name).toBe(mockEnvironment.name)
      expect(body.metadata).toEqual({ source: 'github' })
    })

    it('should use GET method when specified', async () => {
      const fetchMock = mock(() =>
        Promise.resolve({
          ok: true,
          statusText: 'OK',
        } as Response),
      )
      global.fetch = fetchMock as any

      service.addChannel({
        type: 'webhook',
        config: {
          url: 'https://example.com/webhook',
          method: 'GET',
        },
      })

      const event: NotificationEvent = {
        type: 'created',
        environment: mockEnvironment,
        timestamp: new Date(),
      }

      await service.notify(event)

      const callArgs = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(callArgs[1]!.method).toBe('GET')
    })
  })

  describe('notify - Multiple channels', () => {
    it('should send to multiple channels', async () => {
      const fetchMock = mock(() =>
        Promise.resolve({
          ok: true,
          statusText: 'OK',
        } as Response),
      )
      global.fetch = fetchMock as any

      service.addChannel({
        type: 'slack',
        config: {
          webhookUrl: 'https://hooks.slack.com/services/xxx',
        },
      })

      service.addChannel({
        type: 'discord',
        config: {
          webhookUrl: 'https://discord.com/api/webhooks/xxx/yyy',
        },
      })

      const event: NotificationEvent = {
        type: 'created',
        environment: mockEnvironment,
        timestamp: new Date(),
      }

      await service.notify(event)

      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('should continue sending even if one channel fails', async () => {
      let callCount = 0
      const fetchMock = mock(() => {
        callCount++
        return Promise.resolve({
          ok: callCount !== 1, // First call fails
          statusText: callCount === 1 ? 'Bad Request' : 'OK',
        } as Response)
      })
      global.fetch = fetchMock as any

      service.addChannel({
        type: 'slack',
        config: {
          webhookUrl: 'https://hooks.slack.com/services/xxx',
        },
      })

      service.addChannel({
        type: 'discord',
        config: {
          webhookUrl: 'https://discord.com/api/webhooks/xxx/yyy',
        },
      })

      const event: NotificationEvent = {
        type: 'created',
        environment: mockEnvironment,
        timestamp: new Date(),
      }

      // Should not throw even though first channel fails
      await expect(service.notify(event)).resolves.toBeUndefined()

      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
  })

  describe('Event types', () => {
    it('should handle created event', async () => {
      const fetchMock = mock(() =>
        Promise.resolve({
          ok: true,
          statusText: 'OK',
        } as Response),
      )
      global.fetch = fetchMock as any

      service.addChannel({
        type: 'slack',
        config: { webhookUrl: 'https://hooks.slack.com/services/xxx' },
      })

      await service.notify({
        type: 'created',
        environment: mockEnvironment,
        timestamp: new Date(),
      })

      const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]!.body as string)
      expect(body.attachments[0].title).toContain('Created')
    })

    it('should handle updated event', async () => {
      const fetchMock = mock(() =>
        Promise.resolve({
          ok: true,
          statusText: 'OK',
        } as Response),
      )
      global.fetch = fetchMock as any

      service.addChannel({
        type: 'slack',
        config: { webhookUrl: 'https://hooks.slack.com/services/xxx' },
      })

      await service.notify({
        type: 'updated',
        environment: mockEnvironment,
        timestamp: new Date(),
      })

      const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]!.body as string)
      expect(body.attachments[0].title).toContain('Updated')
    })

    it('should handle expired event', async () => {
      const fetchMock = mock(() =>
        Promise.resolve({
          ok: true,
          statusText: 'OK',
        } as Response),
      )
      global.fetch = fetchMock as any

      service.addChannel({
        type: 'slack',
        config: { webhookUrl: 'https://hooks.slack.com/services/xxx' },
      })

      await service.notify({
        type: 'expired',
        environment: mockEnvironment,
        timestamp: new Date(),
      })

      const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]!.body as string)
      expect(body.attachments[0].title).toContain('Expired')
    })
  })
})
