import { describe, expect, it, beforeEach } from 'bun:test'
import { DisasterRecoveryManager } from './disaster-recovery'

describe('DisasterRecoveryManager', () => {
  let manager: DisasterRecoveryManager

  beforeEach(() => {
    manager = new DisasterRecoveryManager()
  })

  describe('DR Plan Creation', () => {
    it('should create DR plan', () => {
      const plan = manager.createDRPlan({
        name: 'Test DR Plan',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
        rto: 60,
        rpo: 5,
        resources: [
          {
            resourceId: 'db-1',
            resourceType: 'rds',
            primaryArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
            secondaryArn: 'arn:aws:rds:us-west-2:123456789012:db:mydb-replica',
            replicationEnabled: true,
          },
        ],
        runbook: {
          estimatedDuration: 60,
          steps: [
            {
              order: 1,
              name: 'Verify Failure',
              description: 'Check if primary is down',
              action: 'aws rds describe-db-instances',
              automatable: true,
              estimatedDuration: 2,
              rollbackable: false,
            },
          ],
        },
      })

      expect(plan.id).toMatch(/^dr-plan-\d+-\d+$/)
      expect(plan.name).toBe('Test DR Plan')
      expect(plan.primaryRegion).toBe('us-east-1')
      expect(plan.secondaryRegion).toBe('us-west-2')
      expect(plan.rto).toBe(60)
      expect(plan.rpo).toBe(5)
      expect(plan.resources).toHaveLength(1)
      expect(plan.runbook.steps).toHaveLength(1)
    })

    it('should get DR plan by id', () => {
      const plan = manager.createDRPlan({
        name: 'Test DR Plan',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
        rto: 60,
        rpo: 5,
        resources: [],
        runbook: { estimatedDuration: 60, steps: [] },
      })

      const retrieved = manager.getDRPlan(plan.id)
      expect(retrieved).toBeDefined()
      expect(retrieved?.id).toBe(plan.id)
      expect(retrieved?.name).toBe('Test DR Plan')
    })

    it('should return undefined for non-existent plan', () => {
      const plan = manager.getDRPlan('non-existent')
      expect(plan).toBeUndefined()
    })

    it('should list all DR plans', () => {
      manager.createDRPlan({
        name: 'Plan 1',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
        rto: 60,
        rpo: 5,
        resources: [],
        runbook: { estimatedDuration: 60, steps: [] },
      })

      manager.createDRPlan({
        name: 'Plan 2',
        primaryRegion: 'eu-west-1',
        secondaryRegion: 'eu-central-1',
        rto: 120,
        rpo: 10,
        resources: [],
        runbook: { estimatedDuration: 120, steps: [] },
      })

      const plans = manager.listDRPlans()
      expect(plans).toHaveLength(2)
      expect(plans[0].name).toBe('Plan 1')
      expect(plans[1].name).toBe('Plan 2')
    })

    it('should include test schedule', () => {
      const plan = manager.createDRPlan({
        name: 'Test DR Plan',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
        rto: 60,
        rpo: 5,
        resources: [],
        runbook: { estimatedDuration: 60, steps: [] },
        testSchedule: '0 0 1 * *',
      })

      expect(plan.testSchedule).toBe('0 0 1 * *')
    })
  })

  describe('RDS DR Plans', () => {
    it('should create RDS DR plan with defaults', () => {
      const plan = manager.createRDSDRPlan({
        primaryDbArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
        secondaryDbArn: 'arn:aws:rds:us-west-2:123456789012:db:mydb-replica',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
      })

      expect(plan.name).toBe('RDS Multi-Region DR')
      expect(plan.primaryRegion).toBe('us-east-1')
      expect(plan.secondaryRegion).toBe('us-west-2')
      expect(plan.rto).toBe(60)
      expect(plan.rpo).toBe(5)
      expect(plan.resources).toHaveLength(1)
      expect(plan.resources[0].resourceType).toBe('rds')
      expect(plan.resources[0].replicationEnabled).toBe(true)
      expect(plan.runbook.steps.length).toBeGreaterThan(0)
      expect(plan.testSchedule).toBe('0 0 1 * *')
    })

    it('should create RDS DR plan with custom RTO/RPO', () => {
      const plan = manager.createRDSDRPlan({
        primaryDbArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
        secondaryDbArn: 'arn:aws:rds:us-west-2:123456789012:db:mydb-replica',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
        rto: 30,
        rpo: 1,
      })

      expect(plan.rto).toBe(30)
      expect(plan.rpo).toBe(1)
    })

    it('should generate comprehensive RDS runbook', () => {
      const plan = manager.createRDSDRPlan({
        primaryDbArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
        secondaryDbArn: 'arn:aws:rds:us-west-2:123456789012:db:mydb-replica',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
      })

      expect(plan.runbook.estimatedDuration).toBe(60)
      expect(plan.runbook.requiredApprovals).toContain('cto')
      expect(plan.runbook.requiredApprovals).toContain('engineering-lead')
      expect(plan.runbook.steps).toHaveLength(7)

      // Verify step sequence
      const stepNames = plan.runbook.steps.map(s => s.name)
      expect(stepNames).toContain('Verify Primary Database Failure')
      expect(stepNames).toContain('Check Replication Lag')
      expect(stepNames).toContain('Promote Read Replica')
      expect(stepNames).toContain('Update DNS Records')
      expect(stepNames).toContain('Update Application Configuration')
      expect(stepNames).toContain('Verify Application Connectivity')
      expect(stepNames).toContain('Monitor for Issues')
    })

    it('should mark most RDS steps as automatable', () => {
      const plan = manager.createRDSDRPlan({
        primaryDbArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
        secondaryDbArn: 'arn:aws:rds:us-west-2:123456789012:db:mydb-replica',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
      })

      const automatableSteps = plan.runbook.steps.filter(s => s.automatable)
      expect(automatableSteps.length).toBeGreaterThan(4)
    })
  })

  describe('DynamoDB DR Plans', () => {
    it('should create DynamoDB DR plan with defaults', () => {
      const plan = manager.createDynamoDBDRPlan({
        tableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/my-table',
        regions: ['us-east-1', 'us-west-2'],
      })

      expect(plan.name).toBe('DynamoDB Global Tables DR')
      expect(plan.primaryRegion).toBe('us-east-1')
      expect(plan.secondaryRegion).toBe('us-west-2')
      expect(plan.rto).toBe(15)
      expect(plan.rpo).toBe(1)
      expect(plan.resources).toHaveLength(1)
      expect(plan.resources[0].resourceType).toBe('dynamodb')
      expect(plan.resources[0].replicationEnabled).toBe(true)
    })

    it('should create DynamoDB DR plan with custom RTO/RPO', () => {
      const plan = manager.createDynamoDBDRPlan({
        tableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/my-table',
        regions: ['us-east-1', 'eu-west-1'],
        rto: 10,
        rpo: 0,
      })

      expect(plan.rto).toBe(10)
      expect(plan.rpo).toBe(0)
    })

    it('should generate DynamoDB runbook', () => {
      const plan = manager.createDynamoDBDRPlan({
        tableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/my-table',
        regions: ['us-east-1', 'us-west-2'],
      })

      expect(plan.runbook.estimatedDuration).toBe(15)
      expect(plan.runbook.steps).toHaveLength(4)

      const stepNames = plan.runbook.steps.map(s => s.name)
      expect(stepNames).toContain('Verify Primary Region Failure')
      expect(stepNames).toContain('Update Route53 Failover')
      expect(stepNames).toContain('Update Application Endpoints')
      expect(stepNames).toContain('Verify Data Consistency')
    })

    it('should mark all DynamoDB steps as automatable', () => {
      const plan = manager.createDynamoDBDRPlan({
        tableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/my-table',
        regions: ['us-east-1', 'us-west-2'],
      })

      const allAutomatable = plan.runbook.steps.every(s => s.automatable)
      expect(allAutomatable).toBe(true)
    })
  })

  describe('Failover Execution', () => {
    it('should execute failover in dry run mode', async () => {
      const plan = manager.createRDSDRPlan({
        primaryDbArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
        secondaryDbArn: 'arn:aws:rds:us-west-2:123456789012:db:mydb-replica',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
      })

      const result = await manager.executeFailover(plan.id, true)

      expect(result.success).toBe(true)
      expect(result.completedSteps).toBe(7)
      expect(result.duration).toBeGreaterThanOrEqual(0)
    })

    it('should execute failover in production mode', async () => {
      const plan = manager.createRDSDRPlan({
        primaryDbArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
        secondaryDbArn: 'arn:aws:rds:us-west-2:123456789012:db:mydb-replica',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
      })

      const result = await manager.executeFailover(plan.id, false)

      expect(result.success).toBe(true)
      expect(result.completedSteps).toBe(7)
    })

    it('should throw error for non-existent plan', async () => {
      await expect(manager.executeFailover('non-existent', true)).rejects.toThrow(
        'DR plan not found: non-existent',
      )
    })

    it('should execute all steps in order', async () => {
      const plan = manager.createDynamoDBDRPlan({
        tableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/my-table',
        regions: ['us-east-1', 'us-west-2'],
      })

      const result = await manager.executeFailover(plan.id, true)

      expect(result.completedSteps).toBe(plan.runbook.steps.length)
    })
  })

  describe('Failover Testing', () => {
    it('should schedule failover test', () => {
      const plan = manager.createRDSDRPlan({
        primaryDbArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
        secondaryDbArn: 'arn:aws:rds:us-west-2:123456789012:db:mydb-replica',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
      })

      const testDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days from now
      const test = manager.scheduleFailoverTest(plan.id, testDate)

      expect(test.id).toMatch(/^failover-test-\d+-\d+$/)
      expect(test.planId).toBe(plan.id)
      expect(test.status).toBe('scheduled')
      expect(test.startTime).toEqual(testDate)
    })

    it('should run failover test', async () => {
      const plan = manager.createRDSDRPlan({
        primaryDbArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
        secondaryDbArn: 'arn:aws:rds:us-west-2:123456789012:db:mydb-replica',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
      })

      const test = await manager.runFailoverTest(plan.id)

      expect(test.id).toMatch(/^failover-test-\d+-\d+$/)
      expect(test.planId).toBe(plan.id)
      expect(test.status).toBe('completed')
      expect(test.startTime).toBeInstanceOf(Date)
      expect(test.endTime).toBeInstanceOf(Date)
      expect(test.results).toBeDefined()
      expect(test.results).toHaveLength(plan.runbook.steps.length)
    })

    it('should throw error for non-existent plan in test', async () => {
      await expect(manager.runFailoverTest('non-existent')).rejects.toThrow(
        'DR plan not found: non-existent',
      )
    })

    it('should record test results for all steps', async () => {
      const plan = manager.createDynamoDBDRPlan({
        tableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/my-table',
        regions: ['us-east-1', 'us-west-2'],
      })

      const test = await manager.runFailoverTest(plan.id)

      expect(test.results).toHaveLength(4)
      test.results!.forEach((result) => {
        expect(result.status).toBe('success')
        expect(result.duration).toBeGreaterThanOrEqual(0)
        expect(result.message).toContain('Successfully validated')
      })
    })

    it('should get failover test by id', async () => {
      const plan = manager.createRDSDRPlan({
        primaryDbArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
        secondaryDbArn: 'arn:aws:rds:us-west-2:123456789012:db:mydb-replica',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
      })

      const test = await manager.runFailoverTest(plan.id)
      const retrieved = manager.getFailoverTest(test.id)

      expect(retrieved).toBeDefined()
      expect(retrieved?.id).toBe(test.id)
      expect(retrieved?.status).toBe('completed')
    })

    it('should list all failover tests', async () => {
      const plan1 = manager.createRDSDRPlan({
        primaryDbArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
        secondaryDbArn: 'arn:aws:rds:us-west-2:123456789012:db:mydb-replica',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
      })

      const plan2 = manager.createDynamoDBDRPlan({
        tableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/my-table',
        regions: ['us-east-1', 'us-west-2'],
      })

      await manager.runFailoverTest(plan1.id)
      await manager.runFailoverTest(plan2.id)

      const tests = manager.listFailoverTests()
      expect(tests.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('DR Plan Validation', () => {
    it('should validate valid DR plan', () => {
      const plan = manager.createRDSDRPlan({
        primaryDbArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
        secondaryDbArn: 'arn:aws:rds:us-west-2:123456789012:db:mydb-replica',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
        rto: 60,
        rpo: 5,
      })

      const validation = manager.validateDRPlan(plan)

      expect(validation.valid).toBe(true)
      expect(validation.errors).toHaveLength(0)
    })

    it('should error when RTO is less than RPO', () => {
      const plan = manager.createDRPlan({
        name: 'Invalid Plan',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
        rto: 5,
        rpo: 10,
        resources: [],
        runbook: { estimatedDuration: 5, steps: [] },
      })

      const validation = manager.validateDRPlan(plan)

      expect(validation.valid).toBe(false)
      expect(validation.errors).toContain('RTO cannot be less than RPO')
    })

    it('should warn when RTO exceeds 4 hours', () => {
      const plan = manager.createDRPlan({
        name: 'Long RTO Plan',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
        rto: 300,
        rpo: 60,
        resources: [
          {
            resourceId: 'db-1',
            resourceType: 'rds',
            primaryArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
            replicationEnabled: true,
          },
        ],
        runbook: { estimatedDuration: 60, steps: [
          {
            order: 1,
            name: 'Test',
            description: 'Test',
            action: 'test',
            automatable: true,
            estimatedDuration: 5,
            rollbackable: false,
          },
        ] },
      })

      const validation = manager.validateDRPlan(plan)

      expect(validation.warnings).toContain('RTO exceeds 4 hours - consider improving recovery time')
    })

    it('should warn when RPO exceeds 1 hour', () => {
      const plan = manager.createDRPlan({
        name: 'Long RPO Plan',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
        rto: 120,
        rpo: 90,
        resources: [
          {
            resourceId: 'db-1',
            resourceType: 'rds',
            primaryArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
            replicationEnabled: true,
          },
        ],
        runbook: { estimatedDuration: 60, steps: [
          {
            order: 1,
            name: 'Test',
            description: 'Test',
            action: 'test',
            automatable: true,
            estimatedDuration: 5,
            rollbackable: false,
          },
        ] },
      })

      const validation = manager.validateDRPlan(plan)

      expect(validation.warnings).toContain('RPO exceeds 1 hour - consider more frequent backups')
    })

    it('should error when no resources defined', () => {
      const plan = manager.createDRPlan({
        name: 'No Resources Plan',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
        rto: 60,
        rpo: 5,
        resources: [],
        runbook: { estimatedDuration: 60, steps: [
          {
            order: 1,
            name: 'Test',
            description: 'Test',
            action: 'test',
            automatable: true,
            estimatedDuration: 5,
            rollbackable: false,
          },
        ] },
      })

      const validation = manager.validateDRPlan(plan)

      expect(validation.valid).toBe(false)
      expect(validation.errors).toContain('No resources defined in DR plan')
    })

    it('should warn when replication not enabled', () => {
      const plan = manager.createDRPlan({
        name: 'No Replication Plan',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
        rto: 60,
        rpo: 5,
        resources: [
          {
            resourceId: 'db-1',
            resourceType: 'rds',
            primaryArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
            replicationEnabled: false,
          },
        ],
        runbook: { estimatedDuration: 60, steps: [
          {
            order: 1,
            name: 'Test',
            description: 'Test',
            action: 'test',
            automatable: true,
            estimatedDuration: 5,
            rollbackable: false,
          },
        ] },
      })

      const validation = manager.validateDRPlan(plan)

      expect(validation.warnings).toContain('Resource db-1 does not have replication enabled')
    })

    it('should warn when no secondary ARN for non-DynamoDB resources', () => {
      const plan = manager.createDRPlan({
        name: 'No Secondary ARN Plan',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
        rto: 60,
        rpo: 5,
        resources: [
          {
            resourceId: 'db-1',
            resourceType: 'rds',
            primaryArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
            replicationEnabled: true,
          },
        ],
        runbook: { estimatedDuration: 60, steps: [
          {
            order: 1,
            name: 'Test',
            description: 'Test',
            action: 'test',
            automatable: true,
            estimatedDuration: 5,
            rollbackable: false,
          },
        ] },
      })

      const validation = manager.validateDRPlan(plan)

      expect(validation.warnings).toContain('Resource db-1 does not have secondary resource defined')
    })

    it('should error when no recovery steps defined', () => {
      const plan = manager.createDRPlan({
        name: 'No Steps Plan',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
        rto: 60,
        rpo: 5,
        resources: [
          {
            resourceId: 'db-1',
            resourceType: 'rds',
            primaryArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
            replicationEnabled: true,
          },
        ],
        runbook: { estimatedDuration: 60, steps: [] },
      })

      const validation = manager.validateDRPlan(plan)

      expect(validation.valid).toBe(false)
      expect(validation.errors).toContain('No recovery steps defined in runbook')
    })

    it('should warn when estimated duration exceeds RTO', () => {
      const plan = manager.createDRPlan({
        name: 'Slow Recovery Plan',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
        rto: 30,
        rpo: 5,
        resources: [
          {
            resourceId: 'db-1',
            resourceType: 'rds',
            primaryArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
            replicationEnabled: true,
          },
        ],
        runbook: {
          estimatedDuration: 60,
          steps: [
            {
              order: 1,
              name: 'Step 1',
              description: 'Test',
              action: 'test',
              automatable: true,
              estimatedDuration: 20,
              rollbackable: false,
            },
            {
              order: 2,
              name: 'Step 2',
              description: 'Test',
              action: 'test',
              automatable: true,
              estimatedDuration: 25,
              rollbackable: false,
            },
          ],
        },
      })

      const validation = manager.validateDRPlan(plan)

      expect(validation.warnings).toContain('Estimated recovery duration (45m) exceeds RTO (30m)')
    })

    it('should warn when manual steps exist', () => {
      const plan = manager.createDRPlan({
        name: 'Manual Steps Plan',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
        rto: 60,
        rpo: 5,
        resources: [
          {
            resourceId: 'db-1',
            resourceType: 'rds',
            primaryArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
            replicationEnabled: true,
          },
        ],
        runbook: {
          estimatedDuration: 60,
          steps: [
            {
              order: 1,
              name: 'Automated Step',
              description: 'Test',
              action: 'test',
              automatable: true,
              estimatedDuration: 10,
              rollbackable: false,
            },
            {
              order: 2,
              name: 'Manual Step 1',
              description: 'Test',
              action: 'test',
              automatable: false,
              estimatedDuration: 20,
              rollbackable: false,
            },
            {
              order: 3,
              name: 'Manual Step 2',
              description: 'Test',
              action: 'test',
              automatable: false,
              estimatedDuration: 15,
              rollbackable: false,
            },
          ],
        },
      })

      const validation = manager.validateDRPlan(plan)

      expect(validation.warnings).toContain('2 manual steps in runbook - consider automation')
    })
  })

  describe('Clear Data', () => {
    it('should clear all data', async () => {
      const plan = manager.createRDSDRPlan({
        primaryDbArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
        secondaryDbArn: 'arn:aws:rds:us-west-2:123456789012:db:mydb-replica',
        primaryRegion: 'us-east-1',
        secondaryRegion: 'us-west-2',
      })

      await manager.runFailoverTest(plan.id)

      manager.clear()

      expect(manager.getDRPlan(plan.id)).toBeUndefined()
      expect(manager.listDRPlans()).toHaveLength(0)
      expect(manager.listFailoverTests()).toHaveLength(0)
    })
  })
})
