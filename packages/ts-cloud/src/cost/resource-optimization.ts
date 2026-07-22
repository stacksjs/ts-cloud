import type { MetricDatapoint } from '../aws/cloudwatch'
import type { CloudResource, ResourceInventoryResult } from './resource-inventory'
import { CloudWatchClient } from '../aws/cloudwatch'
import { CostExplorerClient } from '../aws/cost-explorer'
import { egressUsageCosts, rollingComparisonRange } from './reporting'
import { ResourceInventoryClient } from './resource-inventory'

export interface ResourceSignals {
  cpuAverage?: number
  connectionsAverage?: number
  iopsAverage?: number
  invocations?: number
  objectCount?: number
  requests?: number
  storageBytes?: number
  cacheHitRate?: number
}

export interface IdleResourceFinding {
  resource: CloudResource
  signal: string
  recommendation: string
  monthlySavings: number | null
}

export type OptimizationCategory = 'unused' | 'right-size' | 'commitment' | 'storage' | 'cdn'

export interface OptimizationRecommendation {
  category: OptimizationCategory
  resource: CloudResource
  recommendation: string
  sourceSignal: string
  currentCost: number | null
  projectedCost: number | null
  monthlySavings: number | null
}

export interface OptimizationResult {
  recommendations: OptimizationRecommendation[]
  inventory: ResourceInventoryResult
  savingsAvailable: boolean
  warnings: string[]
}

function estimate(currentCost: number | null, reduction: number): {
  currentCost: number | null
  projectedCost: number | null
  monthlySavings: number | null
} {
  if (currentCost == null) return { currentCost: null, projectedCost: null, monthlySavings: null }
  const monthlySavings = currentCost * reduction
  return { currentCost, projectedCost: currentCost - monthlySavings, monthlySavings }
}

export function resourceOptimizationRecommendations(
  resource: CloudResource,
  signals: ResourceSignals,
  currentCost: number | null,
  includeCommitments: boolean = false,
): OptimizationRecommendation[] {
  const idle = evaluateIdleResource(resource, signals, currentCost)
  if (idle) {
    return [
      {
        category: 'unused',
        resource,
        recommendation: idle.recommendation,
        sourceSignal: idle.signal,
        ...estimate(currentCost, 1),
      },
    ]
  }

  if (
    ((resource.service === 'ec2' && resource.type === 'instance') ||
      (resource.service === 'rds' && resource.type === 'db')) &&
    signals.cpuAverage != null &&
    signals.cpuAverage < 20
  ) {
    return [
      {
        category: 'right-size',
        resource,
        recommendation: 'Validate memory, network, and peak demand, then test one smaller instance class.',
        sourceSignal: `${resource.service.toUpperCase()} 30-day average CPU ${signals.cpuAverage.toFixed(1)}% (<20%)`,
        ...estimate(currentCost, 0.4),
      },
    ]
  }

  if (
    includeCommitments &&
    ((resource.service === 'ec2' && resource.type === 'instance' && resource.state === 'running') ||
      (resource.service === 'rds' && resource.type === 'db' && resource.state === 'available')) &&
    signals.cpuAverage != null &&
    signals.cpuAverage >= 20
  ) {
    return [
      {
        category: 'commitment',
        resource,
        recommendation: 'Compare a one-year no-upfront commitment against this steady workload before purchasing.',
        sourceSignal: `${resource.service.toUpperCase()} remained active with 30-day average CPU ${signals.cpuAverage.toFixed(1)}%`,
        ...estimate(currentCost, 0.3),
      },
    ]
  }

  if (
    resource.service === 's3' &&
    signals.storageBytes != null &&
    signals.storageBytes >= 5 * 1024 ** 3 &&
    signals.requests != null &&
    signals.requests < 9000
  ) {
    const storageGiB = signals.storageBytes / 1024 ** 3
    return [
      {
        category: 'storage',
        resource,
        recommendation: 'Review object age and retrieval needs, then add Intelligent-Tiering or Glacier lifecycle rules.',
        sourceSignal: `${storageGiB.toFixed(1)} GiB stored with ${signals.requests.toFixed(0)} requests over 90 days`,
        ...estimate(currentCost, 0.25),
      },
    ]
  }

  return []
}

export function cloudFrontOptimizationRecommendation(
  monthlyTransferCost: number,
  usageTypes: string[],
): OptimizationRecommendation | null {
  if (monthlyTransferCost <= 0 || usageTypes.length === 0) return null
  return {
    category: 'cdn',
    resource: {
      arn: 'arn:aws:cloudfront::account:distribution/account-wide',
      service: 'cloudfront',
      type: 'distribution',
      id: 'account-wide',
      name: 'account-wide transfer',
      tags: {},
      metadata: {},
    },
    recommendation: 'Enable compression and review cache policies, TTLs, and origin cache headers for high-transfer paths.',
    sourceSignal: `30-day Cost Explorer transfer line items: ${usageTypes.slice(0, 3).join(', ')}`,
    ...estimate(monthlyTransferCost, 0.2),
  }
}

function average(points: MetricDatapoint[]): number | undefined {
  const values = points.map((point) => point.Average).filter((value): value is number => value != null)
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined
}

function sum(points: MetricDatapoint[]): number | undefined {
  const values = points.map((point) => point.Sum).filter((value): value is number => value != null)
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined
}

export function evaluateIdleResource(
  resource: CloudResource,
  signals: ResourceSignals,
  monthlySavings: number | null = null,
): IdleResourceFinding | null {
  if (resource.service === 'ec2' && resource.type === 'volume' && resource.metadata.attached === false) {
    return {
      resource,
      signal: 'EBS volume is detached',
      recommendation: 'Snapshot if needed, then delete the detached volume.',
      monthlySavings,
    }
  }
  if (resource.service === 'ec2' && resource.type === 'elastic-ip' && resource.metadata.associated === false) {
    return {
      resource,
      signal: 'Elastic IP is not associated',
      recommendation: 'Release the unassociated Elastic IP.',
      monthlySavings,
    }
  }
  if (
    resource.service === 'ec2' &&
    resource.type === 'instance' &&
    signals.cpuAverage != null &&
    signals.cpuAverage < 5
  ) {
    return {
      resource,
      signal: `30-day average CPU ${signals.cpuAverage.toFixed(1)}% (<5%)`,
      recommendation: 'Stop/delete if unused, or right-size after validating memory and network demand.',
      monthlySavings,
    }
  }
  if (
    resource.service === 'rds' &&
    resource.type === 'db' &&
    signals.connectionsAverage != null &&
    signals.iopsAverage != null &&
    signals.connectionsAverage === 0 &&
    signals.iopsAverage < 1
  ) {
    return {
      resource,
      signal: `14-day connections 0 and average IOPS ${signals.iopsAverage.toFixed(2)} (<1)`,
      recommendation: 'Take a final snapshot, validate ownership, then stop or delete the database.',
      monthlySavings,
    }
  }
  if (resource.service === 'lambda' && resource.type === 'function' && signals.invocations === 0) {
    return {
      resource,
      signal: '30-day invocations 0',
      recommendation: 'Confirm no event source depends on it, then remove the function.',
      monthlySavings,
    }
  }
  if (resource.service === 's3' && signals.objectCount === 0 && signals.requests === 0) {
    return {
      resource,
      signal: 'Bucket is empty with zero requests over 90 days',
      recommendation: 'Confirm retention policy, then delete the empty bucket.',
      monthlySavings,
    }
  }
  if (
    resource.service === 'elasticache' &&
    signals.connectionsAverage != null &&
    signals.cacheHitRate != null &&
    signals.connectionsAverage === 0 &&
    signals.cacheHitRate < 20
  ) {
    return {
      resource,
      signal: `14-day connections 0 and cache hit rate ${signals.cacheHitRate.toFixed(1)}%`,
      recommendation: 'Validate clients and snapshots, then delete the idle cache cluster.',
      monthlySavings,
    }
  }
  return null
}

export class ResourceOptimizationService {
  private inventory: ResourceInventoryClient
  private costs: CostExplorerClient
  private profile?: string
  private region: string

  constructor(profile?: string, region: string = process.env.AWS_REGION || 'us-east-1') {
    this.profile = profile
    this.region = region
    this.inventory = new ResourceInventoryClient(profile, region)
    this.costs = new CostExplorerClient(profile)
  }

  private async metric(
    cloudwatch: CloudWatchClient,
    resource: CloudResource,
    namespace: string,
    metricName: string,
    dimensionName: string,
    days: number,
    statistic: 'Average' | 'Sum',
    extraDimensions: Array<{ Name: string; Value: string }> = [],
  ): Promise<number | undefined> {
    const end = new Date()
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)
    const points = await cloudwatch.getMetricStatistics({
      Namespace: namespace,
      MetricName: metricName,
      Dimensions: [{ Name: dimensionName, Value: resource.id }, ...extraDimensions],
      StartTime: start,
      EndTime: end,
      Period: 24 * 60 * 60,
      Statistics: [statistic],
    })
    return statistic === 'Sum' ? sum(points) : average(points)
  }

  private async signals(resource: CloudResource): Promise<ResourceSignals> {
    const cloudwatch = new CloudWatchClient(resource.region ?? this.region, this.profile)
    if (resource.service === 'ec2' && resource.type === 'instance') {
      return {
        cpuAverage: await this.metric(cloudwatch, resource, 'AWS/EC2', 'CPUUtilization', 'InstanceId', 30, 'Average'),
      }
    }
    if (resource.service === 'rds' && resource.type === 'db') {
      const [cpuAverage, connectionsAverage, readIops, writeIops] = await Promise.all([
        this.metric(cloudwatch, resource, 'AWS/RDS', 'CPUUtilization', 'DBInstanceIdentifier', 30, 'Average'),
        this.metric(cloudwatch, resource, 'AWS/RDS', 'DatabaseConnections', 'DBInstanceIdentifier', 14, 'Average'),
        this.metric(cloudwatch, resource, 'AWS/RDS', 'ReadIOPS', 'DBInstanceIdentifier', 14, 'Average'),
        this.metric(cloudwatch, resource, 'AWS/RDS', 'WriteIOPS', 'DBInstanceIdentifier', 14, 'Average'),
      ])
      return {
        cpuAverage,
        connectionsAverage,
        iopsAverage: readIops != null && writeIops != null ? readIops + writeIops : undefined,
      }
    }
    if (resource.service === 'lambda' && resource.type === 'function') {
      return {
        invocations: await this.metric(cloudwatch, resource, 'AWS/Lambda', 'Invocations', 'FunctionName', 30, 'Sum'),
      }
    }
    if (resource.service === 's3') {
      const [objectCount, requests, storageBytes] = await Promise.all([
        this.metric(cloudwatch, resource, 'AWS/S3', 'NumberOfObjects', 'BucketName', 90, 'Average', [
          { Name: 'StorageType', Value: 'AllStorageTypes' },
        ]),
        this.metric(cloudwatch, resource, 'AWS/S3', 'AllRequests', 'BucketName', 90, 'Sum'),
        this.metric(cloudwatch, resource, 'AWS/S3', 'BucketSizeBytes', 'BucketName', 90, 'Average', [
          { Name: 'StorageType', Value: 'StandardStorage' },
        ]),
      ])
      return { objectCount, requests, storageBytes }
    }
    if (resource.service === 'elasticache' && resource.type.includes('cluster')) {
      const [connectionsAverage, cacheHitRate] = await Promise.all([
        this.metric(cloudwatch, resource, 'AWS/ElastiCache', 'CurrConnections', 'CacheClusterId', 14, 'Average'),
        this.metric(cloudwatch, resource, 'AWS/ElastiCache', 'CacheHitRate', 'CacheClusterId', 14, 'Average'),
      ])
      return { connectionsAverage, cacheHitRate }
    }
    return {}
  }

  private async resourceCosts(): Promise<Map<string, number>> {
    try {
      const range = rollingComparisonRange(30).current
      const costs = await this.costs.getCostByDimension({
        start: range.start,
        end: range.end,
        dimension: 'RESOURCE_ID',
        granularity: 'DAILY',
      })
      return new Map(costs.map((cost) => [cost.key, cost.amount]))
    } catch {
      return new Map()
    }
  }

  private resourceCost(costs: Map<string, number>, resource: CloudResource): number | null {
    return costs.get(resource.id) ?? costs.get(resource.arn) ?? null
  }

  private async cloudFrontTransfer(): Promise<{ cost: number; usageTypes: string[] }> {
    try {
      const range = rollingComparisonRange(30).current
      const usage = await this.costs.getCostByDimension({
        start: range.start,
        end: range.end,
        dimension: 'USAGE_TYPE',
        granularity: 'DAILY',
        filter: { Dimensions: { Key: 'SERVICE', Values: ['Amazon CloudFront'] } },
      })
      const transfer = egressUsageCosts(usage)
      return {
        cost: transfer.reduce((total, item) => total + item.amount, 0),
        usageTypes: transfer.map((item) => item.key),
      }
    } catch {
      return { cost: 0, usageTypes: [] }
    }
  }

  async unused(options?: { type?: string }): Promise<{
    findings: IdleResourceFinding[]
    inventory: ResourceInventoryResult
    savingsAvailable: boolean
  }> {
    const [inventory, costs] = await Promise.all([this.inventory.discover(options), this.resourceCosts()])
    const findings = (
      await Promise.all(
        inventory.resources.map(async (resource) => {
          const cost = this.resourceCost(costs, resource)
          const immediate = evaluateIdleResource(resource, {}, cost)
          if (immediate) return immediate
          try {
            return evaluateIdleResource(resource, await this.signals(resource), cost)
          } catch {
            return null
          }
        }),
      )
    ).filter((finding): finding is IdleResourceFinding => finding !== null)
    return { findings, inventory, savingsAvailable: findings.some((finding) => finding.monthlySavings != null) }
  }

  async optimize(options?: { type?: string; includeCommitments?: boolean }): Promise<OptimizationResult> {
    const includeCloudFront = !options?.type || ['cloudfront', 'cdn'].includes(options.type.toLowerCase())
    const [inventory, costs, cloudFront] = await Promise.all([
      this.inventory.discover({ type: options?.type }),
      this.resourceCosts(),
      includeCloudFront ? this.cloudFrontTransfer() : Promise.resolve({ cost: 0, usageTypes: [] }),
    ])
    const recommendations: OptimizationRecommendation[] = []
    const warnings = [...inventory.warnings]

    for (const resource of inventory.resources) {
      const currentCost = this.resourceCost(costs, resource)
      const immediate = resourceOptimizationRecommendations(resource, {}, currentCost, options?.includeCommitments)
      if (immediate.length > 0) {
        recommendations.push(...immediate)
        continue
      }
      try {
        recommendations.push(
          ...resourceOptimizationRecommendations(
            resource,
            await this.signals(resource),
            currentCost,
            options?.includeCommitments,
          ),
        )
      } catch (error) {
        warnings.push(
          `CloudWatch metrics unavailable for ${resource.service}:${resource.type}/${resource.name}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    const cloudFrontRecommendation = cloudFrontOptimizationRecommendation(cloudFront.cost, cloudFront.usageTypes)
    if (cloudFrontRecommendation) recommendations.push(cloudFrontRecommendation)
    recommendations.sort(
      (a, b) =>
        (b.monthlySavings ?? -1) - (a.monthlySavings ?? -1) ||
        a.category.localeCompare(b.category) ||
        a.resource.name.localeCompare(b.resource.name),
    )
    return {
      recommendations,
      inventory,
      savingsAvailable: recommendations.some((recommendation) => recommendation.monthlySavings != null),
      warnings,
    }
  }
}
