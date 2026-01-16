import type { CloudFormationBuilder } from '../builder'
import { Fn } from '../types'

export interface CacheConfig {
  redis?: {
    nodeType: string
    numCacheNodes: number
    engine: 'redis'
    engineVersion: string
    port?: number
    parameterGroup?: {
      maxmemoryPolicy?: string
      timeout?: string
      [key: string]: string | undefined
    }
    snapshotRetentionLimit?: number
    snapshotWindow?: string
    automaticFailoverEnabled?: boolean
  }
  memcached?: {
    nodeType: string
    numCacheNodes: number
    engine: 'memcached'
    engineVersion: string
    port?: number
  }
  elasticache?: {
    nodeType: string
    numCacheNodes: number
    engine: string
    engineVersion: string
  }
}

/**
 * Add ElastiCache resources to CloudFormation template
 */
export function addCacheResources(
  builder: CloudFormationBuilder,
  config: CacheConfig,
): void {
  if (config.redis) {
    addRedisCluster(builder, config.redis)
  }

  if (config.memcached) {
    addMemcachedCluster(builder, config.memcached)
  }

  if (config.elasticache) {
    addElastiCacheCluster(builder, config.elasticache)
  }
}

/**
 * Add Redis cluster
 */
function addRedisCluster(
  builder: CloudFormationBuilder,
  config: CacheConfig['redis'],
): void {
  if (!config) return

  // Cache Subnet Group
  builder.addResource('CacheSubnetGroup', 'AWS::ElastiCache::SubnetGroup', {
    Description: 'Subnet group for ElastiCache Redis cluster',
    SubnetIds: [
      Fn.ref('PrivateSubnet1'),
      Fn.ref('PrivateSubnet2'),
    ],
    Tags: [
      { Key: 'Name', Value: Fn.sub('${AWS::StackName}-cache-subnet-group') },
    ],
  }, {
    dependsOn: ['PrivateSubnet1', 'PrivateSubnet2'],
  })

  // Cache Security Group
  builder.addResource('CacheSecurityGroup', 'AWS::EC2::SecurityGroup', {
    GroupDescription: 'Security group for ElastiCache Redis',
    VpcId: Fn.ref('VPC'),
    SecurityGroupIngress: [{
      IpProtocol: 'tcp',
      FromPort: config.port || 6379,
      ToPort: config.port || 6379,
      SourceSecurityGroupId: Fn.ref('AppSecurityGroup'),
    }],
    Tags: [
      { Key: 'Name', Value: Fn.sub('${AWS::StackName}-cache-sg') },
    ],
  }, {
    dependsOn: ['VPC', 'AppSecurityGroup'],
  })

  // Parameter Group
  if (config.parameterGroup && Object.keys(config.parameterGroup).length > 0) {
    builder.addResource('CacheParameterGroup', 'AWS::ElastiCache::ParameterGroup', {
      Description: 'Parameter group for Redis',
      CacheParameterGroupFamily: `redis${config.engineVersion.split('.')[0]}`,
      Properties: config.parameterGroup,
    })
  }

  // Replication Group (Redis cluster with replication)
  if (config.numCacheNodes > 1 || config.automaticFailoverEnabled) {
    builder.addResource('RedisReplicationGroup', 'AWS::ElastiCache::ReplicationGroup', {
      ReplicationGroupDescription: 'Redis replication group',
      ReplicationGroupId: Fn.sub('${AWS::StackName}-redis'),
      Engine: 'redis',
      EngineVersion: config.engineVersion,
      CacheNodeType: config.nodeType,
      NumCacheClusters: config.numCacheNodes,
      AutomaticFailoverEnabled: config.automaticFailoverEnabled || false,
      MultiAZEnabled: config.automaticFailoverEnabled || false,
      Port: config.port || 6379,
      CacheSubnetGroupName: Fn.ref('CacheSubnetGroup'),
      SecurityGroupIds: [Fn.ref('CacheSecurityGroup')],
      CacheParameterGroupName: config.parameterGroup
        ? Fn.ref('CacheParameterGroup')
        : undefined,
      SnapshotRetentionLimit: config.snapshotRetentionLimit || 5,
      SnapshotWindow: config.snapshotWindow || '03:00-05:00',
      PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
      AtRestEncryptionEnabled: true,
      TransitEncryptionEnabled: true,
      Tags: [
        { Key: 'Name', Value: Fn.sub('${AWS::StackName}-redis') },
      ],
    }, {
      dependsOn: config.parameterGroup
        ? ['CacheSubnetGroup', 'CacheSecurityGroup', 'CacheParameterGroup']
        : ['CacheSubnetGroup', 'CacheSecurityGroup'],
    })

    // Output
    builder.addOutputs({
      RedisEndpoint: {
        Description: 'Redis primary endpoint',
        Value: Fn.getAtt('RedisReplicationGroup', 'PrimaryEndPoint.Address'),
        Export: {
          Name: Fn.sub('${AWS::StackName}-redis-endpoint'),
        },
      },
      RedisPort: {
        Description: 'Redis port',
        Value: Fn.getAtt('RedisReplicationGroup', 'PrimaryEndPoint.Port'),
        Export: {
          Name: Fn.sub('${AWS::StackName}-redis-port'),
        },
      },
    })
  }
  else {
    // Single node Redis cluster
    builder.addResource('RedisCacheCluster', 'AWS::ElastiCache::CacheCluster', {
      ClusterName: Fn.sub('${AWS::StackName}-redis'),
      Engine: 'redis',
      EngineVersion: config.engineVersion,
      CacheNodeType: config.nodeType,
      NumCacheNodes: 1,
      Port: config.port || 6379,
      CacheSubnetGroupName: Fn.ref('CacheSubnetGroup'),
      VpcSecurityGroupIds: [Fn.ref('CacheSecurityGroup')],
      CacheParameterGroupName: config.parameterGroup
        ? Fn.ref('CacheParameterGroup')
        : undefined,
      SnapshotRetentionLimit: config.snapshotRetentionLimit || 5,
      SnapshotWindow: config.snapshotWindow || '03:00-05:00',
      PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
      Tags: [
        { Key: 'Name', Value: Fn.sub('${AWS::StackName}-redis') },
      ],
    }, {
      dependsOn: config.parameterGroup
        ? ['CacheSubnetGroup', 'CacheSecurityGroup', 'CacheParameterGroup']
        : ['CacheSubnetGroup', 'CacheSecurityGroup'],
    })

    // Output
    builder.addOutputs({
      RedisEndpoint: {
        Description: 'Redis endpoint',
        Value: Fn.getAtt('RedisCacheCluster', 'RedisEndpoint.Address'),
        Export: {
          Name: Fn.sub('${AWS::StackName}-redis-endpoint'),
        },
      },
      RedisPort: {
        Description: 'Redis port',
        Value: Fn.getAtt('RedisCacheCluster', 'RedisEndpoint.Port'),
        Export: {
          Name: Fn.sub('${AWS::StackName}-redis-port'),
        },
      },
    })
  }
}

/**
 * Add Memcached cluster
 */
function addMemcachedCluster(
  builder: CloudFormationBuilder,
  config: CacheConfig['memcached'],
): void {
  if (!config) return

  // Cache Subnet Group
  if (!builder.hasResource('CacheSubnetGroup')) {
    builder.addResource('CacheSubnetGroup', 'AWS::ElastiCache::SubnetGroup', {
      Description: 'Subnet group for ElastiCache',
      SubnetIds: [
        Fn.ref('PrivateSubnet1'),
        Fn.ref('PrivateSubnet2'),
      ],
    }, {
      dependsOn: ['PrivateSubnet1', 'PrivateSubnet2'],
    })
  }

  // Cache Security Group
  if (!builder.hasResource('CacheSecurityGroup')) {
    builder.addResource('CacheSecurityGroup', 'AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for ElastiCache Memcached',
      VpcId: Fn.ref('VPC'),
      SecurityGroupIngress: [{
        IpProtocol: 'tcp',
        FromPort: config.port || 11211,
        ToPort: config.port || 11211,
        SourceSecurityGroupId: Fn.ref('AppSecurityGroup'),
      }],
      Tags: [
        { Key: 'Name', Value: Fn.sub('${AWS::StackName}-cache-sg') },
      ],
    }, {
      dependsOn: ['VPC', 'AppSecurityGroup'],
    })
  }

  // Memcached Cluster
  builder.addResource('MemcachedCacheCluster', 'AWS::ElastiCache::CacheCluster', {
    ClusterName: Fn.sub('${AWS::StackName}-memcached'),
    Engine: 'memcached',
    EngineVersion: config.engineVersion,
    CacheNodeType: config.nodeType,
    NumCacheNodes: config.numCacheNodes,
    Port: config.port || 11211,
    CacheSubnetGroupName: Fn.ref('CacheSubnetGroup'),
    VpcSecurityGroupIds: [Fn.ref('CacheSecurityGroup')],
    PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
    Tags: [
      { Key: 'Name', Value: Fn.sub('${AWS::StackName}-memcached') },
    ],
  }, {
    dependsOn: ['CacheSubnetGroup', 'CacheSecurityGroup'],
  })

  // Output
  builder.addOutputs({
    MemcachedEndpoint: {
      Description: 'Memcached configuration endpoint',
      Value: Fn.getAtt('MemcachedCacheCluster', 'ConfigurationEndpoint.Address'),
      Export: {
        Name: Fn.sub('${AWS::StackName}-memcached-endpoint'),
      },
    },
    MemcachedPort: {
      Description: 'Memcached port',
      Value: Fn.getAtt('MemcachedCacheCluster', 'ConfigurationEndpoint.Port'),
      Export: {
        Name: Fn.sub('${AWS::StackName}-memcached-port'),
      },
    },
  })
}

/**
 * Add generic ElastiCache cluster
 */
function addElastiCacheCluster(
  builder: CloudFormationBuilder,
  config: CacheConfig['elasticache'],
): void {
  if (!config) return

  const isRedis = config.engine === 'redis'

  // Reuse subnet and security groups from Redis/Memcached functions
  if (!builder.hasResource('CacheSubnetGroup')) {
    builder.addResource('CacheSubnetGroup', 'AWS::ElastiCache::SubnetGroup', {
      Description: 'Subnet group for ElastiCache',
      SubnetIds: [
        Fn.ref('PrivateSubnet1'),
        Fn.ref('PrivateSubnet2'),
      ],
    }, {
      dependsOn: ['PrivateSubnet1', 'PrivateSubnet2'],
    })
  }

  if (!builder.hasResource('CacheSecurityGroup')) {
    builder.addResource('CacheSecurityGroup', 'AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for ElastiCache',
      VpcId: Fn.ref('VPC'),
      SecurityGroupIngress: [{
        IpProtocol: 'tcp',
        FromPort: isRedis ? 6379 : 11211,
        ToPort: isRedis ? 6379 : 11211,
        SourceSecurityGroupId: Fn.ref('AppSecurityGroup'),
      }],
      Tags: [
        { Key: 'Name', Value: Fn.sub('${AWS::StackName}-cache-sg') },
      ],
    }, {
      dependsOn: ['VPC', 'AppSecurityGroup'],
    })
  }

  // ElastiCache Cluster
  builder.addResource('CacheCluster', 'AWS::ElastiCache::CacheCluster', {
    ClusterName: Fn.sub(`\${AWS::StackName}-${config.engine}`),
    Engine: config.engine,
    EngineVersion: config.engineVersion,
    CacheNodeType: config.nodeType,
    NumCacheNodes: config.numCacheNodes,
    CacheSubnetGroupName: Fn.ref('CacheSubnetGroup'),
    VpcSecurityGroupIds: [Fn.ref('CacheSecurityGroup')],
    Tags: [
      { Key: 'Name', Value: Fn.sub(`\${AWS::StackName}-${config.engine}`) },
    ],
  }, {
    dependsOn: ['CacheSubnetGroup', 'CacheSecurityGroup'],
  })
}
