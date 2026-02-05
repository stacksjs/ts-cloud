import type { CloudFormationBuilder } from '../builder'
import { Fn } from '../types'

export interface DatabaseConfig {
  postgres?: {
    engine: 'postgres'
    version: string
    instanceClass: string
    allocatedStorage: number
    maxAllocatedStorage?: number
    multiAZ?: boolean
    backupRetentionDays?: number
    preferredBackupWindow?: string
    preferredMaintenanceWindow?: string
    enablePerformanceInsights?: boolean
    performanceInsightsRetention?: number
    deletionProtection?: boolean
    parameters?: Record<string, string>
  }
  mysql?: {
    engine: 'mysql'
    version: string
    instanceClass: string
    allocatedStorage: number
    maxAllocatedStorage?: number
    multiAZ?: boolean
    backupRetentionDays?: number
    preferredBackupWindow?: string
    preferredMaintenanceWindow?: string
    enablePerformanceInsights?: boolean
    performanceInsightsRetention?: number
    deletionProtection?: boolean
    parameters?: Record<string, string>
  }
  dynamodb?: {
    tables: DynamoDBTableConfig[]
  }
}

export interface DynamoDBTableConfig {
  name: string
  partitionKey: string
  sortKey?: string
  billingMode?: 'PROVISIONED' | 'PAY_PER_REQUEST'
  readCapacity?: number
  writeCapacity?: number
  streamEnabled?: boolean
  pointInTimeRecovery?: boolean
  ttl?: {
    enabled: boolean
    attributeName: string
  }
  globalSecondaryIndexes?: Array<{
    name: string
    partitionKey: string
    sortKey?: string
    projectionType?: 'ALL' | 'KEYS_ONLY' | 'INCLUDE'
    nonKeyAttributes?: string[]
  }>
}

/**
 * Add database resources (RDS, DynamoDB) to CloudFormation template
*/
export function addDatabaseResources(
  builder: CloudFormationBuilder,
  config: DatabaseConfig,
): void {
  if (config.postgres) {
    addRDSInstance(builder, 'postgres', config.postgres)
  }

  if (config.mysql) {
    addRDSInstance(builder, 'mysql', config.mysql)
  }

  if (config.dynamodb?.tables) {
    config.dynamodb.tables.forEach(table => {
      addDynamoDBTable(builder, table)
    })
  }
}

/**
 * Add RDS instance (PostgreSQL or MySQL)
*/
function addRDSInstance(
  builder: CloudFormationBuilder,
  engine: 'postgres' | 'mysql',
  config: DatabaseConfig['postgres'] | DatabaseConfig['mysql'],
): void {
  if (!config) return

  const engineName = engine === 'postgres' ? 'postgres' : 'mysql'
  const logicalId = builder.toLogicalId(`${engineName}-db`)

  // DB Subnet Group
  builder.addResource('DBSubnetGroup', 'AWS::RDS::DBSubnetGroup', {
    DBSubnetGroupDescription: 'Subnet group for RDS instance',
    SubnetIds: [
      Fn.ref('PrivateSubnet1'),
      Fn.ref('PrivateSubnet2'),
    ],
    Tags: [
      { Key: 'Name', Value: Fn.sub('${AWS::StackName}-db-subnet-group') },
    ],
  }, {
    dependsOn: ['PrivateSubnet1', 'PrivateSubnet2'],
  })

  // DB Security Group
  builder.addResource('DBSecurityGroup', 'AWS::EC2::SecurityGroup', {
    GroupDescription: 'Security group for RDS instance',
    VpcId: Fn.ref('VPC'),
    SecurityGroupIngress: [{
      IpProtocol: 'tcp',
      FromPort: engine === 'postgres' ? 5432 : 3306,
      ToPort: engine === 'postgres' ? 5432 : 3306,
      SourceSecurityGroupId: Fn.ref('AppSecurityGroup'),
    }],
    Tags: [
      { Key: 'Name', Value: Fn.sub('${AWS::StackName}-db-sg') },
    ],
  }, {
    dependsOn: ['VPC', 'AppSecurityGroup'],
  })

  // DB Parameter Group
  const parameterGroupFamily = engine === 'postgres'
    ? `postgres${config.version.split('.')[0]}`
    : `mysql${config.version.split('.')[0]}.${config.version.split('.')[1] || '0'}`

  if (config.parameters && Object.keys(config.parameters).length > 0) {
    builder.addResource('DBParameterGroup', 'AWS::RDS::DBParameterGroup', {
      Description: `Parameter group for ${engineName}`,
      Family: parameterGroupFamily,
      Parameters: config.parameters,
      Tags: [
        { Key: 'Name', Value: Fn.sub('${AWS::StackName}-db-params') },
      ],
    })
  }

  // Secrets Manager secret for DB credentials
  builder.addResource('DBSecret', 'AWS::SecretsManager::Secret', {
    Description: 'Database credentials',
    GenerateSecretString: {
      SecretStringTemplate: JSON.stringify({ username: 'admin' }),
      GenerateStringKey: 'password',
      PasswordLength: 32,
      ExcludeCharacters: '"@/\\',
    },
    Tags: [
      { Key: 'Name', Value: Fn.sub('${AWS::StackName}-db-secret') },
    ],
  })

  // RDS Instance
  const dbProperties: Record<string, any> = {
    Engine: engineName,
    EngineVersion: config.version,
    DBInstanceClass: config.instanceClass,
    AllocatedStorage: config.allocatedStorage.toString(),
    MaxAllocatedStorage: config.maxAllocatedStorage?.toString(),
    StorageType: 'gp3',
    StorageEncrypted: true,
    MultiAZ: config.multiAZ !== false,
    DBSubnetGroupName: Fn.ref('DBSubnetGroup'),
    VPCSecurityGroups: [Fn.ref('DBSecurityGroup')],
    MasterUsername: Fn.sub('{{resolve:secretsmanager:${DBSecret}:SecretString:username}}'),
    MasterUserPassword: Fn.sub('{{resolve:secretsmanager:${DBSecret}:SecretString:password}}'),
    BackupRetentionPeriod: config.backupRetentionDays || 7,
    PreferredBackupWindow: config.preferredBackupWindow || '03:00-04:00',
    PreferredMaintenanceWindow: config.preferredMaintenanceWindow || 'sun:04:00-sun:05:00',
    EnablePerformanceInsights: config.enablePerformanceInsights !== false,
    PerformanceInsightsRetentionPeriod: config.performanceInsightsRetention || 7,
    DeletionProtection: config.deletionProtection !== false,
    CopyTagsToSnapshot: true,
    EnableCloudwatchLogsExports: engine === 'postgres'
      ? ['postgresql']
      : ['error', 'general', 'slowquery'],
    Tags: [
      { Key: 'Name', Value: Fn.sub(`\${AWS::StackName}-${engineName}-db`) },
    ],
  }

  if (config.parameters && Object.keys(config.parameters).length > 0) {
    dbProperties.DBParameterGroupName = Fn.ref('DBParameterGroup')
  }

  builder.addResource(logicalId, 'AWS::RDS::DBInstance', dbProperties, {
    dependsOn: ['DBSubnetGroup', 'DBSecurityGroup', 'DBSecret'],
    deletionPolicy: 'Snapshot',
  })

  // Attach secret to RDS instance
  builder.addResource('DBSecretAttachment', 'AWS::SecretsManager::SecretTargetAttachment', {
    SecretId: Fn.ref('DBSecret'),
    TargetId: Fn.ref(logicalId),
    TargetType: 'AWS::RDS::DBInstance',
  }, {
    dependsOn: [logicalId, 'DBSecret'],
  })

  // Outputs
  builder.addOutputs({
    DBEndpoint: {
      Description: 'Database endpoint',
      Value: Fn.getAtt(logicalId, 'Endpoint.Address'),
      Export: {
        Name: Fn.sub('${AWS::StackName}-db-endpoint'),
      },
    },
    DBPort: {
      Description: 'Database port',
      Value: Fn.getAtt(logicalId, 'Endpoint.Port'),
      Export: {
        Name: Fn.sub('${AWS::StackName}-db-port'),
      },
    },
    DBSecretArn: {
      Description: 'ARN of the database credentials secret',
      Value: Fn.ref('DBSecret'),
      Export: {
        Name: Fn.sub('${AWS::StackName}-db-secret-arn'),
      },
    },
  })
}

/**
* Add DynamoDB table
*/
function addDynamoDBTable(
  builder: CloudFormationBuilder,
  config: DynamoDBTableConfig,
): void {
  const logicalId = builder.toLogicalId(`${config.name}-table`)

  const tableProperties: Record<string, any> = {
    TableName: Fn.sub(`\${AWS::StackName}-${config.name}`),
    BillingMode: config.billingMode || 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      {
        AttributeName: config.partitionKey,
        AttributeType: 'S',
      },
    ],
    KeySchema: [
      {
        AttributeName: config.partitionKey,
        KeyType: 'HASH',
      },
    ],
    Tags: [
      { Key: 'Name', Value: Fn.sub(`\${AWS::StackName}-${config.name}`) },
    ],
  }

  // Sort key
  if (config.sortKey) {
    tableProperties.AttributeDefinitions.push({
      AttributeName: config.sortKey,
      AttributeType: 'S',
    })
    tableProperties.KeySchema.push({
      AttributeName: config.sortKey,
      KeyType: 'RANGE',
    })
  }

  // Provisioned capacity (only for PROVISIONED billing mode)
  if (config.billingMode === 'PROVISIONED') {
    tableProperties.ProvisionedThroughput = {
      ReadCapacityUnits: config.readCapacity || 5,
      WriteCapacityUnits: config.writeCapacity || 5,
    }
  }

  // DynamoDB Streams
  if (config.streamEnabled) {
    tableProperties.StreamSpecification = {
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    }
  }

  // Point-in-time recovery
  if (config.pointInTimeRecovery) {
    tableProperties.PointInTimeRecoverySpecification = {
      PointInTimeRecoveryEnabled: true,
    }
  }

  // TTL
  if (config.ttl?.enabled) {
    tableProperties.TimeToLiveSpecification = {
      Enabled: true,
      AttributeName: config.ttl.attributeName,
    }
  }

  // Global Secondary Indexes
  if (config.globalSecondaryIndexes && config.globalSecondaryIndexes.length > 0) {
    tableProperties.GlobalSecondaryIndexes = config.globalSecondaryIndexes.map(gsi => {
      // Add GSI key attributes to AttributeDefinitions if not already present
      const existingAttributes = new Set(
        tableProperties.AttributeDefinitions.map((attr: any) => attr.AttributeName),
      )

      if (!existingAttributes.has(gsi.partitionKey)) {
        tableProperties.AttributeDefinitions.push({
          AttributeName: gsi.partitionKey,
          AttributeType: 'S',
        })
      }

      if (gsi.sortKey && !existingAttributes.has(gsi.sortKey)) {
        tableProperties.AttributeDefinitions.push({
          AttributeName: gsi.sortKey,
          AttributeType: 'S',
        })
      }

      const gsiDef: any = {
        IndexName: gsi.name,
        KeySchema: [
          {
            AttributeName: gsi.partitionKey,
            KeyType: 'HASH',
          },
        ],
        Projection: {
          ProjectionType: gsi.projectionType || 'ALL',
        },
      }

      if (gsi.sortKey) {
        gsiDef.KeySchema.push({
          AttributeName: gsi.sortKey,
          KeyType: 'RANGE',
        })
      }

      if (gsi.projectionType === 'INCLUDE' && gsi.nonKeyAttributes) {
        gsiDef.Projection.NonKeyAttributes = gsi.nonKeyAttributes
      }

      if (config.billingMode === 'PROVISIONED') {
        gsiDef.ProvisionedThroughput = {
          ReadCapacityUnits: config.readCapacity || 5,
          WriteCapacityUnits: config.writeCapacity || 5,
        }
      }

      return gsiDef
    })
  }

  builder.addResource(logicalId, 'AWS::DynamoDB::Table', tableProperties, {
    deletionPolicy: 'Retain',
  })

  // Output
  builder.addOutputs({
    [`${logicalId}Name`]: {
      Description: `${config.name} table name`,
      Value: Fn.ref(logicalId),
      Export: {
        Name: Fn.sub(`\${AWS::StackName}-${config.name}-table`),
      },
    },
    [`${logicalId}Arn`]: {
      Description: `${config.name} table ARN`,
      Value: Fn.getAtt(logicalId, 'Arn'),
      Export: {
        Name: Fn.sub(`\${AWS::StackName}-${config.name}-table-arn`),
      },
    },
  })

  if (config.streamEnabled) {
    builder.addOutputs({
      [`${logicalId}StreamArn`]: {
        Description: `${config.name} stream ARN`,
        Value: Fn.getAtt(logicalId, 'StreamArn'),
        Export: {
          Name: Fn.sub(`\${AWS::StackName}-${config.name}-stream-arn`),
        },
      },
    })
  }
}
