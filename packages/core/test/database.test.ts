import { describe, expect, it } from 'bun:test'
import { Database } from '../src/modules/database'
import { TemplateBuilder } from '../src/template-builder'

describe('Database Module', () => {
  describe('createPostgres', () => {
    it('should create PostgreSQL RDS instance with default settings', () => {
      const { dbInstance, logicalId } = Database.createPostgres({
        slug: 'my-app',
        environment: 'production',
        masterPassword: 'SecurePassword123!',
      })

      expect(dbInstance.Type).toBe('AWS::RDS::DBInstance')
      expect(dbInstance.Properties.Engine).toBe('postgres')
      expect(dbInstance.Properties.EngineVersion).toBe('16.2')
      expect(dbInstance.Properties.DBInstanceClass).toBe('db.t3.micro')
      expect(dbInstance.Properties.AllocatedStorage).toBe(20)
      expect(dbInstance.Properties.StorageType).toBe('gp3')
      expect(dbInstance.Properties.StorageEncrypted).toBe(true)
      expect(dbInstance.Properties.MultiAZ).toBe(false)
      expect(dbInstance.Properties.BackupRetentionPeriod).toBe(7)
      expect(dbInstance.Properties.PubliclyAccessible).toBe(false)
      expect(dbInstance.Properties.DeletionProtection).toBe(true)
      expect(dbInstance.Properties.MasterUsername).toBe('admin')
      expect(dbInstance.Properties.MasterUserPassword).toBe('SecurePassword123!')
      expect(logicalId).toBeDefined()
    })

    it('should create PostgreSQL with subnet group', () => {
      const { dbInstance, subnetGroup, subnetGroupId } = Database.createPostgres({
        slug: 'my-app',
        environment: 'production',
        masterPassword: 'SecurePassword123!',
        subnetIds: ['subnet-1', 'subnet-2', 'subnet-3'],
      })

      expect(subnetGroup).toBeDefined()
      expect(subnetGroup?.Type).toBe('AWS::RDS::DBSubnetGroup')
      expect(subnetGroup?.Properties.SubnetIds).toEqual(['subnet-1', 'subnet-2', 'subnet-3'])
      expect(subnetGroupId).toBeDefined()
    })

    it('should support custom configuration', () => {
      const { dbInstance } = Database.createPostgres({
        slug: 'my-app',
        environment: 'production',
        masterPassword: 'SecurePassword123!',
        instanceClass: 'db.m5.large',
        allocatedStorage: 100,
        storageType: 'io1',
        multiAz: true,
        backupRetentionDays: 30,
        databaseName: 'mydb',
        deletionProtection: false,
      })

      expect(dbInstance.Properties.DBInstanceClass).toBe('db.m5.large')
      expect(dbInstance.Properties.AllocatedStorage).toBe(100)
      expect(dbInstance.Properties.StorageType).toBe('io1')
      expect(dbInstance.Properties.MultiAZ).toBe(true)
      expect(dbInstance.Properties.BackupRetentionPeriod).toBe(30)
      expect(dbInstance.Properties.DBName).toBe('mydb')
      expect(dbInstance.Properties.DeletionProtection).toBe(false)
    })

    it('should support KMS encryption', () => {
      const { dbInstance } = Database.createPostgres({
        slug: 'my-app',
        environment: 'production',
        masterPassword: 'SecurePassword123!',
        encrypted: true,
        kmsKeyId: 'arn:aws:kms:us-east-1:123456789:key/abc',
      })

      expect(dbInstance.Properties.KmsKeyId).toBe('arn:aws:kms:us-east-1:123456789:key/abc')
    })

    it('should enable CloudWatch logs by default', () => {
      const { dbInstance } = Database.createPostgres({
        slug: 'my-app',
        environment: 'production',
        masterPassword: 'SecurePassword123!',
      })

      expect(dbInstance.Properties.EnableCloudwatchLogsExports).toEqual(['postgresql'])
    })

    it('should support security groups', () => {
      const { dbInstance } = Database.createPostgres({
        slug: 'my-app',
        environment: 'production',
        masterPassword: 'SecurePassword123!',
        securityGroupIds: ['sg-123', 'sg-456'],
      })

      expect(dbInstance.Properties.VPCSecurityGroups).toEqual(['sg-123', 'sg-456'])
    })
  })

  describe('createMysql', () => {
    it('should create MySQL RDS instance with default settings', () => {
      const { dbInstance } = Database.createMysql({
        slug: 'my-app',
        environment: 'production',
        masterPassword: 'SecurePassword123!',
      })

      expect(dbInstance.Type).toBe('AWS::RDS::DBInstance')
      expect(dbInstance.Properties.Engine).toBe('mysql')
      expect(dbInstance.Properties.EngineVersion).toBe('8.0.35')
      expect(dbInstance.Properties.DBInstanceClass).toBe('db.t3.micro')
    })

    it('should enable MySQL-specific CloudWatch logs', () => {
      const { dbInstance } = Database.createMysql({
        slug: 'my-app',
        environment: 'production',
        masterPassword: 'SecurePassword123!',
      })

      expect(dbInstance.Properties.EnableCloudwatchLogsExports).toEqual(['error', 'general', 'slowquery'])
    })
  })

  describe('createReadReplica', () => {
    it('should create read replica', () => {
      const { replica, logicalId } = Database.createReadReplica('primary-db-id', {
        slug: 'my-app',
        environment: 'production',
      })

      expect(replica.Type).toBe('AWS::RDS::DBInstance')
      expect(replica.Properties.DBInstanceClass).toBe('db.t3.micro')
      expect(replica.Properties.PubliclyAccessible).toBe(false)
      expect(logicalId).toBeDefined()
    })

    it('should support custom instance class', () => {
      const { replica } = Database.createReadReplica('primary-db-id', {
        slug: 'my-app',
        environment: 'production',
        instanceClass: 'db.r5.large',
      })

      expect(replica.Properties.DBInstanceClass).toBe('db.r5.large')
    })
  })

  describe('createParameterGroup', () => {
    it('should create PostgreSQL parameter group', () => {
      const { parameterGroup, logicalId } = Database.createParameterGroup('postgres', '16.2', {
        slug: 'my-app',
        environment: 'production',
        parameters: {
          'shared_buffers': '256MB',
          'max_connections': '200',
        },
      })

      expect(parameterGroup.Type).toBe('AWS::RDS::DBParameterGroup')
      expect(parameterGroup.Properties.Family).toBe('postgres16')
      expect(parameterGroup.Properties.Parameters?.shared_buffers).toBe('256MB')
      expect(parameterGroup.Properties.Parameters?.max_connections).toBe('200')
      expect(logicalId).toBeDefined()
    })

    it('should create MySQL parameter group', () => {
      const { parameterGroup } = Database.createParameterGroup('mysql', '8.0.35', {
        slug: 'my-app',
        environment: 'production',
      })

      expect(parameterGroup.Properties.Family).toBe('mysql8.0')
    })
  })

  describe('enableBackup', () => {
    it('should enable backup with custom retention', () => {
      const { dbInstance } = Database.createPostgres({
        slug: 'my-app',
        environment: 'production',
        masterPassword: 'SecurePassword123!',
        backupRetentionDays: 0,
      })

      Database.enableBackup(dbInstance, 14)

      expect(dbInstance.Properties.BackupRetentionPeriod).toBe(14)
    })
  })

  describe('createTable', () => {
    it('should create DynamoDB table with default settings', () => {
      const { table, logicalId } = Database.createTable({
        slug: 'my-app',
        environment: 'production',
        partitionKey: {
          name: 'id',
          type: 'S',
        },
      })

      expect(table.Type).toBe('AWS::DynamoDB::Table')
      expect(table.Properties.BillingMode).toBe('PAY_PER_REQUEST')
      expect(table.Properties.AttributeDefinitions).toHaveLength(1)
      expect(table.Properties.AttributeDefinitions[0].AttributeName).toBe('id')
      expect(table.Properties.AttributeDefinitions[0].AttributeType).toBe('S')
      expect(table.Properties.KeySchema).toHaveLength(1)
      expect(table.Properties.KeySchema[0].AttributeName).toBe('id')
      expect(table.Properties.KeySchema[0].KeyType).toBe('HASH')
      expect(table.Properties.SSESpecification?.SSEEnabled).toBe(true)
      expect(table.Properties.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled).toBe(true)
      expect(logicalId).toBeDefined()
    })

    it('should create table with partition and sort keys', () => {
      const { table } = Database.createTable({
        slug: 'my-app',
        environment: 'production',
        partitionKey: {
          name: 'userId',
          type: 'S',
        },
        sortKey: {
          name: 'timestamp',
          type: 'N',
        },
      })

      expect(table.Properties.AttributeDefinitions).toHaveLength(2)
      expect(table.Properties.KeySchema).toHaveLength(2)
      expect(table.Properties.KeySchema[1].AttributeName).toBe('timestamp')
      expect(table.Properties.KeySchema[1].KeyType).toBe('RANGE')
    })

    it('should support custom table name', () => {
      const { table } = Database.createTable({
        slug: 'my-app',
        environment: 'production',
        tableName: 'custom-table',
        partitionKey: {
          name: 'id',
          type: 'S',
        },
      })

      expect(table.Properties.TableName).toBe('custom-table')
    })

    it('should support provisioned billing mode', () => {
      const { table } = Database.createTable({
        slug: 'my-app',
        environment: 'production',
        partitionKey: {
          name: 'id',
          type: 'S',
        },
        billingMode: 'PROVISIONED',
        readCapacity: 10,
        writeCapacity: 5,
      })

      expect(table.Properties.BillingMode).toBe('PROVISIONED')
      expect(table.Properties.ProvisionedThroughput?.ReadCapacityUnits).toBe(10)
      expect(table.Properties.ProvisionedThroughput?.WriteCapacityUnits).toBe(5)
    })

    it('should enable streams', () => {
      const { table } = Database.createTable({
        slug: 'my-app',
        environment: 'production',
        partitionKey: {
          name: 'id',
          type: 'S',
        },
        streamEnabled: true,
        streamViewType: 'NEW_IMAGE',
      })

      expect(table.Properties.StreamSpecification?.StreamViewType).toBe('NEW_IMAGE')
    })

    it('should support KMS encryption', () => {
      const { table } = Database.createTable({
        slug: 'my-app',
        environment: 'production',
        partitionKey: {
          name: 'id',
          type: 'S',
        },
        encrypted: true,
        kmsKeyId: 'arn:aws:kms:us-east-1:123456789:key/abc',
      })

      expect(table.Properties.SSESpecification?.SSEType).toBe('KMS')
      expect(table.Properties.SSESpecification?.KMSMasterKeyId).toBe('arn:aws:kms:us-east-1:123456789:key/abc')
    })

    it('should enable TTL', () => {
      const { table } = Database.createTable({
        slug: 'my-app',
        environment: 'production',
        partitionKey: {
          name: 'id',
          type: 'S',
        },
        ttlAttribute: 'expiresAt',
      })

      expect(table.Properties.TimeToLiveSpecification?.AttributeName).toBe('expiresAt')
      expect(table.Properties.TimeToLiveSpecification?.Enabled).toBe(true)
    })
  })

  describe('addGlobalSecondaryIndex', () => {
    it('should add GSI to table', () => {
      const { table } = Database.createTable({
        slug: 'my-app',
        environment: 'production',
        partitionKey: {
          name: 'id',
          type: 'S',
        },
      })

      Database.addGlobalSecondaryIndex(table, {
        indexName: 'email-index',
        partitionKey: {
          name: 'email',
          type: 'S',
        },
      })

      expect(table.Properties.GlobalSecondaryIndexes).toHaveLength(1)
      expect(table.Properties.GlobalSecondaryIndexes![0].IndexName).toBe('email-index')
      expect(table.Properties.GlobalSecondaryIndexes![0].KeySchema[0].AttributeName).toBe('email')
      expect(table.Properties.GlobalSecondaryIndexes![0].Projection.ProjectionType).toBe('ALL')
    })

    it('should add GSI with sort key', () => {
      const { table } = Database.createTable({
        slug: 'my-app',
        environment: 'production',
        partitionKey: {
          name: 'id',
          type: 'S',
        },
      })

      Database.addGlobalSecondaryIndex(table, {
        indexName: 'status-created-index',
        partitionKey: {
          name: 'status',
          type: 'S',
        },
        sortKey: {
          name: 'createdAt',
          type: 'N',
        },
      })

      expect(table.Properties.GlobalSecondaryIndexes![0].KeySchema).toHaveLength(2)
      expect(table.Properties.GlobalSecondaryIndexes![0].KeySchema[1].AttributeName).toBe('createdAt')
    })

    it('should support INCLUDE projection', () => {
      const { table } = Database.createTable({
        slug: 'my-app',
        environment: 'production',
        partitionKey: {
          name: 'id',
          type: 'S',
        },
      })

      Database.addGlobalSecondaryIndex(table, {
        indexName: 'email-index',
        partitionKey: {
          name: 'email',
          type: 'S',
        },
        projectionType: 'INCLUDE',
        nonKeyAttributes: ['name', 'createdAt'],
      })

      expect(table.Properties.GlobalSecondaryIndexes![0].Projection.ProjectionType).toBe('INCLUDE')
      expect(table.Properties.GlobalSecondaryIndexes![0].Projection.NonKeyAttributes).toEqual(['name', 'createdAt'])
    })

    it('should add provisioned throughput for provisioned tables', () => {
      const { table } = Database.createTable({
        slug: 'my-app',
        environment: 'production',
        partitionKey: {
          name: 'id',
          type: 'S',
        },
        billingMode: 'PROVISIONED',
      })

      Database.addGlobalSecondaryIndex(table, {
        indexName: 'email-index',
        partitionKey: {
          name: 'email',
          type: 'S',
        },
        readCapacity: 10,
        writeCapacity: 5,
      })

      expect(table.Properties.GlobalSecondaryIndexes![0].ProvisionedThroughput?.ReadCapacityUnits).toBe(10)
      expect(table.Properties.GlobalSecondaryIndexes![0].ProvisionedThroughput?.WriteCapacityUnits).toBe(5)
    })
  })

  describe('enableStreams', () => {
    it('should enable streams on table', () => {
      const { table } = Database.createTable({
        slug: 'my-app',
        environment: 'production',
        partitionKey: {
          name: 'id',
          type: 'S',
        },
      })

      Database.enableStreams(table, 'KEYS_ONLY')

      expect(table.Properties.StreamSpecification?.StreamViewType).toBe('KEYS_ONLY')
    })
  })

  describe('InstanceClasses', () => {
    it('should provide common instance class constants', () => {
      expect(Database.InstanceClasses.T3_Micro).toBe('db.t3.micro')
      expect(Database.InstanceClasses.T3_Small).toBe('db.t3.small')
      expect(Database.InstanceClasses.M5_Large).toBe('db.m5.large')
      expect(Database.InstanceClasses.R5_XLarge).toBe('db.r5.xlarge')
    })
  })

  describe('Integration with TemplateBuilder', () => {
    it('should create PostgreSQL database infrastructure', () => {
      const template = new TemplateBuilder('PostgreSQL Database')

      const { dbInstance, subnetGroup, logicalId, subnetGroupId } = Database.createPostgres({
        slug: 'my-app',
        environment: 'production',
        masterPassword: 'SecurePassword123!',
        subnetIds: ['subnet-1', 'subnet-2', 'subnet-3'],
        securityGroupIds: ['sg-123'],
        multiAz: true,
      })

      if (subnetGroup && subnetGroupId) {
        template.addResource(subnetGroupId, subnetGroup)
      }

      template.addResource(logicalId, dbInstance)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(2)
      expect(result.Resources[logicalId].Type).toBe('AWS::RDS::DBInstance')
    })

    it('should create DynamoDB table with GSI', () => {
      const template = new TemplateBuilder('DynamoDB Table')

      const { table, logicalId } = Database.createTable({
        slug: 'my-app',
        environment: 'production',
        partitionKey: {
          name: 'userId',
          type: 'S',
        },
        sortKey: {
          name: 'timestamp',
          type: 'N',
        },
        streamEnabled: true,
      })

      Database.addGlobalSecondaryIndex(table, {
        indexName: 'email-index',
        partitionKey: {
          name: 'email',
          type: 'S',
        },
      })

      template.addResource(logicalId, table)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(1)
      expect(result.Resources[logicalId]!.Properties!.GlobalSecondaryIndexes).toHaveLength(1)
      expect(result.Resources[logicalId]!.Properties!.StreamSpecification).toBeDefined()
    })

    it('should generate valid JSON template', () => {
      const template = new TemplateBuilder('Database Test')

      const { table, logicalId } = Database.createTable({
        slug: 'test',
        environment: 'development',
        partitionKey: {
          name: 'id',
          type: 'S',
        },
      })

      template.addResource(logicalId, table)

      const json = template.toJSON()
      const parsed = JSON.parse(json)

      expect(parsed.Resources[logicalId].Type).toBe('AWS::DynamoDB::Table')
      expect(parsed.Resources[logicalId].Properties.TableName).toBeDefined()
    })
  })
})
