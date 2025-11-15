/**
 * Preview environment notifications
 * Send notifications to Slack, Discord, email, etc. when preview environments are created/destroyed
 */

import type { PreviewEnvironment } from './manager'

export interface NotificationChannel {
  type: 'slack' | 'discord' | 'email' | 'webhook'
  config: SlackConfig | DiscordConfig | EmailConfig | WebhookConfig
}

export interface SlackConfig {
  webhookUrl: string
  channel?: string
  username?: string
  iconEmoji?: string
}

export interface DiscordConfig {
  webhookUrl: string
  username?: string
  avatarUrl?: string
}

export interface EmailConfig {
  from: string
  to: string[]
  smtpHost: string
  smtpPort: number
  smtpUser?: string
  smtpPassword?: string
}

export interface WebhookConfig {
  url: string
  method?: 'POST' | 'GET'
  headers?: Record<string, string>
}

export interface NotificationEvent {
  type: 'created' | 'updated' | 'destroyed' | 'failed' | 'expired'
  environment: PreviewEnvironment
  timestamp: Date
  metadata?: Record<string, any>
}

/**
 * Preview environment notification service
 */
export class PreviewNotificationService {
  private channels: NotificationChannel[] = []

  /**
   * Add notification channel
   */
  addChannel(channel: NotificationChannel): void {
    this.channels.push(channel)
  }

  /**
   * Remove notification channel
   */
  removeChannel(type: NotificationChannel['type']): void {
    this.channels = this.channels.filter(c => c.type !== type)
  }

  /**
   * Send notification to all channels
   */
  async notify(event: NotificationEvent): Promise<void> {
    const promises = this.channels.map(channel => this.sendToChannel(channel, event))

    await Promise.allSettled(promises)
  }

  /**
   * Send notification to specific channel
   */
  private async sendToChannel(channel: NotificationChannel, event: NotificationEvent): Promise<void> {
    switch (channel.type) {
      case 'slack':
        await this.sendToSlack(channel.config as SlackConfig, event)
        break
      case 'discord':
        await this.sendToDiscord(channel.config as DiscordConfig, event)
        break
      case 'email':
        await this.sendToEmail(channel.config as EmailConfig, event)
        break
      case 'webhook':
        await this.sendToWebhook(channel.config as WebhookConfig, event)
        break
    }
  }

  /**
   * Send notification to Slack
   */
  private async sendToSlack(config: SlackConfig, event: NotificationEvent): Promise<void> {
    const message = this.formatSlackMessage(event, config)

    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    })

    if (!response.ok) {
      throw new Error(`Failed to send Slack notification: ${response.statusText}`)
    }
  }

  /**
   * Format Slack message
   */
  private formatSlackMessage(event: NotificationEvent, config: SlackConfig): any {
    const { environment, type } = event

    const emoji = {
      created: ':rocket:',
      updated: ':arrows_counterclockwise:',
      destroyed: ':wastebasket:',
      failed: ':x:',
      expired: ':hourglass_flowing_sand:',
    }[type]

    const color = {
      created: '#36a64f',
      updated: '#2196F3',
      destroyed: '#808080',
      failed: '#f44336',
      expired: '#ff9800',
    }[type]

    const title = {
      created: 'Preview Environment Created',
      updated: 'Preview Environment Updated',
      destroyed: 'Preview Environment Destroyed',
      failed: 'Preview Environment Failed',
      expired: 'Preview Environment Expired',
    }[type]

    return {
      username: config.username || 'ts-cloud',
      icon_emoji: config.iconEmoji || ':cloud:',
      channel: config.channel,
      attachments: [
        {
          color,
          title: `${emoji} ${title}`,
          fields: [
            {
              title: 'Environment',
              value: environment.name,
              short: true,
            },
            {
              title: 'Branch',
              value: environment.branch,
              short: true,
            },
            ...(environment.pr
              ? [
                  {
                    title: 'PR',
                    value: `#${environment.pr}`,
                    short: true,
                  },
                ]
              : []),
            {
              title: 'Commit',
              value: environment.commitSha.substring(0, 7),
              short: true,
            },
            ...(environment.url
              ? [
                  {
                    title: 'URL',
                    value: environment.url,
                    short: false,
                  },
                ]
              : []),
            ...(type === 'created'
              ? [
                  {
                    title: 'Expires',
                    value: environment.expiresAt.toLocaleString(),
                    short: true,
                  },
                ]
              : []),
          ],
          footer: 'ts-cloud Preview Environments',
          ts: Math.floor(event.timestamp.getTime() / 1000),
        },
      ],
    }
  }

  /**
   * Send notification to Discord
   */
  private async sendToDiscord(config: DiscordConfig, event: NotificationEvent): Promise<void> {
    const message = this.formatDiscordMessage(event, config)

    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    })

    if (!response.ok) {
      throw new Error(`Failed to send Discord notification: ${response.statusText}`)
    }
  }

  /**
   * Format Discord message
   */
  private formatDiscordMessage(event: NotificationEvent, config: DiscordConfig): any {
    const { environment, type } = event

    const emoji = {
      created: ':rocket:',
      updated: ':arrows_counterclockwise:',
      destroyed: ':wastebasket:',
      failed: ':x:',
      expired: ':hourglass:',
    }[type]

    const color = {
      created: 0x36A64F,
      updated: 0x2196F3,
      destroyed: 0x808080,
      failed: 0xF44336,
      expired: 0xFF9800,
    }[type]

    const title = {
      created: 'Preview Environment Created',
      updated: 'Preview Environment Updated',
      destroyed: 'Preview Environment Destroyed',
      failed: 'Preview Environment Failed',
      expired: 'Preview Environment Expired',
    }[type]

    return {
      username: config.username || 'ts-cloud',
      avatar_url: config.avatarUrl,
      embeds: [
        {
          title: `${emoji} ${title}`,
          color,
          fields: [
            {
              name: 'Environment',
              value: environment.name,
              inline: true,
            },
            {
              name: 'Branch',
              value: environment.branch,
              inline: true,
            },
            ...(environment.pr
              ? [
                  {
                    name: 'PR',
                    value: `#${environment.pr}`,
                    inline: true,
                  },
                ]
              : []),
            {
              name: 'Commit',
              value: `\`${environment.commitSha.substring(0, 7)}\``,
              inline: true,
            },
            ...(environment.url
              ? [
                  {
                    name: 'URL',
                    value: environment.url,
                    inline: false,
                  },
                ]
              : []),
          ],
          timestamp: event.timestamp.toISOString(),
          footer: {
            text: 'ts-cloud Preview Environments',
          },
        },
      ],
    }
  }

  /**
   * Send notification via email
   */
  private async sendToEmail(config: EmailConfig, event: NotificationEvent): Promise<void> {
    // This is a placeholder - actual implementation would use nodemailer or similar
    // For now, we'll just log that email would be sent
    console.log(`Email notification would be sent to ${config.to.join(', ')}`)
  }

  /**
   * Send notification to custom webhook
   */
  private async sendToWebhook(config: WebhookConfig, event: NotificationEvent): Promise<void> {
    const response = await fetch(config.url, {
      method: config.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...config.headers,
      },
      body: JSON.stringify({
        event: event.type,
        environment: event.environment,
        timestamp: event.timestamp.toISOString(),
        metadata: event.metadata,
      }),
    })

    if (!response.ok) {
      throw new Error(`Failed to send webhook notification: ${response.statusText}`)
    }
  }
}

/**
 * Global notification service instance
 */
export const previewNotifications = new PreviewNotificationService()
