import { describe, expect, it } from 'bun:test'
import type { CloudResource } from './resource-inventory'
import { evaluateIdleResource } from './resource-optimization'

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
