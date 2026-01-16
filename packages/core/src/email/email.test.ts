import { describe, expect, it, beforeEach } from 'bun:test'
import {
  BounceComplaintHandler,
  bounceComplaintHandler,
  EmailAnalyticsManager,
  emailAnalyticsManager,
  SenderReputationManager,
  senderReputationManager,
  EmailTemplateManager,
  emailTemplateManager,
} from '.'

describe('Bounce and Complaint Handler', () => {
  let manager: BounceComplaintHandler

  beforeEach(() => {
    manager = new BounceComplaintHandler()
  })

  it('should record bounce event', () => {
    const bounce = manager.recordBounce({
      timestamp: new Date(),
      messageId: 'msg-123',
      recipient: 'bounce@example.com',
      bounceType: 'Permanent',
      bounceSubType: 'General',
      feedbackId: 'fb-123',
    })

    expect(bounce.id).toContain('bounce')
    expect(bounce.bounceType).toBe('Permanent')
  })

  it('should auto-suppress permanent bounces', () => {
    manager.recordBounce({
      timestamp: new Date(),
      messageId: 'msg-123',
      recipient: 'permanent@example.com',
      bounceType: 'Permanent',
      bounceSubType: 'General',
      feedbackId: 'fb-123',
    })

    expect(manager.isSuppressed('permanent@example.com')).toBe(true)
  })

  it('should record complaint event', () => {
    const complaint = manager.recordComplaint({
      timestamp: new Date(),
      messageId: 'msg-456',
      recipients: ['complaint1@example.com', 'complaint2@example.com'],
      feedbackId: 'fb-456',
    })

    expect(complaint.id).toContain('complaint')
    expect(complaint.recipients).toHaveLength(2)
  })

  it('should create automatic bounce handler', () => {
    const handler = manager.createAutomaticBounceHandler({
      name: 'auto-handler',
      notificationTopicArn: 'arn:aws:sns:us-east-1:123456789012:topic',
    })

    expect(handler.autoSuppress).toBe(true)
    expect(handler.bounceThreshold).toBe(5)
  })

  it('should get bounce statistics', () => {
    const start = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const end = new Date()

    manager.recordBounce({
      timestamp: new Date(),
      messageId: 'msg-1',
      recipient: 'test1@example.com',
      bounceType: 'Permanent',
      bounceSubType: 'General',
      feedbackId: 'fb-1',
    })

    manager.recordBounce({
      timestamp: new Date(),
      messageId: 'msg-2',
      recipient: 'test2@example.com',
      bounceType: 'Transient',
      bounceSubType: 'General',
      feedbackId: 'fb-2',
    })

    const stats = manager.getBounceStatistics(start, end)

    expect(stats.totalBounces).toBe(2)
    expect(stats.permanentBounces).toBe(1)
    expect(stats.transientBounces).toBe(1)
  })

  it('should use global instance', () => {
    expect(bounceComplaintHandler).toBeInstanceOf(BounceComplaintHandler)
  })
})

describe('Email Analytics Manager', () => {
  let manager: EmailAnalyticsManager

  beforeEach(() => {
    manager = new EmailAnalyticsManager()
  })

  it('should track open event', () => {
    const event = manager.trackOpen({
      messageId: 'msg-123',
      recipient: 'user@example.com',
      ipAddress: '192.0.2.1',
      userAgent: 'Mozilla/5.0',
    })

    expect(event.eventType).toBe('open')
    expect(event.ipAddress).toBe('192.0.2.1')
  })

  it('should track click event', () => {
    const event = manager.trackClick({
      messageId: 'msg-123',
      recipient: 'user@example.com',
      link: 'https://example.com/landing',
      ipAddress: '192.0.2.1',
      userAgent: 'Mozilla/5.0',
    })

    expect(event.eventType).toBe('click')
    expect(event.link).toBe('https://example.com/landing')
  })

  it('should create campaign', () => {
    const campaign = manager.createCampaign({
      name: 'Summer Sale',
      subject: 'Big Summer Sale!',
      fromEmail: 'sales@example.com',
      tags: { category: 'promotional' },
    })

    expect(campaign.id).toContain('campaign')
    expect(campaign.sentCount).toBe(0)
  })

  it('should generate analytics report', () => {
    const campaign = manager.createCampaign({
      name: 'Test Campaign',
      subject: 'Test',
      fromEmail: 'test@example.com',
      tags: { campaignId: 'camp-1' },
    })

    // Track events
    manager.trackEvent({
      eventType: 'send',
      messageId: 'msg-1',
      recipient: 'user1@example.com',
      timestamp: new Date(),
      tags: { campaignId: campaign.id },
    })

    manager.trackEvent({
      eventType: 'delivery',
      messageId: 'msg-1',
      recipient: 'user1@example.com',
      timestamp: new Date(),
      tags: { campaignId: campaign.id },
    })

    manager.trackOpen({
      messageId: 'msg-1',
      recipient: 'user1@example.com',
      ipAddress: '192.0.2.1',
      userAgent: 'Mozilla/5.0',
      tags: { campaignId: campaign.id },
    })

    const report = manager.generateReport({
      campaignId: campaign.id,
      startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      endDate: new Date(),
    })

    expect(report.totalSent).toBe(1)
    expect(report.totalDelivered).toBe(1)
    expect(report.totalOpened).toBe(1)
  })

  it('should create A/B test', () => {
    const abTest = manager.createABTest({
      name: 'Subject Line Test',
      variants: [
        { name: 'A', subject: 'Subject A', content: 'Content A', weight: 50 },
        { name: 'B', subject: 'Subject B', content: 'Content B', weight: 50 },
      ],
    })

    expect(abTest.status).toBe('draft')
    expect(abTest.variants).toHaveLength(2)
  })

  it('should start and complete A/B test', () => {
    const abTest = manager.createABTest({
      name: 'Test',
      variants: [
        { name: 'A', subject: 'A', content: 'A', weight: 50 },
        { name: 'B', subject: 'B', content: 'B', weight: 50 },
      ],
    })

    manager.startABTest(abTest.id)
    expect(abTest.status).toBe('running')

    manager.completeABTest(abTest.id)
    expect(abTest.status).toBe('completed')
    expect(abTest.winner).toBeDefined()
  })

  it('should use global instance', () => {
    expect(emailAnalyticsManager).toBeInstanceOf(EmailAnalyticsManager)
  })
})

describe('Sender Reputation Manager', () => {
  let manager: SenderReputationManager

  beforeEach(() => {
    manager = new SenderReputationManager()
  })

  it('should get reputation dashboard', () => {
    const dashboard = manager.getReputationDashboard()

    expect(dashboard.id).toContain('dashboard')
    expect(dashboard.overallScore).toBeGreaterThanOrEqual(0)
    expect(dashboard.overallScore).toBeLessThanOrEqual(100)
    expect(dashboard.blacklistStatus).toBeDefined()
  })

  it('should create warmup plan', () => {
    const warmup = manager.createWarmupPlan({
      name: 'New Domain Warmup',
      initialDailyLimit: 100,
      targetDailyLimit: 10000,
      durationDays: 20,
    })

    expect(warmup.id).toContain('warmup')
    expect(warmup.dailyLimits).toHaveLength(20)
    expect(warmup.status).toBe('active')
  })

  it('should create aggressive warmup plan', () => {
    const warmup = manager.createAggressiveWarmupPlan({
      name: 'Aggressive Warmup',
    })

    expect(warmup.totalDays).toBe(14)
    expect(warmup.dailyLimits[0]).toBe(500)
  })

  it('should create conservative warmup plan', () => {
    const warmup = manager.createConservativeWarmupPlan({
      name: 'Conservative Warmup',
    })

    expect(warmup.totalDays).toBe(30)
    expect(warmup.dailyLimits[0]).toBe(200)
  })

  it('should advance warmup plan', () => {
    const warmup = manager.createWarmupPlan({
      name: 'Test Warmup',
      initialDailyLimit: 100,
      targetDailyLimit: 1000,
      durationDays: 10,
    })

    const initialDay = warmup.currentDay
    manager.advanceWarmupPlan(warmup.id)

    expect(warmup.currentDay).toBe(initialDay + 1)
  })

  it('should track domain reputation', () => {
    const reputation = manager.trackDomainReputation({
      domain: 'example.com',
      totalSent: 1000,
      delivered: 950,
      opened: 300,
      clicked: 100,
      bounced: 30,
      complained: 2,
    })

    expect(reputation.domain).toBe('example.com')
    expect(reputation.deliveryRate).toBeGreaterThan(0)
    expect(reputation.reputationScore).toBeDefined()
  })

  it('should use global instance', () => {
    expect(senderReputationManager).toBeInstanceOf(SenderReputationManager)
  })
})

describe('Email Template Manager', () => {
  let manager: EmailTemplateManager

  beforeEach(() => {
    manager = new EmailTemplateManager()
  })

  it('should create template', () => {
    const template = manager.createTemplate({
      name: 'Welcome Email',
      subject: 'Welcome {{userName}}!',
      htmlPart: '<h1>Welcome {{userName}}</h1>',
      textPart: 'Welcome {{userName}}',
    })

    expect(template.id).toContain('template')
    expect(template.variables).toContain('userName')
    expect(template.version).toBe(1)
  })

  it('should create welcome template', () => {
    const template = manager.createWelcomeTemplate({
      name: 'Welcome',
      companyName: 'Acme Inc',
    })

    expect(template.subject).toContain('Welcome')
    expect(template.variables).toContain('userName')
    expect(template.variables).toContain('companyName')
  })

  it('should create password reset template', () => {
    const template = manager.createPasswordResetTemplate({
      name: 'Password Reset',
      companyName: 'Acme Inc',
    })

    expect(template.subject).toContain('password')
    expect(template.variables).toContain('resetUrl')
  })

  it('should update template', () => {
    const template = manager.createTemplate({
      name: 'Test',
      subject: 'Original Subject',
      htmlPart: '<p>Original</p>',
      textPart: 'Original',
    })

    manager.updateTemplate(template.id, {
      subject: 'Updated Subject',
    }, 'Changed subject line')

    expect(template.subject).toBe('Updated Subject')
    expect(template.version).toBe(2)
  })

  it('should render template', () => {
    const template = manager.createTemplate({
      name: 'Test',
      subject: 'Hello {{name}}!',
      htmlPart: '<p>Welcome {{name}} to {{company}}</p>',
      textPart: 'Welcome {{name}} to {{company}}',
    })

    const rendered = manager.renderTemplate(template.id, {
      name: 'John',
      company: 'Acme Inc',
    })

    expect(rendered.subject).toBe('Hello John!')
    expect(rendered.html).toContain('Welcome John to Acme Inc')
  })

  it('should test template', () => {
    const template = manager.createTemplate({
      name: 'Test',
      subject: 'Test {{var}}',
      htmlPart: '<p>{{var}}</p>',
      textPart: '{{var}}',
    })

    const test = manager.testTemplate(template.id, { var: 'value' })

    expect(test.renderedSubject).toBe('Test value')
    expect(test.renderedHtml).toContain('value')
  })

  it('should get template versions', () => {
    const template = manager.createTemplate({
      name: 'Test',
      subject: 'V1',
      htmlPart: '<p>V1</p>',
      textPart: 'V1',
    })

    manager.updateTemplate(template.id, { subject: 'V2' })
    manager.updateTemplate(template.id, { subject: 'V3' })

    const versions = manager.getTemplateVersions(template.id)

    expect(versions).toHaveLength(3)
    expect(versions[0].version).toBe(1)
    expect(versions[2].version).toBe(3)
  })

  it('should revert to version', () => {
    const template = manager.createTemplate({
      name: 'Test',
      subject: 'V1',
      htmlPart: '<p>V1</p>',
      textPart: 'V1',
    })

    manager.updateTemplate(template.id, { subject: 'V2' })
    manager.revertToVersion(template.id, 1)

    expect(template.subject).toBe('V1')
  })

  it('should use global instance', () => {
    expect(emailTemplateManager).toBeInstanceOf(EmailTemplateManager)
  })
})
