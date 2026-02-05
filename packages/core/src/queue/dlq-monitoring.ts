/**
 * SQS Dead Letter Queue Monitoring
 * DLQ monitoring, alerts, and automated reprocessing
*/

export interface DLQMonitor {
  id: string
  name: string
  queueUrl: string
  sourceQueues: string[]
  maxReceiveCount: number
  alarmThreshold: number
  autoReprocess: boolean
  reprocessStrategy: 'immediate' | 'scheduled' | 'manual'
  notificationTopicArn?: string
}

export interface DLQMetrics {
  id: string
  queueUrl: string
  timestamp: Date
  approximateNumberOfMessages: number
  approximateAgeOfOldestMessage: number // seconds
  messagesReceived: number
  messagesDeleted: number
  messagesReprocessed: number
}

export interface DLQAlert {
  id: string
  monitorId: string
  alertType: 'threshold_exceeded' | 'old_message' | 'high_receive_count'
  severity: 'low' | 'medium' | 'high' | 'critical'
  message: string
  timestamp: Date
  acknowledged: boolean
}

export interface ReprocessJob {
  id: string
  queueUrl: string
  messageId: string
  attempts: number
  status: 'pending' | 'processing' | 'success' | 'failed'
  startedAt?: Date
  completedAt?: Date
  error?: string
}

/**
 * DLQ monitoring manager
*/
export class DLQMonitoringManager {
  private monitors: Map<string, DLQMonitor> = new Map()
  private metrics: Map<string, DLQMetrics[]> = new Map()
  private alerts: Map<string, DLQAlert> = new Map()
  private reprocessJobs: Map<string, ReprocessJob> = new Map()
  private monitorCounter = 0
  private metricsCounter = 0
  private alertCounter = 0
  private jobCounter = 0

  /**
   * Create DLQ monitor
  */
  createDLQMonitor(monitor: Omit<DLQMonitor, 'id'>): DLQMonitor {
    const id = `dlq-monitor-${Date.now()}-${this.monitorCounter++}`

    const dlqMonitor: DLQMonitor = {
      id,
      ...monitor,
    }

    this.monitors.set(id, dlqMonitor)

    return dlqMonitor
  }

  /**
   * Create automated DLQ monitor
  */
  createAutomatedMonitor(options: {
    name: string
    queueUrl: string
    sourceQueues: string[]
    notificationTopicArn: string
  }): DLQMonitor {
    return this.createDLQMonitor({
      name: options.name,
      queueUrl: options.queueUrl,
      sourceQueues: options.sourceQueues,
      maxReceiveCount: 3,
      alarmThreshold: 10,
      autoReprocess: true,
      reprocessStrategy: 'scheduled',
      notificationTopicArn: options.notificationTopicArn,
    })
  }

  /**
   * Collect DLQ metrics
  */
  collectMetrics(queueUrl: string): DLQMetrics {
    const id = `metrics-${Date.now()}-${this.metricsCounter++}`

    // Simulate metrics collection
    const metrics: DLQMetrics = {
      id,
      queueUrl,
      timestamp: new Date(),
      approximateNumberOfMessages: Math.floor(Math.random() * 100),
      approximateAgeOfOldestMessage: Math.floor(Math.random() * 86400), // 0-24 hours
      messagesReceived: Math.floor(Math.random() * 50),
      messagesDeleted: Math.floor(Math.random() * 30),
      messagesReprocessed: Math.floor(Math.random() * 20),
    }

    const queueMetrics = this.metrics.get(queueUrl) || []
    queueMetrics.push(metrics)
    this.metrics.set(queueUrl, queueMetrics)

    // Check for alerts
    this.checkForAlerts(queueUrl, metrics)

    return metrics
  }

  /**
   * Check for alerts
  */
  private checkForAlerts(queueUrl: string, metrics: DLQMetrics): void {
    const monitor = Array.from(this.monitors.values()).find(m => m.queueUrl === queueUrl)

    if (!monitor) {
      return
    }

    // Check message threshold
    if (metrics.approximateNumberOfMessages >= monitor.alarmThreshold) {
      this.createAlert({
        monitorId: monitor.id,
        alertType: 'threshold_exceeded',
        severity: 'high',
        message: `DLQ ${monitor.name} has ${metrics.approximateNumberOfMessages} messages (threshold: ${monitor.alarmThreshold})`,
      })
    }

    // Check message age
    const maxAge = 3600 // 1 hour
    if (metrics.approximateAgeOfOldestMessage > maxAge) {
      this.createAlert({
        monitorId: monitor.id,
        alertType: 'old_message',
        severity: 'medium',
        message: `DLQ ${monitor.name} has messages older than ${maxAge} seconds`,
      })
    }
  }

  /**
   * Create alert
  */
  private createAlert(alert: Omit<DLQAlert, 'id' | 'timestamp' | 'acknowledged'>): DLQAlert {
    const id = `alert-${Date.now()}-${this.alertCounter++}`

    const dlqAlert: DLQAlert = {
      id,
      timestamp: new Date(),
      acknowledged: false,
      ...alert,
    }

    this.alerts.set(id, dlqAlert)

    return dlqAlert
  }

  /**
   * Acknowledge alert
  */
  acknowledgeAlert(alertId: string): DLQAlert {
    const alert = this.alerts.get(alertId)

    if (!alert) {
      throw new Error(`Alert not found: ${alertId}`)
    }

    alert.acknowledged = true

    return alert
  }

  /**
   * Create reprocess job
  */
  createReprocessJob(options: {
    queueUrl: string
    messageId: string
  }): ReprocessJob {
    const id = `reprocess-${Date.now()}-${this.jobCounter++}`

    const job: ReprocessJob = {
      id,
      queueUrl: options.queueUrl,
      messageId: options.messageId,
      attempts: 0,
      status: 'pending',
    }

    this.reprocessJobs.set(id, job)

    return job
  }

  /**
   * Execute reprocess job
  */
  async executeReprocessJob(jobId: string): Promise<ReprocessJob> {
    const job = this.reprocessJobs.get(jobId)

    if (!job) {
      throw new Error(`Reprocess job not found: ${jobId}`)
    }

    job.status = 'processing'
    job.startedAt = new Date()
    job.attempts++

    // Simulate reprocessing
    await new Promise(resolve => setTimeout(resolve, 100))

    // Random success/failure
    const success = Math.random() > 0.3

    job.status = success ? 'success' : 'failed'
    job.completedAt = new Date()

    if (!success) {
      job.error = 'Reprocessing failed - original error still present'
    }

    return job
  }

  /**
   * Batch reprocess DLQ messages
  */
  async batchReprocess(options: {
    queueUrl: string
    maxMessages: number
  }): Promise<ReprocessJob[]> {
    const jobs: ReprocessJob[] = []

    for (let i = 0; i < options.maxMessages; i++) {
      const job = this.createReprocessJob({
        queueUrl: options.queueUrl,
        messageId: `msg-${i}`,
      })

      await this.executeReprocessJob(job.id)
      jobs.push(job)
    }

    return jobs
  }

  /**
   * Get DLQ statistics
  */
  getDLQStatistics(queueUrl: string, hours: number = 24): {
    totalMessages: number
    avgAge: number
    messagesReceived: number
    messagesDeleted: number
    messagesReprocessed: number
    successRate: number
  } {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)
    const metricsHistory = (this.metrics.get(queueUrl) || [])
      .filter(m => m.timestamp >= cutoff)

    if (metricsHistory.length === 0) {
      return {
        totalMessages: 0,
        avgAge: 0,
        messagesReceived: 0,
        messagesDeleted: 0,
        messagesReprocessed: 0,
        successRate: 0,
      }
    }

    const latest = metricsHistory[metricsHistory.length - 1]
    const totalReceived = metricsHistory.reduce((sum, m) => sum + m.messagesReceived, 0)
    const totalDeleted = metricsHistory.reduce((sum, m) => sum + m.messagesDeleted, 0)
    const totalReprocessed = metricsHistory.reduce((sum, m) => sum + m.messagesReprocessed, 0)
    const avgAge = metricsHistory.reduce((sum, m) => sum + m.approximateAgeOfOldestMessage, 0) / metricsHistory.length

    const successRate = totalReprocessed > 0 ? (totalDeleted / totalReprocessed) * 100 : 0

    return {
      totalMessages: latest.approximateNumberOfMessages,
      avgAge,
      messagesReceived: totalReceived,
      messagesDeleted: totalDeleted,
      messagesReprocessed: totalReprocessed,
      successRate,
    }
  }

  /**
   * Get monitor
  */
  getMonitor(id: string): DLQMonitor | undefined {
    return this.monitors.get(id)
  }

  /**
   * List monitors
  */
  listMonitors(): DLQMonitor[] {
    return Array.from(this.monitors.values())
  }

  /**
   * Get alerts
  */
  getAlerts(monitorId?: string, acknowledged?: boolean): DLQAlert[] {
    let alerts = Array.from(this.alerts.values())

    if (monitorId) {
      alerts = alerts.filter(a => a.monitorId === monitorId)
    }

    if (acknowledged !== undefined) {
      alerts = alerts.filter(a => a.acknowledged === acknowledged)
    }

    return alerts.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  }

  /**
   * Get reprocess jobs
  */
  getReprocessJobs(queueUrl?: string): ReprocessJob[] {
    let jobs = Array.from(this.reprocessJobs.values())

    if (queueUrl) {
      jobs = jobs.filter(j => j.queueUrl === queueUrl)
    }

    return jobs
  }

  /**
   * Generate CloudFormation for DLQ alarm
  */
  generateDLQAlarmCF(monitor: DLQMonitor): any {
    return {
      Type: 'AWS::CloudWatch::Alarm',
      Properties: {
        AlarmName: `${monitor.name}-messages-alarm`,
        AlarmDescription: `Alert when DLQ ${monitor.name} exceeds threshold`,
        MetricName: 'ApproximateNumberOfMessagesVisible',
        Namespace: 'AWS/SQS',
        Statistic: 'Average',
        Period: 300,
        EvaluationPeriods: 1,
        Threshold: monitor.alarmThreshold,
        ComparisonOperator: 'GreaterThanThreshold',
        Dimensions: [
          {
            Name: 'QueueName',
            Value: monitor.queueUrl.split('/').pop(),
          },
        ],
        ...(monitor.notificationTopicArn && {
          AlarmActions: [monitor.notificationTopicArn],
        }),
      },
    }
  }

  /**
   * Clear all data
  */
  clear(): void {
    this.monitors.clear()
    this.metrics.clear()
    this.alerts.clear()
    this.reprocessJobs.clear()
    this.monitorCounter = 0
    this.metricsCounter = 0
    this.alertCounter = 0
    this.jobCounter = 0
  }
}

/**
 * Global DLQ monitoring manager instance
*/
export const dlqMonitoringManager: DLQMonitoringManager = new DLQMonitoringManager()
