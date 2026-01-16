import { describe, expect, it, beforeEach } from 'bun:test'
import {
  FIFOQueueManager,
  fifoQueueManager,
  DLQMonitoringManager,
  dlqMonitoringManager,
  BatchProcessingManager,
  batchProcessingManager,
  QueueManagementManager,
  queueManagementManager,
} from '.'

describe('FIFO Queue Manager', () => {
  let manager: FIFOQueueManager

  beforeEach(() => {
    manager = new FIFOQueueManager()
  })

  it('should create FIFO queue', () => {
    const queue = manager.createFIFOQueue({
      name: 'test-queue',
      contentBasedDeduplication: true,
      deduplicationScope: 'queue',
      fifoThroughputLimit: 'perQueue',
      messageRetentionPeriod: 345600,
      visibilityTimeout: 30,
      receiveMessageWaitTime: 0,
    })

    expect(queue.id).toContain('fifo-queue')
    expect(queue.name).toBe('test-queue.fifo')
  })

  it('should create high-throughput FIFO', () => {
    const queue = manager.createHighThroughputFIFO({
      name: 'high-throughput',
      contentBasedDeduplication: true,
    })

    expect(queue.deduplicationScope).toBe('messageGroup')
    expect(queue.fifoThroughputLimit).toBe('perMessageGroupId')
  })

  it('should send message to FIFO queue', () => {
    const queue = manager.createStandardFIFO({
      name: 'test',
      contentBasedDeduplication: false,
    })

    const message = manager.sendMessage({
      queueId: queue.id,
      messageGroupId: 'group1',
      messageBody: 'Test message',
      messageDeduplicationId: 'dedup-1',
    })

    expect(message).toBeDefined()
    expect(message?.messageGroupId).toBe('group1')
  })

  it('should deduplicate messages', () => {
    const queue = manager.createStandardFIFO({
      name: 'test',
      contentBasedDeduplication: false,
    })

    const msg1 = manager.sendMessage({
      queueId: queue.id,
      messageGroupId: 'group1',
      messageBody: 'Test',
      messageDeduplicationId: 'same-id',
    })

    const msg2 = manager.sendMessage({
      queueId: queue.id,
      messageGroupId: 'group1',
      messageBody: 'Test',
      messageDeduplicationId: 'same-id',
    })

    expect(msg1).toBeDefined()
    expect(msg2).toBeNull() // Deduplicated
  })

  it('should track message groups', () => {
    const queue = manager.createStandardFIFO({ name: 'test' })

    manager.sendMessage({
      queueId: queue.id,
      messageGroupId: 'group1',
      messageBody: 'Message 1',
      messageDeduplicationId: 'msg1',
    })

    manager.sendMessage({
      queueId: queue.id,
      messageGroupId: 'group2',
      messageBody: 'Message 2',
      messageDeduplicationId: 'msg2',
    })

    const groups = manager.getMessageGroups(queue.id)
    expect(groups).toHaveLength(2)
  })

  it('should use global instance', () => {
    expect(fifoQueueManager).toBeInstanceOf(FIFOQueueManager)
  })
})

describe('DLQ Monitoring Manager', () => {
  let manager: DLQMonitoringManager

  beforeEach(() => {
    manager = new DLQMonitoringManager()
  })

  it('should create DLQ monitor', () => {
    const monitor = manager.createDLQMonitor({
      name: 'test-dlq',
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-dlq',
      sourceQueues: ['source-queue'],
      maxReceiveCount: 3,
      alarmThreshold: 10,
      autoReprocess: false,
      reprocessStrategy: 'manual',
    })

    expect(monitor.id).toContain('dlq-monitor')
    expect(monitor.maxReceiveCount).toBe(3)
  })

  it('should create automated monitor', () => {
    const monitor = manager.createAutomatedMonitor({
      name: 'automated',
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/dlq',
      sourceQueues: ['main-queue'],
      notificationTopicArn: 'arn:aws:sns:us-east-1:123456789012:alerts',
    })

    expect(monitor.autoReprocess).toBe(true)
    expect(monitor.reprocessStrategy).toBe('scheduled')
  })

  it('should collect metrics', () => {
    const metrics = manager.collectMetrics('https://sqs.us-east-1.amazonaws.com/123456789012/test')

    expect(metrics.id).toContain('metrics')
    expect(metrics.approximateNumberOfMessages).toBeGreaterThanOrEqual(0)
  })

  it('should create reprocess job', async () => {
    const job = manager.createReprocessJob({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/dlq',
      messageId: 'msg-123',
    })

    expect(job.status).toBe('pending')

    await manager.executeReprocessJob(job.id)

    expect(['success', 'failed']).toContain(job.status)
  })

  it('should batch reprocess messages', async () => {
    const jobs = await manager.batchReprocess({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/dlq',
      maxMessages: 5,
    })

    expect(jobs).toHaveLength(5)
  })

  it('should get DLQ statistics', () => {
    manager.collectMetrics('https://sqs.us-east-1.amazonaws.com/123456789012/test')

    const stats = manager.getDLQStatistics('https://sqs.us-east-1.amazonaws.com/123456789012/test')

    expect(stats).toBeDefined()
    expect(stats.totalMessages).toBeGreaterThanOrEqual(0)
  })

  it('should use global instance', () => {
    expect(dlqMonitoringManager).toBeInstanceOf(DLQMonitoringManager)
  })
})

describe('Batch Processing Manager', () => {
  let manager: BatchProcessingManager

  beforeEach(() => {
    manager = new BatchProcessingManager()
  })

  it('should create batch config', () => {
    const config = manager.createBatchConfig({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/queue',
      batchSize: 10,
      maxWaitTime: 100,
      parallelProcessors: 5,
      retryAttempts: 3,
      visibilityTimeout: 30,
    })

    expect(config.id).toContain('batch-config')
    expect(config.batchSize).toBe(10)
  })

  it('should create high-throughput config', () => {
    const config = manager.createHighThroughputConfig({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/queue',
    })

    expect(config.batchSize).toBe(10)
    expect(config.parallelProcessors).toBe(10)
  })

  it('should create low-latency config', () => {
    const config = manager.createLowLatencyConfig({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/queue',
    })

    expect(config.batchSize).toBe(1)
    expect(config.maxWaitTime).toBe(0)
  })

  it('should create batch job', () => {
    const config = manager.createBatchConfig({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/queue',
      batchSize: 5,
      maxWaitTime: 100,
      parallelProcessors: 2,
      retryAttempts: 2,
      visibilityTimeout: 30,
    })

    const job = manager.createBatchJob({
      configId: config.id,
      messageCount: 20,
    })

    expect(job.messages).toHaveLength(20)
    expect(job.status).toBe('pending')
  })

  it('should process batch job', async () => {
    const config = manager.createBatchConfig({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/queue',
      batchSize: 5,
      maxWaitTime: 100,
      parallelProcessors: 2,
      retryAttempts: 2,
      visibilityTimeout: 30,
    })

    const job = manager.createBatchJob({
      configId: config.id,
      messageCount: 10,
    })

    await manager.processBatchJob(job.id)

    expect(['completed', 'failed']).toContain(job.status)
    expect(job.processedCount).toBeGreaterThan(0)
  })

  it('should get batch statistics', async () => {
    const config = manager.createBatchConfig({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/queue',
      batchSize: 5,
      maxWaitTime: 100,
      parallelProcessors: 2,
      retryAttempts: 2,
      visibilityTimeout: 30,
    })

    const job = manager.createBatchJob({
      configId: config.id,
      messageCount: 10,
    })

    await manager.processBatchJob(job.id)

    const stats = manager.getBatchStatistics(config.id)

    expect(stats.totalJobsProcessed).toBe(1)
    expect(stats.totalMessagesProcessed).toBeGreaterThan(0)
  })

  it('should optimize batch config', async () => {
    const config = manager.createBatchConfig({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/queue',
      batchSize: 5,
      maxWaitTime: 100,
      parallelProcessors: 2,
      retryAttempts: 2,
      visibilityTimeout: 30,
    })

    const job = manager.createBatchJob({
      configId: config.id,
      messageCount: 10,
    })

    await manager.processBatchJob(job.id)

    const optimized = manager.optimizeBatchConfig(config.id)

    expect(optimized).toBeDefined()
  })

  it('should use global instance', () => {
    expect(batchProcessingManager).toBeInstanceOf(BatchProcessingManager)
  })
})

describe('Queue Management Manager', () => {
  let manager: QueueManagementManager

  beforeEach(() => {
    manager = new QueueManagementManager()
  })

  it('should create standard queue', () => {
    const queue = manager.createStandardQueue({
      queueName: 'test-queue',
      messageRetentionDays: 4,
    })

    expect(queue.id).toContain('queue')
    expect(queue.queueName).toBe('test-queue')
  })

  it('should create long polling queue', () => {
    const queue = manager.createLongPollingQueue({
      queueName: 'long-poll',
      waitTimeSeconds: 20,
    })

    expect(queue.receiveMessageWaitTime).toBe(20)
  })

  it('should create retention policy', () => {
    const queue = manager.createStandardQueue({
      queueName: 'test',
    })

    const policy = manager.createRetentionPolicy({
      queueId: queue.id,
      retentionPeriod: 86400, // 1 day
      autoCleanup: true,
      archiveExpiredMessages: false,
    })

    expect(policy.id).toContain('retention')
    expect(policy.retentionPeriod).toBe(86400)
  })

  it('should create archival retention policy', () => {
    const queue = manager.createStandardQueue({
      queueName: 'test',
    })

    const policy = manager.createArchivalRetentionPolicy({
      queueId: queue.id,
      retentionDays: 30,
      s3Bucket: 'archive-bucket',
    })

    expect(policy.archiveExpiredMessages).toBe(true)
    expect(policy.archiveS3Bucket).toBe('archive-bucket')
  })

  it('should create delay queue', () => {
    const queue = manager.createStandardQueue({
      queueName: 'test',
    })

    const delay = manager.createDelayQueue({
      queueUrl: queue.queueUrl,
      defaultDelay: 60,
      perMessageDelay: false,
      maxDelay: 900,
    })

    expect(delay.defaultDelay).toBe(60)
  })

  it('should purge queue', async () => {
    const queue = manager.createStandardQueue({
      queueName: 'test',
    })

    const purgeOp = await manager.purgeQueue(queue.id)

    expect(purgeOp.status).toBe('in_progress')

    await new Promise(resolve => setTimeout(resolve, 150))

    expect(purgeOp.status).toBe('completed')
  })

  it('should collect queue metrics', () => {
    const queue = manager.createStandardQueue({
      queueName: 'test',
    })

    const metrics = manager.collectQueueMetrics(queue.queueUrl)

    expect(metrics.approximateNumberOfMessages).toBeGreaterThanOrEqual(0)
  })

  it('should get queue health', () => {
    const queue = manager.createStandardQueue({
      queueName: 'test',
    })

    manager.collectQueueMetrics(queue.queueUrl)

    const health = manager.getQueueHealth(queue.queueUrl)

    expect(['healthy', 'warning', 'critical']).toContain(health.status)
  })

  it('should use global instance', () => {
    expect(queueManagementManager).toBeInstanceOf(QueueManagementManager)
  })
})
