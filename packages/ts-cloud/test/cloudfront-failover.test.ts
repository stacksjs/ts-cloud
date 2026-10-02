/**
 * CloudFront origin failover (stacksjs/stacks#1159) through the two
 * distribution builders users reach: `infrastructure.cdn.<name>` in the
 * CloudFormation generator, and `buildCloudFrontOriginConfig` for a
 * self-hosted origin.
 *
 * The fixture holds both builders' output from before failover existed, so
 * the no-failover tests prove the feature is invisible until it is configured.
 */

import type { CloudConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { buildCloudFrontOriginConfig } from '../src/drivers/shared/cloudfront-origin'
import { InfrastructureGenerator } from '../src/generators/infrastructure'
import fixture from './fixtures/cloudfront-no-failover.json'

const PRIMARY = 'my-app-production-site.s3.us-east-1.amazonaws.com'

function cdnConfig(cdn: Record<string, any>): CloudConfig {
  return {
    project: { name: 'My App', slug: 'my-app', region: 'us-east-1' },
    environments: { production: { type: 'production' } },
    infrastructure: { cdn: { main: { origin: PRIMARY, originShield: true, ...cdn } } },
  } as CloudConfig
}

function distributionFor(config: CloudConfig): any {
  const generator = new InfrastructureGenerator({ config, environment: 'production' })
  generator.generate()
  const template = JSON.parse(generator.toJSON())
  return Object.values(template.Resources).find((r: any) => r.Type === 'AWS::CloudFront::Distribution')
}

describe('infrastructure.cdn failoverOrigin', () => {
  it('emits the same distribution as before when failover is not configured', () => {
    expect(JSON.stringify(distributionFor(cdnConfig({})), null, 2)).toBe(
      JSON.stringify(fixture.infrastructureCdn, null, 2),
    )
  })

  it('adds an origin group and targets it from the default cache behavior', () => {
    const config = distributionFor(
      cdnConfig({ failoverOrigin: 'my-app-production-site-replica.s3.us-west-2.amazonaws.com' }),
    ).Properties.DistributionConfig

    expect(config.Origins).toHaveLength(2)
    expect(config.Origins[1]).toEqual({
      Id: 'S3-my-app-production-main-cdn-failover',
      DomainName: 'my-app-production-site-replica.s3.us-west-2.amazonaws.com',
      OriginPath: '',
      S3OriginConfig: { OriginAccessIdentity: '' },
      OriginShield: { Enabled: false },
    })
    expect(config.OriginGroups).toEqual({
      Quantity: 1,
      Items: [
        {
          Id: 'S3-my-app-production-main-cdn-failover-group',
          FailoverCriteria: { StatusCodes: { Quantity: 4, Items: [500, 502, 503, 504] } },
          Members: {
            Quantity: 2,
            Items: [
              { OriginId: 'S3-my-app-production-main-cdn' },
              { OriginId: 'S3-my-app-production-main-cdn-failover' },
            ],
          },
        },
      ],
    })
    expect(config.DefaultCacheBehavior.TargetOriginId).toBe('S3-my-app-production-main-cdn-failover-group')
    expect(config.DefaultCacheBehavior.AllowedMethods).toEqual(['GET', 'HEAD', 'OPTIONS'])
    // CloudFront only fails OPTIONS over when it is a cached method.
    expect(config.DefaultCacheBehavior.CachedMethods).toContain('OPTIONS')
  })

  it('makes a non-S3 failover host an HTTPS-only custom origin and honors failoverStatusCodes', () => {
    const config = distributionFor(
      cdnConfig({ failoverOrigin: 'backup.example.com', failoverStatusCodes: [504, 403, 503] }),
    ).Properties.DistributionConfig

    expect(config.Origins[1].CustomOriginConfig).toEqual({
      HTTPPort: 80,
      HTTPSPort: 443,
      OriginProtocolPolicy: 'https-only',
    })
    expect(config.Origins[1].S3OriginConfig).toBeUndefined()
    expect(config.OriginGroups.Items[0].FailoverCriteria.StatusCodes).toEqual({ Quantity: 3, Items: [403, 503, 504] })
  })

  it('keeps compute routes on their own origin when routeCompute is on', () => {
    const config = distributionFor({
      ...cdnConfig({}),
      infrastructure: {
        compute: { size: 'small', runtime: 'bun' },
        cdn: { main: { origin: PRIMARY, failoverOrigin: 'backup.example.com', routeCompute: true } },
      },
    } as CloudConfig).Properties.DistributionConfig

    expect(config.DefaultCacheBehavior.TargetOriginId).toBe('S3-my-app-production-main-cdn-failover-group')
    expect(config.CacheBehaviors.length).toBeGreaterThan(0)
    for (const behavior of config.CacheBehaviors) {
      expect(behavior.TargetOriginId).not.toBe('S3-my-app-production-main-cdn-failover-group')
    }
  })

  it('rejects status codes CloudFront cannot fail over on', () => {
    expect(() => distributionFor(cdnConfig({ failoverOrigin: 'backup.example.com', failoverStatusCodes: [500, 501] }))).toThrow(
      /501 is not a status code CloudFront can fail over on/,
    )
  })

  it('rejects failoverStatusCodes with no failoverOrigin', () => {
    expect(() => distributionFor(cdnConfig({ failoverStatusCodes: [500] }))).toThrow(
      /infrastructure\.cdn\.main: failoverStatusCodes needs failoverOrigin/,
    )
  })
})

describe('buildCloudFrontOriginConfig failoverOriginDomain', () => {
  const base = {
    aliases: ['stacksjs.com', 'www.stacksjs.com'],
    originDomain: 'origin.stacksjs.com',
    viewerCertificateArn: 'arn:aws:acm:us-east-1:123:certificate/abc',
    behaviors: [
      { pathPattern: '/api/*', kind: 'dynamic' as const },
      { pathPattern: '/docs/*', kind: 'static' as const },
    ],
    originSecret: 'shh',
    originShield: true,
    originShieldRegion: 'us-east-1',
  }

  it('emits the same config as before when failover is not configured', () => {
    expect(JSON.stringify(buildCloudFrontOriginConfig(base), null, 2)).toBe(
      JSON.stringify(fixture.originFronted, null, 2),
    )
  })

  it('groups a second box with the primary for the default behavior only', () => {
    const c = buildCloudFrontOriginConfig({ ...base, failoverOriginDomain: 'origin-dr.stacksjs.com' })

    expect(c.Origins.Quantity).toBe(2)
    const secondary = c.Origins.Items[1]
    expect(secondary.Id).toBe('origin-failover')
    expect(secondary.DomainName).toBe('origin-dr.stacksjs.com')
    expect(secondary.CustomOriginConfig.OriginProtocolPolicy).toBe('https-only')
    // The secondary box enforces the same origin guard.
    expect(secondary.CustomHeaders).toEqual(c.Origins.Items[0].CustomHeaders)
    expect(secondary.OriginShield).toEqual({ Enabled: false })

    expect(c.OriginGroups).toEqual({
      Quantity: 1,
      Items: [
        {
          Id: 'origin-failover-group',
          FailoverCriteria: { StatusCodes: { Quantity: 4, Items: [500, 502, 503, 504] } },
          Members: { Quantity: 2, Items: [{ OriginId: 'origin' }, { OriginId: 'origin-failover' }] },
        },
      ],
    })
    expect(c.DefaultCacheBehavior.TargetOriginId).toBe('origin-failover-group')
    // The write-capable /api/* behavior cannot target a group, so it stays on the primary.
    for (const b of c.CacheBehaviors.Items) expect(b.TargetOriginId).toBe('origin')
  })

  it('applies custom failover status codes', () => {
    const c = buildCloudFrontOriginConfig({
      ...base,
      failoverOriginDomain: 'origin-dr.stacksjs.com',
      failoverStatusCodes: [502, 429],
    })
    expect(c.OriginGroups.Items[0].FailoverCriteria.StatusCodes).toEqual({ Quantity: 2, Items: [429, 502] })
  })

  it('rejects invalid status codes, a looping failover host, and a failover host equal to the primary', () => {
    expect(() =>
      buildCloudFrontOriginConfig({ ...base, failoverOriginDomain: 'origin-dr.stacksjs.com', failoverStatusCodes: [418] }),
    ).toThrow(/418/)
    expect(() => buildCloudFrontOriginConfig({ ...base, failoverOriginDomain: 'www.stacksjs.com' })).toThrow(
      /must not be one of the aliases/,
    )
    expect(() => buildCloudFrontOriginConfig({ ...base, failoverOriginDomain: 'origin.stacksjs.com' })).toThrow(
      /must differ from originDomain/,
    )
    expect(() => buildCloudFrontOriginConfig({ ...base, failoverStatusCodes: [500] })).toThrow(
      /failoverStatusCodes needs failoverOriginDomain/,
    )
  })
})
