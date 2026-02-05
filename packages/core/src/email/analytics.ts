/**
 * SES Email Analytics
 * Email tracking, analytics, and reporting
*/

export interface EmailEvent {
  id: string
  messageId: string
  eventType: 'send' | 'delivery' | 'open' | 'click' | 'bounce' | 'complaint' | 'reject' | 'renderingFailure'
  timestamp: Date
  recipient: string
  subject?: string
  tags?: Record<string, string>
}

export interface OpenEvent extends EmailEvent {
  eventType: 'open'
  ipAddress: string
  userAgent: string
}

export interface ClickEvent extends EmailEvent {
  eventType: 'click'
  link: string
  ipAddress: string
  userAgent: string
}

export interface EmailCampaign {
  id: string
  name: string
  subject: string
  fromEmail: string
  tags: Record<string, string>
  sentCount: number
  deliveredCount: number
  openCount: number
  clickCount: number
  bounceCount: number
  complaintCount: number
  createdAt: Date
}

export interface AnalyticsReport {
  id: string
  campaignId?: string
  startDate: Date
  endDate: Date
  totalSent: number
  totalDelivered: number
  totalOpened: number
  totalClicked: number
  totalBounced: number
  totalComplaints: number
  deliveryRate: number
  openRate: number
  clickRate: number
  clickToOpenRate: number
  bounceRate: number
  complaintRate: number
  topLinks: Array<{ link: string; clicks: number }>
  deviceBreakdown: Record<string, number>
  locationBreakdown: Record<string, number>
}

export interface ABTest {
  id: string
  name: string
  variants: ABTestVariant[]
  status: 'draft' | 'running' | 'completed'
  startedAt?: Date
  completedAt?: Date
  winner?: string
}

export interface ABTestVariant {
  id: string
  name: string
  subject: string
  content: string
  weight: number
  sentCount: number
  openCount: number
  clickCount: number
  conversionCount: number
}

/**
 * Email analytics manager
*/
export class EmailAnalyticsManager {
  private events: Map<string, EmailEvent> = new Map()
  private campaigns: Map<string, EmailCampaign> = new Map()
  private reports: Map<string, AnalyticsReport> = new Map()
  private abTests: Map<string, ABTest> = new Map()
  private eventCounter = 0
  private campaignCounter = 0
  private reportCounter = 0
  private abTestCounter = 0

  /**
   * Track email event
  */
  trackEvent(event: Omit<EmailEvent, 'id'>): EmailEvent {
    const id = `event-${Date.now()}-${this.eventCounter++}`

    const emailEvent: EmailEvent = {
      id,
      ...event,
    }

    this.events.set(id, emailEvent)

    // Update campaign stats if tags match
    if (event.tags?.campaignId) {
      this.updateCampaignStats(event.tags.campaignId, event.eventType)
    }

    return emailEvent
  }

  /**
   * Track open event
  */
  trackOpen(options: {
    messageId: string
    recipient: string
    ipAddress: string
    userAgent: string
    tags?: Record<string, string>
  }): OpenEvent {
    return this.trackEvent({
      ...options,
      eventType: 'open',
      timestamp: new Date(),
    }) as OpenEvent
  }

  /**
   * Track click event
  */
  trackClick(options: {
    messageId: string
    recipient: string
    link: string
    ipAddress: string
    userAgent: string
    tags?: Record<string, string>
  }): ClickEvent {
    return this.trackEvent({
      ...options,
      eventType: 'click',
      timestamp: new Date(),
    }) as ClickEvent
  }

  /**
   * Create campaign
  */
  createCampaign(campaign: Omit<EmailCampaign, 'id' | 'sentCount' | 'deliveredCount' | 'openCount' | 'clickCount' | 'bounceCount' | 'complaintCount' | 'createdAt'>): EmailCampaign {
    const id = `campaign-${Date.now()}-${this.campaignCounter++}`

    const emailCampaign: EmailCampaign = {
      id,
      sentCount: 0,
      deliveredCount: 0,
      openCount: 0,
      clickCount: 0,
      bounceCount: 0,
      complaintCount: 0,
      createdAt: new Date(),
      ...campaign,
    }

    this.campaigns.set(id, emailCampaign)

    return emailCampaign
  }

  /**
   * Update campaign stats
  */
  private updateCampaignStats(campaignId: string, eventType: string): void {
    const campaign = this.campaigns.get(campaignId)

    if (!campaign) {
      return
    }

    switch (eventType) {
      case 'send':
        campaign.sentCount++
        break
      case 'delivery':
        campaign.deliveredCount++
        break
      case 'open':
        campaign.openCount++
        break
      case 'click':
        campaign.clickCount++
        break
      case 'bounce':
        campaign.bounceCount++
        break
      case 'complaint':
        campaign.complaintCount++
        break
    }
  }

  /**
   * Generate analytics report
  */
  generateReport(options: {
    campaignId?: string
    startDate: Date
    endDate: Date
  }): AnalyticsReport {
    const id = `report-${Date.now()}-${this.reportCounter++}`

    const events = Array.from(this.events.values()).filter(e => {
      const inDateRange = e.timestamp >= options.startDate && e.timestamp <= options.endDate
      const matchesCampaign = !options.campaignId || e.tags?.campaignId === options.campaignId
      return inDateRange && matchesCampaign
    })

    const totalSent = events.filter(e => e.eventType === 'send').length
    const totalDelivered = events.filter(e => e.eventType === 'delivery').length
    const totalOpened = events.filter(e => e.eventType === 'open').length
    const totalClicked = events.filter(e => e.eventType === 'click').length
    const totalBounced = events.filter(e => e.eventType === 'bounce').length
    const totalComplaints = events.filter(e => e.eventType === 'complaint').length

    const deliveryRate = totalSent > 0 ? (totalDelivered / totalSent) * 100 : 0
    const openRate = totalDelivered > 0 ? (totalOpened / totalDelivered) * 100 : 0
    const clickRate = totalDelivered > 0 ? (totalClicked / totalDelivered) * 100 : 0
    const clickToOpenRate = totalOpened > 0 ? (totalClicked / totalOpened) * 100 : 0
    const bounceRate = totalSent > 0 ? (totalBounced / totalSent) * 100 : 0
    const complaintRate = totalDelivered > 0 ? (totalComplaints / totalDelivered) * 100 : 0

    // Top links
    const linkCounts = new Map<string, number>()
    for (const event of events) {
      if (event.eventType === 'click') {
        const clickEvent = event as ClickEvent
        linkCounts.set(clickEvent.link, (linkCounts.get(clickEvent.link) || 0) + 1)
      }
    }

    const topLinks = Array.from(linkCounts.entries())
      .map(([link, clicks]) => ({ link, clicks }))
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, 10)

    // Device breakdown (simplified)
    const deviceBreakdown: Record<string, number> = {
      desktop: 0,
      mobile: 0,
      tablet: 0,
      unknown: 0,
    }

    for (const event of events) {
      if (event.eventType === 'open' || event.eventType === 'click') {
        const ua = (event as OpenEvent | ClickEvent).userAgent.toLowerCase()
        if (ua.includes('mobile')) {
          deviceBreakdown.mobile++
        } else if (ua.includes('tablet')) {
          deviceBreakdown.tablet++
        } else if (ua.includes('mozilla')) {
          deviceBreakdown.desktop++
        } else {
          deviceBreakdown.unknown++
        }
      }
    }

    const report: AnalyticsReport = {
      id,
      campaignId: options.campaignId,
      startDate: options.startDate,
      endDate: options.endDate,
      totalSent,
      totalDelivered,
      totalOpened,
      totalClicked,
      totalBounced,
      totalComplaints,
      deliveryRate,
      openRate,
      clickRate,
      clickToOpenRate,
      bounceRate,
      complaintRate,
      topLinks,
      deviceBreakdown,
      locationBreakdown: {}, // Would require GeoIP lookup
    }

    this.reports.set(id, report)

    return report
  }

  /**
   * Create A/B test
  */
  createABTest(options: {
    name: string
    variants: Array<{
      name: string
      subject: string
      content: string
      weight: number
    }>
  }): ABTest {
    const id = `abtest-${Date.now()}-${this.abTestCounter++}`

    const abTest: ABTest = {
      id,
      name: options.name,
      variants: options.variants.map((v, index) => ({
        id: `variant-${id}-${index}`,
        sentCount: 0,
        openCount: 0,
        clickCount: 0,
        conversionCount: 0,
        ...v,
      })),
      status: 'draft',
    }

    this.abTests.set(id, abTest)

    return abTest
  }

  /**
   * Start A/B test
  */
  startABTest(abTestId: string): ABTest {
    const abTest = this.abTests.get(abTestId)

    if (!abTest) {
      throw new Error(`A/B test not found: ${abTestId}`)
    }

    abTest.status = 'running'
    abTest.startedAt = new Date()

    return abTest
  }

  /**
   * Complete A/B test
  */
  completeABTest(abTestId: string): ABTest {
    const abTest = this.abTests.get(abTestId)

    if (!abTest) {
      throw new Error(`A/B test not found: ${abTestId}`)
    }

    // Determine winner by open rate
    let winner = abTest.variants[0]
    let bestOpenRate = 0

    for (const variant of abTest.variants) {
      const openRate = variant.sentCount > 0 ? variant.openCount / variant.sentCount : 0
      if (openRate > bestOpenRate) {
        bestOpenRate = openRate
        winner = variant
      }
    }

    abTest.status = 'completed'
    abTest.completedAt = new Date()
    abTest.winner = winner.id

    return abTest
  }

  /**
   * Get campaign
  */
  getCampaign(id: string): EmailCampaign | undefined {
    return this.campaigns.get(id)
  }

  /**
   * List campaigns
  */
  listCampaigns(): EmailCampaign[] {
    return Array.from(this.campaigns.values())
  }

  /**
   * Get events
  */
  getEvents(options?: {
    messageId?: string
    eventType?: string
    startDate?: Date
    endDate?: Date
  }): EmailEvent[] {
    let events = Array.from(this.events.values())

    if (options?.messageId) {
      events = events.filter(e => e.messageId === options.messageId)
    }

    if (options?.eventType) {
      events = events.filter(e => e.eventType === options.eventType)
    }

    if (options?.startDate) {
      events = events.filter(e => e.timestamp >= options.startDate!)
    }

    if (options?.endDate) {
      events = events.filter(e => e.timestamp <= options.endDate!)
    }

    return events
  }

  /**
   * Generate CloudFormation for tracking configuration
  */
  generateTrackingConfigurationCF(options: {
    configurationSetName: string
    openTracking?: boolean
    clickTracking?: boolean
  }): any {
    return {
      Type: 'AWS::SES::ConfigurationSet',
      Properties: {
        Name: options.configurationSetName,
        ...(options.openTracking && {
          TrackingOptions: {
            CustomRedirectDomain: 'tracking.example.com',
          },
        }),
      },
    }
  }

  /**
   * Clear all data
  */
  clear(): void {
    this.events.clear()
    this.campaigns.clear()
    this.reports.clear()
    this.abTests.clear()
    this.eventCounter = 0
    this.campaignCounter = 0
    this.reportCounter = 0
    this.abTestCounter = 0
  }
}

/**
 * Global email analytics manager instance
*/
export const emailAnalyticsManager: EmailAnalyticsManager = new EmailAnalyticsManager()
