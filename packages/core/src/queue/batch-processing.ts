/**
 * SQS Batch Processing
 * Batch operations, parallel processing, and throughput optimization
 */

export interface BatchConfig {
  id: string
  queueUrl: string
  batchSize: number
  maxWaitTime: number // milliseconds
  parallelProcessors: number
  retryAttempts: number
  visibilityTimeout: number
}

export interface BatchJob {
  id: string
  configId: string
  messages: BatchMessage[]
  status: 'pending' | 'processing' | 'completed' | 'failed'
  startedAt?: Date
  completedAt?: Date
  processedCount: number
  failedCount: number
}

export interface BatchMessage {
  id: string
  messageId: string
  body: string
  receiptHandle: string
  attributes: Record<string, any>
  status: 'pending' | 'processing' | 'success' | 'failed'
  processingTime?: number
  error?: string
}

export interface ProcessorMetrics {
  id: string
  configId: string
  timestamp: Date
  messagesProcessed: number
  averageProcessingTime: number
  throughput: number // messages per second
  errorRate: number
}

/**
 * Batch processing manager
 */
export class BatchProcessingManager {
  private configs: Map<string, BatchConfig> = new Map()
  private jobs: Map<string, BatchJob> = new Map()
  private metrics: Map<string, ProcessorMetrics[]> = new Map()
  private configCounter = 0
  private jobCounter = 0
  private metricsCounter = 0

  /**
   * Create batch config
   */
  createBatchConfig(config: Omit<BatchConfig, 'id'>): BatchConfig {
    const id = `batch-config-${Date.now()}-${this.configCounter++}`

    const batchConfig: BatchConfig = {
      id,
      ...config,
    }

    this.configs.set(id, batchConfig)

    return batchConfig
  }

  /**
   * Create high-throughput batch config
   */
  createHighThroughputConfig(options: {
    queueUrl: string
  }): BatchConfig {
    return this.createBatchConfig({
      queueUrl: options.queueUrl,
      batchSize: 10, // Max for SQS
      maxWaitTime: 100,
      parallelProcessors: 10,
      retryAttempts: 3,
      visibilityTimeout: 30,
    })
  }

  /**
   * Create low-latency batch config
   */
  createLowLatencyConfig(options: {
    queueUrl: string
  }): BatchConfig {
    return this.createBatchConfig({
      queueUrl: options.queueUrl,
      batchSize: 1,
      maxWaitTime: 0,
      parallelProcessors: 5,
      retryAttempts: 2,
      visibilityTimeout: 10,
    })
  }

  /**
   * Create batch job
   */
  createBatchJob(options: {
    configId: string
    messageCount: number
  }): BatchJob {
    const id = `batch-job-${Date.now()}-${this.jobCounter++}`

    const config = this.configs.get(options.configId)

    if (!config) {
      throw new Error(`Batch config not found: ${options.configId}`)
    }

    const messages: BatchMessage[] = []
    for (let i = 0; i < options.messageCount; i++) {
      messages.push({
        id: `msg-${id}-${i}`,
        messageId: `${id}-${i}`,
        body: `Message ${i}`,
        receiptHandle: `receipt-${id}-${i}`,
        attributes: {},
        status: 'pending',
      })
    }

    const job: BatchJob = {
      id,
      configId: options.configId,
      messages,
      status: 'pending',
      processedCount: 0,
      failedCount: 0,
    }

    this.jobs.set(id, job)

    return job
  }

  /**
   * Process batch job
   */
  async processBatchJob(jobId: string): Promise<BatchJob> {
    const job = this.jobs.get(jobId)

    if (!job) {
      throw new Error(`Batch job not found: ${jobId}`)
    }

    const config = this.configs.get(job.configId)

    if (!config) {
      throw new Error(`Batch config not found: ${job.configId}`)
    }

    job.status = 'processing'
    job.startedAt = new Date()

    // Process in batches
    const batches = this.chunkArray(job.messages, config.batchSize)

    for (const batch of batches) {
      await this.processBatch(batch, config)
    }

    // Update job status
    job.processedCount = job.messages.filter(m => m.status === 'success').length
    job.failedCount = job.messages.filter(m => m.status === 'failed').length
    job.status = job.failedCount === 0 ? 'completed' : 'failed'
    job.completedAt = new Date()

    // Collect metrics
    this.collectProcessorMetrics(config.id, job)

    return job
  }

  /**
   * Process single batch
   */
  private async processBatch(messages: BatchMessage[], config: BatchConfig): Promise<void> {
    const promises = messages.map(msg => this.processMessage(msg, config))
    await Promise.all(promises)
  }

  /**
   * Process single message
   */
  private async processMessage(message: BatchMessage, config: BatchConfig): Promise<void> {
    message.status = 'processing'

    const startTime = Date.now()

    // Simulate processing with random delay
    await new Promise(resolve => setTimeout(resolve, Math.random() * 100))

    const processingTime = Date.now() - startTime
    message.processingTime = processingTime

    // Random success/failure
    const success = Math.random() > 0.1

    if (success) {
      message.status = 'success'
    } else {
      message.status = 'failed'
      message.error = 'Processing error'
    }
  }

  /**
   * Chunk array into batches
   */
  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize))
    }
    return chunks
  }

  /**
   * Collect processor metrics
   */
  private collectProcessorMetrics(configId: string, job: BatchJob): void {
    const id = `metrics-${Date.now()}-${this.metricsCounter++}`

    const successfulMessages = job.messages.filter(m => m.status === 'success')
    const processingTimes = successfulMessages
      .map(m => m.processingTime || 0)
      .filter(t => t > 0)

    const averageProcessingTime = processingTimes.length > 0
      ? processingTimes.reduce((sum, t) => sum + t, 0) / processingTimes.length
      : 0

    const duration = job.completedAt && job.startedAt
      ? (job.completedAt.getTime() - job.startedAt.getTime()) / 1000
      : 1

    const throughput = job.processedCount / duration

    const errorRate = job.messages.length > 0
      ? (job.failedCount / job.messages.length) * 100
      : 0

    const metrics: ProcessorMetrics = {
      id,
      configId,
      timestamp: new Date(),
      messagesProcessed: job.processedCount,
      averageProcessingTime,
      throughput,
      errorRate,
    }

    const configMetrics = this.metrics.get(configId) || []
    configMetrics.push(metrics)
    this.metrics.set(configId, configMetrics)
  }

  /**
   * Get batch statistics
   */
  getBatchStatistics(configId: string): {
    totalJobsProcessed: number
    totalMessagesProcessed: number
    averageThroughput: number
    averageErrorRate: number
    averageProcessingTime: number
  } {
    const metricsHistory = this.metrics.get(configId) || []

    if (metricsHistory.length === 0) {
      return {
        totalJobsProcessed: 0,
        totalMessagesProcessed: 0,
        averageThroughput: 0,
        averageErrorRate: 0,
        averageProcessingTime: 0,
      }
    }

    const totalMessagesProcessed = metricsHistory.reduce((sum, m) => sum + m.messagesProcessed, 0)
    const averageThroughput = metricsHistory.reduce((sum, m) => sum + m.throughput, 0) / metricsHistory.length
    const averageErrorRate = metricsHistory.reduce((sum, m) => sum + m.errorRate, 0) / metricsHistory.length
    const averageProcessingTime = metricsHistory.reduce((sum, m) => sum + m.averageProcessingTime, 0) / metricsHistory.length

    return {
      totalJobsProcessed: metricsHistory.length,
      totalMessagesProcessed,
      averageThroughput,
      averageErrorRate,
      averageProcessingTime,
    }
  }

  /**
   * Optimize batch config
   */
  optimizeBatchConfig(configId: string): BatchConfig {
    const config = this.configs.get(configId)

    if (!config) {
      throw new Error(`Batch config not found: ${configId}`)
    }

    const stats = this.getBatchStatistics(configId)

    // Increase batch size if error rate is low
    if (stats.averageErrorRate < 5 && config.batchSize < 10) {
      config.batchSize = Math.min(10, config.batchSize + 1)
    }

    // Decrease batch size if error rate is high
    if (stats.averageErrorRate > 20 && config.batchSize > 1) {
      config.batchSize = Math.max(1, config.batchSize - 1)
    }

    // Adjust parallel processors based on throughput
    if (stats.averageThroughput < 5 && config.parallelProcessors < 20) {
      config.parallelProcessors++
    }

    return config
  }

  /**
   * Get config
   */
  getConfig(id: string): BatchConfig | undefined {
    return this.configs.get(id)
  }

  /**
   * List configs
   */
  listConfigs(): BatchConfig[] {
    return Array.from(this.configs.values())
  }

  /**
   * Get job
   */
  getJob(id: string): BatchJob | undefined {
    return this.jobs.get(id)
  }

  /**
   * List jobs
   */
  listJobs(configId?: string): BatchJob[] {
    let jobs = Array.from(this.jobs.values())

    if (configId) {
      jobs = jobs.filter(j => j.configId === configId)
    }

    return jobs
  }

  /**
   * Generate CloudFormation for Lambda batch processor
   */
  generateBatchProcessorCF(config: BatchConfig): any {
    return {
      Type: 'AWS::Lambda::EventSourceMapping',
      Properties: {
        EventSourceArn: `arn:aws:sqs:us-east-1:123456789012:${config.queueUrl.split('/').pop()}`,
        FunctionName: 'batch-processor-function',
        BatchSize: config.batchSize,
        MaximumBatchingWindowInSeconds: config.maxWaitTime / 1000,
        FunctionResponseTypes: ['ReportBatchItemFailures'],
      },
    }
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.configs.clear()
    this.jobs.clear()
    this.metrics.clear()
    this.configCounter = 0
    this.jobCounter = 0
    this.metricsCounter = 0
  }
}

/**
 * Global batch processing manager instance
 */
export const batchProcessingManager = new BatchProcessingManager()
