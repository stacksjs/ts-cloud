import { describe, expect, it } from 'bun:test'
import { Cache } from '../src/modules/cache'
import { TemplateBuilder } from '../src/template-builder'

describe('Cache Module', () => {
  describe('createRedis', () => {
    it('should create Redis replication group with default settings', () => {
      const { replicationGroup, logicalId } = Cache.createRedis({
        slug: 'my-app',
        environment: 'production',
      })

      expect(replicationGroup.Type).toBe('AWS::ElastiCache::ReplicationGroup')
      expect(replicationGroup.Properties.Engine).toBe('redis')
      expect(replicationGroup.Properties.EngineVersion).toBe('7.1')
      expect(replicationGroup.Properties.CacheNodeType).toBe('cache.t3.micro')
      expect(replicationGroup.Properties.Port).toBe(6379)
      expect(replicationGroup.Properties.NumCacheClusters).toBe(2)
      expect(replicationGroup.Properties.AutomaticFailoverEnabled).toBe(true)
      expect(replicationGroup.Properties.MultiAZEnabled).toBe(true)
      expect(replicationGroup.Properties.AtRestEncryptionEnabled).toBe(true)
      expect(replicationGroup.Properties.TransitEncryptionEnabled).toBe(true)
      expect(replicationGroup.Properties.SnapshotRetentionLimit).toBe(7)
      expect(logicalId).toBeDefined()
    })

    it('should create Redis with subnet group', () => {
      const { replicationGroup, subnetGroup, subnetGroupId } = Cache.createRedis({
        slug: 'my-app',
        environment: 'production',
        subnetIds: ['subnet-1', 'subnet-2', 'subnet-3'],
      })

      expect(subnetGroup).toBeDefined()
      expect(subnetGroup?.Type).toBe('AWS::ElastiCache::SubnetGroup')
      expect(subnetGroup?.Properties.SubnetIds).toEqual(['subnet-1', 'subnet-2', 'subnet-3'])
      expect(subnetGroupId).toBeDefined()
    })

    it('should support custom configuration', () => {
      const { replicationGroup } = Cache.createRedis({
        slug: 'my-app',
        environment: 'production',
        nodeType: 'cache.r5.large',
        engineVersion: '7.0',
        port: 6380,
        numCacheClusters: 3,
        automaticFailover: false,
        multiAz: false,
        snapshotRetentionDays: 14,
      })

      expect(replicationGroup.Properties.CacheNodeType).toBe('cache.r5.large')
      expect(replicationGroup.Properties.EngineVersion).toBe('7.0')
      expect(replicationGroup.Properties.Port).toBe(6380)
      expect(replicationGroup.Properties.NumCacheClusters).toBe(3)
      expect(replicationGroup.Properties.AutomaticFailoverEnabled).toBe(false)
      expect(replicationGroup.Properties.MultiAZEnabled).toBe(false)
      expect(replicationGroup.Properties.SnapshotRetentionLimit).toBe(14)
    })

    it('should support cluster mode', () => {
      const { replicationGroup } = Cache.createRedis({
        slug: 'my-app',
        environment: 'production',
        clusterMode: true,
        numNodeGroups: 3,
        replicasPerNodeGroup: 2,
      })

      expect(replicationGroup.Properties.NumNodeGroups).toBe(3)
      expect(replicationGroup.Properties.ReplicasPerNodeGroup).toBe(2)
      expect(replicationGroup.Properties.NumCacheClusters).toBeUndefined()
    })

    it('should support auth token', () => {
      const { replicationGroup } = Cache.createRedis({
        slug: 'my-app',
        environment: 'production',
        authToken: 'MySecureToken123!',
      })

      expect(replicationGroup.Properties.AuthToken).toBe('MySecureToken123!')
    })

    it('should support KMS encryption', () => {
      const { replicationGroup } = Cache.createRedis({
        slug: 'my-app',
        environment: 'production',
        atRestEncryption: true,
        kmsKeyId: 'arn:aws:kms:us-east-1:123456789:key/abc',
      })

      expect(replicationGroup.Properties.KmsKeyId).toBe('arn:aws:kms:us-east-1:123456789:key/abc')
    })

    it('should support security groups', () => {
      const { replicationGroup } = Cache.createRedis({
        slug: 'my-app',
        environment: 'production',
        securityGroupIds: ['sg-123', 'sg-456'],
      })

      expect(replicationGroup.Properties.SecurityGroupIds).toEqual(['sg-123', 'sg-456'])
    })

    it('should support snapshot window', () => {
      const { replicationGroup } = Cache.createRedis({
        slug: 'my-app',
        environment: 'production',
        snapshotWindow: '03:00-05:00',
      })

      expect(replicationGroup.Properties.SnapshotWindow).toBe('03:00-05:00')
    })

    it('should support maintenance window', () => {
      const { replicationGroup } = Cache.createRedis({
        slug: 'my-app',
        environment: 'production',
        maintenanceWindow: 'sun:05:00-sun:07:00',
      })

      expect(replicationGroup.Properties.PreferredMaintenanceWindow).toBe('sun:05:00-sun:07:00')
    })

    it('should disable encryption when requested', () => {
      const { replicationGroup } = Cache.createRedis({
        slug: 'my-app',
        environment: 'production',
        atRestEncryption: false,
        transitEncryption: false,
      })

      expect(replicationGroup.Properties.AtRestEncryptionEnabled).toBe(false)
      expect(replicationGroup.Properties.TransitEncryptionEnabled).toBe(false)
    })
  })

  describe('createMemcached', () => {
    it('should create Memcached cluster with default settings', () => {
      const { cluster, logicalId } = Cache.createMemcached({
        slug: 'my-app',
        environment: 'production',
      })

      expect(cluster.Type).toBe('AWS::ElastiCache::CacheCluster')
      expect(cluster.Properties.Engine).toBe('memcached')
      expect(cluster.Properties.EngineVersion).toBe('1.6.22')
      expect(cluster.Properties.CacheNodeType).toBe('cache.t3.micro')
      expect(cluster.Properties.Port).toBe(11211)
      expect(cluster.Properties.NumCacheNodes).toBe(2)
      expect(cluster.Properties.AZMode).toBe('cross-az')
      expect(logicalId).toBeDefined()
    })

    it('should create Memcached with subnet group', () => {
      const { cluster, subnetGroup, subnetGroupId } = Cache.createMemcached({
        slug: 'my-app',
        environment: 'production',
        subnetIds: ['subnet-1', 'subnet-2'],
      })

      expect(subnetGroup).toBeDefined()
      expect(subnetGroup?.Type).toBe('AWS::ElastiCache::SubnetGroup')
      expect(subnetGroup?.Properties.SubnetIds).toEqual(['subnet-1', 'subnet-2'])
      expect(subnetGroupId).toBeDefined()
    })

    it('should support custom configuration', () => {
      const { cluster } = Cache.createMemcached({
        slug: 'my-app',
        environment: 'production',
        nodeType: 'cache.m5.large',
        engineVersion: '1.6.17',
        port: 11212,
        numCacheNodes: 3,
        azMode: 'single-az',
      })

      expect(cluster.Properties.CacheNodeType).toBe('cache.m5.large')
      expect(cluster.Properties.EngineVersion).toBe('1.6.17')
      expect(cluster.Properties.Port).toBe(11212)
      expect(cluster.Properties.NumCacheNodes).toBe(3)
      expect(cluster.Properties.AZMode).toBe('single-az')
    })

    it('should support security groups', () => {
      const { cluster } = Cache.createMemcached({
        slug: 'my-app',
        environment: 'production',
        securityGroupIds: ['sg-123'],
      })

      expect(cluster.Properties.VpcSecurityGroupIds).toEqual(['sg-123'])
    })

    it('should support preferred availability zones', () => {
      const { cluster } = Cache.createMemcached({
        slug: 'my-app',
        environment: 'production',
        preferredAzs: ['us-east-1a', 'us-east-1b'],
      })

      expect(cluster.Properties.PreferredAvailabilityZones).toEqual(['us-east-1a', 'us-east-1b'])
    })

    it('should support maintenance window', () => {
      const { cluster } = Cache.createMemcached({
        slug: 'my-app',
        environment: 'production',
        maintenanceWindow: 'sun:05:00-sun:07:00',
      })

      expect(cluster.Properties.PreferredMaintenanceWindow).toBe('sun:05:00-sun:07:00')
    })
  })

  describe('enableClusterMode', () => {
    it('should enable cluster mode on Redis', () => {
      const { replicationGroup } = Cache.createRedis({
        slug: 'my-app',
        environment: 'production',
      })

      Cache.enableClusterMode(replicationGroup, 3, 2)

      expect(replicationGroup.Properties.NumNodeGroups).toBe(3)
      expect(replicationGroup.Properties.ReplicasPerNodeGroup).toBe(2)
      expect(replicationGroup.Properties.NumCacheClusters).toBeUndefined()
    })
  })

  describe('createRedisParameterGroup', () => {
    it('should create Redis parameter group', () => {
      const { parameterGroup, logicalId } = Cache.createRedisParameterGroup('7.1', {
        slug: 'my-app',
        environment: 'production',
        parameters: {
          'maxmemory-policy': 'allkeys-lru',
          'timeout': '300',
        },
      })

      expect(parameterGroup.Type).toBe('AWS::ElastiCache::ParameterGroup')
      expect(parameterGroup.Properties.CacheParameterGroupFamily).toBe('redis7.x')
      expect(parameterGroup.Properties.Properties?.['maxmemory-policy']).toBe('allkeys-lru')
      expect(parameterGroup.Properties.Properties?.timeout).toBe('300')
      expect(logicalId).toBeDefined()
    })

    it('should support different Redis versions', () => {
      const { parameterGroup: v6 } = Cache.createRedisParameterGroup('6.2', {
        slug: 'my-app',
        environment: 'production',
      })

      const { parameterGroup: v7 } = Cache.createRedisParameterGroup('7.0', {
        slug: 'my-app',
        environment: 'production',
      })

      expect(v6.Properties.CacheParameterGroupFamily).toBe('redis6.x')
      expect(v7.Properties.CacheParameterGroupFamily).toBe('redis7.x')
    })
  })

  describe('createMemcachedParameterGroup', () => {
    it('should create Memcached parameter group', () => {
      const { parameterGroup, logicalId } = Cache.createMemcachedParameterGroup('1.6.22', {
        slug: 'my-app',
        environment: 'production',
        parameters: {
          'max_item_size': '10485760',
        },
      })

      expect(parameterGroup.Type).toBe('AWS::ElastiCache::ParameterGroup')
      expect(parameterGroup.Properties.CacheParameterGroupFamily).toBe('memcached1.6')
      expect(parameterGroup.Properties.Properties?.max_item_size).toBe('10485760')
      expect(logicalId).toBeDefined()
    })
  })

  describe('NodeTypes', () => {
    it('should provide common node type constants', () => {
      expect(Cache.NodeTypes.T3_Micro).toBe('cache.t3.micro')
      expect(Cache.NodeTypes.T3_Small).toBe('cache.t3.small')
      expect(Cache.NodeTypes.M5_Large).toBe('cache.m5.large')
      expect(Cache.NodeTypes.R5_XLarge).toBe('cache.r5.xlarge')
      expect(Cache.NodeTypes.R6g_Large).toBe('cache.r6g.large')
    })
  })

  describe('Integration with TemplateBuilder', () => {
    it('should create Redis cluster infrastructure', () => {
      const template = new TemplateBuilder('Redis Cluster')

      const { replicationGroup, subnetGroup, logicalId, subnetGroupId } = Cache.createRedis({
        slug: 'my-app',
        environment: 'production',
        subnetIds: ['subnet-1', 'subnet-2', 'subnet-3'],
        securityGroupIds: ['sg-123'],
        numCacheClusters: 3,
        authToken: 'MySecureToken123!',
      })

      if (subnetGroup && subnetGroupId) {
        template.addResource(subnetGroupId, subnetGroup)
      }

      template.addResource(logicalId, replicationGroup)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(2)
      expect(result.Resources[logicalId].Type).toBe('AWS::ElastiCache::ReplicationGroup')
    })

    it('should create Redis cluster mode infrastructure', () => {
      const template = new TemplateBuilder('Redis Cluster Mode')

      const { replicationGroup, logicalId } = Cache.createRedis({
        slug: 'my-app',
        environment: 'production',
        clusterMode: true,
        numNodeGroups: 3,
        replicasPerNodeGroup: 2,
        nodeType: Cache.NodeTypes.R5_Large,
      })

      template.addResource(logicalId, replicationGroup)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(1)
      expect(result.Resources[logicalId].Properties.NumNodeGroups).toBe(3)
      expect(result.Resources[logicalId].Properties.ReplicasPerNodeGroup).toBe(2)
    })

    it('should create Memcached cluster infrastructure', () => {
      const template = new TemplateBuilder('Memcached Cluster')

      const { cluster, subnetGroup, logicalId, subnetGroupId } = Cache.createMemcached({
        slug: 'my-app',
        environment: 'production',
        subnetIds: ['subnet-1', 'subnet-2'],
        numCacheNodes: 3,
        azMode: 'cross-az',
      })

      if (subnetGroup && subnetGroupId) {
        template.addResource(subnetGroupId, subnetGroup)
      }

      template.addResource(logicalId, cluster)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(2)
      expect(result.Resources[logicalId].Type).toBe('AWS::ElastiCache::CacheCluster')
    })

    it('should create Redis with parameter group', () => {
      const template = new TemplateBuilder('Redis with Params')

      const { replicationGroup, logicalId: redisId } = Cache.createRedis({
        slug: 'my-app',
        environment: 'production',
      })

      const { parameterGroup, logicalId: paramsId } = Cache.createRedisParameterGroup('7.1', {
        slug: 'my-app',
        environment: 'production',
        parameters: {
          'maxmemory-policy': 'allkeys-lru',
        },
      })

      template.addResource(paramsId, parameterGroup)
      template.addResource(redisId, replicationGroup)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(2)
      expect(result.Resources[paramsId].Type).toBe('AWS::ElastiCache::ParameterGroup')
    })

    it('should generate valid JSON template', () => {
      const template = new TemplateBuilder('Cache Test')

      const { replicationGroup, logicalId } = Cache.createRedis({
        slug: 'test',
        environment: 'development',
      })

      template.addResource(logicalId, replicationGroup)

      const json = template.toJSON()
      const parsed = JSON.parse(json)

      expect(parsed.Resources[logicalId].Type).toBe('AWS::ElastiCache::ReplicationGroup')
      expect(parsed.Resources[logicalId].Properties.Engine).toBe('redis')
    })
  })
})
