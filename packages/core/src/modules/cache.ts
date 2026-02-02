import type {
  ElastiCacheCluster,
  ElastiCacheParameterGroup,
  ElastiCacheReplicationGroup,
  ElastiCacheSubnetGroup,
} from '@stacksjs/ts-cloud-aws-types'
import type { EnvironmentType } from '@stacksjs/ts-cloud-types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface RedisOptions {
  slug: string
  environment: EnvironmentType
  nodeType?: string
  engineVersion?: string
  port?: number
  subnetIds?: string[]
  securityGroupIds?: string[]
  numCacheClusters?: number
  automaticFailover?: boolean
  multiAz?: boolean
  clusterMode?: boolean
  numNodeGroups?: number
  replicasPerNodeGroup?: number
  atRestEncryption?: boolean
  transitEncryption?: boolean
  authToken?: string
  kmsKeyId?: string
  snapshotRetentionDays?: number
  snapshotWindow?: string
  maintenanceWindow?: string
}

export interface MemcachedOptions {
  slug: string
  environment: EnvironmentType
  nodeType?: string
  engineVersion?: string
  port?: number
  numCacheNodes?: number
  subnetIds?: string[]
  securityGroupIds?: string[]
  azMode?: 'single-az' | 'cross-az'
  preferredAzs?: string[]
  maintenanceWindow?: string
}

/**
 * Cache Module - ElastiCache (Redis + Memcached)
 * Provides clean API for creating Redis and Memcached clusters
 */
export class Cache {
  /**
   * Create a Redis cluster
   */
  static createRedis(options: RedisOptions): {
    replicationGroup: ElastiCacheReplicationGroup
    subnetGroup?: ElastiCacheSubnetGroup
    logicalId: string
    subnetGroupId?: string
  } {
    const {
      slug,
      environment,
      nodeType = 'cache.t3.micro',
      engineVersion = '7.1',
      port = 6379,
      subnetIds,
      securityGroupIds,
      numCacheClusters = 2,
      automaticFailover = true,
      multiAz = true,
      clusterMode = false,
      numNodeGroups = 1,
      replicasPerNodeGroup = 1,
      atRestEncryption = true,
      transitEncryption = true,
      authToken,
      kmsKeyId,
      snapshotRetentionDays = 7,
      snapshotWindow,
      maintenanceWindow,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'redis',
    })

    const logicalId = generateLogicalId(resourceName)

    // Create subnet group if subnets provided
    let subnetGroup: ElastiCacheSubnetGroup | undefined
    let subnetGroupId: string | undefined

    if (subnetIds && subnetIds.length > 0) {
      const subnetGroupName = generateResourceName({
        slug,
        environment,
        resourceType: 'cache-subnet-group',
      })

      subnetGroupId = generateLogicalId(subnetGroupName)

      subnetGroup = {
        Type: 'AWS::ElastiCache::SubnetGroup',
        Properties: {
          CacheSubnetGroupName: subnetGroupName,
          Description: `Subnet group for ${resourceName}`,
          SubnetIds: subnetIds,
          Tags: [
            { Key: 'Name', Value: subnetGroupName },
            { Key: 'Environment', Value: environment },
          ],
        },
      }
    }

    const replicationGroup: ElastiCacheReplicationGroup = {
      Type: 'AWS::ElastiCache::ReplicationGroup',
      Properties: {
        ReplicationGroupId: resourceName,
        ReplicationGroupDescription: `Redis cluster for ${slug} ${environment}`,
        Engine: 'redis',
        EngineVersion: engineVersion,
        CacheNodeType: nodeType,
        Port: port,
        AutomaticFailoverEnabled: automaticFailover,
        MultiAZEnabled: multiAz,
        AtRestEncryptionEnabled: atRestEncryption,
        TransitEncryptionEnabled: transitEncryption,
        SnapshotRetentionLimit: snapshotRetentionDays,
        AutoMinorVersionUpgrade: true,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    // Configure cluster mode or replication mode
    if (clusterMode) {
      replicationGroup.Properties.NumNodeGroups = numNodeGroups
      replicationGroup.Properties.ReplicasPerNodeGroup = replicasPerNodeGroup
    }
    else {
      replicationGroup.Properties.NumCacheClusters = numCacheClusters
    }

    if (authToken) {
      replicationGroup.Properties.AuthToken = authToken
    }

    if (kmsKeyId) {
      replicationGroup.Properties.KmsKeyId = kmsKeyId
    }

    if (subnetGroupId) {
      replicationGroup.Properties.CacheSubnetGroupName = Fn.Ref(subnetGroupId) as unknown as string
    }

    if (securityGroupIds && securityGroupIds.length > 0) {
      replicationGroup.Properties.SecurityGroupIds = securityGroupIds
    }

    if (snapshotWindow) {
      replicationGroup.Properties.SnapshotWindow = snapshotWindow
    }

    if (maintenanceWindow) {
      replicationGroup.Properties.PreferredMaintenanceWindow = maintenanceWindow
    }

    return {
      replicationGroup,
      subnetGroup,
      logicalId,
      subnetGroupId,
    }
  }

  /**
   * Create a Memcached cluster
   */
  static createMemcached(options: MemcachedOptions): {
    cluster: ElastiCacheCluster
    subnetGroup?: ElastiCacheSubnetGroup
    logicalId: string
    subnetGroupId?: string
  } {
    const {
      slug,
      environment,
      nodeType = 'cache.t3.micro',
      engineVersion = '1.6.22',
      port = 11211,
      numCacheNodes = 2,
      subnetIds,
      securityGroupIds,
      azMode = 'cross-az',
      preferredAzs,
      maintenanceWindow,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'memcached',
    })

    const logicalId = generateLogicalId(resourceName)

    // Create subnet group if subnets provided
    let subnetGroup: ElastiCacheSubnetGroup | undefined
    let subnetGroupId: string | undefined

    if (subnetIds && subnetIds.length > 0) {
      const subnetGroupName = generateResourceName({
        slug,
        environment,
        resourceType: 'cache-subnet-group',
      })

      subnetGroupId = generateLogicalId(subnetGroupName)

      subnetGroup = {
        Type: 'AWS::ElastiCache::SubnetGroup',
        Properties: {
          CacheSubnetGroupName: subnetGroupName,
          Description: `Subnet group for ${resourceName}`,
          SubnetIds: subnetIds,
          Tags: [
            { Key: 'Name', Value: subnetGroupName },
            { Key: 'Environment', Value: environment },
          ],
        },
      }
    }

    const cluster: ElastiCacheCluster = {
      Type: 'AWS::ElastiCache::CacheCluster',
      Properties: {
        ClusterName: resourceName,
        CacheNodeType: nodeType,
        Engine: 'memcached',
        EngineVersion: engineVersion,
        NumCacheNodes: numCacheNodes,
        Port: port,
        AZMode: azMode,
        AutoMinorVersionUpgrade: true,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    if (subnetGroupId) {
      cluster.Properties.CacheSubnetGroupName = Fn.Ref(subnetGroupId) as unknown as string
    }

    if (securityGroupIds && securityGroupIds.length > 0) {
      cluster.Properties.VpcSecurityGroupIds = securityGroupIds
    }

    if (preferredAzs && preferredAzs.length > 0) {
      cluster.Properties.PreferredAvailabilityZones = preferredAzs
    }

    if (maintenanceWindow) {
      cluster.Properties.PreferredMaintenanceWindow = maintenanceWindow
    }

    return {
      cluster,
      subnetGroup,
      logicalId,
      subnetGroupId,
    }
  }

  /**
   * Enable cluster mode for Redis (returns new configuration)
   */
  static enableClusterMode(
    replicationGroup: ElastiCacheReplicationGroup,
    numNodeGroups: number = 3,
    replicasPerNodeGroup: number = 2,
  ): ElastiCacheReplicationGroup {
    // Remove NumCacheClusters (used for non-cluster mode)
    delete replicationGroup.Properties.NumCacheClusters

    // Set cluster mode parameters
    replicationGroup.Properties.NumNodeGroups = numNodeGroups
    replicationGroup.Properties.ReplicasPerNodeGroup = replicasPerNodeGroup

    return replicationGroup
  }

  /**
   * Create a parameter group for Redis
   */
  static createRedisParameterGroup(
    version: string,
    options: {
      slug: string
      environment: EnvironmentType
      parameters?: Record<string, string>
    },
  ): {
      parameterGroup: ElastiCacheParameterGroup
      logicalId: string
    } {
    const { slug, environment, parameters = {} } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'redis-params',
    })

    const logicalId = generateLogicalId(resourceName)

    // Determine parameter group family
    const family = `redis${version.split('.')[0]}.x`

    const parameterGroup: ElastiCacheParameterGroup = {
      Type: 'AWS::ElastiCache::ParameterGroup',
      Properties: {
        CacheParameterGroupFamily: family,
        Description: `Parameter group for ${resourceName}`,
        Properties: parameters,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    return { parameterGroup, logicalId }
  }

  /**
   * Create a parameter group for Memcached
   */
  static createMemcachedParameterGroup(
    version: string,
    options: {
      slug: string
      environment: EnvironmentType
      parameters?: Record<string, string>
    },
  ): {
      parameterGroup: ElastiCacheParameterGroup
      logicalId: string
    } {
    const { slug, environment, parameters = {} } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'memcached-params',
    })

    const logicalId = generateLogicalId(resourceName)

    // Determine parameter group family
    const family = `memcached${version.split('.')[0]}.${version.split('.')[1]}`

    const parameterGroup: ElastiCacheParameterGroup = {
      Type: 'AWS::ElastiCache::ParameterGroup',
      Properties: {
        CacheParameterGroupFamily: family,
        Description: `Parameter group for ${resourceName}`,
        Properties: parameters,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    return { parameterGroup, logicalId }
  }

  /**
   * Common ElastiCache node types
   */
  static readonly NodeTypes = {
    // T3 - Burstable performance
    T3_Micro: 'cache.t3.micro',
    T3_Small: 'cache.t3.small',
    T3_Medium: 'cache.t3.medium',

    // T4g - Arm-based burstable
    T4g_Micro: 'cache.t4g.micro',
    T4g_Small: 'cache.t4g.small',
    T4g_Medium: 'cache.t4g.medium',

    // M5 - General purpose
    M5_Large: 'cache.m5.large',
    M5_XLarge: 'cache.m5.xlarge',
    M5_2XLarge: 'cache.m5.2xlarge',

    // R5 - Memory optimized
    R5_Large: 'cache.r5.large',
    R5_XLarge: 'cache.r5.xlarge',
    R5_2XLarge: 'cache.r5.2xlarge',
    R5_4XLarge: 'cache.r5.4xlarge',

    // R6g - Arm-based memory optimized
    R6g_Large: 'cache.r6g.large',
    R6g_XLarge: 'cache.r6g.xlarge',
    R6g_2XLarge: 'cache.r6g.2xlarge',
  } as const
}
