import type { MetricDatapoint } from '../aws/cloudwatch'
import type { CloudResource, ResourceInventoryResult } from './resource-inventory'
import { CloudWatchClient } from '../aws/cloudwatch'
import { CostExplorerClient } from '../aws/cost-explorer'
import { rollingComparisonRange } from './reporting'
import { ResourceInventoryClient } from './resource-inventory'

export interface ResourceSignals {
  cpuAverage?: number
  connectionsAverage?: number
  iopsAverage?: number
  invocations?: number
  objectCount?: number
  requests?: number
  cacheHitRate?: number
}

export interface IdleResourceFinding {
  resource: CloudResource
  signal: string
  recommendation: string
  monthlySavings: number | null
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
      const [connectionsAverage, readIops, writeIops] = await Promise.all([
        this.metric(cloudwatch, resource, 'AWS/RDS', 'DatabaseConnections', 'DBInstanceIdentifier', 14, 'Average'),
        this.metric(cloudwatch, resource, 'AWS/RDS', 'ReadIOPS', 'DBInstanceIdentifier', 14, 'Average'),
        this.metric(cloudwatch, resource, 'AWS/RDS', 'WriteIOPS', 'DBInstanceIdentifier', 14, 'Average'),
      ])
      return {
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
      const [objectCount, requests] = await Promise.all([
        this.metric(cloudwatch, resource, 'AWS/S3', 'NumberOfObjects', 'BucketName', 90, 'Average', [
          { Name: 'StorageType', Value: 'AllStorageTypes' },
        ]),
        this.metric(cloudwatch, resource, 'AWS/S3', 'AllRequests', 'BucketName', 90, 'Sum'),
      ])
      return { objectCount, requests }
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

  async unused(options?: { type?: string }): Promise<{
    findings: IdleResourceFinding[]
    inventory: ResourceInventoryResult
    savingsAvailable: boolean
  }> {
    const [inventory, costs] = await Promise.all([this.inventory.discover(options), this.resourceCosts()])
    const findings = (
      await Promise.all(
        inventory.resources.map(async (resource) => {
          const immediate = evaluateIdleResource(resource, {}, costs.get(resource.id) ?? null)
          if (immediate) return immediate
          try {
            return evaluateIdleResource(resource, await this.signals(resource), costs.get(resource.id) ?? null)
          } catch {
            return null
          }
        }),
      )
    ).filter((finding): finding is IdleResourceFinding => finding !== null)
    return { findings, inventory, savingsAvailable: costs.size > 0 }
  }
}
