import type { CloudFormationResource } from './index'

/**
 * AWS ElastiCache Types
*/

export interface ElastiCacheCluster extends CloudFormationResource {
  Type: 'AWS::ElastiCache::CacheCluster'
  Properties: {
    ClusterName?: string
    CacheNodeType: string
    Engine: 'memcached' | 'redis'
    EngineVersion?: string
    NumCacheNodes: number
    Port?: number
    PreferredAvailabilityZone?: string
    PreferredAvailabilityZones?: string[]
    PreferredMaintenanceWindow?: string
    CacheSubnetGroupName?: string | { Ref: string }
    VpcSecurityGroupIds?: string[]
    CacheParameterGroupName?: string | { Ref: string }
    SnapshotRetentionLimit?: number
    SnapshotWindow?: string
    AutoMinorVersionUpgrade?: boolean
    AZMode?: 'single-az' | 'cross-az'
    NotificationTopicArn?: string
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface ElastiCacheReplicationGroup extends CloudFormationResource {
  Type: 'AWS::ElastiCache::ReplicationGroup'
  Properties: {
    ReplicationGroupId?: string
    ReplicationGroupDescription: string
    Engine?: 'redis'
    EngineVersion?: string
    CacheNodeType: string
    NumCacheClusters?: number
    NumNodeGroups?: number
    ReplicasPerNodeGroup?: number
    AutomaticFailoverEnabled?: boolean
    MultiAZEnabled?: boolean
    PreferredCacheClusterAZs?: string[]
    Port?: number
    CacheSubnetGroupName?: string | { Ref: string }
    SecurityGroupIds?: string[]
    CacheParameterGroupName?: string | { Ref: string }
    SnapshotRetentionLimit?: number
    SnapshotWindow?: string
    PreferredMaintenanceWindow?: string
    AtRestEncryptionEnabled?: boolean
    TransitEncryptionEnabled?: boolean
    AuthToken?: string
    KmsKeyId?: string
    AutoMinorVersionUpgrade?: boolean
    NotificationTopicArn?: string
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface ElastiCacheSubnetGroup extends CloudFormationResource {
  Type: 'AWS::ElastiCache::SubnetGroup'
  Properties: {
    CacheSubnetGroupName?: string
    Description: string
    SubnetIds: string[]
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface ElastiCacheParameterGroup extends CloudFormationResource {
  Type: 'AWS::ElastiCache::ParameterGroup'
  Properties: {
    CacheParameterGroupFamily: string
    Description: string
    Properties?: Record<string, string>
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}
