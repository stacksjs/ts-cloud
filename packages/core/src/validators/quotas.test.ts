/**
 * Service Quota Validation Tests
 */

import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_SERVICE_LIMITS,
  checkServiceQuotas,
  getQuotaUsageSummary,
  suggestQuotaIncrease,
} from './quotas'

describe('DEFAULT_SERVICE_LIMITS', () => {
  it('should have EC2 limits', () => {
    expect(DEFAULT_SERVICE_LIMITS.ec2).toBeDefined()
    expect(DEFAULT_SERVICE_LIMITS.ec2['Running On-Demand Instances']).toBe(20)
    expect(DEFAULT_SERVICE_LIMITS.ec2['VPCs']).toBe(5)
    expect(DEFAULT_SERVICE_LIMITS.ec2['Security Groups']).toBe(500)
  })

  it('should have RDS limits', () => {
    expect(DEFAULT_SERVICE_LIMITS.rds).toBeDefined()
    expect(DEFAULT_SERVICE_LIMITS.rds['DB Instances']).toBe(40)
  })

  it('should have S3 limits', () => {
    expect(DEFAULT_SERVICE_LIMITS.s3).toBeDefined()
    expect(DEFAULT_SERVICE_LIMITS.s3['Buckets']).toBe(100)
  })

  it('should have Lambda limits', () => {
    expect(DEFAULT_SERVICE_LIMITS.lambda).toBeDefined()
    expect(DEFAULT_SERVICE_LIMITS.lambda['Concurrent Executions']).toBe(1000)
  })

  it('should have DynamoDB limits', () => {
    expect(DEFAULT_SERVICE_LIMITS.dynamodb).toBeDefined()
    expect(DEFAULT_SERVICE_LIMITS.dynamodb['Tables']).toBe(256)
  })
})

describe('checkServiceQuotas', () => {
  it('should return empty array for minimal config', async () => {
    const quotas = await checkServiceQuotas({
      project: { name: 'Test', slug: 'test' },
    })

    expect(Array.isArray(quotas)).toBe(true)
    expect(quotas.length).toBe(0)
  })

  it('should check EC2 instance quotas', async () => {
    const quotas = await checkServiceQuotas({
      project: { name: 'Test', slug: 'test' },
      infrastructure: {
        compute: {
          server: {
            autoScaling: {
              max: 10,
            },
          },
        },
      },
    })

    const ec2Quota = quotas.find(q => q.quotaName === 'Running On-Demand Instances')
    expect(ec2Quota).toBeDefined()
    expect(ec2Quota?.service).toBe('EC2')
    expect(ec2Quota?.currentValue).toBe(10)
    expect(ec2Quota?.limit).toBe(20)
    expect(ec2Quota?.percentage).toBe(50)
    expect(ec2Quota?.warning).toBe(false)
  })

  it('should warn when EC2 quota exceeds 80%', async () => {
    const quotas = await checkServiceQuotas({
      project: { name: 'Test', slug: 'test' },
      infrastructure: {
        compute: {
          server: {
            autoScaling: {
              max: 17,
            },
          },
        },
      },
    })

    const ec2Quota = quotas.find(q => q.quotaName === 'Running On-Demand Instances')
    expect(ec2Quota?.warning).toBe(true)
  })

  it('should check VPC quotas', async () => {
    const quotas = await checkServiceQuotas({
      project: { name: 'Test', slug: 'test' },
      infrastructure: {
        network: {
          vpc: {},
        },
      },
    })

    const vpcQuota = quotas.find(q => q.quotaName === 'VPCs')
    expect(vpcQuota).toBeDefined()
    expect(vpcQuota?.service).toBe('EC2')
    expect(vpcQuota?.currentValue).toBe(1)
    expect(vpcQuota?.limit).toBe(5)
  })

  it('should check RDS database quotas', async () => {
    const quotas = await checkServiceQuotas({
      project: { name: 'Test', slug: 'test' },
      infrastructure: {
        database: {
          postgres: {},
        },
      },
    })

    const rdsQuota = quotas.find(q => q.quotaName === 'DB Instances')
    expect(rdsQuota).toBeDefined()
    expect(rdsQuota?.service).toBe('RDS')
    expect(rdsQuota?.currentValue).toBe(1)
    expect(rdsQuota?.limit).toBe(40)
  })

  it('should check S3 bucket quotas', async () => {
    const quotas = await checkServiceQuotas({
      project: { name: 'Test', slug: 'test' },
      infrastructure: {
        storage: {
          uploads: {},
          assets: {},
          backups: {},
        },
      },
    })

    const s3Quota = quotas.find(q => q.quotaName === 'Buckets')
    expect(s3Quota).toBeDefined()
    expect(s3Quota?.service).toBe('S3')
    expect(s3Quota?.currentValue).toBe(3)
    expect(s3Quota?.limit).toBe(100)
  })

  it('should warn when S3 bucket quota exceeds 80%', async () => {
    const storage: any = {}
    for (let i = 0; i < 85; i++) {
      storage[`bucket${i}`] = {}
    }

    const quotas = await checkServiceQuotas({
      project: { name: 'Test', slug: 'test' },
      infrastructure: {
        storage,
      },
    })

    const s3Quota = quotas.find(q => q.quotaName === 'Buckets')
    expect(s3Quota?.warning).toBe(true)
  })

  it('should check Lambda function quotas', async () => {
    const quotas = await checkServiceQuotas({
      project: { name: 'Test', slug: 'test' },
      infrastructure: {
        functions: {
          api: [
            { name: 'handler1', runtime: 'nodejs20.x' },
            { name: 'handler2', runtime: 'nodejs20.x' },
          ],
        },
      },
    })

    const lambdaQuota = quotas.find(q => q.quotaName === 'Functions (estimated)')
    expect(lambdaQuota).toBeDefined()
    expect(lambdaQuota?.service).toBe('Lambda')
    expect(lambdaQuota?.currentValue).toBe(2)
    expect(lambdaQuota?.limit).toBe(1000)
  })

  it('should check DynamoDB table quotas', async () => {
    const quotas = await checkServiceQuotas({
      project: { name: 'Test', slug: 'test' },
      infrastructure: {
        database: {
          dynamodb: {
            tables: [
              { name: 'users', partitionKey: 'id' },
              { name: 'posts', partitionKey: 'id' },
            ],
          },
        },
      },
    })

    const dynamoQuota = quotas.find(q => q.quotaName === 'Tables')
    expect(dynamoQuota).toBeDefined()
    expect(dynamoQuota?.service).toBe('DynamoDB')
    expect(dynamoQuota?.currentValue).toBe(2)
    expect(dynamoQuota?.limit).toBe(256)
  })

  it('should check multiple quotas at once', async () => {
    const quotas = await checkServiceQuotas({
      project: { name: 'Test', slug: 'test' },
      infrastructure: {
        compute: {
          server: {
            autoScaling: { max: 5 },
          },
        },
        network: {
          vpc: {},
        },
        storage: {
          uploads: {},
        },
        database: {
          postgres: {},
        },
      },
    })

    expect(quotas.length).toBeGreaterThan(0)
    expect(quotas.some(q => q.service === 'EC2')).toBe(true)
    expect(quotas.some(q => q.service === 'S3')).toBe(true)
    expect(quotas.some(q => q.service === 'RDS')).toBe(true)
  })
})

describe('getQuotaUsageSummary', () => {
  it('should return message for empty quotas', () => {
    const summary = getQuotaUsageSummary([])

    expect(summary).toBe('No quotas to check')
  })

  it('should format quota usage summary', () => {
    const summary = getQuotaUsageSummary([
      {
        service: 'EC2',
        quotaName: 'Running Instances',
        currentValue: 10,
        limit: 20,
        percentage: 50,
        warning: false,
      },
      {
        service: 'S3',
        quotaName: 'Buckets',
        currentValue: 5,
        limit: 100,
        percentage: 5,
        warning: false,
      },
    ])

    expect(summary).toContain('Service Quota Usage')
    expect(summary).toContain('EC2')
    expect(summary).toContain('Running Instances')
    expect(summary).toContain('10/20')
    expect(summary).toContain('50.0%')
    expect(summary).toContain('S3')
    expect(summary).toContain('Buckets')
  })

  it('should show warning indicator for quota warnings', () => {
    const summary = getQuotaUsageSummary([
      {
        service: 'EC2',
        quotaName: 'Running Instances',
        currentValue: 18,
        limit: 20,
        percentage: 90,
        warning: true,
      },
    ])

    expect(summary).toContain('⚠')
  })

  it('should show checkmark for normal usage', () => {
    const summary = getQuotaUsageSummary([
      {
        service: 'EC2',
        quotaName: 'Running Instances',
        currentValue: 5,
        limit: 20,
        percentage: 25,
        warning: false,
      },
    ])

    expect(summary).toContain('✓')
  })

  it('should group quotas by service', () => {
    const summary = getQuotaUsageSummary([
      {
        service: 'EC2',
        quotaName: 'Instances',
        currentValue: 5,
        limit: 20,
        percentage: 25,
        warning: false,
      },
      {
        service: 'EC2',
        quotaName: 'VPCs',
        currentValue: 2,
        limit: 5,
        percentage: 40,
        warning: false,
      },
      {
        service: 'S3',
        quotaName: 'Buckets',
        currentValue: 3,
        limit: 100,
        percentage: 3,
        warning: false,
      },
    ])

    // Should have EC2 section with 2 items
    const ec2Section = summary.split('S3:')[0]
    expect(ec2Section).toContain('Instances')
    expect(ec2Section).toContain('VPCs')
  })
})

describe('suggestQuotaIncrease', () => {
  it('should return empty array for no warnings', () => {
    const suggestions = suggestQuotaIncrease([
      {
        service: 'EC2',
        quotaName: 'Instances',
        currentValue: 5,
        limit: 20,
        percentage: 25,
        warning: false,
      },
    ])

    expect(suggestions).toEqual([])
  })

  it('should suggest increase for quotas at 100%', () => {
    const suggestions = suggestQuotaIncrease([
      {
        service: 'EC2',
        quotaName: 'Instances',
        currentValue: 20,
        limit: 20,
        percentage: 100,
        warning: true,
      },
    ])

    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toContain('Request quota increase')
    expect(suggestions[0]).toContain('EC2')
    expect(suggestions[0]).toContain('Instances')
    expect(suggestions[0]).toContain('20')
  })

  it('should suggest consideration for quotas with warnings', () => {
    const suggestions = suggestQuotaIncrease([
      {
        service: 'S3',
        quotaName: 'Buckets',
        currentValue: 85,
        limit: 100,
        percentage: 85,
        warning: true,
      },
    ])

    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toContain('Consider requesting quota increase')
    expect(suggestions[0]).toContain('S3')
    expect(suggestions[0]).toContain('Buckets')
    expect(suggestions[0]).toContain('85.0%')
  })

  it('should provide multiple suggestions', () => {
    const suggestions = suggestQuotaIncrease([
      {
        service: 'EC2',
        quotaName: 'Instances',
        currentValue: 20,
        limit: 20,
        percentage: 100,
        warning: true,
      },
      {
        service: 'S3',
        quotaName: 'Buckets',
        currentValue: 85,
        limit: 100,
        percentage: 85,
        warning: true,
      },
    ])

    expect(suggestions).toHaveLength(2)
  })

  it('should prioritize 100% quotas over warnings', () => {
    const suggestions = suggestQuotaIncrease([
      {
        service: 'EC2',
        quotaName: 'Instances',
        currentValue: 20,
        limit: 20,
        percentage: 100,
        warning: true,
      },
      {
        service: 'S3',
        quotaName: 'Buckets',
        currentValue: 85,
        limit: 100,
        percentage: 85,
        warning: true,
      },
    ])

    expect(suggestions[0]).toContain('Request quota increase')
    expect(suggestions[1]).toContain('Consider requesting')
  })
})
