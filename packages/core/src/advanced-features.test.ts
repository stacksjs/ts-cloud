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

describe('Storage Advanced Manager', () => {
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
