/**
 * The AWS driver's teardown, driven end to end against a fake EC2 API: which
 * region it acts in, which instances it terminates, and which security group
 * it deletes.
 */

import type { EC2Client } from '../../src/aws/ec2'
import type { CloudConfig } from '@ts-cloud/core'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { AwsDriver } from '../../src/drivers/aws/driver'
import { awsResourceTags } from '../../src/drivers/aws/provision'

interface FakeInstance {
  InstanceId: string
  VpcId?: string
  Tags: { Key: string; Value: string }[]
}

interface FakeGroup {
  GroupId: string
  GroupName: string
  VpcId?: string
  Tags?: { Key: string; Value: string }[]
}

interface FakeAws {
  clientsBuiltFor: string[]
  terminated: string[]
  deletedGroups: string[]
  describedIn: string[]
  ec2Client: (region: string) => EC2Client
}

/** An EC2 API whose contents differ per region, so a wrong region shows up. */
function fakeAws(byRegion: Record<string, { instances?: FakeInstance[]; groups?: FakeGroup[] }>): FakeAws {
  const state: FakeAws = {
    clientsBuiltFor: [],
    terminated: [],
    deletedGroups: [],
    describedIn: [],
    ec2Client: () => ({}) as EC2Client,
  }

  state.ec2Client = (region: string): EC2Client => {
    state.clientsBuiltFor.push(region)
    const instances = byRegion[region]?.instances ?? []
    const groups = byRegion[region]?.groups ?? []

    return {
      describeInstances: async (options?: { InstanceIds?: string[]; Filters?: { Name: string; Values: string[] }[] }) => {
        state.describedIn.push(region)
        const wanted = options?.InstanceIds
        const matching = instances.filter((instance) => {
          if (wanted) return wanted.includes(instance.InstanceId)
          return (options?.Filters ?? []).every((filter) => {
            if (!filter.Name.startsWith('tag:')) return true
            const key = filter.Name.slice(4)
            return filter.Values.includes(instance.Tags.find((tag) => tag.Key === key)?.Value ?? '')
          })
        })
        return { Reservations: [{ Instances: matching }] }
      },
      terminateInstances: async (ids: string[]) => {
        state.terminated.push(...ids)
        return {}
      },
      waitForInstanceState: async () => undefined,
      describeSecurityGroups: async (options?: { Filters?: { Name: string; Values: string[] }[] }) => {
        const filters = options?.Filters ?? []
        const name = filters.find((f) => f.Name === 'group-name')?.Values[0]
        const vpc = filters.find((f) => f.Name === 'vpc-id')?.Values[0]
        return {
          SecurityGroups: groups.filter(
            (group) => (!name || group.GroupName === name) && (!vpc || group.VpcId === vpc),
          ),
        }
      },
      deleteSecurityGroup: async (groupId: string) => {
        state.deletedGroups.push(groupId)
      },
    } as unknown as EC2Client
  }

  return state
}

function config(region: string): CloudConfig {
  return {
    project: { name: 'My App', slug: 'my-app', region },
    environments: { production: { type: 'production' } },
    cloud: { provider: 'aws' },
    infrastructure: { compute: { size: 'small' } },
  }
}

const instance = (id: string, vpcId: string): FakeInstance => ({
  InstanceId: id,
  VpcId: vpcId,
  Tags: awsResourceTags('my-app', 'production'),
})

const ourGroup = (id: string, vpcId: string): FakeGroup => ({
  GroupId: id,
  GroupName: 'my-app-production-app-sg',
  VpcId: vpcId,
  Tags: awsResourceTags('my-app', 'production'),
})

describe('AwsDriver.destroyCompute', () => {
  let originalCwd: string
  let tempCwd: string

  beforeEach(async () => {
    originalCwd = process.cwd()
    tempCwd = `${originalCwd}/.tmp-aws-teardown-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await mkdir(tempCwd, { recursive: true })
    process.chdir(tempCwd)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(tempCwd, { recursive: true, force: true })
  })

  it('terminates the instances and deletes the group', async () => {
    const aws = fakeAws({
      'us-east-1': { instances: [instance('i-1', 'vpc-app')], groups: [ourGroup('sg-1', 'vpc-app')] },
    })
    const driver = new AwsDriver({ region: 'us-east-1', ec2Client: aws.ec2Client })

    const result = await driver.destroyCompute!({ config: config('us-east-1'), environment: 'production' })

    expect(aws.terminated).toEqual(['i-1'])
    expect(aws.deletedGroups).toEqual(['sg-1'])
    expect(result.destroyed).toEqual(['instance i-1', 'security group my-app-production-app-sg'])
  })

  it('acts in the region the config names, not the one the driver was built with', async () => {
    // The factory builds the driver from config, but a driver constructed by
    // hand can disagree — the config is what the deploy meant.
    const aws = fakeAws({
      'eu-central-1': { instances: [instance('i-eu', 'vpc-eu')], groups: [ourGroup('sg-eu', 'vpc-eu')] },
      'us-east-1': { instances: [instance('i-us', 'vpc-us')], groups: [ourGroup('sg-us', 'vpc-us')] },
    })
    const driver = new AwsDriver({ region: 'us-east-1', ec2Client: aws.ec2Client })

    await driver.destroyCompute!({ config: config('eu-central-1'), environment: 'production' })

    expect(aws.terminated).toEqual(['i-eu'])
    expect(aws.deletedGroups).toEqual(['sg-eu'])
    expect(aws.describedIn).not.toContain('us-east-1')
  })

  it('leaves a same-named group in another VPC alone', async () => {
    const aws = fakeAws({
      'us-east-1': {
        instances: [instance('i-1', 'vpc-app')],
        groups: [
          { GroupId: 'sg-other', GroupName: 'my-app-production-app-sg', VpcId: 'vpc-other' },
          ourGroup('sg-ours', 'vpc-app'),
        ],
      },
    })
    const driver = new AwsDriver({ region: 'us-east-1', ec2Client: aws.ec2Client })

    await driver.destroyCompute!({ config: config('us-east-1'), environment: 'production' })

    expect(aws.deletedGroups).toEqual(['sg-ours'])
  })

  it('leaves a group tagged for another project alone', async () => {
    const aws = fakeAws({
      'us-east-1': {
        instances: [instance('i-1', 'vpc-app')],
        groups: [
          {
            GroupId: 'sg-theirs',
            GroupName: 'my-app-production-app-sg',
            VpcId: 'vpc-app',
            Tags: awsResourceTags('other-app', 'production'),
          },
        ],
      },
    })
    const driver = new AwsDriver({ region: 'us-east-1', ec2Client: aws.ec2Client })

    const result = await driver.destroyCompute!({ config: config('us-east-1'), environment: 'production' })

    expect(aws.deletedGroups).toEqual([])
    expect(result.destroyed).toEqual(['instance i-1'])
  })

  it('reports nothing when the project has nothing left', async () => {
    const aws = fakeAws({ 'us-east-1': {} })
    const driver = new AwsDriver({ region: 'us-east-1', ec2Client: aws.ec2Client })

    const result = await driver.destroyCompute!({ config: config('us-east-1'), environment: 'production' })

    expect(result.destroyed).toEqual([])
    expect(aws.terminated).toEqual([])
  })

  it('skips an untagged group once the instances are gone', async () => {
    // With no instance left there is no VPC to place the group by, so a name
    // match alone is not enough to delete it.
    const aws = fakeAws({
      'us-east-1': { groups: [{ GroupId: 'sg-legacy', GroupName: 'my-app-production-app-sg', VpcId: 'vpc-app' }] },
    })
    const driver = new AwsDriver({ region: 'us-east-1', ec2Client: aws.ec2Client })

    const result = await driver.destroyCompute!({ config: config('us-east-1'), environment: 'production' })

    expect(aws.deletedGroups).toEqual([])
    expect(result.destroyed).toEqual([])
  })
})
