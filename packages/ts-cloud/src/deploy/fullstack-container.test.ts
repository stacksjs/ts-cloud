import { describe, expect, it } from 'bun:test'
import type { ExistingStaticFullStackDependencies } from './fullstack-container'
import { deployExistingStaticFullStack, estimateExistingStaticFullStackMonthlyCost, generateExistingStaticFullStackTemplate } from './fullstack-container'

const imageUri = `923076644019.dkr.ecr.us-east-1.amazonaws.com/example@sha256:${'a'.repeat(64)}`

function options() {
  return { name: 'Example', slug: 'example', imageUri, distributionId: 'E123456789AB', expectedAlias: 'example.com', originDomain: 'origin-api.example.com', certificateArn: 'arn:aws:acm:us-east-1:923076644019:certificate/one' }
}

function fake(): { dependencies: ExistingStaticFullStackDependencies, calls: string[] } {
  const calls: string[] = []
  let created = false
  return {
    calls,
    dependencies: {
      sts: { getCallerIdentity: async () => ({ Account: '923076644019' }) },
      cloudfront: {
        getDistribution: async () => ({ Id: 'E123456789AB', ARN: 'arn:aws:cloudfront::923076644019:distribution/E123456789AB', Status: 'Deployed', DomainName: 'd.example.cloudfront.net', Enabled: true, Aliases: { Items: ['example.com'] } }),
        upsertExistingDistributionOrigin: async (_id, input) => { calls.push(`cloudfront:${input.domainName}`); return { distributionId: 'E123456789AB', originId: input.id, domainName: input.domainName, pathPattern: input.pathPattern, changed: true, applied: true, etag: 'two' } },
      },
      cloudformation: {
        describeStacks: async () => {
          if (!created) throw Object.assign(new Error('Stack with id example-backend does not exist'), { code: 'ValidationError' })
          return { Stacks: [{ StackId: 'stack', StackName: 'example-backend', StackStatus: 'CREATE_COMPLETE', CreationTime: 'now', Outputs: [{ OutputKey: 'AppLoadBalancerDnsName', OutputValue: 'example-alb.us-east-1.elb.amazonaws.com' }] }] }
        },
        createStack: async () => { created = true; calls.push('create-stack'); return { StackId: 'stack' } },
        updateStack: async () => { calls.push('update-stack'); return { StackId: 'stack' } },
        waitForStack: async () => { calls.push('wait-stack') },
      },
      dns: { upsertRecord: async (_domain, record) => { calls.push(`dns:${record.content}`); return { success: true } } },
      fetch: (async () => { calls.push('health'); return new Response(JSON.stringify({ ok: true }), { status: 200 }) }) as unknown as typeof fetch,
      sleep: async () => {},
    },
  }
}

describe('existing static full-stack deployment', () => {
  it('generates a backend-only template from an immutable image', () => {
    const template = generateExistingStaticFullStackTemplate(options())
    expect(template.Resources.AppService.Type).toBe('AWS::ECS::Service')
    expect(template.Resources.PostgresDb.Type).toBe('AWS::RDS::DBInstance')
    expect(template.Resources.RedisReplicationGroup.Type).toBe('AWS::ElastiCache::ReplicationGroup')
    expect(template.Resources.CloudFrontDistribution).toBeUndefined()
    expect(template.Metadata.ContainerDigest).toBe(`sha256:${'a'.repeat(64)}`)
  })

  it('refuses a mutable container tag', async () => {
    const value = fake()
    await expect(deployExistingStaticFullStack({ ...options(), imageUri: 'example:latest' }, value.dependencies)).rejects.toThrow('immutable ECR digest URI')
    expect(value.calls).toEqual([])
  })

  it('returns a read-only account, stack, routing, and cost plan', async () => {
    const value = fake()
    const plan = await deployExistingStaticFullStack(options(), value.dependencies)
    expect(plan.mode).toBe('plan')
    expect(plan.stack.existed).toBe(false)
    expect(plan.stack.resourceTypes['AWS::ECS::Service']).toBe(1)
    expect(plan.services).toEqual({ database: true, cache: true, queue: true, mail: 'ses', desiredCount: 1 })
    expect(value.calls).toEqual([])
  })

  it('provisions, maps external DNS, checks health, then changes CloudFront', async () => {
    const value = fake()
    const plan = await deployExistingStaticFullStack({ ...options(), apply: true, confirm: 'E123456789AB:/api/*:example-backend' }, value.dependencies)
    expect(plan.applied).toBe(true)
    expect(plan.health?.status).toBe(200)
    expect(value.calls).toEqual(['create-stack', 'wait-stack', 'dns:example-alb.us-east-1.elb.amazonaws.com', 'health', 'cloudfront:origin-api.example.com'])
  })

  it('estimates every always-on baseline component explicitly', () => {
    const estimate = estimateExistingStaticFullStackMonthlyCost()
    expect(Object.keys(estimate.components)).toEqual(['fargate', 'applicationLoadBalancer', 'natGateway', 'postgres', 'redis'])
    expect(estimate.monthlyUsd).toBeGreaterThan(80)
  })
})
