import { describe, expect, it } from 'bun:test'
import type { CloudResource } from './resource-inventory'
import {
  cloudFrontOptimizationRecommendation,
  evaluateIdleResource,
  resourceOptimizationRecommendations,
} from './resource-optimization'

function resource(service: string, type: string, metadata: CloudResource['metadata'] = {}): CloudResource {
  return {
    arn: `arn:aws:${service}:us-east-1:123:${type}/id`,
    service,
    type,
    id: 'id',
    name: 'resource',
    region: 'us-east-1',
    tags: {},
    metadata,
  }
}

describe('unused AWS resource heuristics', () => {
  it('flags detached EBS and unassociated Elastic IP resources without metrics', () => {
    expect(evaluateIdleResource(resource('ec2', 'volume', { attached: false }), {})).toMatchObject({
      signal: 'EBS volume is detached',
    })
    expect(evaluateIdleResource(resource('ec2', 'elastic-ip', { associated: false }), {})).toMatchObject({
      signal: 'Elastic IP is not associated',
    })
  })

  it('uses the documented EC2, RDS, Lambda, S3, and ElastiCache thresholds', () => {
    expect(evaluateIdleResource(resource('ec2', 'instance'), { cpuAverage: 4.9 })).not.toBeNull()
    expect(evaluateIdleResource(resource('rds', 'db'), { connectionsAverage: 0, iopsAverage: 0.5 })).not.toBeNull()
    expect(evaluateIdleResource(resource('lambda', 'function'), { invocations: 0 })).not.toBeNull()
    expect(evaluateIdleResource(resource('s3', 's3'), { objectCount: 0, requests: 0 })).not.toBeNull()
    expect(
      evaluateIdleResource(resource('elasticache', 'cluster'), { connectionsAverage: 0, cacheHitRate: 10 }),
    ).not.toBeNull()
  })

  it('does not treat missing evidence or a boundary value as idle', () => {
    expect(evaluateIdleResource(resource('ec2', 'instance'), {})).toBeNull()
    expect(evaluateIdleResource(resource('ec2', 'instance'), { cpuAverage: 5 })).toBeNull()
    expect(evaluateIdleResource(resource('rds', 'db'), { connectionsAverage: 0 })).toBeNull()
    expect(evaluateIdleResource(resource('s3', 's3'), { objectCount: 0 })).toBeNull()
  })

  it('attaches CUR resource-level savings when available', () => {
    expect(evaluateIdleResource(resource('lambda', 'function'), { invocations: 0 }, 12.5)).toMatchObject({
      monthlySavings: 12.5,
    })
  })
})

describe('AWS cost optimization recommendations', () => {
  it('turns unused resources into full-cost removal estimates', () => {
    expect(resourceOptimizationRecommendations(resource('ec2', 'volume', { attached: false }), {}, 20)).toEqual([
      expect.objectContaining({
        category: 'unused',
        currentCost: 20,
        projectedCost: 0,
        monthlySavings: 20,
        sourceSignal: 'EBS volume is detached',
      }),
    ])
  })

  it('recommends right-sizing below 20% utilization with a directional estimate', () => {
    expect(resourceOptimizationRecommendations(resource('ec2', 'instance'), { cpuAverage: 12 }, 100)).toEqual([
      expect.objectContaining({
        category: 'right-size',
        currentCost: 100,
        projectedCost: 60,
        monthlySavings: 40,
      }),
    ])
  })

  it('only returns commitment candidates when explicitly requested', () => {
    const instance = { ...resource('ec2', 'instance'), state: 'running' }
    expect(resourceOptimizationRecommendations(instance, { cpuAverage: 45 }, 100)).toEqual([])
    expect(resourceOptimizationRecommendations(instance, { cpuAverage: 45 }, 100, true)).toEqual([
      expect.objectContaining({ category: 'commitment', projectedCost: 70, monthlySavings: 30 }),
    ])
  })

  it('uses bucket size and request activity for storage transitions', () => {
    expect(
      resourceOptimizationRecommendations(
        resource('s3', 'bucket'),
        { storageBytes: 6 * 1024 ** 3, requests: 100, objectCount: 1000 },
        40,
      ),
    ).toEqual([expect.objectContaining({ category: 'storage', projectedCost: 30, monthlySavings: 10 })])
  })

  it('uses real CloudFront transfer line items for account-level cache recommendations', () => {
    expect(cloudFrontOptimizationRecommendation(50, ['USW2-DataTransfer-Out-Bytes'])).toMatchObject({
      category: 'cdn',
      currentCost: 50,
      projectedCost: 40,
      monthlySavings: 10,
      sourceSignal: expect.stringContaining('USW2-DataTransfer-Out-Bytes'),
    })
    expect(cloudFrontOptimizationRecommendation(0, [])).toBeNull()
  })

  it('keeps cost fields explicitly unavailable without CUR resource IDs', () => {
    expect(resourceOptimizationRecommendations(resource('ec2', 'instance'), { cpuAverage: 10 }, null)).toEqual([
      expect.objectContaining({ currentCost: null, projectedCost: null, monthlySavings: null }),
    ])
  })
})
