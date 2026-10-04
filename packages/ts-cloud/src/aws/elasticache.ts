/**
 * AWS ElastiCache Operations
 * Direct API calls without AWS CLI dependency
 */
import { XMLParser } from '@stacksjs/ts-xml'
import { AWSClient } from './client'
import { CloudWatchClient } from './cloudwatch'
import { asList, queryResult } from './xml-result'

export interface CacheCluster {
  CacheClusterId: string
  CacheClusterStatus: string
  Engine: string
  EngineVersion: string
  CacheNodeType: string
  NumCacheNodes: number
  PreferredAvailabilityZone?: string
  CacheClusterCreateTime: string
  CacheNodes?: Array<{
    CacheNodeId: string
    CacheNodeStatus: string
    Endpoint?: {
      Address: string
      Port: number
    }
  }>
}

export interface ReplicationGroup {
  ReplicationGroupId: string
  Status: string
  Description?: string
  MemberClusters?: string[]
  NodeGroups?: Array<{
    NodeGroupId: string
    Status: string
    PrimaryEndpoint?: {
      Address: string
      Port: number
    }
  }>
}

export interface CacheEngineVersion {
  Engine: string
  EngineVersion: string
  CacheParameterGroupFamily: string
}

/**
 * ElastiCache answers in XML that this client parses itself, keeping every
 * value as text. AWSClient's parser turns numeric text into numbers, which
 * would make an engine version of `7.0` read as `7`.
 */
const elastiCacheXmlParser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true })

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '')
    return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function parseEndpoint(node: any): { Address: string; Port: number } | undefined {
  if (!node?.Address)
    return undefined
  return { Address: String(node.Address), Port: toNumber(node.Port) ?? 0 }
}

function parseCacheCluster(node: any): CacheCluster {
  return {
    CacheClusterId: String(node?.CacheClusterId ?? ''),
    CacheClusterStatus: String(node?.CacheClusterStatus ?? ''),
    Engine: String(node?.Engine ?? ''),
    EngineVersion: String(node?.EngineVersion ?? ''),
    CacheNodeType: String(node?.CacheNodeType ?? ''),
    NumCacheNodes: toNumber(node?.NumCacheNodes) ?? 0,
    PreferredAvailabilityZone: node?.PreferredAvailabilityZone || undefined,
    CacheClusterCreateTime: String(node?.CacheClusterCreateTime ?? ''),
    CacheNodes: asList(node?.CacheNodes?.CacheNode).map((cacheNode: any) => ({
      CacheNodeId: String(cacheNode.CacheNodeId ?? ''),
      CacheNodeStatus: String(cacheNode.CacheNodeStatus ?? ''),
      Endpoint: parseEndpoint(cacheNode.Endpoint),
    })),
  }
}

function parseReplicationGroup(node: any): ReplicationGroup {
  return {
    ReplicationGroupId: String(node?.ReplicationGroupId ?? ''),
    Status: String(node?.Status ?? ''),
    Description: node?.Description || undefined,
    MemberClusters: asList<string>(node?.MemberClusters?.ClusterId).map(String),
    NodeGroups: asList(node?.NodeGroups?.NodeGroup).map((group: any) => ({
      NodeGroupId: String(group.NodeGroupId ?? ''),
      Status: String(group.Status ?? ''),
      PrimaryEndpoint: parseEndpoint(group.PrimaryEndpoint),
    })),
  }
}

/**
 * ElastiCache management using direct API calls
 */
export class ElastiCacheClient {
  private client: AWSClient
  private region: string
  private profile?: string

  constructor(region: string = 'us-east-1', profile?: string) {
    this.region = region
    this.profile = profile
    this.client = new AWSClient(undefined, { profile })
  }

  /**
   * Send one query-API action and return its `<{Action}Result>`, parsed with
   * values kept as text.
   */
  private async query(params: Record<string, any>): Promise<any> {
    const text = await this.client.request({
      service: 'elasticache',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      rawResponse: true,
    })
    if (typeof text !== 'string' || !text.trim())
      return undefined
    return queryResult(elastiCacheXmlParser.parse(text), params.Action)
  }

  /**
   * List all cache clusters
   */
  async describeCacheClusters(cacheClusterId?: string): Promise<{ CacheClusters: CacheCluster[] }> {
    const params: Record<string, any> = {
      Action: 'DescribeCacheClusters',
      Version: '2015-02-02',
      ShowCacheNodeInfo: 'true',
    }

    if (cacheClusterId) {
      params.CacheClusterId = cacheClusterId
    }

    const result = await this.query(params)
    return { CacheClusters: asList(result?.CacheClusters?.CacheCluster).map(parseCacheCluster) }
  }

  /**
   * List all replication groups (Redis clusters)
   */
  async describeReplicationGroups(replicationGroupId?: string): Promise<{ ReplicationGroups: ReplicationGroup[] }> {
    const params: Record<string, any> = {
      Action: 'DescribeReplicationGroups',
      Version: '2015-02-02',
    }

    if (replicationGroupId) {
      params.ReplicationGroupId = replicationGroupId
    }

    const result = await this.query(params)
    return { ReplicationGroups: asList(result?.ReplicationGroups?.ReplicationGroup).map(parseReplicationGroup) }
  }

  /**
   * Create a cache cluster
   */
  async createCacheCluster(options: {
    cacheClusterId: string
    engine: 'memcached' | 'redis'
    cacheNodeType: string
    numCacheNodes?: number
    engineVersion?: string
    port?: number
    securityGroupIds?: string[]
    subnetGroupName?: string
    tags?: Array<{ Key: string; Value: string }>
  }): Promise<{ CacheCluster: CacheCluster }> {
    const params: Record<string, any> = {
      Action: 'CreateCacheCluster',
      Version: '2015-02-02',
      CacheClusterId: options.cacheClusterId,
      Engine: options.engine,
      CacheNodeType: options.cacheNodeType,
    }

    if (options.numCacheNodes) {
      params.NumCacheNodes = options.numCacheNodes
    }

    if (options.engineVersion) {
      params.EngineVersion = options.engineVersion
    }

    if (options.port) {
      params.Port = options.port
    }

    if (options.securityGroupIds && options.securityGroupIds.length > 0) {
      options.securityGroupIds.forEach((id, index) => {
        params[`SecurityGroupIds.member.${index + 1}`] = id
      })
    }

    if (options.subnetGroupName) {
      params.CacheSubnetGroupName = options.subnetGroupName
    }

    if (options.tags && options.tags.length > 0) {
      options.tags.forEach((tag, index) => {
        params[`Tags.member.${index + 1}.Key`] = tag.Key
        params[`Tags.member.${index + 1}.Value`] = tag.Value
      })
    }

    const result = await this.query(params)
    return { CacheCluster: parseCacheCluster(result?.CacheCluster) }
  }

  /**
   * Delete a cache cluster
   */
  async deleteCacheCluster(cacheClusterId: string, finalSnapshotId?: string): Promise<void> {
    const params: Record<string, any> = {
      Action: 'DeleteCacheCluster',
      Version: '2015-02-02',
      CacheClusterId: cacheClusterId,
    }

    if (finalSnapshotId) {
      params.FinalSnapshotIdentifier = finalSnapshotId
    }

    await this.query(params)
  }

  /**
   * Reboot cache cluster nodes
   */
  async rebootCacheCluster(cacheClusterId: string, nodeIds: string[]): Promise<void> {
    const params: Record<string, any> = {
      Action: 'RebootCacheCluster',
      Version: '2015-02-02',
      CacheClusterId: cacheClusterId,
    }

    nodeIds.forEach((id, index) => {
      params[`CacheNodeIdsToReboot.member.${index + 1}`] = id
    })

    await this.query(params)
  }

  /**
   * List available cache engine versions
   */
  async describeCacheEngineVersions(engine?: string): Promise<{ CacheEngineVersions: CacheEngineVersion[] }> {
    const params: Record<string, any> = {
      Action: 'DescribeCacheEngineVersions',
      Version: '2015-02-02',
    }

    if (engine) {
      params.Engine = engine
    }

    // One page holds 100 versions; follow the marker so the list is complete.
    const versions: CacheEngineVersion[] = []
    let marker: string | undefined
    do {
      const result = await this.query(marker ? { ...params, Marker: marker } : params)
      for (const version of asList(result?.CacheEngineVersions?.CacheEngineVersion)) {
        versions.push({
          Engine: String(version.Engine ?? ''),
          EngineVersion: String(version.EngineVersion ?? ''),
          CacheParameterGroupFamily: String(version.CacheParameterGroupFamily ?? ''),
        })
      }
      marker = result?.Marker || undefined
    } while (marker)

    return { CacheEngineVersions: versions }
  }

  /**
   * The cluster's latest CloudWatch readings over the last ten minutes.
   *
   * A metric with no datapoint in that window is left undefined rather than
   * reported as 0. Memcached publishes GetHits/GetMisses where Redis and
   * Valkey publish CacheHits/CacheMisses.
   */
  async getCacheStatistics(cacheClusterId: string): Promise<{
    cpuUtilization?: number
    evictions?: number
    hits?: number
    misses?: number
    connections?: number
  }> {
    const result = await this.describeCacheClusters(cacheClusterId)
    const cluster = result.CacheClusters[0]
    if (!cluster) {
      throw new Error(`Cache cluster ${cacheClusterId} not found`)
    }

    const memcached = cluster.Engine === 'memcached'
    const cloudwatch = new CloudWatchClient(this.region, this.profile)
    const endTime = new Date()
    const startTime = new Date(endTime.getTime() - 10 * 60 * 1000)
    const latest = async (metricName: string, statistic: 'Average' | 'Sum'): Promise<number | undefined> => {
      const points = await cloudwatch.getMetricStatistics({
        Namespace: 'AWS/ElastiCache',
        MetricName: metricName,
        Dimensions: [{ Name: 'CacheClusterId', Value: cacheClusterId }],
        StartTime: startTime,
        EndTime: endTime,
        Period: 300,
        Statistics: [statistic],
      })
      const newest = [...points].sort((a, b) => new Date(b.Timestamp ?? 0).getTime() - new Date(a.Timestamp ?? 0).getTime())[0]
      return newest?.[statistic]
    }

    const [cpuUtilization, evictions, hits, misses, connections] = await Promise.all([
      latest('CPUUtilization', 'Average'),
      latest('Evictions', 'Sum'),
      latest(memcached ? 'GetHits' : 'CacheHits', 'Sum'),
      latest(memcached ? 'GetMisses' : 'CacheMisses', 'Sum'),
      latest('CurrConnections', 'Average'),
    ])
    return { cpuUtilization, evictions, hits, misses, connections }
  }
}
