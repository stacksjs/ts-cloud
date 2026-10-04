import { describe, expect, it } from 'bun:test'
import { CDN } from '../src/modules/cdn'
import {
  buildOriginGroups,
  ORIGIN_CONNECTION_ATTEMPTS,
  ORIGIN_CONNECTION_TIMEOUT,
  resolveOriginConnection,
  validateOriginGroups,
} from '../src/modules/cdn-failover'
import {
  buildFailoverReplicaPolicyStatement,
  buildReplicationConfiguration,
  buildReplicationRole,
  DEFAULT_STORAGE_FAILOVER_STATUS_CODES,
  resolveStorageFailover,
  STORAGE_FAILOVER_METADATA_KEY,
  storageFailoverReplicasFromTemplate,
} from '../src/modules/storage-failover'

// stacksjs/stacks#1159: the whole-distribution checks, connection tuning,
// selection criteria, and the bucket half of cross-region failover.

/** A valid CloudFormation-shaped distribution with one origin group. */
function cfnDistribution(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    Origins: [
      { Id: 'primary', DomainName: 'a.s3.us-east-1.amazonaws.com' },
      { Id: 'secondary', DomainName: 'b.s3.us-west-2.amazonaws.com' },
    ],
    OriginGroups: buildOriginGroups({ primaryOriginId: 'primary', secondaryOriginId: 'secondary', groupId: 'group' }),
    DefaultCacheBehavior: { TargetOriginId: 'group', AllowedMethods: ['GET', 'HEAD', 'OPTIONS'] },
    ...overrides,
  }
}

describe('resolveOriginConnection', () => {
  it('returns only the keys that were set, so an untuned origin is unchanged', () => {
    expect(resolveOriginConnection(undefined)).toEqual({})
    expect(resolveOriginConnection({})).toEqual({})
    expect(resolveOriginConnection({ connectionAttempts: 1 })).toEqual({ ConnectionAttempts: 1 })
    expect(resolveOriginConnection({ connectionAttempts: 2, connectionTimeout: 4 })).toEqual({
      ConnectionAttempts: 2,
      ConnectionTimeout: 4,
    })
  })

  it('accepts both ends of the ranges CloudFront documents', () => {
    expect(ORIGIN_CONNECTION_ATTEMPTS).toEqual({ min: 1, max: 3 })
    expect(ORIGIN_CONNECTION_TIMEOUT).toEqual({ min: 1, max: 10 })
    expect(resolveOriginConnection({ connectionAttempts: 3, connectionTimeout: 10 })).toEqual({
      ConnectionAttempts: 3,
      ConnectionTimeout: 10,
    })
    expect(resolveOriginConnection({ connectionAttempts: 1, connectionTimeout: 1 })).toEqual({
      ConnectionAttempts: 1,
      ConnectionTimeout: 1,
    })
  })

  it('rejects out-of-range and fractional values, naming the origin', () => {
    expect(() => resolveOriginConnection({ connectionAttempts: 0 }, 'infrastructure.cdn.main')).toThrow(
      /infrastructure\.cdn\.main connectionAttempts must be a whole number from 1 to 3, got 0/,
    )
    expect(() => resolveOriginConnection({ connectionAttempts: 4 })).toThrow(/from 1 to 3, got 4/)
    expect(() => resolveOriginConnection({ connectionTimeout: 11 })).toThrow(/connectionTimeout \(seconds\) must be a whole number from 1 to 10, got 11/)
    expect(() => resolveOriginConnection({ connectionTimeout: 2.5 })).toThrow(/got 2.5/)
    expect(() => resolveOriginConnection({ connectionTimeout: '5' as any })).toThrow(/got "5"/)
  })
})

describe('origin group selection criteria', () => {
  it('omits SelectionCriteria unless set, and emits it when set', () => {
    expect(buildOriginGroups({ primaryOriginId: 'a', secondaryOriginId: 'b' }).Items[0]).not.toHaveProperty(
      'SelectionCriteria',
    )
    expect(
      buildOriginGroups({ primaryOriginId: 'a', secondaryOriginId: 'b', selectionCriteria: 'default' }).Items[0]
        .SelectionCriteria,
    ).toBe('default')
  })

  it('rejects an unknown value', () => {
    expect(() =>
      buildOriginGroups({ primaryOriginId: 'a', secondaryOriginId: 'b', selectionCriteria: 'fastest' as any }),
    ).toThrow(/selection criteria "fastest". Allowed: default, media-quality-based/)
  })

  it('allows media-quality-based only between MediaPackage v2 origins', () => {
    const mediaPackage = (id: string) => ({
      Id: id,
      DomainName: `abc123.egress.xyz.mediapackagev2.us-west-2.amazonaws.com`,
    })
    const groups = buildOriginGroups({
      primaryOriginId: 'mp1',
      secondaryOriginId: 'mp2',
      groupId: 'group',
      selectionCriteria: 'media-quality-based',
    })
    expect(() =>
      validateOriginGroups({
        Origins: [mediaPackage('mp1'), mediaPackage('mp2')],
        OriginGroups: groups,
        DefaultCacheBehavior: { TargetOriginId: 'group', AllowedMethods: ['GET', 'HEAD'] },
      }),
    ).not.toThrow()

    const s3Groups = cfnDistribution({
      OriginGroups: buildOriginGroups({
        primaryOriginId: 'primary',
        secondaryOriginId: 'secondary',
        groupId: 'group',
        selectionCriteria: 'media-quality-based',
      }),
    })
    expect(() => validateOriginGroups(s3Groups)).toThrow(
      /only works between AWS Elemental MediaPackage v2 origins, but member "primary" is a\.s3\.us-east-1\.amazonaws\.com/,
    )
  })
})

describe('validateOriginGroups', () => {
  it('passes a valid distribution, and one with no groups at all', () => {
    expect(() => validateOriginGroups(cfnDistribution())).not.toThrow()
    expect(() =>
      validateOriginGroups({
        Origins: [{ Id: 'only', DomainName: 'x.example.com' }],
        DefaultCacheBehavior: { TargetOriginId: 'only', AllowedMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'OPTIONS', 'DELETE'] },
      }),
    ).not.toThrow()
  })

  it('accepts the CloudFront API shape ({ Quantity, Items })', () => {
    const config = cfnDistribution()
    expect(() =>
      validateOriginGroups({
        Origins: { Quantity: 2, Items: config.Origins },
        OriginGroups: config.OriginGroups,
        DefaultCacheBehavior: { TargetOriginId: 'group', AllowedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] } },
        CacheBehaviors: { Quantity: 0 },
      }),
    ).not.toThrow()
  })

  it('requires exactly two members', () => {
    const one = cfnDistribution()
    one.OriginGroups.Items[0].Members = { Quantity: 1, Items: [{ OriginId: 'primary' }] }
    expect(() => validateOriginGroups(one, 'infrastructure.cdn.main')).toThrow(
      /infrastructure\.cdn\.main origin group "group" must have exactly 2 members \(a primary and a secondary\), it has 1/,
    )

    const three = cfnDistribution()
    three.Origins.push({ Id: 'third', DomainName: 'c.example.com' })
    three.OriginGroups.Items[0].Members = {
      Quantity: 3,
      Items: [{ OriginId: 'primary' }, { OriginId: 'secondary' }, { OriginId: 'third' }],
    }
    expect(() => validateOriginGroups(three)).toThrow(/must have exactly 2 members.*it has 3/)

    const lying = cfnDistribution()
    lying.OriginGroups.Items[0].Members.Quantity = 3
    expect(() => validateOriginGroups(lying)).toThrow(/it has 2 with Quantity 3/)
  })

  it('requires members to be origins of the distribution', () => {
    const config = cfnDistribution()
    config.OriginGroups.Items[0].Members.Items[1] = { OriginId: 'ghost' }
    expect(() => validateOriginGroups(config)).toThrow(
      /lists member "ghost", which is not an origin of this distribution\. Origins: primary, secondary/,
    )
  })

  it('rejects the same origin as both members', () => {
    const config = cfnDistribution()
    config.OriginGroups.Items[0].Members.Items[1] = { OriginId: 'primary' }
    expect(() => validateOriginGroups(config)).toThrow(/lists "primary" as both primary and secondary/)
  })

  it('rejects a group id that shadows an origin id, a duplicate group, and a missing id', () => {
    const shadow = cfnDistribution({
      OriginGroups: buildOriginGroups({ primaryOriginId: 'primary', secondaryOriginId: 'secondary', groupId: 'primary' }),
      DefaultCacheBehavior: { TargetOriginId: 'primary', AllowedMethods: ['GET', 'HEAD'] },
    })
    expect(() => validateOriginGroups(shadow)).toThrow(/has the same id as an origin/)

    const twice = cfnDistribution()
    twice.OriginGroups = { Quantity: 2, Items: [twice.OriginGroups.Items[0], twice.OriginGroups.Items[0]] }
    expect(() => validateOriginGroups(twice)).toThrow(/declares origin group "group" twice/)

    const unnamed = cfnDistribution()
    unnamed.OriginGroups.Items[0].Id = ''
    expect(() => validateOriginGroups(unnamed)).toThrow(/an origin group without an Id/)
  })

  it('rejects a Quantity that disagrees with Items', () => {
    const groups = cfnDistribution()
    groups.OriginGroups.Quantity = 2
    expect(() => validateOriginGroups(groups)).toThrow(/OriginGroups\.Quantity is 2 but it lists 1 group/)

    const codes = cfnDistribution()
    codes.OriginGroups.Items[0].FailoverCriteria.StatusCodes.Quantity = 9
    expect(() => validateOriginGroups(codes)).toThrow(/StatusCodes\.Quantity is 9 but it lists 4 code/)
  })

  it('rejects status codes CloudFront cannot fail over on, and an empty list', () => {
    const bad = cfnDistribution()
    bad.OriginGroups.Items[0].FailoverCriteria.StatusCodes = { Quantity: 2, Items: [500, 501] }
    expect(() => validateOriginGroups(bad)).toThrow(/501 is not a status code CloudFront can fail over on/)

    const empty = cfnDistribution()
    empty.OriginGroups.Items[0].FailoverCriteria.StatusCodes = { Quantity: 0, Items: [] }
    expect(() => validateOriginGroups(empty)).toThrow(/at least one code/)
  })

  it('rejects any behavior targeting a group that allows writes, default or path', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const config = cfnDistribution({
        DefaultCacheBehavior: { TargetOriginId: 'group', AllowedMethods: ['GET', 'HEAD', 'OPTIONS', method] },
      })
      expect(() => validateOriginGroups(config, 'infrastructure.cdn.main')).toThrow(
        new RegExp(`the default cache behavior of infrastructure\\.cdn\\.main \\(origin group "group"\\) allows ${method}`),
      )
    }

    const path = cfnDistribution({
      CacheBehaviors: [
        { PathPattern: '/api/*', TargetOriginId: 'primary', AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        { PathPattern: '/upload/*', TargetOriginId: 'group', AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'] },
      ],
    })
    // The /api/* behavior targets a plain origin and may write; /upload/* targets the group and may not.
    expect(() => validateOriginGroups(path)).toThrow(/cache behavior for "\/upload\/\*".*allows PUT, POST, PATCH, DELETE/)
  })

  it('treats an unset AllowedMethods on a group behavior as CloudFront does (GET, HEAD)', () => {
    expect(() => validateOriginGroups(cfnDistribution({ DefaultCacheBehavior: { TargetOriginId: 'group' } }))).not.toThrow()
  })

  it('rejects a behavior targeting neither an origin nor a group', () => {
    const config = cfnDistribution({ DefaultCacheBehavior: { TargetOriginId: 'nowhere', AllowedMethods: ['GET', 'HEAD'] } })
    expect(() => validateOriginGroups(config)).toThrow(/targets "nowhere", which is neither an origin nor an origin group/)
  })

  it('checks every origin\'s connection settings', () => {
    const config = cfnDistribution()
    config.Origins[1].ConnectionAttempts = 5
    expect(() => validateOriginGroups(config)).toThrow(/origin "secondary" ConnectionAttempts must be a whole number from 1 to 3, got 5/)
    const timeout = cfnDistribution()
    timeout.Origins[0].ConnectionTimeout = 0
    expect(() => validateOriginGroups(timeout)).toThrow(/origin "primary" ConnectionTimeout \(seconds\) must be a whole number from 1 to 10, got 0/)
  })

  it('skips comparisons on CloudFormation intrinsics it cannot resolve', () => {
    expect(() =>
      validateOriginGroups({
        Origins: [
          { Id: { Ref: 'PrimaryId' }, DomainName: { 'Fn::GetAtt': ['Bucket', 'RegionalDomainName'] } },
          { Id: 'secondary', DomainName: 'b.s3.us-west-2.amazonaws.com' },
        ],
        OriginGroups: {
          Quantity: 1,
          Items: [
            {
              Id: 'group',
              FailoverCriteria: { StatusCodes: { Quantity: 1, Items: [503] } },
              Members: { Quantity: 2, Items: [{ OriginId: 'primary' }, { OriginId: 'secondary' }] },
            },
          ],
        },
        DefaultCacheBehavior: { TargetOriginId: 'group', AllowedMethods: ['GET', 'HEAD'] },
      }),
    ).not.toThrow()
  })
})

describe('CDN.addOriginFailover connection tuning and selection criteria', () => {
  const base = {
    slug: 'my-app',
    environment: 'production' as const,
    origin: { type: 's3' as const, domainName: 'my-bucket.s3.amazonaws.com' },
  }

  it('tunes the primary and the secondary independently', () => {
    const { distribution } = CDN.createDistribution({
      ...base,
      failoverOrigin: {
        domainName: 'backup.example.com',
        connectionAttempts: 2,
        connectionTimeout: 5,
        selectionCriteria: 'default',
        primary: { connectionAttempts: 1, connectionTimeout: 2 },
      },
    })
    const config = distribution.Properties.DistributionConfig
    expect(config.Origins[0]).toMatchObject({ Id: 'DefaultOrigin', ConnectionAttempts: 1, ConnectionTimeout: 2 })
    expect(config.Origins[1]).toMatchObject({ Id: 'FailoverOrigin', ConnectionAttempts: 2, ConnectionTimeout: 5 })
    expect(config.OriginGroups?.Items?.[0].SelectionCriteria).toBe('default')
  })

  it('tunes the primary origin through OriginConfig', () => {
    const { distribution } = CDN.createDistribution({
      ...base,
      origin: { ...base.origin, connectionAttempts: 1, connectionTimeout: 3 },
    })
    expect(distribution.Properties.DistributionConfig.Origins[0]).toMatchObject({
      ConnectionAttempts: 1,
      ConnectionTimeout: 3,
    })
  })

  it('rejects out-of-range tuning before changing the distribution', () => {
    const { distribution } = CDN.createDistribution(base)
    expect(() =>
      CDN.addOriginFailover(distribution, { domainName: 'backup.example.com', primary: { connectionTimeout: 30 } }),
    ).toThrow(/primary origin connectionTimeout \(seconds\) must be a whole number from 1 to 10, got 30/)
    expect(distribution.Properties.DistributionConfig.Origins).toHaveLength(1)
    expect(distribution.Properties.DistributionConfig.OriginGroups).toBeUndefined()
  })
})

describe('resolveStorageFailover', () => {
  const base = { primaryBucket: 'my-app-production-public', primaryRegion: 'us-east-1', where: 'infrastructure.storage.public' }

  it('defaults the replica name, the status codes and replication', () => {
    expect(resolveStorageFailover({ ...base, failover: { region: 'us-west-2' } })).toEqual({
      replicaBucket: 'my-app-production-public-us-west-2',
      replicaRegion: 'us-west-2',
      replicate: true,
      statusCodes: [403, 404, 500, 502, 503, 504],
      primaryConnection: {},
    })
    expect(DEFAULT_STORAGE_FAILOVER_STATUS_CODES).toEqual([403, 404, 500, 502, 503, 504])
  })

  it('honors an explicit bucket, codes, tuning and replicate: false', () => {
    expect(
      resolveStorageFailover({
        ...base,
        failover: {
          region: 'eu-west-1',
          bucket: 'my-replica',
          statusCodes: [503, 500],
          connectionAttempts: 1,
          connectionTimeout: 3,
          replicate: false,
        },
      }),
    ).toEqual({
      replicaBucket: 'my-replica',
      replicaRegion: 'eu-west-1',
      replicate: false,
      statusCodes: [500, 503],
      primaryConnection: { ConnectionAttempts: 1, ConnectionTimeout: 3 },
    })
  })

  it('rejects a missing, malformed or same region', () => {
    expect(() => resolveStorageFailover({ ...base, failover: {} as any })).toThrow(
      /infrastructure\.storage\.public\.failover\.region must be an AWS region/,
    )
    expect(() => resolveStorageFailover({ ...base, failover: { region: 'west' } })).toThrow(/got "west"/)
    expect(() => resolveStorageFailover({ ...base, failover: { region: 'us-east-1' } })).toThrow(
      /same region as the primary bucket/,
    )
  })

  it('rejects an invalid or colliding replica name, with a hint for an over-long default', () => {
    expect(() =>
      resolveStorageFailover({ ...base, primaryBucket: 'a'.repeat(55), failover: { region: 'ap-southeast-2' } }),
    ).toThrow(/is 70 characters; S3 allows 63\. Set infrastructure\.storage\.public\.failover\.bucket/)
    expect(() => resolveStorageFailover({ ...base, failover: { region: 'us-west-2', bucket: 'Bad_Name' } })).toThrow(
      /"Bad_Name" is not a valid S3 bucket name/,
    )
    expect(() =>
      resolveStorageFailover({ ...base, failover: { region: 'us-west-2', bucket: 'my-app-production-public' } }),
    ).toThrow(/must differ from the primary bucket/)
  })

  it('rejects status codes and tuning CloudFront would refuse', () => {
    expect(() => resolveStorageFailover({ ...base, failover: { region: 'us-west-2', statusCodes: [418] } })).toThrow(/418/)
    expect(() => resolveStorageFailover({ ...base, failover: { region: 'us-west-2', connectionAttempts: 9 } })).toThrow(
      /infrastructure\.storage\.public\.failover connectionAttempts must be a whole number from 1 to 3/,
    )
  })
})

describe('replication and replica-policy builders', () => {
  it('scopes the replication role to the two buckets', () => {
    const role = buildReplicationRole({ primaryBucket: 'src', replicaBucket: 'dst' })
    expect(role.Type).toBe('AWS::IAM::Role')
    expect(role.Properties.AssumeRolePolicyDocument.Statement[0].Principal).toEqual({ Service: 's3.amazonaws.com' })
    const resources = role.Properties.Policies[0].PolicyDocument.Statement.map((s: any) => s.Resource)
    expect(resources).toEqual(['arn:aws:s3:::src', 'arn:aws:s3:::src/*', 'arn:aws:s3:::dst/*'])
  })

  it('replicates every object and its deletes', () => {
    expect(buildReplicationConfiguration({ replicaBucket: 'dst', roleArn: { 'Fn::GetAtt': ['Role', 'Arn'] } })).toEqual({
      Role: { 'Fn::GetAtt': ['Role', 'Arn'] },
      Rules: [
        {
          Id: 'cloudfront-failover-replica',
          Status: 'Enabled',
          Priority: 1,
          Filter: { Prefix: '' },
          DeleteMarkerReplication: { Status: 'Enabled' },
          Destination: { Bucket: 'arn:aws:s3:::dst' },
        },
      ],
    })
  })

  it('lets one distribution read the replica', () => {
    expect(
      buildFailoverReplicaPolicyStatement({ replicaBucket: 'dst', distributionArn: 'arn:aws:cloudfront::1:distribution/E1' }),
    ).toEqual({
      Sid: 'AllowCloudFrontFailoverRead',
      Effect: 'Allow',
      Principal: { Service: 'cloudfront.amazonaws.com' },
      Action: 's3:GetObject',
      Resource: 'arn:aws:s3:::dst/*',
      Condition: { StringEquals: { 'AWS:SourceArn': 'arn:aws:cloudfront::1:distribution/E1' } },
    })
  })

  it('reads replicas back out of a template, object or JSON', () => {
    const replica = {
      name: 'public',
      primaryBucket: 'src',
      primaryRegion: 'us-east-1',
      replicaBucket: 'dst',
      replicaRegion: 'us-west-2',
      replicate: true,
      distributionArnOutput: 'publicCloudFrontDistributionArn',
    }
    const template = { Resources: {}, Metadata: { [STORAGE_FAILOVER_METADATA_KEY]: [replica] } }
    expect(storageFailoverReplicasFromTemplate(template)).toEqual([replica])
    expect(storageFailoverReplicasFromTemplate(JSON.stringify(template))).toEqual([replica])
    expect(storageFailoverReplicasFromTemplate({ Resources: {} })).toEqual([])
  })
})
