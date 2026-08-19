/**
 * AWS teardown removes the security group ts-cloud created for a project — and
 * only that one. A same-named group in another VPC, or one tagged for another
 * project, belongs to something else.
 *
 * The live API orchestration lives in the driver; the decision it makes is
 * `selectProjectSecurityGroup`, which is what these tests drive.
 */

import type { AwsSecurityGroupCandidate } from '../../src/drivers/aws/provision'
import { describe, expect, it } from 'bun:test'
import {
  awsResourceTags,
  awsSecurityGroupName,
  matchesAwsProjectTags,
  selectProjectSecurityGroup,
} from '../../src/drivers/aws/provision'

const SLUG = 'my-app'
const ENVIRONMENT = 'production'
const NAME = awsSecurityGroupName(SLUG, ENVIRONMENT)

function group(overrides: Partial<AwsSecurityGroupCandidate> = {}): AwsSecurityGroupCandidate {
  return {
    GroupId: 'sg-ours',
    GroupName: NAME,
    VpcId: 'vpc-app',
    Tags: awsResourceTags(SLUG, ENVIRONMENT),
    ...overrides,
  }
}

describe('security group naming and tags', () => {
  it('names the group after the project and environment', () => {
    expect(awsSecurityGroupName('my-app', 'staging')).toBe('my-app-staging-app-sg')
  })

  it('tags a resource with the project vocabulary teardown reads', () => {
    expect(awsResourceTags('my-app', 'production')).toEqual([
      { Key: 'Project', Value: 'my-app' },
      { Key: 'Environment', Value: 'production' },
      { Key: 'Role', Value: 'app' },
      { Key: 'ManagedBy', Value: 'ts-cloud' },
    ])
    expect(awsResourceTags('my-app', 'production', 'services')[2]).toEqual({ Key: 'Role', Value: 'services' })
  })

  it('matches tags by project and environment, whatever the role', () => {
    expect(matchesAwsProjectTags(awsResourceTags(SLUG, ENVIRONMENT, 'services'), SLUG, ENVIRONMENT)).toBe(true)
    expect(matchesAwsProjectTags(awsResourceTags(SLUG, 'staging'), SLUG, ENVIRONMENT)).toBe(false)
    expect(matchesAwsProjectTags(awsResourceTags('other', ENVIRONMENT), SLUG, ENVIRONMENT)).toBe(false)
    expect(matchesAwsProjectTags(undefined, SLUG, ENVIRONMENT)).toBe(false)
    expect(matchesAwsProjectTags([], SLUG, ENVIRONMENT)).toBe(false)
  })
})

describe('selecting the group to delete', () => {
  const options = { slug: SLUG, environment: ENVIRONMENT, vpcId: 'vpc-app' }

  it('picks the group ts-cloud created', () => {
    expect(selectProjectSecurityGroup([group()], options)?.GroupId).toBe('sg-ours')
  })

  it('ignores a group of another name', () => {
    expect(selectProjectSecurityGroup([group({ GroupName: 'default' })], options)).toBeUndefined()
  })

  it('ignores a same-named group in another VPC', () => {
    // Provisioning scopes its lookup to a VPC; teardown has to be as careful,
    // or it deletes a group belonging to a different deployment entirely.
    expect(selectProjectSecurityGroup([group({ GroupId: 'sg-elsewhere', VpcId: 'vpc-other' })], options))
      .toBeUndefined()
  })

  it('ignores a group tagged for another project or environment', () => {
    expect(selectProjectSecurityGroup([group({ Tags: awsResourceTags('other-app', ENVIRONMENT) })], options))
      .toBeUndefined()
    expect(selectProjectSecurityGroup([group({ Tags: awsResourceTags(SLUG, 'staging') })], options))
      .toBeUndefined()
  })

  it('picks ours out of a list of near misses', () => {
    const found = selectProjectSecurityGroup(
      [
        group({ GroupId: 'sg-other-vpc', VpcId: 'vpc-other' }),
        group({ GroupId: 'sg-other-project', Tags: awsResourceTags('other-app', ENVIRONMENT) }),
        group(),
      ],
      options,
    )
    expect(found?.GroupId).toBe('sg-ours')
  })

  it('deletes an untagged group when the VPC places it on this box', () => {
    // Groups created before ts-cloud tagged them carry no tags at all.
    expect(selectProjectSecurityGroup([group({ GroupId: 'sg-legacy', Tags: undefined })], options)?.GroupId)
      .toBe('sg-legacy')
    expect(selectProjectSecurityGroup([group({ GroupId: 'sg-legacy', Tags: [] })], options)?.GroupId)
      .toBe('sg-legacy')
  })

  it('leaves an untagged group alone when there is no VPC to place it by', () => {
    // Every instance is already gone, so nothing ties this group to the
    // project beyond a name anyone could have used.
    const noVpc = { slug: SLUG, environment: ENVIRONMENT }
    expect(selectProjectSecurityGroup([group({ Tags: undefined })], noVpc)).toBeUndefined()
  })

  it('still deletes a tagged group when the VPC is unknown', () => {
    const noVpc = { slug: SLUG, environment: ENVIRONMENT }
    expect(selectProjectSecurityGroup([group()], noVpc)?.GroupId).toBe('sg-ours')
  })

  it('tolerates a group with no VPC reported', () => {
    expect(selectProjectSecurityGroup([group({ VpcId: undefined })], options)?.GroupId).toBe('sg-ours')
  })

  it('finds nothing in an empty account', () => {
    expect(selectProjectSecurityGroup([], options)).toBeUndefined()
  })
})
