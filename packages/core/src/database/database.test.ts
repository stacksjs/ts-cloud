import { describe, expect, it, beforeEach } from 'bun:test'
import {
  MigrationManager,
  migrationManager,
  ReplicaManager,
  replicaManager,
  PerformanceManager,
  performanceManager,
  DatabaseUserManager,
  databaseUserManager,
} from '.'

describe('Migration Manager', () => {
  let manager: MigrationManager

  beforeEach(() => {
    manager = new MigrationManager()
  })

  describe('Migration Creation', () => {
    it('should create migration plan', () => {
      const plan = manager.createPlan({
        name: 'Initial Schema',
        database: {
          type: 'rds',
          identifier: 'my-database',
          engine: 'postgres',
        },
        migrations: [],
        autoApply: false,
      })

      expect(plan.id).toContain('migration-plan')
      expect(plan.name).toBe('Initial Schema')
      expect(plan.database.type).toBe('rds')
    })

    it('should create schema migration', () => {
      const migration = manager.createSchemaMigration({
        version: '1.0.0',
        name: 'Add user table',
        tableName: 'users',
        changes: [
          {
            type: 'add_column',
            columnName: 'email',
            columnType: 'VARCHAR(255)',
            nullable: false,
          },
        ],
      })

      expect(migration.id).toContain('migration')
      expect(migration.version).toBe('1.0.0')
      expect(migration.up).toContain('ADD COLUMN')
      expect(migration.down).toContain('DROP COLUMN')
    })

    it('should create data migration', () => {
      const migration = manager.createDataMigration({
        version: '1.0.1',
        name: 'Seed initial data',
        upSQL: "INSERT INTO users (name) VALUES ('Admin');",
        downSQL: "DELETE FROM users WHERE name = 'Admin';",
      })

      expect(migration.version).toBe('1.0.1')
      expect(migration.up).toContain('INSERT')
      expect(migration.down).toContain('DELETE')
    })
  })

  describe('Migration Execution', () => {
    it('should execute migration plan in dry-run mode', async () => {
      const plan = manager.createPlan({
        name: 'Test Plan',
        database: {
          type: 'rds',
          identifier: 'test-db',
        },
        migrations: [],
      })

      const migration = manager.createDataMigration({
        version: '1.0.0',
        name: 'Test migration',
        upSQL: 'CREATE TABLE test (id INT);',
        downSQL: 'DROP TABLE test;',
      })

      manager.addMigrationToPlan(plan.id, migration)

      const result = await manager.executePlan(plan.id, true)

      expect(result.success).toBe(true)
      expect(result.appliedMigrations).toHaveLength(1)
      expect(result.failedMigrations).toHaveLength(0)
    })

    it('should get migration status', () => {
      const plan = manager.createPlan({
        name: 'Test Plan',
        database: { type: 'rds', identifier: 'test-db' },
        migrations: [],
      })

      const status = manager.getMigrationStatus(plan.id)

      expect(status.currentVersion).toBe('0.0.0')
      expect(status.pendingMigrations).toHaveLength(0)
      expect(status.appliedMigrations).toHaveLength(0)
    })
  })

  describe('Migration Validation', () => {
    it('should validate migration plan', () => {
      const plan = manager.createPlan({
        name: 'Test Plan',
        database: { type: 'rds', identifier: 'test-db' },
        migrations: [],
      })

      const migration = manager.createDataMigration({
        version: '1.0.0',
        name: 'Test',
        upSQL: 'SELECT 1;',
        downSQL: 'SELECT 0;',
      })

      manager.addMigrationToPlan(plan.id, migration)

      const validation = manager.validatePlan(plan.id)

      expect(validation.valid).toBe(true)
      expect(validation.errors).toHaveLength(0)
    })

    it('should detect duplicate migration versions', () => {
      const plan = manager.createPlan({
        name: 'Test Plan',
        database: { type: 'rds', identifier: 'test-db' },
        migrations: [],
      })

      const migration1 = manager.createDataMigration({
        version: '1.0.0',
        name: 'First',
        upSQL: 'SELECT 1;',
        downSQL: '',
      })

      const migration2 = manager.createDataMigration({
        version: '1.0.0',
        name: 'Second',
        upSQL: 'SELECT 2;',
        downSQL: '',
      })

      manager.addMigrationToPlan(plan.id, migration1)
      manager.addMigrationToPlan(plan.id, migration2)

      const validation = manager.validatePlan(plan.id)

      expect(validation.valid).toBe(false)
      expect(validation.errors.some(e => e.includes('Duplicate'))).toBe(true)
    })
  })

  it('should use global instance', () => {
    expect(migrationManager).toBeInstanceOf(MigrationManager)
  })
})

describe('Replica Manager', () => {
  let manager: ReplicaManager

  beforeEach(() => {
    manager = new ReplicaManager()
  })

  describe('Replica Creation', () => {
    it('should create read replica', () => {
      const replica = manager.createRDSReplica({
        sourceDatabase: 'primary-db',
        name: 'replica-1',
        region: 'us-east-1',
        instanceClass: 'db.t3.medium',
      })

      expect(replica.id).toContain('replica')
      expect(replica.name).toBe('replica-1')
      expect(replica.sourceDatabase).toBe('primary-db')
      expect(replica.status).toBe('creating')
    })

    it('should create cross-region replica', () => {
      const replica = manager.createCrossRegionReplica({
        sourceDatabase: 'primary-db',
        name: 'replica-eu',
        targetRegion: 'eu-west-1',
      })

      expect(replica.region).toBe('eu-west-1')
      expect(replica.multiAZ).toBe(true)
    })

    it('should create replication group with auto-scaling', () => {
      const group = manager.createAutoScalingReplicationGroup({
        name: 'production-replicas',
        primaryDatabase: 'primary-db',
        minReplicas: 2,
        maxReplicas: 5,
        targetCPU: 70,
      })

      expect(group.id).toContain('replication-group')
      expect(group.autoScaling?.enabled).toBe(true)
      expect(group.autoScaling?.minReplicas).toBe(2)
      expect(group.autoScaling?.maxReplicas).toBe(5)
    })
  })

  describe('RDS Proxy', () => {
    it('should create connection pool proxy', () => {
      const proxy = manager.createConnectionPoolProxy({
        name: 'app-proxy',
        engineFamily: 'POSTGRESQL',
        targetDatabase: 'my-database',
        vpcSubnetIds: ['subnet-1', 'subnet-2'],
        securityGroupIds: ['sg-1'],
        secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:db-creds',
      })

      expect(proxy.id).toContain('rds-proxy')
      expect(proxy.name).toBe('app-proxy')
      expect(proxy.engineFamily).toBe('POSTGRESQL')
      expect(proxy.requireTLS).toBe(true)
    })

    it('should create serverless proxy with optimized settings', () => {
      const proxy = manager.createServerlessProxy({
        name: 'lambda-proxy',
        engineFamily: 'MYSQL',
        targetDatabase: 'serverless-db',
        vpcSubnetIds: ['subnet-1'],
        securityGroupIds: ['sg-1'],
        secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:db-creds',
      })

      expect(proxy.maxIdleConnectionsPercent).toBe(10)
      expect(proxy.connectionBorrowTimeout).toBe(60)
      expect(proxy.idleClientTimeout).toBe(300)
    })
  })

  describe('Replica Operations', () => {
    it('should promote replica to primary', () => {
      const replica = manager.createRDSReplica({
        sourceDatabase: 'primary-db',
        name: 'replica-1',
      })

      replica.replicationLag = 100 // Low lag

      const result = manager.promoteReplica(replica.id)

      expect(result.success).toBe(true)
      expect(result.message).toContain('successfully')
    })

    it('should fail promotion with high replication lag', () => {
      const replica = manager.createRDSReplica({
        sourceDatabase: 'primary-db',
        name: 'replica-1',
      })

      replica.replicationLag = 10000 // High lag

      const result = manager.promoteReplica(replica.id)

      expect(result.success).toBe(false)
      expect(result.message).toContain('lag too high')
    })

    it('should get replication lag', () => {
      const replica = manager.createRDSReplica({
        sourceDatabase: 'primary-db',
        name: 'replica-1',
      })

      const lag = manager.getReplicationLag(replica.id)

      expect(typeof lag).toBe('number')
      expect(lag).toBeGreaterThanOrEqual(0)
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate replica CloudFormation', () => {
      const replica = manager.createRDSReplica({
        sourceDatabase: 'primary-db',
        name: 'replica-1',
      })

      const cf = manager.generateReplicaCF(replica)

      expect(cf.Type).toBe('AWS::RDS::DBInstance')
      expect(cf.Properties.SourceDBInstanceIdentifier).toBe('primary-db')
      expect(cf.Properties.DBInstanceIdentifier).toBe('replica-1')
    })

    it('should generate proxy CloudFormation', () => {
      const proxy = manager.createConnectionPoolProxy({
        name: 'test-proxy',
        engineFamily: 'POSTGRESQL',
        targetDatabase: 'test-db',
        vpcSubnetIds: ['subnet-1'],
        securityGroupIds: ['sg-1'],
        secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:db-creds',
      })

      const cf = manager.generateProxyCF(proxy)

      expect(cf.Type).toBe('AWS::RDS::DBProxy')
      expect(cf.Properties.DBProxyName).toBe('test-proxy')
      expect(cf.Properties.EngineFamily).toBe('POSTGRESQL')
    })
  })

  it('should use global instance', () => {
    expect(replicaManager).toBeInstanceOf(ReplicaManager)
  })
})

describe('Performance Manager', () => {
  let manager: PerformanceManager

  beforeEach(() => {
    manager = new PerformanceManager()
  })

  describe('Performance Insights', () => {
    it('should enable performance insights', () => {
      const insights = manager.enablePerformanceInsights({
        name: 'production-insights',
        databaseIdentifier: 'prod-db',
        retentionPeriod: 7,
      })

      expect(insights.id).toContain('pi-')
      expect(insights.enabled).toBe(true)
      expect(insights.retentionPeriod).toBe(7)
    })

    it('should enable performance insights with encryption', () => {
      const insights = manager.enablePerformanceInsights({
        name: 'encrypted-insights',
        databaseIdentifier: 'prod-db',
        kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/12345',
      })

      expect(insights.kmsKeyId).toBe('arn:aws:kms:us-east-1:123456789012:key/12345')
    })
  })

  describe('Slow Query Logging', () => {
    it('should enable slow query log to CloudWatch', () => {
      const log = manager.enableSlowQueryLog({
        name: 'slow-queries',
        databaseIdentifier: 'prod-db',
        logDestination: 'cloudwatch',
        cloudwatchLogGroup: '/aws/rds/slow-queries',
        minExecutionTime: 2000,
      })

      expect(log.id).toContain('slow-query')
      expect(log.logDestination).toBe('cloudwatch')
      expect(log.minExecutionTime).toBe(2000)
    })

    it('should enable slow query log to S3', () => {
      const log = manager.enableSlowQueryLog({
        name: 'slow-queries-s3',
        databaseIdentifier: 'prod-db',
        logDestination: 's3',
        s3Bucket: 'my-logs-bucket',
      })

      expect(log.logDestination).toBe('s3')
      expect(log.s3Bucket).toBe('my-logs-bucket')
      expect(log.s3Prefix).toBe('slow-queries/')
    })
  })

  describe('Query Metrics', () => {
    it('should record query metric', () => {
      const metric = manager.recordQueryMetric({
        queryId: 'SELECT_USERS',
        sql: 'SELECT * FROM users WHERE active = true',
        executionCount: 100,
        avgExecutionTime: 25,
        maxExecutionTime: 150,
        minExecutionTime: 10,
        totalCPUTime: 2500,
        totalIOWait: 500,
        totalLockWait: 100,
        rowsExamined: 1000,
        rowsReturned: 100,
      })

      expect(metric.id).toContain('metric')
      expect(metric.avgExecutionTime).toBe(25)
      expect(metric.executionCount).toBe(100)
    })
  })

  describe('Performance Reports', () => {
    it('should generate daily performance report', () => {
      const report = manager.generatePerformanceReport({
        name: 'Daily Report',
        databaseIdentifier: 'prod-db',
        reportType: 'daily',
      })

      expect(report.id).toContain('report')
      expect(report.reportType).toBe('daily')
      expect(report.metrics).toBeDefined()
      expect(report.recommendations).toBeDefined()
    })

    it('should include performance metrics', () => {
      const report = manager.generatePerformanceReport({
        name: 'Test Report',
        databaseIdentifier: 'test-db',
        reportType: 'weekly',
      })

      expect(report.metrics.avgCPU).toBeGreaterThan(0)
      expect(report.metrics.avgConnections).toBeGreaterThan(0)
      expect(report.metrics.cacheHitRatio).toBeGreaterThan(0)
    })

    it('should generate recommendations based on metrics', () => {
      // Add slow query
      manager.recordQueryMetric({
        queryId: 'SLOW_QUERY',
        sql: 'SELECT * FROM large_table',
        executionCount: 10,
        avgExecutionTime: 5000,
        maxExecutionTime: 10000,
        minExecutionTime: 2000,
        totalCPUTime: 50000,
        totalIOWait: 10000,
        totalLockWait: 1000,
        rowsExamined: 1000000,
        rowsReturned: 100,
      })

      const report = manager.generatePerformanceReport({
        name: 'Test Report',
        databaseIdentifier: 'test-db',
        reportType: 'daily',
      })

      expect(report.recommendations.length).toBeGreaterThan(0)
    })
  })

  describe('Query Analysis', () => {
    it('should analyze query', () => {
      const analysis = manager.analyzeQuery('SELECT * FROM users WHERE email = "test@example.com"')

      expect(analysis.id).toBeDefined()
      expect(analysis.sql).toContain('SELECT')
      expect(analysis.executionPlan).toBeDefined()
      expect(analysis.bottlenecks).toBeDefined()
      expect(analysis.recommendations).toBeDefined()
    })

    it('should detect full table scan', () => {
      const analysis = manager.analyzeQuery('SELECT * FROM users')

      expect(analysis.bottlenecks.some(b => b.type === 'full_table_scan')).toBe(true)
    })

    it('should recommend index', () => {
      const recommendation = manager.recommendIndex({
        tableName: 'users',
        columns: ['email', 'active'],
        reason: 'Frequently queried together in WHERE clause',
        estimatedImprovement: 75,
      })

      expect(recommendation.id).toContain('index-rec')
      expect(recommendation.createSQL).toContain('CREATE INDEX')
      expect(recommendation.estimatedImprovement).toBe(75)
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate performance insights CloudFormation', () => {
      const insights = manager.enablePerformanceInsights({
        name: 'test-insights',
        databaseIdentifier: 'test-db',
      })

      const cf = manager.generatePerformanceInsightsCF(insights)

      expect(cf.EnablePerformanceInsights).toBe(true)
      expect(cf.PerformanceInsightsRetentionPeriod).toBe(7)
    })

    it('should generate slow query alarm', () => {
      const cf = manager.generateSlowQueryAlarmCF({
        alarmName: 'HighSlowQueries',
        logGroupName: '/aws/rds/slow-queries',
        threshold: 10,
      })

      expect(cf.Type).toBe('AWS::CloudWatch::Alarm')
      expect(cf.Properties.AlarmName).toBe('HighSlowQueries')
      expect(cf.Properties.Threshold).toBe(10)
    })
  })

  it('should use global instance', () => {
    expect(performanceManager).toBeInstanceOf(PerformanceManager)
  })
})

describe('Database User Manager', () => {
  let manager: DatabaseUserManager

  beforeEach(() => {
    manager = new DatabaseUserManager()
  })

  describe('User Creation', () => {
    it('should create read-only user', () => {
      const user = manager.createReadOnlyUser({
        username: 'readonly',
        database: 'production',
        passwordSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:readonly',
      })

      expect(user.id).toContain('db-user')
      expect(user.username).toBe('readonly')
      expect(user.privileges).toHaveLength(1)
      expect(user.privileges[0].privileges).toContain('SELECT')
      expect(user.rotationEnabled).toBe(true)
    })

    it('should create read-write user', () => {
      const user = manager.createReadWriteUser({
        username: 'appuser',
        database: 'production',
      })

      expect(user.privileges[0].privileges).toContain('SELECT')
      expect(user.privileges[0].privileges).toContain('INSERT')
      expect(user.privileges[0].privileges).toContain('UPDATE')
      expect(user.privileges[0].privileges).toContain('DELETE')
    })

    it('should create admin user', () => {
      const user = manager.createAdminUser({
        username: 'admin',
        database: 'production',
      })

      expect(user.privileges[0].privileges).toContain('ALL')
    })

    it('should create application user with specific tables', () => {
      const user = manager.createApplicationUser({
        username: 'api',
        database: 'production',
        tables: [
          { name: 'users', privileges: ['SELECT', 'INSERT', 'UPDATE'] },
          { name: 'sessions', privileges: ['SELECT', 'INSERT', 'DELETE'] },
        ],
      })

      expect(user.privileges).toHaveLength(2)
      expect(user.privileges[0].table).toBe('users')
      expect(user.privileges[1].table).toBe('sessions')
    })
  })

  describe('Roles', () => {
    it('should create user role', () => {
      const role = manager.createRole({
        name: 'Developer',
        description: 'Developer access to test databases',
        privileges: [
          {
            database: 'test',
            privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
          },
        ],
      })

      expect(role.id).toContain('role')
      expect(role.name).toBe('Developer')
      expect(role.users).toHaveLength(0)
    })

    it('should assign user to role', () => {
      const user = manager.createReadOnlyUser({
        username: 'dev1',
        database: 'test',
      })

      const role = manager.createRole({
        name: 'Developer',
        privileges: [
          {
            database: 'test',
            privileges: ['INSERT', 'UPDATE'],
          },
        ],
      })

      manager.assignUserToRole(user.id, role.id)

      expect(role.users).toContain(user.id)
      // User should now have merged privileges
      expect(user.privileges[0].privileges).toContain('SELECT')
      expect(user.privileges[0].privileges).toContain('INSERT')
    })
  })

  describe('Privilege Management', () => {
    it('should grant privileges', () => {
      const user = manager.createReadOnlyUser({
        username: 'user1',
        database: 'production',
      })

      const result = manager.grantPrivileges(user.id, [
        {
          database: 'production',
          privileges: ['INSERT', 'UPDATE'],
        },
      ])

      expect(result.success).toBe(true)
      expect(user.privileges[0].privileges).toContain('INSERT')
      expect(user.privileges[0].privileges).toContain('UPDATE')
    })

    it('should revoke privileges', () => {
      const user = manager.createReadWriteUser({
        username: 'user1',
        database: 'production',
      })

      const result = manager.revokePrivileges(user.id, [
        {
          database: 'production',
          privileges: ['DELETE'],
        },
      ])

      expect(result.success).toBe(true)
      expect(user.privileges[0].privileges).not.toContain('DELETE')
    })
  })

  describe('Password Rotation', () => {
    it('should rotate password', () => {
      const user = manager.createReadOnlyUser({
        username: 'user1',
        database: 'production',
      })

      const result = manager.rotatePassword(user.id)

      expect(result.success).toBe(true)
      expect(result.newSecretArn).toContain('arn:aws:secretsmanager')
      expect(user.lastRotated).toBeDefined()
    })

    it('should check if password rotation needed', () => {
      const user = manager.createReadOnlyUser({
        username: 'user1',
        database: 'production',
      })

      user.lastRotated = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000) // 100 days ago

      const needsRotation = manager.needsPasswordRotation(user.id)

      expect(needsRotation).toBe(true)
    })
  })

  describe('Access Auditing', () => {
    it('should audit access', () => {
      const audit = manager.auditAccess({
        username: 'user1',
        action: 'LOGIN',
        success: true,
        ipAddress: '192.168.1.1',
      })

      expect(audit.id).toContain('audit')
      expect(audit.username).toBe('user1')
      expect(audit.action).toBe('LOGIN')
    })

    it('should get user access history', () => {
      manager.auditAccess({ username: 'user1', action: 'LOGIN', success: true })
      manager.auditAccess({ username: 'user1', action: 'QUERY', success: true })

      const history = manager.getUserAccessHistory('user1')

      expect(history).toHaveLength(2)
    })

    it('should get failed login attempts', () => {
      manager.auditAccess({ username: 'user1', action: 'LOGIN', success: false })
      manager.auditAccess({ username: 'user1', action: 'LOGIN', success: false })
      manager.auditAccess({ username: 'user1', action: 'LOGIN', success: true })

      const failedAttempts = manager.getFailedLoginAttempts('user1')

      expect(failedAttempts).toHaveLength(2)
    })
  })

  describe('SQL Generation', () => {
    it('should generate PostgreSQL user creation SQL', () => {
      const user = manager.createReadWriteUser({
        username: 'testuser',
        database: 'production',
      })

      const sql = manager.generateCreateUserSQL(user, 'postgres')

      expect(sql).toContain('CREATE USER testuser')
      expect(sql).toContain('GRANT')
    })

    it('should generate MySQL user creation SQL', () => {
      const user = manager.createReadOnlyUser({
        username: 'testuser',
        database: 'production',
      })

      const sql = manager.generateCreateUserSQL(user, 'mysql')

      expect(sql).toContain("CREATE USER 'testuser'")
      expect(sql).toContain('GRANT')
      expect(sql).toContain('FLUSH PRIVILEGES')
    })
  })

  it('should use global instance', () => {
    expect(databaseUserManager).toBeInstanceOf(DatabaseUserManager)
  })
})
