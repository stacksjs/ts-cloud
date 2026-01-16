import { describe, expect, it, beforeEach } from 'bun:test'
import { BackupManager } from './manager'

describe('BackupManager', () => {
  let manager: BackupManager

  beforeEach(() => {
    manager = new BackupManager()
  })

  describe('Vault Management', () => {
    it('should create backup vault', () => {
      const vault = {
        name: 'test-vault',
        region: 'us-east-1',
        encryptionKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/abcd-1234',
      }

      manager.createVault(vault)

      const retrieved = manager.getVault('test-vault')
      expect(retrieved).toBeDefined()
      expect(retrieved?.name).toBe('test-vault')
      expect(retrieved?.region).toBe('us-east-1')
      expect(retrieved?.encryptionKeyArn).toBe('arn:aws:kms:us-east-1:123456789012:key/abcd-1234')
    })

    it('should return undefined for non-existent vault', () => {
      const vault = manager.getVault('non-existent')
      expect(vault).toBeUndefined()
    })

    it('should create multiple vaults', () => {
      manager.createVault({ name: 'vault1', region: 'us-east-1' })
      manager.createVault({ name: 'vault2', region: 'us-west-2' })

      expect(manager.getVault('vault1')).toBeDefined()
      expect(manager.getVault('vault2')).toBeDefined()
    })
  })

  describe('Backup Plan Management', () => {
    beforeEach(() => {
      manager.createVault({ name: 'default-vault', region: 'us-east-1' })
    })

    it('should create backup plan', () => {
      const plan = manager.createBackupPlan({
        name: 'Test Plan',
        schedule: '0 2 * * *',
        retentionDays: 7,
        vaultName: 'default-vault',
        resources: [
          {
            resourceArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
            resourceType: 'rds',
            region: 'us-east-1',
          },
        ],
      })

      expect(plan.id).toMatch(/^backup-plan-\d+-\d+$/)
      expect(plan.name).toBe('Test Plan')
      expect(plan.schedule).toBe('0 2 * * *')
      expect(plan.retentionDays).toBe(7)
      expect(plan.vaultName).toBe('default-vault')
      expect(plan.resources).toHaveLength(1)
    })

    it('should get backup plan by id', () => {
      const plan = manager.createBackupPlan({
        name: 'Test Plan',
        schedule: '0 2 * * *',
        retentionDays: 7,
        vaultName: 'default-vault',
        resources: [],
      })

      const retrieved = manager.getBackupPlan(plan.id)
      expect(retrieved).toBeDefined()
      expect(retrieved?.id).toBe(plan.id)
      expect(retrieved?.name).toBe('Test Plan')
    })

    it('should return undefined for non-existent plan', () => {
      const plan = manager.getBackupPlan('non-existent')
      expect(plan).toBeUndefined()
    })

    it('should list all backup plans', () => {
      manager.createBackupPlan({
        name: 'Plan 1',
        schedule: '0 2 * * *',
        retentionDays: 7,
        vaultName: 'default-vault',
        resources: [],
      })

      manager.createBackupPlan({
        name: 'Plan 2',
        schedule: '0 3 * * *',
        retentionDays: 14,
        vaultName: 'default-vault',
        resources: [],
      })

      const plans = manager.listBackupPlans()
      expect(plans).toHaveLength(2)
      expect(plans[0].name).toBe('Plan 1')
      expect(plans[1].name).toBe('Plan 2')
    })

    it('should include lifecycle configuration', () => {
      const plan = manager.createBackupPlan({
        name: 'Test Plan',
        schedule: '0 2 * * *',
        retentionDays: 90,
        vaultName: 'default-vault',
        resources: [],
        lifecycle: {
          moveTocoldStorageAfterDays: 30,
          deleteAfterDays: 90,
        },
      })

      expect(plan.lifecycle).toBeDefined()
      expect(plan.lifecycle?.moveTocoldStorageAfterDays).toBe(30)
      expect(plan.lifecycle?.deleteAfterDays).toBe(90)
    })

    it('should include tags', () => {
      const plan = manager.createBackupPlan({
        name: 'Test Plan',
        schedule: '0 2 * * *',
        retentionDays: 7,
        vaultName: 'default-vault',
        resources: [],
        tags: {
          Environment: 'production',
          Team: 'platform',
        },
      })

      expect(plan.tags).toBeDefined()
      expect(plan.tags?.Environment).toBe('production')
      expect(plan.tags?.Team).toBe('platform')
    })
  })

  describe('RDS Backup Plans', () => {
    it('should create RDS backup plan with defaults', () => {
      const plan = manager.createRDSBackupPlan({
        dbInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
      })

      expect(plan.name).toBe('RDS Daily Backup')
      expect(plan.schedule).toBe('0 2 * * *')
      expect(plan.retentionDays).toBe(7)
      expect(plan.vaultName).toBe('default-vault')
      expect(plan.resources).toHaveLength(1)
      expect(plan.resources[0].resourceType).toBe('rds')
      expect(plan.lifecycle?.moveTocoldStorageAfterDays).toBe(30)
      expect(plan.lifecycle?.deleteAfterDays).toBe(7)
    })

    it('should create RDS backup plan with custom options', () => {
      const plan = manager.createRDSBackupPlan({
        dbInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
        schedule: '0 1 * * *',
        retentionDays: 30,
        vaultName: 'custom-vault',
      })

      expect(plan.schedule).toBe('0 1 * * *')
      expect(plan.retentionDays).toBe(30)
      expect(plan.vaultName).toBe('custom-vault')
      expect(plan.lifecycle?.deleteAfterDays).toBe(30)
    })
  })

  describe('DynamoDB Backup Plans', () => {
    it('should create DynamoDB backup plan with defaults', () => {
      const plan = manager.createDynamoDBBackupPlan({
        tableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/my-table',
      })

      expect(plan.name).toBe('DynamoDB Daily Backup')
      expect(plan.schedule).toBe('0 3 * * *')
      expect(plan.retentionDays).toBe(35)
      expect(plan.vaultName).toBe('dynamodb-vault')
      expect(plan.resources).toHaveLength(1)
      expect(plan.resources[0].resourceType).toBe('dynamodb')
      expect(plan.lifecycle?.deleteAfterDays).toBe(35)
    })

    it('should create DynamoDB backup plan with cross-region copy', () => {
      const plan = manager.createDynamoDBBackupPlan({
        tableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/my-table',
        crossRegionCopy: ['us-west-2', 'eu-west-1'],
      })

      expect(plan.tags).toBeDefined()
      expect(plan.tags?.CrossRegionCopy).toBe('us-west-2,eu-west-1')
    })

    it('should create DynamoDB backup plan with custom options', () => {
      const plan = manager.createDynamoDBBackupPlan({
        tableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/my-table',
        schedule: '0 4 * * *',
        retentionDays: 90,
      })

      expect(plan.schedule).toBe('0 4 * * *')
      expect(plan.retentionDays).toBe(90)
    })
  })

  describe('EFS Backup Plans', () => {
    it('should create EFS backup plan with defaults', () => {
      const plan = manager.createEFSBackupPlan({
        fileSystemArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-12345678',
      })

      expect(plan.name).toBe('EFS Daily Backup')
      expect(plan.schedule).toBe('0 1 * * *')
      expect(plan.retentionDays).toBe(30)
      expect(plan.vaultName).toBe('efs-vault')
      expect(plan.resources).toHaveLength(1)
      expect(plan.resources[0].resourceType).toBe('efs')
      expect(plan.lifecycle?.deleteAfterDays).toBe(30)
    })

    it('should create EFS backup plan with custom options', () => {
      const plan = manager.createEFSBackupPlan({
        fileSystemArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-12345678',
        schedule: '0 0 * * *',
        retentionDays: 60,
      })

      expect(plan.schedule).toBe('0 0 * * *')
      expect(plan.retentionDays).toBe(60)
    })
  })

  describe('Point-in-Time Recovery', () => {
    it('should enable PITR for RDS', () => {
      const result = manager.enablePointInTimeRecovery(
        'arn:aws:rds:us-east-1:123456789012:db:mydb',
        'rds',
      )

      expect(result.enabled).toBe(true)
      expect(result.earliestRestorableTime).toBeInstanceOf(Date)
      expect(result.latestRestorableTime).toBeInstanceOf(Date)
      expect(result.earliestRestorableTime.getTime()).toBeLessThan(
        result.latestRestorableTime.getTime(),
      )
    })

    it('should enable PITR for DynamoDB', () => {
      const result = manager.enablePointInTimeRecovery(
        'arn:aws:dynamodb:us-east-1:123456789012:table/my-table',
        'dynamodb',
      )

      expect(result.enabled).toBe(true)
      expect(result.earliestRestorableTime).toBeInstanceOf(Date)
      expect(result.latestRestorableTime).toBeInstanceOf(Date)
    })

    it('should provide 7-day window for PITR', () => {
      const result = manager.enablePointInTimeRecovery(
        'arn:aws:rds:us-east-1:123456789012:db:mydb',
        'rds',
      )

      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
      const timeDiff
        = result.latestRestorableTime.getTime() - result.earliestRestorableTime.getTime()

      // Allow some tolerance for test execution time
      expect(timeDiff).toBeGreaterThanOrEqual(sevenDaysMs - 1000)
      expect(timeDiff).toBeLessThanOrEqual(sevenDaysMs + 1000)
    })
  })

  describe('Restore Jobs', () => {
    it('should create restore job from backup', async () => {
      const job = await manager.restoreFromBackup({
        backupId: 'backup-12345',
        resourceType: 'rds',
      })

      expect(job.id).toMatch(/^restore-\d+-\d+$/)
      expect(job.backupId).toBe('backup-12345')
      expect(job.resourceType).toBe('rds')
      expect(job.status).toBe('pending')
      expect(job.startTime).toBeInstanceOf(Date)
    })

    it('should create restore job with target region', async () => {
      const job = await manager.restoreFromBackup({
        backupId: 'backup-12345',
        resourceType: 'dynamodb',
        targetRegion: 'us-west-2',
      })

      expect(job.targetRegion).toBe('us-west-2')
    })

    it('should get restore job by id', async () => {
      const job = await manager.restoreFromBackup({
        backupId: 'backup-12345',
        resourceType: 'rds',
      })

      const retrieved = manager.getRestoreJob(job.id)
      expect(retrieved).toBeDefined()
      expect(retrieved?.id).toBe(job.id)
      expect(retrieved?.backupId).toBe('backup-12345')
    })

    it('should list all restore jobs', async () => {
      await manager.restoreFromBackup({
        backupId: 'backup-1',
        resourceType: 'rds',
      })

      await manager.restoreFromBackup({
        backupId: 'backup-2',
        resourceType: 'dynamodb',
      })

      const jobs = manager.listRestoreJobs()
      expect(jobs.length).toBeGreaterThanOrEqual(2)
    })

    it('should restore to point in time', async () => {
      const restoreTime = new Date(Date.now() - 2 * 60 * 60 * 1000) // 2 hours ago

      const job = await manager.restoreToPointInTime({
        sourceResourceArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
        targetResourceName: 'mydb-restored',
        restoreTime,
        resourceType: 'rds',
      })

      expect(job.id).toMatch(/^pitr-\d+-\d+$/)
      expect(job.backupId).toMatch(/^pitr-\d+$/)
      expect(job.resourceType).toBe('rds')
      expect(job.status).toBe('pending')
    })
  })

  describe('Cross-Region Replication', () => {
    it('should setup cross-region replication', () => {
      // This should not throw
      expect(() => {
        manager.setupCrossRegionReplication({
          sourceVault: 'primary-vault',
          sourceRegion: 'us-east-1',
          targetRegions: ['us-west-2', 'eu-west-1'],
        })
      }).not.toThrow()
    })

    it('should accept multiple target regions', () => {
      expect(() => {
        manager.setupCrossRegionReplication({
          sourceVault: 'primary-vault',
          sourceRegion: 'us-east-1',
          targetRegions: ['us-west-2', 'eu-west-1', 'ap-southeast-1'],
        })
      }).not.toThrow()
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate backup vault CloudFormation', () => {
      const vault = {
        name: 'test-vault',
        region: 'us-east-1',
        encryptionKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/abcd-1234',
      }

      const cf = manager.generateBackupVaultCF(vault)

      expect(cf.Type).toBe('AWS::Backup::BackupVault')
      expect(cf.Properties.BackupVaultName).toBe('test-vault')
      expect(cf.Properties.EncryptionKeyArn).toBe('arn:aws:kms:us-east-1:123456789012:key/abcd-1234')
    })

    it('should generate backup vault CloudFormation without encryption', () => {
      const vault = {
        name: 'test-vault',
        region: 'us-east-1',
      }

      const cf = manager.generateBackupVaultCF(vault)

      expect(cf.Type).toBe('AWS::Backup::BackupVault')
      expect(cf.Properties.BackupVaultName).toBe('test-vault')
      expect(cf.Properties.EncryptionKeyArn).toBeUndefined()
    })

    it('should generate backup plan CloudFormation', () => {
      const plan = manager.createBackupPlan({
        name: 'Test Plan',
        schedule: '0 2 * * *',
        retentionDays: 7,
        vaultName: 'default-vault',
        resources: [],
        lifecycle: {
          moveTocoldStorageAfterDays: 30,
          deleteAfterDays: 90,
        },
      })

      const cf = manager.generateBackupPlanCF(plan)

      expect(cf.Type).toBe('AWS::Backup::BackupPlan')
      expect(cf.Properties.BackupPlan.BackupPlanName).toBe('Test Plan')
      expect(cf.Properties.BackupPlan.BackupPlanRule).toHaveLength(1)
      expect(cf.Properties.BackupPlan.BackupPlanRule[0].TargetBackupVault).toBe('default-vault')
      expect(cf.Properties.BackupPlan.BackupPlanRule[0].ScheduleExpression).toBe('cron(0 2 * * *)')
      expect(cf.Properties.BackupPlan.BackupPlanRule[0].Lifecycle.MoveToColdStorageAfterDays).toBe(30)
      expect(cf.Properties.BackupPlan.BackupPlanRule[0].Lifecycle.DeleteAfterDays).toBe(90)
    })

    it('should generate backup plan CloudFormation without lifecycle', () => {
      const plan = manager.createBackupPlan({
        name: 'Test Plan',
        schedule: '0 2 * * *',
        retentionDays: 7,
        vaultName: 'default-vault',
        resources: [],
      })

      const cf = manager.generateBackupPlanCF(plan)

      expect(cf.Properties.BackupPlan.BackupPlanRule[0].Lifecycle).toBeUndefined()
    })

    it('should generate backup selection CloudFormation', () => {
      const plan = manager.createBackupPlan({
        name: 'Test Plan',
        schedule: '0 2 * * *',
        retentionDays: 7,
        vaultName: 'default-vault',
        resources: [
          {
            resourceArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
            resourceType: 'rds',
            region: 'us-east-1',
          },
          {
            resourceArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/my-table',
            resourceType: 'dynamodb',
            region: 'us-east-1',
          },
        ],
      })

      const cf = manager.generateBackupSelectionCF(plan)

      expect(cf.Type).toBe('AWS::Backup::BackupSelection')
      expect(cf.Properties.BackupPlanId.Ref).toBe(`BackupPlan${plan.id}`)
      expect(cf.Properties.BackupSelection.SelectionName).toBe('Test PlanSelection')
      expect(cf.Properties.BackupSelection.Resources).toHaveLength(2)
      expect(cf.Properties.BackupSelection.Resources[0]).toBe(
        'arn:aws:rds:us-east-1:123456789012:db:mydb',
      )
    })
  })

  describe('Clear Data', () => {
    it('should clear all data', async () => {
      manager.createVault({ name: 'vault1', region: 'us-east-1' })
      manager.createBackupPlan({
        name: 'Plan 1',
        schedule: '0 2 * * *',
        retentionDays: 7,
        vaultName: 'vault1',
        resources: [],
      })
      await manager.restoreFromBackup({
        backupId: 'backup-1',
        resourceType: 'rds',
      })

      manager.clear()

      expect(manager.getVault('vault1')).toBeUndefined()
      expect(manager.listBackupPlans()).toHaveLength(0)
      expect(manager.listRestoreJobs()).toHaveLength(0)
    })
  })
})
