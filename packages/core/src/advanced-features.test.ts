import { describe, expect, it, beforeEach } from 'bun:test'
import { StaticSiteManager, staticSiteManager } from './static-site'
import { StorageAdvancedManager, storageAdvancedManager } from './s3'
import { HealthCheckManager, healthCheckManager } from './health-checks'
import { NetworkSecurityManager, networkSecurityManager } from './network-security'
import { BackupManager, backupManager, ContinuousBackup } from './backup/manager'
import { ResourceManagementManager, resourceManagementManager } from './resource-mgmt'
import { ProgressiveDeploymentManager, progressiveDeploymentManager } from './deployment/progressive'
import { XRayManager, xrayManager } from './observability/xray'
import { MetricsManager, metricsManager } from './observability/metrics'
import { LogsManager, logsManager } from './observability/logs'

describe('Static Site Manager', () => {
  let manager: StaticSiteManager

  beforeEach(() => {
    manager = new StaticSiteManager()
  })

  it('should create asset optimization', () => {
    const opt = manager.createAssetOptimization({
      name: 'prod-assets',
      minify: true,
      compress: true,
      compressionType: 'brotli',
      sourceMaps: false,
      cacheControl: 'max-age=31536000',
    })
    expect(opt.id).toContain('asset-opt')
    expect(opt.compressionType).toBe('brotli')
  })

  it('should create image optimization', () => {
    const opt = manager.createImageOptimization({
      formats: ['webp', 'avif'],
      quality: 80,
      responsive: true,
      lazy: true,
      sizes: [320, 640, 1024],
    })
    expect(opt.formats).toContain('webp')
  })

  it('should use global instance', () => {
    expect(staticSiteManager).toBeInstanceOf(StaticSiteManager)
  })
})

describe('S3 Advanced Manager', () => {
  let manager: StorageAdvancedManager

  beforeEach(() => {
    manager = new StorageAdvancedManager()
  })

  it('should create lifecycle policy', () => {
    const policy = manager.createLifecyclePolicy([
      { days: 30, storageClass: 'STANDARD_IA' },
      { days: 90, storageClass: 'GLACIER' },
    ], 365)
    expect(policy.transitions).toHaveLength(2)
    expect(policy.expiration).toBe(365)
  })

  it('should enable versioning', () => {
    const config = manager.enableVersioning(true)
    expect(config.enabled).toBe(true)
    expect(config.mfaDelete).toBe(true)
  })

  it('should create replication rule', () => {
    const rule = manager.createReplicationRule('us-east-1', 'us-west-2', 'backup-bucket')
    expect(rule.destRegion).toBe('us-west-2')
  })

  it('should enable object lock in compliance mode', () => {
    const lock = manager.enableObjectLock({
      bucketName: 'compliance-bucket',
      mode: 'COMPLIANCE',
      retentionDays: 90,
      legalHoldEnabled: true,
    })
    expect(lock.mode).toBe('COMPLIANCE')
    expect(lock.retentionDays).toBe(90)
    expect(lock.legalHoldEnabled).toBe(true)
  })

  it('should enable object lock in governance mode', () => {
    const lock = manager.enableObjectLock({
      bucketName: 'governance-bucket',
      mode: 'GOVERNANCE',
      retentionYears: 7,
    })
    expect(lock.mode).toBe('GOVERNANCE')
    expect(lock.retentionYears).toBe(7)
  })

  it('should enable transfer acceleration', () => {
    const config = manager.enableTransferAcceleration('my-bucket')
    expect(config.enabled).toBe(true)
    expect(config.endpoint).toBe('my-bucket.s3-accelerate.amazonaws.com')
  })

  it('should create access point', () => {
    const accessPoint = manager.createAccessPoint({
      name: 'my-access-point',
      bucketName: 'my-bucket',
      publicAccessBlock: true,
    })
    expect(accessPoint.name).toBe('my-access-point')
    expect(accessPoint.publicAccessBlock).toBe(true)
  })

  it('should create VPC access point', () => {
    const accessPoint = manager.createAccessPoint({
      name: 'vpc-access-point',
      bucketName: 'my-bucket',
      vpcId: 'vpc-12345',
      publicAccessBlock: true,
    })
    expect(accessPoint.vpcId).toBe('vpc-12345')
  })

  it('should create glacier deep archive configuration', () => {
    const glacier = manager.createGlacierArchive({
      bucketName: 'archive-bucket',
      archiveType: 'DEEP_ARCHIVE',
      transitionDays: 90,
      restoreTier: 'Bulk',
      restoreDays: 14,
    })
    expect(glacier.archiveType).toBe('DEEP_ARCHIVE')
    expect(glacier.transitionDays).toBe(90)
    expect(glacier.restoreConfig?.tier).toBe('Bulk')
    expect(glacier.restoreConfig?.days).toBe(14)
  })

  it('should create standard glacier configuration', () => {
    const glacier = manager.createGlacierArchive({
      bucketName: 'archive-bucket',
      archiveType: 'GLACIER',
      transitionDays: 30,
    })
    expect(glacier.archiveType).toBe('GLACIER')
    expect(glacier.transitionDays).toBe(30)
  })

  it('should create inventory configuration', () => {
    const inventory = manager.createInventory({
      sourceBucket: 'source-bucket',
      destinationBucket: 'inventory-bucket',
      schedule: 'Daily',
      format: 'Parquet',
      includedFields: ['Size', 'LastModifiedDate', 'StorageClass', 'ETag', 'ReplicationStatus'],
      prefix: 'documents/',
    })
    expect(inventory.schedule).toBe('Daily')
    expect(inventory.format).toBe('Parquet')
    expect(inventory.includedFields).toContain('ReplicationStatus')
    expect(inventory.prefix).toBe('documents/')
  })

  it('should create batch operation', () => {
    const batchOp = manager.createBatchOperation({
      operation: 'Copy',
      manifestBucket: 'manifest-bucket',
      manifestKey: 'manifest.csv',
      priority: 5,
    })
    expect(batchOp.operation).toBe('Copy')
    expect(batchOp.priority).toBe(5)
    expect(batchOp.status).toBe('pending')
  })

  it('should execute batch operation', () => {
    const batchOp = manager.createBatchOperation({
      operation: 'Delete',
      manifestBucket: 'manifest-bucket',
      manifestKey: 'delete-list.csv',
    })
    const executed = manager.executeBatchOperation(batchOp.id)
    expect(executed.status).toBe('in_progress')
    expect(executed.totalObjects).toBeDefined()
  })

  it('should create Lambda event notification', () => {
    const notification = manager.createLambdaNotification({
      bucketName: 'event-bucket',
      lambdaArn: 'arn:aws:lambda:us-east-1:123:function:processor',
      events: ['s3:ObjectCreated:*'],
      prefix: 'uploads/',
      suffix: '.jpg',
    })
    expect(notification.destination.type).toBe('Lambda')
    expect(notification.events).toContain('s3:ObjectCreated:*')
    expect(notification.filter?.prefix).toBe('uploads/')
    expect(notification.filter?.suffix).toBe('.jpg')
  })

  it('should create SQS event notification', () => {
    const notification = manager.createSQSNotification({
      bucketName: 'event-bucket',
      queueArn: 'arn:aws:sqs:us-east-1:123:queue:events',
      events: ['s3:ObjectRemoved:*'],
    })
    expect(notification.destination.type).toBe('SQS')
    expect(notification.events).toContain('s3:ObjectRemoved:*')
  })

  it('should create SNS event notification', () => {
    const notification = manager.createSNSNotification({
      bucketName: 'event-bucket',
      topicArn: 'arn:aws:sns:us-east-1:123:topic:s3-events',
      events: ['s3:ObjectRestore:*', 's3:Replication:*'],
      prefix: 'important/',
    })
    expect(notification.destination.type).toBe('SNS')
    expect(notification.events).toHaveLength(2)
    expect(notification.filter?.prefix).toBe('important/')
  })

  it('should generate CloudFormation for object lock', () => {
    const lock = manager.enableObjectLock({
      bucketName: 'compliance-bucket',
      mode: 'COMPLIANCE',
      retentionDays: 90,
    })
    const cf = manager.generateObjectLockCF(lock)
    expect(cf.ObjectLockEnabled).toBe('Enabled')
    expect(cf.ObjectLockConfiguration.Rule.DefaultRetention.Mode).toBe('COMPLIANCE')
    expect(cf.ObjectLockConfiguration.Rule.DefaultRetention.Days).toBe(90)
  })

  it('should generate CloudFormation for access point', () => {
    const accessPoint = manager.createAccessPoint({
      name: 'my-access-point',
      bucketName: 'my-bucket',
      vpcId: 'vpc-12345',
    })
    const cf = manager.generateAccessPointCF(accessPoint)
    expect(cf.Type).toBe('AWS::S3::AccessPoint')
    expect(cf.Properties.Name).toBe('my-access-point')
    expect(cf.Properties.VpcConfiguration.VpcId).toBe('vpc-12345')
  })

  it('should use global instance', () => {
    expect(storageAdvancedManager).toBeInstanceOf(StorageAdvancedManager)
  })
})

describe('Health Check Manager', () => {
  let manager: HealthCheckManager

  beforeEach(() => {
    manager = new HealthCheckManager()
  })

  it('should create health check', () => {
    const check = manager.createHealthCheck('https://example.com/health', 60, 5)
    expect(check.url).toBe('https://example.com/health')
    expect(check.interval).toBe(60)
  })

  it('should create synthetic monitor', () => {
    const monitor = manager.createSyntheticMonitor('API Test', 'script.js', 300, ['us-east-1', 'eu-west-1'])
    expect(monitor.locations).toHaveLength(2)
  })

  it('should track uptime', () => {
    const tracker = manager.trackUptime('api-server', 86000, 400)
    expect(tracker.availability).toBeGreaterThan(99)
  })

  it('should use global instance', () => {
    expect(healthCheckManager).toBeInstanceOf(HealthCheckManager)
  })
})

describe('Network Security Manager', () => {
  let manager: NetworkSecurityManager

  beforeEach(() => {
    manager = new NetworkSecurityManager()
  })

  it('should create WAF rule', () => {
    const rule = manager.createWAFRule('block-sql-injection', 100, 'block', ['sql-injection'])
    expect(rule.action).toBe('block')
    expect(rule.priority).toBe(100)
  })

  it('should enable Shield', () => {
    const protection = manager.enableShield('arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/my-lb', 'advanced')
    expect(protection.protectionType).toBe('advanced')
  })

  it('should create security group', () => {
    const sg = manager.createSecurityGroup('web-sg', 'vpc-123', [
      { protocol: 'tcp', port: 443, source: '0.0.0.0/0' },
    ])
    expect(sg.rules).toHaveLength(1)
  })

  it('should use global instance', () => {
    expect(networkSecurityManager).toBeInstanceOf(NetworkSecurityManager)
  })
})

describe('Backup Advanced Manager', () => {
  let manager: BackupManager

  beforeEach(() => {
    manager = new BackupManager()
  })

  it('should enable continuous backup', () => {
    const backup = manager.enableContinuousBackup('db-instance-1', 30)
    expect(backup.enabled).toBe(true)
    expect(backup.retentionDays).toBe(30)
  })

  it('should enable PITR', () => {
    const pitr = manager.enablePointInTimeRecovery('arn:aws:rds:us-east-1:123:db:table-1', 'rds')
    expect(pitr.enabled).toBe(true)
    expect(pitr.earliestRestorableTime).toBeDefined()
  })

  it('should create backup vault', () => {
    const vault = { name: 'production-vault', region: 'us-east-1', encryptionKeyArn: 'arn:aws:kms:us-east-1:123:key/abc' }
    manager.createVault(vault)
    expect(manager.getVault('production-vault')?.name).toBe('production-vault')
  })

  it('should use global instance', () => {
    expect(backupManager).toBeInstanceOf(BackupManager)
  })
})

describe('Resource Management Manager', () => {
  let manager: ResourceManagementManager

  beforeEach(() => {
    manager = new ResourceManagementManager()
  })

  it('should create tagging strategy', () => {
    const strategy = manager.createTaggingStrategy(
      { Environment: 'production', Team: 'platform' },
      ['resource-1', 'resource-2']
    )
    expect(strategy.tags.Environment).toBe('production')
  })

  it('should create cost allocation', () => {
    const allocation = manager.createCostAllocation('Environment', [
      { tagValue: 'production', cost: 5000 },
      { tagValue: 'staging', cost: 1000 },
    ])
    expect(allocation.allocations).toHaveLength(2)
  })

  it('should create resource group', () => {
    const group = manager.createResourceGroup('web-servers', ['AWS::EC2::Instance'], [
      { key: 'Environment', values: ['production'] },
    ])
    expect(group.name).toBe('web-servers')
  })

  it('should use global instance', () => {
    expect(resourceManagementManager).toBeInstanceOf(ResourceManagementManager)
  })
})

describe('Deployment Advanced Manager', () => {
  let manager: ProgressiveDeploymentManager

  beforeEach(() => {
    manager = new ProgressiveDeploymentManager()
  })

  it('should create progressive rollout', () => {
    const rollout = manager.createProgressiveRollout('gradual-deploy', [
      { percentage: 10, durationMinutes: 10 },
      { percentage: 50, durationMinutes: 30 },
      { percentage: 100, durationMinutes: 60 },
    ])
    expect(rollout.stages).toHaveLength(3)
    expect(rollout.currentStage).toBe(0)
  })

  it('should create feature flag', () => {
    const flag = manager.createFeatureFlag('new-ui', 25)
    expect(flag.rolloutPercentage).toBe(25)
    expect(flag.enabled).toBe(false)
  })

  it('should create deployment gate', () => {
    const gate = manager.createDeploymentGate('production-approval', 'manual', ['admin@example.com'])
    expect(gate.type).toBe('manual')
    expect(gate.approvers).toContain('admin@example.com')
  })

  it('should use global instance', () => {
    expect(progressiveDeploymentManager).toBeInstanceOf(ProgressiveDeploymentManager)
  })
})

describe('Observability Advanced - Distributed Tracing', () => {
  let manager: XRayManager

  beforeEach(() => {
    manager = new XRayManager()
  })

  it('should create distributed trace', () => {
    const trace = manager.createTrace('trace-123', [
      { spanId: 'span-1', name: 'api-call', duration: 100, tags: { service: 'api' } },
      { spanId: 'span-2', name: 'db-query', duration: 50, tags: { service: 'db' } },
    ])
    expect(trace.spans).toHaveLength(2)
  })

  it('should use global instance', () => {
    expect(xrayManager).toBeInstanceOf(XRayManager)
  })
})

describe('Observability Advanced - Custom Metrics', () => {
  let manager: MetricsManager

  beforeEach(() => {
    manager = new MetricsManager()
  })

  it('should publish custom metric', () => {
    const metric = manager.publishCustomMetric('MyApp', 'RequestCount', 100, { Environment: 'production' })
    expect(metric.value).toBe(100)
    expect(metric.namespace).toBe('MyApp')
  })

  it('should use global instance', () => {
    expect(metricsManager).toBeInstanceOf(MetricsManager)
  })
})

describe('Observability Advanced - Log Aggregation', () => {
  let manager: LogsManager

  beforeEach(() => {
    manager = new LogsManager()
  })

  it('should create log aggregation', () => {
    const aggregation = manager.createLogAggregation('/aws/lambda/my-function', [
      { pattern: 'ERROR', metric: 'ErrorCount' },
    ], 14)
    expect(aggregation.filters).toHaveLength(1)
    expect(aggregation.retention).toBe(14)
  })

  it('should use global instance', () => {
    expect(logsManager).toBeInstanceOf(LogsManager)
  })
})
