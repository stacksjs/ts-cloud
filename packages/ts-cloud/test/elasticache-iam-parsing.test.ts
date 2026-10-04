/**
 * ElastiCache and IAM response parsing.
 *
 * ElastiCache's parsers were stubs: describeCacheClusters read flat fields
 * off a body that has none and returned [], createCacheCluster invented
 * defaults ('redis', '7.0', 'cache.t3.micro'), describeReplicationGroups and
 * describeCacheEngineVersions returned [] behind a TODO, and
 * getCacheStatistics reported zeros.
 *
 * IAM's regex helpers took the first matching tag anywhere and cut a
 * `<member>` holding its own `<member>` list in half, so an instance profile
 * came back with its role's ARN and an empty ID.
 *
 * Both now parse the raw XML with values kept as text, so the bodies below
 * are handed over as the text AWS sends.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { CloudWatchClient } from '../src/aws/cloudwatch'
import { ElastiCacheClient } from '../src/aws/elasticache'
import { IAMClient } from '../src/aws/iam'

const XML = '<?xml version="1.0" encoding="UTF-8"?>\n'
const METADATA = '<ResponseMetadata><RequestId>aebe383e-1497-4009-b974-71f12b0d3e18</RequestId></ResponseMetadata>'

/** Answer every request with raw XML text, as AWSClient does for `rawResponse`. */
function respondWithText(client: object, ...bodies: string[]): Array<Record<string, any>> {
  const calls: Array<Record<string, any>> = []
  ;(client as any).client.request = async (options: any) => {
    calls.push(options)
    expect(options.rawResponse).toBe(true)
    return XML + (bodies[calls.length - 1] ?? bodies.at(-1))
  }
  return calls
}

function elastiCacheBody(action: string, result: string): string {
  return `<${action}Response xmlns="http://elasticache.amazonaws.com/doc/2015-02-02/"><${action}Result>${result}</${action}Result>${METADATA}</${action}Response>`
}

const REDIS_CLUSTER = '<CacheCluster><CacheClusterId>app-cache</CacheClusterId><CacheClusterStatus>available</CacheClusterStatus><Engine>redis</Engine><EngineVersion>7.0</EngineVersion><CacheNodeType>cache.t4g.small</CacheNodeType><NumCacheNodes>1</NumCacheNodes><PreferredAvailabilityZone>us-east-1a</PreferredAvailabilityZone><CacheClusterCreateTime>2026-09-01T10:00:00.000Z</CacheClusterCreateTime><CacheNodes><CacheNode><CacheNodeId>0001</CacheNodeId><CacheNodeStatus>available</CacheNodeStatus><Endpoint><Address>app-cache.abc123.0001.use1.cache.amazonaws.com</Address><Port>6379</Port></Endpoint></CacheNode></CacheNodes></CacheCluster>'

describe('ElastiCacheClient parses real responses', () => {
  it('describeCacheClusters returns the cluster with its node endpoint (it returned [])', async () => {
    const ec = new ElastiCacheClient('us-east-1')
    respondWithText(ec, elastiCacheBody('DescribeCacheClusters', `<CacheClusters>${REDIS_CLUSTER}</CacheClusters>`))
    const { CacheClusters } = await ec.describeCacheClusters('app-cache')
    expect(CacheClusters).toEqual([{
      CacheClusterId: 'app-cache',
      CacheClusterStatus: 'available',
      Engine: 'redis',
      EngineVersion: '7.0',
      CacheNodeType: 'cache.t4g.small',
      NumCacheNodes: 1,
      PreferredAvailabilityZone: 'us-east-1a',
      CacheClusterCreateTime: '2026-09-01T10:00:00.000Z',
      CacheNodes: [{
        CacheNodeId: '0001',
        CacheNodeStatus: 'available',
        Endpoint: { Address: 'app-cache.abc123.0001.use1.cache.amazonaws.com', Port: 6379 },
      }],
    }])
  })

  it('describeCacheClusters returns [] for an account with none', async () => {
    const ec = new ElastiCacheClient('us-east-1')
    respondWithText(ec, elastiCacheBody('DescribeCacheClusters', '<CacheClusters/>'))
    expect(await ec.describeCacheClusters()).toEqual({ CacheClusters: [] })
  })

  it('createCacheCluster returns the created cluster, not invented defaults', async () => {
    const ec = new ElastiCacheClient('us-east-1')
    respondWithText(ec, elastiCacheBody('CreateCacheCluster', '<CacheCluster><CacheClusterId>jobs</CacheClusterId><CacheClusterStatus>creating</CacheClusterStatus><Engine>memcached</Engine><EngineVersion>1.6.22</EngineVersion><CacheNodeType>cache.t3.micro</CacheNodeType><NumCacheNodes>2</NumCacheNodes></CacheCluster>'))
    const { CacheCluster } = await ec.createCacheCluster({ cacheClusterId: 'jobs', engine: 'memcached', cacheNodeType: 'cache.t3.micro', numCacheNodes: 2 })
    expect(CacheCluster).toMatchObject({ CacheClusterId: 'jobs', Engine: 'memcached', EngineVersion: '1.6.22', NumCacheNodes: 2, CacheNodes: [] })
  })

  it('describeReplicationGroups returns groups, members and primary endpoints (it returned [])', async () => {
    const ec = new ElastiCacheClient('us-east-1')
    respondWithText(ec, elastiCacheBody('DescribeReplicationGroups', '<ReplicationGroups><ReplicationGroup><ReplicationGroupId>sessions</ReplicationGroupId><Description>Session store</Description><Status>available</Status><MemberClusters><ClusterId>sessions-001</ClusterId><ClusterId>sessions-002</ClusterId></MemberClusters><NodeGroups><NodeGroup><NodeGroupId>0001</NodeGroupId><Status>available</Status><PrimaryEndpoint><Address>sessions.abc123.ng.0001.use1.cache.amazonaws.com</Address><Port>6379</Port></PrimaryEndpoint></NodeGroup></NodeGroups></ReplicationGroup></ReplicationGroups>'))
    expect(await ec.describeReplicationGroups()).toEqual({
      ReplicationGroups: [{
        ReplicationGroupId: 'sessions',
        Status: 'available',
        Description: 'Session store',
        MemberClusters: ['sessions-001', 'sessions-002'],
        NodeGroups: [{
          NodeGroupId: '0001',
          Status: 'available',
          PrimaryEndpoint: { Address: 'sessions.abc123.ng.0001.use1.cache.amazonaws.com', Port: 6379 },
        }],
      }],
    })
  })

  it('describeCacheEngineVersions keeps 7.0 as text and follows the marker (it returned [])', async () => {
    const ec = new ElastiCacheClient('us-east-1')
    const calls = respondWithText(
      ec,
      elastiCacheBody('DescribeCacheEngineVersions', '<Marker>page-2</Marker><CacheEngineVersions><CacheEngineVersion><Engine>redis</Engine><EngineVersion>7.0</EngineVersion><CacheParameterGroupFamily>redis7</CacheParameterGroupFamily></CacheEngineVersion></CacheEngineVersions>'),
      elastiCacheBody('DescribeCacheEngineVersions', '<CacheEngineVersions><CacheEngineVersion><Engine>valkey</Engine><EngineVersion>8.0</EngineVersion><CacheParameterGroupFamily>valkey8</CacheParameterGroupFamily></CacheEngineVersion></CacheEngineVersions>'),
    )
    expect(await ec.describeCacheEngineVersions()).toEqual({
      CacheEngineVersions: [
        { Engine: 'redis', EngineVersion: '7.0', CacheParameterGroupFamily: 'redis7' },
        { Engine: 'valkey', EngineVersion: '8.0', CacheParameterGroupFamily: 'valkey8' },
      ],
    })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.body).toContain('Marker=page-2')
  })
})

describe('ElastiCacheClient.getCacheStatistics', () => {
  const original = CloudWatchClient.prototype.getMetricStatistics
  afterEach(() => {
    CloudWatchClient.prototype.getMetricStatistics = original
  })

  it('reads CloudWatch, with memcached hit metrics, and leaves a missing metric undefined instead of 0', async () => {
    const ec = new ElastiCacheClient('us-east-1')
    respondWithText(ec, elastiCacheBody('DescribeCacheClusters', '<CacheClusters><CacheCluster><CacheClusterId>jobs</CacheClusterId><Engine>memcached</Engine></CacheCluster></CacheClusters>'))
    const asked: string[] = []
    CloudWatchClient.prototype.getMetricStatistics = async function (options: any) {
      asked.push(options.MetricName)
      expect(options.Namespace).toBe('AWS/ElastiCache')
      expect(options.Dimensions).toEqual([{ Name: 'CacheClusterId', Value: 'jobs' }])
      const readings: Record<string, any[]> = {
        CPUUtilization: [
          { Timestamp: '2026-10-04T10:00:00Z', Average: 3 },
          { Timestamp: '2026-10-04T10:05:00Z', Average: 4.5 },
        ],
        Evictions: [{ Timestamp: '2026-10-04T10:05:00Z', Sum: 0 }],
        GetHits: [{ Timestamp: '2026-10-04T10:05:00Z', Sum: 120 }],
        GetMisses: [{ Timestamp: '2026-10-04T10:05:00Z', Sum: 7 }],
        CurrConnections: [],
      }
      return readings[options.MetricName] ?? []
    } as any
    expect(await ec.getCacheStatistics('jobs')).toEqual({ cpuUtilization: 4.5, evictions: 0, hits: 120, misses: 7, connections: undefined })
    expect(asked.sort()).toEqual(['CPUUtilization', 'CurrConnections', 'Evictions', 'GetHits', 'GetMisses'])
  })

  it('throws for a cluster that does not exist', async () => {
    const ec = new ElastiCacheClient('us-east-1')
    respondWithText(ec, elastiCacheBody('DescribeCacheClusters', '<CacheClusters/>'))
    await expect(ec.getCacheStatistics('missing')).rejects.toThrow('Cache cluster missing not found')
  })
})

function iamBody(action: string, result: string): string {
  return `<${action}Response xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><${action}Result>${result}</${action}Result>${METADATA}</${action}Response>`
}

const ROLE_MEMBER = '<member><Path>/</Path><RoleName>mail-server-role</RoleName><RoleId>AROAEXAMPLEROLEID0001</RoleId><Arn>arn:aws:iam::123456789012:role/mail-server-role</Arn><CreateDate>2025-12-09T00:48:12Z</CreateDate><AssumeRolePolicyDocument>%7B%22Version%22%3A%222012-10-17%22%7D</AssumeRolePolicyDocument></member>'

describe('IAMClient parses responses structurally', () => {
  it('reports an instance profile\'s own ID and ARN, not its nested role\'s', async () => {
    const iam = new IAMClient('us-east-1')
    respondWithText(iam, iamBody('ListInstanceProfiles', `<IsTruncated>false</IsTruncated><InstanceProfiles><member><Path>/</Path><InstanceProfileName>mail-server-profile</InstanceProfileName><Roles>${ROLE_MEMBER}</Roles><InstanceProfileId>AIPAEXAMPLEPROFILE01</InstanceProfileId><Arn>arn:aws:iam::123456789012:instance-profile/mail-server-profile</Arn><CreateDate>2025-12-09T00:48:31Z</CreateDate></member><member><Path>/</Path><InstanceProfileName>web-profile</InstanceProfileName><Roles/><InstanceProfileId>AIPAEXAMPLEPROFILE02</InstanceProfileId><Arn>arn:aws:iam::123456789012:instance-profile/web-profile</Arn><CreateDate>2025-12-10T00:00:00Z</CreateDate></member></InstanceProfiles>`))
    const { InstanceProfiles } = await iam.listInstanceProfiles()
    expect(InstanceProfiles).toEqual([
      { InstanceProfileName: 'mail-server-profile', InstanceProfileId: 'AIPAEXAMPLEPROFILE01', Arn: 'arn:aws:iam::123456789012:instance-profile/mail-server-profile', Path: '/', CreateDate: '2025-12-09T00:48:31Z' },
      { InstanceProfileName: 'web-profile', InstanceProfileId: 'AIPAEXAMPLEPROFILE02', Arn: 'arn:aws:iam::123456789012:instance-profile/web-profile', Path: '/', CreateDate: '2025-12-10T00:00:00Z' },
    ])
  })

  it('keeps a user whose tags hold their own <member> list whole', async () => {
    const iam = new IAMClient('us-east-1')
    respondWithText(iam, iamBody('ListUsers', '<IsTruncated>true</IsTruncated><Marker>next-page</Marker><Users><member><Path>/</Path><UserName>deploy</UserName><Tags><member><Key>team</Key><Value>platform</Value></member></Tags><UserId>AIDAEXAMPLEUSERID0001</UserId><Arn>arn:aws:iam::123456789012:user/deploy</Arn><CreateDate>2025-12-08T20:28:13Z</CreateDate></member></Users>'))
    expect(await iam.listUsers()).toEqual({
      Users: [{ UserName: 'deploy', UserId: 'AIDAEXAMPLEUSERID0001', Arn: 'arn:aws:iam::123456789012:user/deploy', Path: '/', CreateDate: '2025-12-08T20:28:13Z', PasswordLastUsed: undefined }],
      IsTruncated: true,
      Marker: 'next-page',
    })
  })

  it('decodes XML entities and returns text list items', async () => {
    const iam = new IAMClient('us-east-1')
    respondWithText(iam, iamBody('ListRolePolicies', '<IsTruncated>false</IsTruncated><PolicyNames><member>read &amp; write</member><member>logs</member></PolicyNames>'))
    expect(await iam.listRolePolicies({ RoleName: 'mail-server-role' })).toEqual({ PolicyNames: ['read & write', 'logs'], IsTruncated: false, Marker: undefined })
  })

  it('reads an account summary map', async () => {
    const iam = new IAMClient('us-east-1')
    respondWithText(iam, iamBody('GetAccountSummary', '<SummaryMap><entry><key>Users</key><value>23</value></entry><entry><key>InstanceProfiles</key><value>5</value></entry></SummaryMap>'))
    expect(await iam.getAccountSummary()).toMatchObject({ Users: 23, InstanceProfiles: 5 })
  })
})
