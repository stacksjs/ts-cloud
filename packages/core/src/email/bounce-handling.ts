/**
 * SES Bounce and Complaint Handling
 * Automated bounce processing and reputation management
 */

export interface BounceEvent {
  id: string
  timestamp: Date
  messageId: string
  recipient: string
  bounceType: 'Permanent' | 'Transient' | 'Undetermined'
  bounceSubType: string
  diagnosticCode?: string
  feedbackId: string
}

export interface ComplaintEvent {
  id: string
  timestamp: Date
  messageId: string
  recipients: string[]
  complaintFeedbackType?: string
  userAgent?: string
  feedbackId: string
  arrivalDate?: Date
}

export interface BounceHandler {
  id: string
  name: string
  bounceThreshold: number
  complaintThreshold: number
  suppressionDuration: number // seconds
  autoSuppress: boolean
  notificationTopicArn?: string
}

export interface SuppressionListEntry {
  id: string
  emailAddress: string
  reason: 'BOUNCE' | 'COMPLAINT'
  suppressedAt: Date
  expiresAt?: Date
  bounceCount?: number
  complaintCount?: number
}

export interface ReputationMetrics {
  id: string
  timestamp: Date
  bounceRate: number
  complaintRate: number
  sendingQuota: number
  maxSendRate: number
  sentLast24Hours: number
  reputationStatus: 'Good' | 'Warning' | 'Probation' | 'Shutdown'
}

/**
 * Bounce and complaint handler
 */
export class BounceComplaintHandler {
  private bounces: Map<string, BounceEvent> = new Map()
  private complaints: Map<string, ComplaintEvent> = new Map()
  private handlers: Map<string, BounceHandler> = new Map()
  private suppressionList: Map<string, SuppressionListEntry> = new Map()
  private metrics: Map<string, ReputationMetrics> = new Map()
  private bounceCounter = 0
  private complaintCounter = 0
  private handlerCounter = 0
  private suppressionCounter = 0
  private metricsCounter = 0

  /**
   * Record bounce event
   */
  recordBounce(bounce: Omit<BounceEvent, 'id'>): BounceEvent {
    const id = `bounce-${Date.now()}-${this.bounceCounter++}`

    const bounceEvent: BounceEvent = {
      id,
      ...bounce,
    }

    this.bounces.set(id, bounceEvent)

    // Auto-suppress if permanent bounce
    if (bounce.bounceType === 'Permanent') {
      this.addToSuppressionList({
        emailAddress: bounce.recipient,
        reason: 'BOUNCE',
      })
    }

    return bounceEvent
  }

  /**
   * Record complaint event
   */
  recordComplaint(complaint: Omit<ComplaintEvent, 'id'>): ComplaintEvent {
    const id = `complaint-${Date.now()}-${this.complaintCounter++}`

    const complaintEvent: ComplaintEvent = {
      id,
      ...complaint,
    }

    this.complaints.set(id, complaintEvent)

    // Auto-suppress all recipients
    for (const recipient of complaint.recipients) {
      this.addToSuppressionList({
        emailAddress: recipient,
        reason: 'COMPLAINT',
      })
    }

    return complaintEvent
  }

  /**
   * Create bounce handler
   */
  createBounceHandler(handler: Omit<BounceHandler, 'id'>): BounceHandler {
    const id = `handler-${Date.now()}-${this.handlerCounter++}`

    const bounceHandler: BounceHandler = {
      id,
      ...handler,
    }

    this.handlers.set(id, bounceHandler)

    return bounceHandler
  }

  /**
   * Create automatic bounce handler
   */
  createAutomaticBounceHandler(options: {
    name: string
    notificationTopicArn: string
  }): BounceHandler {
    return this.createBounceHandler({
      name: options.name,
      bounceThreshold: 5, // 5% bounce rate
      complaintThreshold: 0.1, // 0.1% complaint rate
      suppressionDuration: 2592000, // 30 days
      autoSuppress: true,
      notificationTopicArn: options.notificationTopicArn,
    })
  }

  /**
   * Add to suppression list
   */
  addToSuppressionList(entry: {
    emailAddress: string
    reason: 'BOUNCE' | 'COMPLAINT'
    expirationDays?: number
  }): SuppressionListEntry {
    const id = `suppression-${Date.now()}-${this.suppressionCounter++}`

    const expiresAt = entry.expirationDays
      ? new Date(Date.now() + entry.expirationDays * 24 * 60 * 60 * 1000)
      : undefined

    const suppressionEntry: SuppressionListEntry = {
      id,
      emailAddress: entry.emailAddress,
      reason: entry.reason,
      suppressedAt: new Date(),
      expiresAt,
      bounceCount: entry.reason === 'BOUNCE' ? 1 : 0,
      complaintCount: entry.reason === 'COMPLAINT' ? 1 : 0,
    }

    this.suppressionList.set(entry.emailAddress, suppressionEntry)

    return suppressionEntry
  }

  /**
   * Remove from suppression list
   */
  removeFromSuppressionList(emailAddress: string): boolean {
    return this.suppressionList.delete(emailAddress)
  }

  /**
   * Check if email is suppressed
   */
  isSuppressed(emailAddress: string): boolean {
    const entry = this.suppressionList.get(emailAddress)

    if (!entry) {
      return false
    }

    // Check if expired
    if (entry.expiresAt && entry.expiresAt < new Date()) {
      this.suppressionList.delete(emailAddress)
      return false
    }

    return true
  }

  /**
   * Get bounce statistics
   */
  getBounceStatistics(startDate: Date, endDate: Date): {
    totalBounces: number
    permanentBounces: number
    transientBounces: number
    bounceRate: number
    topRecipients: Array<{ email: string; count: number }>
  } {
    const bounces = Array.from(this.bounces.values()).filter(
      b => b.timestamp >= startDate && b.timestamp <= endDate
    )

    const totalBounces = bounces.length
    const permanentBounces = bounces.filter(b => b.bounceType === 'Permanent').length
    const transientBounces = bounces.filter(b => b.bounceType === 'Transient').length

    // Calculate bounce rate (would need sent count in real implementation)
    const estimatedSent = totalBounces * 10 // Placeholder
    const bounceRate = (totalBounces / estimatedSent) * 100

    // Top recipients by bounce count
    const recipientCounts = new Map<string, number>()
    for (const bounce of bounces) {
      recipientCounts.set(bounce.recipient, (recipientCounts.get(bounce.recipient) || 0) + 1)
    }

    const topRecipients = Array.from(recipientCounts.entries())
      .map(([email, count]) => ({ email, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    return {
      totalBounces,
      permanentBounces,
      transientBounces,
      bounceRate,
      topRecipients,
    }
  }

  /**
   * Get complaint statistics
   */
  getComplaintStatistics(startDate: Date, endDate: Date): {
    totalComplaints: number
    uniqueComplainters: number
    complaintRate: number
  } {
    const complaints = Array.from(this.complaints.values()).filter(
      c => c.timestamp >= startDate && c.timestamp <= endDate
    )

    const totalComplaints = complaints.length
    const uniqueEmails = new Set<string>()

    for (const complaint of complaints) {
      for (const recipient of complaint.recipients) {
        uniqueEmails.add(recipient)
      }
    }

    const uniqueComplainters = uniqueEmails.size

    // Calculate complaint rate (would need sent count in real implementation)
    const estimatedSent = totalComplaints * 1000 // Placeholder
    const complaintRate = (totalComplaints / estimatedSent) * 100

    return {
      totalComplaints,
      uniqueComplainters,
      complaintRate,
    }
  }

  /**
   * Calculate reputation metrics
   */
  calculateReputationMetrics(): ReputationMetrics {
    const id = `metrics-${Date.now()}-${this.metricsCounter++}`

    const now = new Date()
    const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000)

    const stats = this.getBounceStatistics(last24Hours, now)
    const complaintStats = this.getComplaintStatistics(last24Hours, now)

    let reputationStatus: 'Good' | 'Warning' | 'Probation' | 'Shutdown'

    if (stats.bounceRate > 10 || complaintStats.complaintRate > 0.5) {
      reputationStatus = 'Shutdown'
    } else if (stats.bounceRate > 5 || complaintStats.complaintRate > 0.1) {
      reputationStatus = 'Probation'
    } else if (stats.bounceRate > 2 || complaintStats.complaintRate > 0.05) {
      reputationStatus = 'Warning'
    } else {
      reputationStatus = 'Good'
    }

    const metrics: ReputationMetrics = {
      id,
      timestamp: now,
      bounceRate: stats.bounceRate,
      complaintRate: complaintStats.complaintRate,
      sendingQuota: 50000,
      maxSendRate: 14,
      sentLast24Hours: stats.totalBounces * 10, // Placeholder
      reputationStatus,
    }

    this.metrics.set(id, metrics)

    return metrics
  }

  /**
   * Get bounce events
   */
  getBounces(messageId?: string): BounceEvent[] {
    const bounces = Array.from(this.bounces.values())
    return messageId ? bounces.filter(b => b.messageId === messageId) : bounces
  }

  /**
   * Get complaint events
   */
  getComplaints(messageId?: string): ComplaintEvent[] {
    const complaints = Array.from(this.complaints.values())
    return messageId ? complaints.filter(c => c.messageId === messageId) : complaints
  }

  /**
   * List suppression list
   */
  listSuppressionList(reason?: 'BOUNCE' | 'COMPLAINT'): SuppressionListEntry[] {
    const entries = Array.from(this.suppressionList.values())
    return reason ? entries.filter(e => e.reason === reason) : entries
  }

  /**
   * Generate CloudFormation for SNS topic subscription
   */
  generateSNSSubscriptionCF(options: {
    topicArn: string
    endpoint: string
    protocol: 'email' | 'email-json' | 'http' | 'https' | 'sqs' | 'lambda'
  }): any {
    return {
      Type: 'AWS::SNS::Subscription',
      Properties: {
        TopicArn: options.topicArn,
        Endpoint: options.endpoint,
        Protocol: options.protocol,
      },
    }
  }

  /**
   * Generate CloudFormation for SES configuration set event destination
   */
  generateEventDestinationCF(options: {
    configurationSetName: string
    eventDestinationName: string
    eventTypes: Array<'send' | 'reject' | 'bounce' | 'complaint' | 'delivery' | 'open' | 'click' | 'renderingFailure'>
    snsTopicArn?: string
    cloudWatchDestination?: {
      dimensionConfigurations: Array<{
        dimensionName: string
        dimensionValueSource: 'messageTag' | 'emailHeader' | 'linkTag'
        defaultDimensionValue: string
      }>
    }
  }): any {
    return {
      Type: 'AWS::SES::ConfigurationSetEventDestination',
      Properties: {
        ConfigurationSetName: options.configurationSetName,
        EventDestination: {
          Name: options.eventDestinationName,
          Enabled: true,
          MatchingEventTypes: options.eventTypes,
          ...(options.snsTopicArn && {
            SnsDestination: {
              TopicARN: options.snsTopicArn,
            },
          }),
          ...(options.cloudWatchDestination && {
            CloudWatchDestination: options.cloudWatchDestination,
          }),
        },
      },
    }
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.bounces.clear()
    this.complaints.clear()
    this.handlers.clear()
    this.suppressionList.clear()
    this.metrics.clear()
    this.bounceCounter = 0
    this.complaintCounter = 0
    this.handlerCounter = 0
    this.suppressionCounter = 0
    this.metricsCounter = 0
  }
}

/**
 * Global bounce and complaint handler instance
 */
export const bounceComplaintHandler: BounceComplaintHandler = new BounceComplaintHandler()
