/**
 * Cross-region bucket failover (stacksjs/stacks#1159): what the generator
 * emits for `infrastructure.storage.<name>.failover`, connection tuning on
 * `infrastructure.cdn`, and the deploy-time replica steps.
 */

import type { CloudConfig } from '@ts-cloud/core'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { STORAGE_FAILOVER_METADATA_KEY, storageFailoverReplicasFromTemplate } from '@ts-cloud/core'
import { S3Client } from '../src/aws/s3'
import { ensureFailoverReplicaBuckets, grantFailoverReplicaAccess, seedFailoverReplicas } from '../src/deploy/storage-failover'
import { buildCloudFrontOriginConfig } from '../src/drivers/shared/cloudfront-origin'
import { InfrastructureGenerator } from '../src/generators/infrastructure'

const CERT = 'arn:aws:acm:us-east-1:123456789012:certificate/abc'

function siteConfig(storage: Record<string, any>, extra: Record<string, any> = {}): CloudConfig {
  return {
    project: { name: 'My App', slug: 'my-app', region: 'us-east-1' },
    environments: { production: { type: 'production' } },
    infrastructure: {
      dns: { domain: 'example.com' },
      ssl: { certificateArn: CERT },
      storage,
      ...extra,
    },
  } as CloudConfig
}

function generate(config: CloudConfig): { template: any; generator: InfrastructureGenerator } {
  const generator = new InfrastructureGenerator({ config, environment: 'production' })
  generator.generate()
  return { template: JSON.parse(generator.toJSON()), generator }
}

function resourcesOfType(template: any, type: string): Array<[string, any]> {
  return Object.entries(template.Resources).filter(([, r]: [string, any]) => r.Type === type) as Array<[string, any]>
}

describe('infrastructure.storage.<name>.failover', () => {
  it('is off unless configured: no group, no replication, no metadata', () => {
    const { template, generator } = generate(siteConfig({ public: { website: true } }))
    const [, distribution] = resourcesOfType(template, 'AWS::CloudFront::Distribution')[0]
    expect(distribution.Properties.DistributionConfig.OriginGroups).toBeUndefined()
    expect(template.Metadata).toBeUndefined()
    expect(generator.getStorageFailoverReplicas()).toEqual([])
    const [, bucket] = resourcesOfType(template, 'AWS::S3::Bucket')[0]
    expect(bucket.Properties.ReplicationConfiguration).toBeUndefined()
  })

  it('serves the default behavior from a group of the primary and its replica', () => {
    const { template } = generate(siteConfig({ public: { website: true, failover: { region: 'us-west-2' } } }))
    const [, distribution] = resourcesOfType(template, 'AWS::CloudFront::Distribution')[0]
    const config = distribution.Properties.DistributionConfig

    expect(config.Origins).toHaveLength(2)
    expect(config.Origins[1]).toEqual({
      Id: 'S3-my-app-production-public-failover',
      DomainName: 'my-app-production-public-us-west-2.s3.us-west-2.amazonaws.com',
      OriginPath: '',
      S3OriginConfig: { OriginAccessIdentity: '' },
      OriginAccessControlId: config.Origins[0].OriginAccessControlId,
    })
    expect(config.OriginGroups).toEqual({
      Quantity: 1,
      Items: [
        {
          Id: 'S3-my-app-production-public-failover-group',
          FailoverCriteria: { StatusCodes: { Quantity: 6, Items: [403, 404, 500, 502, 503, 504] } },
          Members: {
            Quantity: 2,
            Items: [{ OriginId: 'S3-my-app-production-public' }, { OriginId: 'S3-my-app-production-public-failover' }],
          },
        },
      ],
    })
    expect(config.DefaultCacheBehavior.TargetOriginId).toBe('S3-my-app-production-public-failover-group')
    expect(config.DefaultCacheBehavior.AllowedMethods).toEqual(['GET', 'HEAD', 'OPTIONS'])
    expect(config.DefaultCacheBehavior.CachedMethods).toContain('OPTIONS')
  })

  it('replicates the primary into the replica, versioned, with a scoped role', () => {
    const { template } = generate(siteConfig({ public: { website: true, failover: { region: 'us-west-2' } } }))
    const [bucketId, bucket] = resourcesOfType(template, 'AWS::S3::Bucket')[0]
    expect(bucket.Properties.VersioningConfiguration).toEqual({ Status: 'Enabled' })
    const replication = bucket.Properties.ReplicationConfiguration
    expect(replication.Rules[0].Destination).toEqual({ Bucket: 'arn:aws:s3:::my-app-production-public-us-west-2' })
    expect(replication.Role).toEqual({ 'Fn::GetAtt': [`${bucketId}FailoverReplicationRole`, 'Arn'] })

    const role = template.Resources[`${bucketId}FailoverReplicationRole`]
    expect(role.Type).toBe('AWS::IAM::Role')
    const statements = role.Properties.Policies[0].PolicyDocument.Statement
    expect(statements.at(-1).Resource).toBe('arn:aws:s3:::my-app-production-public-us-west-2/*')
  })

  it('records the replica for the deployer and outputs the distribution ARN', () => {
    const { template, generator } = generate(siteConfig({ public: { website: true, failover: { region: 'us-west-2' } } }))
    const replica = {
      name: 'public',
      primaryBucket: 'my-app-production-public',
      primaryRegion: 'us-east-1',
      replicaBucket: 'my-app-production-public-us-west-2',
      replicaRegion: 'us-west-2',
      replicate: true,
      distributionArnOutput: 'publicCloudFrontDistributionArn',
    }
    expect(template.Metadata[STORAGE_FAILOVER_METADATA_KEY]).toEqual([replica])
    expect(storageFailoverReplicasFromTemplate(template)).toEqual([replica])
    expect(generator.getStorageFailoverReplicas()).toEqual([replica])

    const [distId] = resourcesOfType(template, 'AWS::CloudFront::Distribution')[0]
    expect(template.Outputs.publicCloudFrontDistributionArn.Value).toEqual({
      'Fn::Sub': `arn:\${AWS::Partition}:cloudfront::\${AWS::AccountId}:distribution/\${${distId}}`,
    })
    expect(template.Outputs.publicFailoverBucketName.Value).toBe('my-app-production-public-us-west-2')
  })

  it('honors bucket, codes, tuning and replicate: false', () => {
    const { template } = generate(
      siteConfig({
        public: {
          website: true,
          failover: {
            region: 'eu-west-1',
            bucket: 'my-replica',
            statusCodes: [503, 500],
            connectionAttempts: 1,
            connectionTimeout: 2,
            replicate: false,
          },
        },
      }),
    )
    const [, distribution] = resourcesOfType(template, 'AWS::CloudFront::Distribution')[0]
    const config = distribution.Properties.DistributionConfig
    expect(config.Origins[0]).toMatchObject({ ConnectionAttempts: 1, ConnectionTimeout: 2 })
    expect(config.Origins[1].DomainName).toBe('my-replica.s3.eu-west-1.amazonaws.com')
    expect(config.Origins[1].ConnectionAttempts).toBeUndefined()
    expect(config.OriginGroups.Items[0].FailoverCriteria.StatusCodes.Items).toEqual([500, 503])

    const [, bucket] = resourcesOfType(template, 'AWS::S3::Bucket')[0]
    expect(bucket.Properties.ReplicationConfiguration).toBeUndefined()
    expect(resourcesOfType(template, 'AWS::IAM::Role')).toHaveLength(0)
    expect(template.Metadata[STORAGE_FAILOVER_METADATA_KEY][0].replicate).toBe(false)
  })

  it('keeps compute routes (which accept writes) off the group', () => {
    const { template } = generate(
      siteConfig({ public: { website: true, failover: { region: 'us-west-2' } } }, { compute: { size: 'small', runtime: 'bun' } }),
    )
    const [, distribution] = resourcesOfType(template, 'AWS::CloudFront::Distribution').find(([id]) =>
      id.includes('public'),
    )!
    const config = distribution.Properties.DistributionConfig
    expect(config.DefaultCacheBehavior.TargetOriginId).toBe('S3-my-app-production-public-failover-group')
    expect(config.CacheBehaviors.length).toBeGreaterThan(0)
    for (const behavior of config.CacheBehaviors) {
      expect(behavior.TargetOriginId).not.toBe('S3-my-app-production-public-failover-group')
    }
  })

  it('fails loudly when the bucket has no distribution to fail over in', () => {
    expect(() => generate(siteConfig({ assets: { failover: { region: 'us-west-2' } } }))).toThrow(
      /infrastructure\.storage\.assets\.failover needs this bucket to be served by its own CloudFront distribution/,
    )
    const noSsl = siteConfig({ public: { website: true, failover: { region: 'us-west-2' } } })
    delete (noSsl.infrastructure as any).ssl
    expect(() => generate(noSsl)).toThrow(/SSL configured/)
    expect(() =>
      generate(siteConfig({ public: { website: true }, docs: { website: true, path: '/docs', failover: { region: 'us-west-2' } } })),
    ).toThrow(/not mounted under the path of another site/)
  })

  it('rejects a same-region replica and invalid codes at generation', () => {
    expect(() => generate(siteConfig({ public: { website: true, failover: { region: 'us-east-1' } } }))).toThrow(
      /same region as the primary bucket/,
    )
    expect(() =>
      generate(siteConfig({ public: { website: true, failover: { region: 'us-west-2', statusCodes: [501] } } })),
    ).toThrow(/501 is not a status code/)
  })
})

describe('infrastructure.cdn connection tuning and failoverOrigin object form', () => {
  function cdnDistribution(cdn: Record<string, any>): any {
    const { template } = generate({
      project: { name: 'My App', slug: 'my-app', region: 'us-east-1' },
      environments: { production: { type: 'production' } },
      infrastructure: { cdn: { main: { origin: 'my-app-site.s3.us-east-1.amazonaws.com', ...cdn } } },
    } as CloudConfig)
    return resourcesOfType(template, 'AWS::CloudFront::Distribution')[0][1].Properties.DistributionConfig
  }

  it('tunes the primary origin', () => {
    const config = cdnDistribution({ connectionAttempts: 1, connectionTimeout: 4 })
    expect(config.Origins[0]).toMatchObject({ ConnectionAttempts: 1, ConnectionTimeout: 4 })
  })

  it('takes failoverOrigin as an object with its own path and tuning', () => {
    const config = cdnDistribution({
      failoverOrigin: { domain: 'backup.example.com', originPath: '/mirror', connectionAttempts: 2, connectionTimeout: 6 },
    })
    expect(config.Origins[1]).toMatchObject({
      DomainName: 'backup.example.com',
      OriginPath: '/mirror',
      ConnectionAttempts: 2,
      ConnectionTimeout: 6,
    })
    expect(config.DefaultCacheBehavior.TargetOriginId).toBe(config.OriginGroups.Items[0].Id)
  })

  it('rejects out-of-range tuning and a failover origin equal to the primary', () => {
    expect(() => cdnDistribution({ connectionAttempts: 4 })).toThrow(/infrastructure\.cdn\.main connectionAttempts must be a whole number from 1 to 3/)
    expect(() => cdnDistribution({ failoverOrigin: { domain: 'b.example.com', connectionTimeout: 0 } })).toThrow(
      /infrastructure\.cdn\.main\.failoverOrigin connectionTimeout/,
    )
    expect(() => cdnDistribution({ failoverOrigin: 'my-app-site.s3.us-east-1.amazonaws.com' })).toThrow(
      /failoverOrigin must differ from origin/,
    )
  })
})

describe('buildCloudFrontOriginConfig connection tuning', () => {
  const base = {
    aliases: ['example.com'],
    originDomain: 'origin.example.com',
    failoverOriginDomain: 'origin-dr.example.com',
    viewerCertificateArn: CERT,
  }

  it('keeps 3 attempts of 10 seconds by default and tunes only the primary', () => {
    expect(buildCloudFrontOriginConfig(base).Origins.Items[0]).toMatchObject({ ConnectionAttempts: 3, ConnectionTimeout: 10 })
    const tuned = buildCloudFrontOriginConfig({ ...base, connectionAttempts: 1, connectionTimeout: 3 })
    expect(tuned.Origins.Items[0]).toMatchObject({ ConnectionAttempts: 1, ConnectionTimeout: 3 })
    expect(tuned.Origins.Items[1]).toMatchObject({ ConnectionAttempts: 3, ConnectionTimeout: 10 })
  })

  it('rejects out-of-range tuning', () => {
    expect(() => buildCloudFrontOriginConfig({ ...base, connectionTimeout: 11 })).toThrow(/from 1 to 10, got 11/)
  })
})

describe('deploy-time replica steps', () => {
  const replica = {
    name: 'public',
    primaryBucket: 'src',
    primaryRegion: 'us-east-1',
    replicaBucket: 'dst',
    replicaRegion: 'us-west-2',
    replicate: true,
    distributionArnOutput: 'publicCloudFrontDistributionArn',
  }
  const spies: Array<{ mockRestore: () => void }> = []
  function spy<K extends keyof S3Client>(method: K, impl: (...args: any[]) => any) {
    const s = spyOn(S3Client.prototype, method as any).mockImplementation(impl as any)
    spies.push(s)
    return s
  }
  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore()
  })

  it('creates a missing replica private, encrypted and versioned', async () => {
    spy('headBucket', async () => ({ exists: false }))
    const created = spy('createBucket', async () => {})
    const pab = spy('putPublicAccessBlock', async () => {})
    const enc = spy('putBucketEncryption', async () => {})
    spy('getBucketVersioning', async () => ({}))
    const versioning = spy('putBucketVersioning', async () => {})

    await ensureFailoverReplicaBuckets([replica])
    expect(created).toHaveBeenCalledWith('dst')
    expect(pab.mock.calls[0][1]).toEqual({
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    })
    expect(enc).toHaveBeenCalledWith('dst', 'AES256')
    expect(versioning).toHaveBeenCalledWith('dst', 'Enabled')
  })

  it('reuses an existing replica and refuses one in the wrong region or account', async () => {
    spy('headBucket', async () => ({ exists: true, region: 'us-west-2' }))
    const created = spy('createBucket', async () => {})
    spy('putPublicAccessBlock', async () => {})
    spy('putBucketEncryption', async () => {})
    spy('getBucketVersioning', async () => ({ Status: 'Enabled' }))
    const versioning = spy('putBucketVersioning', async () => {})
    await ensureFailoverReplicaBuckets([replica])
    expect(created).not.toHaveBeenCalled()
    expect(versioning).not.toHaveBeenCalled()

    while (spies.length) spies.pop()!.mockRestore()
    spy('headBucket', async () => ({ exists: true, region: 'eu-west-1' }))
    await expect(ensureFailoverReplicaBuckets([replica])).rejects.toThrow(/is in eu-west-1, not us-west-2/)

    while (spies.length) spies.pop()!.mockRestore()
    spy('headBucket', async () => {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    })
    await expect(ensureFailoverReplicaBuckets([replica])).rejects.toThrow(/another account may own it/)
  })

  it('adds the distribution to the replica policy, keeping other statements and replacing its own', async () => {
    spy('getBucketPolicy', async () => ({
      Version: '2012-10-17',
      Statement: [
        { Sid: 'SomeoneElse', Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::dst/x' },
        { Sid: 'AllowCloudFrontFailoverRead', Condition: { StringEquals: { 'AWS:SourceArn': 'old' } } },
      ],
    }))
    const put = spy('putBucketPolicy', async () => {})
    await grantFailoverReplicaAccess([replica], {
      publicCloudFrontDistributionArn: 'arn:aws:cloudfront::123:distribution/E1',
    })
    const [bucket, policy] = put.mock.calls[0] as [string, any]
    expect(bucket).toBe('dst')
    expect(policy.Statement).toHaveLength(2)
    expect(policy.Statement[0].Sid).toBe('SomeoneElse')
    expect(policy.Statement[1].Condition.StringEquals['AWS:SourceArn']).toBe('arn:aws:cloudfront::123:distribution/E1')
  })

  it('refuses to grant access without the distribution ARN output', async () => {
    await expect(grantFailoverReplicaAccess([replica], {})).rejects.toThrow(/publicCloudFrontDistributionArn is missing/)
  })

  it('copies only objects the replica lacks or holds at another size', async () => {
    spy('listAllObjects', async function (this: any, options: { bucket: string }) {
      return options.bucket === 'src'
        ? [
            { Key: 'same.html', Size: 10 },
            { Key: 'changed.html', Size: 20 },
            { Key: 'new folder/a b.css', Size: 5 },
          ]
        : [
            { Key: 'same.html', Size: 10 },
            { Key: 'changed.html', Size: 19 },
          ]
    })
    const copied = spy('copyObject', async () => {})
    expect(await seedFailoverReplicas([replica])).toEqual({ dst: 2 })
    expect(copied.mock.calls.map((call: any[]) => call[0].sourceKey)).toEqual(['changed.html', 'new folder/a b.css'])
    expect(copied.mock.calls[0][0]).toMatchObject({ sourceBucket: 'src', destinationBucket: 'dst' })
  })
})
