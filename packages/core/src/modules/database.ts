import type {
  DynamoDBTable,
  RDSDBInstance,
  RDSDBParameterGroup,
  RDSDBSubnetGroup,
} from '@stacksjs/ts-cloud-aws-types'
import type { EnvironmentType } from '@stacksjs/ts-cloud-types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface RDSOptions {
  slug: string
  environment: EnvironmentType
  dbInstanceIdentifier?: string
  dbInstanceClass?: string
  instanceClass?: string // Alias for dbInstanceClass
  allocatedStorage?: number
  storageType?: 'gp2' | 'gp3' | 'io1' | 'io2'
  masterUsername?: string
  masterUserPassword?: string
  masterPassword?: string // Alias for masterUserPassword
  databaseName?: string
  subnetIds?: string[]
  securityGroupIds?: string[]
  encrypted?: boolean
  kmsKeyId?: string
  multiAz?: boolean
  backupRetentionDays?: number
  publiclyAccessible?: boolean
  enableCloudwatchLogs?: boolean
  deletionProtection?: boolean
}

export interface DynamoDBTableOptions {
  slug: string
  environment: EnvironmentType
  tableName?: string
  partitionKey: {
    name: string
    type: 'S' | 'N' | 'B'
  }
  sortKey?: {
    name: string
    type: 'S' | 'N' | 'B'
  }
  billingMode?: 'PROVISIONED' | 'PAY_PER_REQUEST'
  readCapacity?: number
  writeCapacity?: number
  streamEnabled?: boolean
  streamViewType?: 'NEW_IMAGE' | 'OLD_IMAGE' | 'NEW_AND_OLD_IMAGES' | 'KEYS_ONLY'
  encrypted?: boolean
  kmsKeyId?: string
  pointInTimeRecovery?: boolean
  ttlAttribute?: string
}

export interface GlobalSecondaryIndexOptions {
  indexName: string
  partitionKey: {
    name: string
    type: 'S' | 'N' | 'B'
  }
  sortKey?: {
    name: string
    type: 'S' | 'N' | 'B'
  }
  projectionType?: 'ALL' | 'KEYS_ONLY' | 'INCLUDE'
  nonKeyAttributes?: string[]
  readCapacity?: number
  writeCapacity?: number
}

/**
 * Database Module - RDS + DynamoDB
 * Provides clean API for relational (RDS) and NoSQL (DynamoDB) databases
 */
export class Database {
  /**
   * Create a PostgreSQL RDS instance
   */
  static createPostgres(options: RDSOptions): {
    dbInstance: RDSDBInstance
    subnetGroup?: RDSDBSubnetGroup
    logicalId: string
    subnetGroupId?: string
  } {
    return Database.createRDSInstance('postgres', '16.2', options)
  }

  /**
   * Create a MySQL RDS instance
   */
  static createMysql(options: RDSOptions): {
    dbInstance: RDSDBInstance
    subnetGroup?: RDSDBSubnetGroup
    logicalId: string
    subnetGroupId?: string
  } {
    return Database.createRDSInstance('mysql', '8.0.35', options)
  }

  /**
   * Create an RDS instance (internal helper)
   */
  private static createRDSInstance(
    engine: 'postgres' | 'mysql',
    engineVersion: string,
    options: RDSOptions,
  ): {
      dbInstance: RDSDBInstance
      subnetGroup?: RDSDBSubnetGroup
      logicalId: string
      subnetGroupId?: string
    } {
    const {
      slug,
      environment,
      instanceClass = 'db.t3.micro',
      allocatedStorage = 20,
      storageType = 'gp3',
      masterUsername = 'admin',
      masterPassword,
      databaseName,
      subnetIds,
      securityGroupIds,
      encrypted = true,
      kmsKeyId,
      multiAz = false,
      backupRetentionDays = 7,
      publiclyAccessible = false,
      enableCloudwatchLogs = true,
      deletionProtection = true,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: `${engine}-db`,
    })

    const logicalId = generateLogicalId(resourceName)

    // Create subnet group if subnets provided
    let subnetGroup: RDSDBSubnetGroup | undefined
    let subnetGroupId: string | undefined

    if (subnetIds && subnetIds.length > 0) {
      const subnetGroupName = generateResourceName({
        slug,
        environment,
        resourceType: 'db-subnet-group',
      })

      subnetGroupId = generateLogicalId(subnetGroupName)

      subnetGroup = {
        Type: 'AWS::RDS::DBSubnetGroup',
        Properties: {
          DBSubnetGroupName: subnetGroupName,
          DBSubnetGroupDescription: `Subnet group for ${resourceName}`,
          SubnetIds: subnetIds,
          Tags: [
            { Key: 'Name', Value: subnetGroupName },
            { Key: 'Environment', Value: environment },
          ],
        },
      }
    }

    const dbInstance: RDSDBInstance = {
      Type: 'AWS::RDS::DBInstance',
      Properties: {
        DBInstanceIdentifier: resourceName,
        DBInstanceClass: instanceClass,
        Engine: engine,
        EngineVersion: engineVersion,
        MasterUsername: masterUsername,
        MasterUserPassword: masterPassword,
        AllocatedStorage: allocatedStorage,
        StorageType: storageType,
        StorageEncrypted: encrypted,
        MultiAZ: multiAz,
        BackupRetentionPeriod: backupRetentionDays,
        PubliclyAccessible: publiclyAccessible,
        DeletionProtection: deletionProtection,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    if (databaseName) {
      dbInstance.Properties.DBName = databaseName
    }

    if (kmsKeyId) {
      dbInstance.Properties.KmsKeyId = kmsKeyId
    }

    if (subnetGroupId) {
      dbInstance.Properties.DBSubnetGroupName = Fn.Ref(subnetGroupId) as unknown as string
    }

    if (securityGroupIds && securityGroupIds.length > 0) {
      dbInstance.Properties.VPCSecurityGroups = securityGroupIds
    }

    if (enableCloudwatchLogs) {
      dbInstance.Properties.EnableCloudwatchLogsExports = engine === 'postgres'
        ? ['postgresql']
        : ['error', 'general', 'slowquery']
    }

    return {
      dbInstance,
      subnetGroup,
      logicalId,
      subnetGroupId,
    }
  }

  /**
   * Create a read replica
   */
  static createReadReplica(
    sourceDbLogicalId: string,
    options: Omit<RDSOptions, 'masterUsername' | 'masterPassword' | 'databaseName'>,
  ): {
      replica: RDSDBInstance
      logicalId: string
    } {
    const {
      slug,
      environment,
      instanceClass = 'db.t3.micro',
      securityGroupIds,
      publiclyAccessible = false,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'db-replica',
    })

    const logicalId = generateLogicalId(resourceName)

    const replica: RDSDBInstance = {
      Type: 'AWS::RDS::DBInstance',
      Properties: {
        DBInstanceIdentifier: resourceName,
        DBInstanceClass: instanceClass,
        SourceDBInstanceIdentifier: Fn.Ref(sourceDbLogicalId) as unknown as string,
        PubliclyAccessible: publiclyAccessible,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
          { Key: 'Type', Value: 'ReadReplica' },
        ],
      },
    }

    if (securityGroupIds && securityGroupIds.length > 0) {
      replica.Properties.VPCSecurityGroups = securityGroupIds
    }

    return { replica, logicalId }
  }

  /**
   * Create a DB parameter group
   */
  static createParameterGroup(
    engine: 'postgres' | 'mysql',
    version: string,
    options: {
      slug: string
      environment: EnvironmentType
      parameters?: Record<string, string>
    },
  ): {
      parameterGroup: RDSDBParameterGroup
      logicalId: string
    } {
    const { slug, environment, parameters = {} } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'db-params',
    })

    const logicalId = generateLogicalId(resourceName)

    // Determine parameter group family
    const family = engine === 'postgres'
      ? `postgres${version.split('.')[0]}`
      : `mysql${version.split('.')[0]}.${version.split('.')[1]}`

    const parameterGroup: RDSDBParameterGroup = {
      Type: 'AWS::RDS::DBParameterGroup',
      Properties: {
        DBParameterGroupName: resourceName,
        Description: `Parameter group for ${resourceName}`,
        Family: family,
        Parameters: parameters,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    return { parameterGroup, logicalId }
  }

  /**
   * Enable backup for RDS instance
   */
  static enableBackup(
    dbInstance: RDSDBInstance,
    retentionDays: number = 7,
  ): RDSDBInstance {
    dbInstance.Properties.BackupRetentionPeriod = retentionDays
    return dbInstance
  }

  /**
   * Create a DynamoDB table
   */
  static createTable(options: DynamoDBTableOptions): {
    table: DynamoDBTable
    logicalId: string
  } {
    const {
      slug,
      environment,
      tableName,
      partitionKey,
      sortKey,
      billingMode = 'PAY_PER_REQUEST',
      readCapacity = 5,
      writeCapacity = 5,
      streamEnabled = false,
      streamViewType = 'NEW_AND_OLD_IMAGES',
      encrypted = true,
      kmsKeyId,
      pointInTimeRecovery = true,
      ttlAttribute,
    } = options

    const resourceName = tableName || generateResourceName({
      slug,
      environment,
      resourceType: 'table',
    })

    const logicalId = generateLogicalId(resourceName)

    // Build attribute definitions
    const attributeDefinitions: DynamoDBTable['Properties']['AttributeDefinitions'] = [
      {
        AttributeName: partitionKey.name,
        AttributeType: partitionKey.type,
      },
    ]

    if (sortKey) {
      attributeDefinitions.push({
        AttributeName: sortKey.name,
        AttributeType: sortKey.type,
      })
    }

    // Build key schema
    const keySchema: DynamoDBTable['Properties']['KeySchema'] = [
      {
        AttributeName: partitionKey.name,
        KeyType: 'HASH',
      },
    ]

    if (sortKey) {
      keySchema.push({
        AttributeName: sortKey.name,
        KeyType: 'RANGE',
      })
    }

    const table: DynamoDBTable = {
      Type: 'AWS::DynamoDB::Table',
      Properties: {
        TableName: resourceName,
        BillingMode: billingMode,
        AttributeDefinitions: attributeDefinitions,
        KeySchema: keySchema,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    if (billingMode === 'PROVISIONED') {
      table.Properties.ProvisionedThroughput = {
        ReadCapacityUnits: readCapacity,
        WriteCapacityUnits: writeCapacity,
      }
    }

    if (streamEnabled) {
      table.Properties.StreamSpecification = {
        StreamViewType: streamViewType,
      }
    }

    if (encrypted) {
      table.Properties.SSESpecification = {
        SSEEnabled: true,
        SSEType: kmsKeyId ? 'KMS' : 'AES256',
        KMSMasterKeyId: kmsKeyId,
      }
    }

    if (pointInTimeRecovery) {
      table.Properties.PointInTimeRecoverySpecification = {
        PointInTimeRecoveryEnabled: true,
      }
    }

    if (ttlAttribute) {
      table.Properties.TimeToLiveSpecification = {
        AttributeName: ttlAttribute,
        Enabled: true,
      }
    }

    return { table, logicalId }
  }

  /**
   * Add a global secondary index to a DynamoDB table
   */
  static addGlobalSecondaryIndex(
    table: DynamoDBTable,
    index: GlobalSecondaryIndexOptions,
  ): DynamoDBTable {
    const {
      indexName,
      partitionKey,
      sortKey,
      projectionType = 'ALL',
      nonKeyAttributes,
      readCapacity = 5,
      writeCapacity = 5,
    } = index

    // Add attribute definitions if not already present
    if (!table.Properties.AttributeDefinitions.some(attr => attr.AttributeName === partitionKey.name)) {
      table.Properties.AttributeDefinitions.push({
        AttributeName: partitionKey.name,
        AttributeType: partitionKey.type,
      })
    }

    if (sortKey && !table.Properties.AttributeDefinitions.some(attr => attr.AttributeName === sortKey.name)) {
      table.Properties.AttributeDefinitions.push({
        AttributeName: sortKey.name,
        AttributeType: sortKey.type,
      })
    }

    // Build GSI key schema
    const gsiKeySchema: { AttributeName: string, KeyType: 'HASH' | 'RANGE' }[] = [
      {
        AttributeName: partitionKey.name,
        KeyType: 'HASH',
      },
    ]

    if (sortKey) {
      gsiKeySchema.push({
        AttributeName: sortKey.name,
        KeyType: 'RANGE',
      })
    }

    // Build GSI
    const gsi = {
      IndexName: indexName,
      KeySchema: gsiKeySchema,
      Projection: {
        ProjectionType: projectionType as 'ALL' | 'KEYS_ONLY' | 'INCLUDE',
        NonKeyAttributes: projectionType === 'INCLUDE' ? nonKeyAttributes : undefined,
      },
      ProvisionedThroughput: undefined as { ReadCapacityUnits: number, WriteCapacityUnits: number } | undefined,
    }

    if (table.Properties.BillingMode === 'PROVISIONED') {
      gsi.ProvisionedThroughput = {
        ReadCapacityUnits: readCapacity,
        WriteCapacityUnits: writeCapacity,
      }
    }

    if (!table.Properties.GlobalSecondaryIndexes) {
      table.Properties.GlobalSecondaryIndexes = []
    }

    table.Properties.GlobalSecondaryIndexes.push(gsi)

    return table
  }

  /**
   * Enable streams on a DynamoDB table
   */
  static enableStreams(
    table: DynamoDBTable,
    viewType: 'NEW_IMAGE' | 'OLD_IMAGE' | 'NEW_AND_OLD_IMAGES' | 'KEYS_ONLY' = 'NEW_AND_OLD_IMAGES',
  ): DynamoDBTable {
    table.Properties.StreamSpecification = {
      StreamViewType: viewType,
    }
    return table
  }

  /**
   * Common RDS instance classes
   */
  static readonly InstanceClasses = {
    // T3 - Burstable performance
    T3_Micro: 'db.t3.micro',
    T3_Small: 'db.t3.small',
    T3_Medium: 'db.t3.medium',
    T3_Large: 'db.t3.large',

    // T4g - Arm-based burstable
    T4g_Micro: 'db.t4g.micro',
    T4g_Small: 'db.t4g.small',
    T4g_Medium: 'db.t4g.medium',

    // M5 - General purpose
    M5_Large: 'db.m5.large',
    M5_XLarge: 'db.m5.xlarge',
    M5_2XLarge: 'db.m5.2xlarge',

    // R5 - Memory optimized
    R5_Large: 'db.r5.large',
    R5_XLarge: 'db.r5.xlarge',
    R5_2XLarge: 'db.r5.2xlarge',
  } as const
}
