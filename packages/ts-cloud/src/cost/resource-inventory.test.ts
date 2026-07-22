import { describe, expect, it } from 'bun:test'
import { ResourceInventoryClient, mergeResources, parseResourceArn } from './resource-inventory'

describe('AWS resource inventory', () => {
  it('normalizes ARNs and names from tags', () => {
    expect(parseResourceArn('arn:aws:ec2:us-east-1:123456789012:instance/i-123', { Name: 'web' })).toMatchObject({
      service: 'ec2',
      type: 'instance',
      id: 'i-123',
      name: 'web',
      region: 'us-east-1',
      accountId: '123456789012',
    })
  })

  it('merges tagged and direct-discovery records without losing metadata', () => {
    const tagged = parseResourceArn('arn:aws:ec2:us-east-1:123456789012:instance/i-123', { Team: 'platform' })
    const direct = {
      ...parseResourceArn('arn:aws:ec2:us-east-1::instance/i-123'),
      state: 'running',
      metadata: { instanceType: 'm7g.large' },
    }
    expect(mergeResources([tagged, direct])).toEqual([
      expect.objectContaining({
        arn: tagged.arn,
        state: 'running',
        tags: { Team: 'platform' },
        metadata: { instanceType: 'm7g.large' },
      }),
    ])
  })

  it('follows Resource Groups Tagging API pagination', async () => {
    const client = new ResourceInventoryClient()
    let calls = 0
    // @ts-expect-error test seam for direct AWS transport
    client.client.request = async () => {
      calls++
      return calls === 1
        ? {
            ResourceTagMappingList: [
              { ResourceARN: 'arn:aws:lambda:us-east-1:123:function:first', Tags: [{ Key: 'Name', Value: 'First' }] },
            ],
            PaginationToken: 'next',
          }
        : { ResourceTagMappingList: [{ ResourceARN: 'arn:aws:s3:::second', Tags: [] }] }
    }
    // @ts-expect-error test seam for the private provider operation
    const resources = await client.taggedResources()
    expect(resources.map((resource: any) => resource.name)).toEqual(['First', 'second'])
    expect(calls).toBe(2)
  })

  it('unions providers, filters aliases, and surfaces partial coverage', async () => {
    const client = new ResourceInventoryClient()
    const ec2 = parseResourceArn('arn:aws:ec2:us-east-1:123:instance/i-1')
    const s3 = parseResourceArn('arn:aws:s3:::assets')
    // @ts-expect-error controlled provider seams
    client.taggedResources = async () => [ec2]
    // @ts-expect-error controlled provider seams
    client.ec2Resources = async () => [ec2]
    // @ts-expect-error controlled provider seams
    client.rdsResources = async () => {
      throw new Error('denied')
    }
    // @ts-expect-error controlled provider seams
    client.lambdaResources = async () => []
    // @ts-expect-error controlled provider seams
    client.s3Resources = async () => [s3]

    const result = await client.discover({ type: 'ec2' })
    expect(result.resources).toHaveLength(1)
    expect(result.resources[0].id).toBe('i-1')
    expect(result.warnings).toEqual([expect.stringContaining('rds:DescribeDBInstances unavailable: denied')])
  })
})
