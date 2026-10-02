import { describe, expect, it } from 'bun:test'
import { CDN } from '../src/modules/cdn'
import {
  assertOriginGroupMethods,
  buildOriginGroups,
  CLOUDFRONT_FAILOVER_STATUS_CODES,
  DEFAULT_FAILOVER_STATUS_CODES,
  isS3RestEndpoint,
  resolveFailoverStatusCodes,
} from '../src/modules/cdn-failover'
import noFailoverFixture from './fixtures/cdn-distribution-no-failover.json'

// stacksjs/stacks#1159

describe('resolveFailoverStatusCodes', () => {
  it('defaults to the server-error codes', () => {
    expect(resolveFailoverStatusCodes()).toEqual([500, 502, 503, 504])
    expect(DEFAULT_FAILOVER_STATUS_CODES).toEqual([500, 502, 503, 504])
  })

  it('accepts every code CloudFront documents, deduplicated and sorted', () => {
    expect(resolveFailoverStatusCodes([504, 403, 504, 404])).toEqual([403, 404, 504])
    expect(resolveFailoverStatusCodes(CLOUDFRONT_FAILOVER_STATUS_CODES)).toEqual([
      400, 403, 404, 416, 429, 500, 502, 503, 504,
    ])
  })

  it('rejects codes CloudFront cannot fail over on', () => {
    expect(() => resolveFailoverStatusCodes([500, 501])).toThrow(/501 is not a status code CloudFront can fail over on/)
    expect(() => resolveFailoverStatusCodes([200, 301])).toThrow(/200, 301 are not status codes/)
  })

  it('rejects an empty list instead of emitting an invalid StatusCodes block', () => {
    expect(() => resolveFailoverStatusCodes([])).toThrow(/at least one code/)
  })
})

describe('buildOriginGroups', () => {
  it('emits the CloudFormation OriginGroups shape, primary first', () => {
    expect(buildOriginGroups({ primaryOriginId: 'primary', secondaryOriginId: 'secondary' })).toEqual({
      Quantity: 1,
      Items: [
        {
          Id: 'primary-failover-group',
          FailoverCriteria: { StatusCodes: { Quantity: 4, Items: [500, 502, 503, 504] } },
          Members: { Quantity: 2, Items: [{ OriginId: 'primary' }, { OriginId: 'secondary' }] },
        },
      ],
    })
  })

  it('honors a custom group id and status codes', () => {
    const groups = buildOriginGroups({
      primaryOriginId: 'a',
      secondaryOriginId: 'b',
      groupId: 'ha',
      statusCodes: [404, 503],
    })
    expect(groups.Items[0].Id).toBe('ha')
    expect(groups.Items[0].FailoverCriteria.StatusCodes).toEqual({ Quantity: 2, Items: [404, 503] })
  })

  it('refuses a group whose two members are the same origin', () => {
    expect(() => buildOriginGroups({ primaryOriginId: 'a', secondaryOriginId: 'a' })).toThrow(/must differ/)
  })
})

describe('assertOriginGroupMethods', () => {
  it('allows read-only behaviors in either the CloudFormation or the API form', () => {
    expect(() => assertOriginGroupMethods(['GET', 'HEAD'])).not.toThrow()
    expect(() => assertOriginGroupMethods(['GET', 'HEAD', 'OPTIONS'])).not.toThrow()
    expect(() => assertOriginGroupMethods({ Items: ['GET', 'HEAD', 'OPTIONS'] })).not.toThrow()
  })

  it('rejects a behavior that allows writes, naming the methods', () => {
    expect(() =>
      assertOriginGroupMethods(['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'], 'the /api/* behavior'),
    ).toThrow(/the \/api\/\* behavior allows PUT, POST, PATCH, DELETE/)
    expect(() => assertOriginGroupMethods({ Items: ['GET', 'POST'] })).toThrow(/may only allow GET, HEAD, OPTIONS/)
  })
})

describe('isS3RestEndpoint', () => {
  it('recognizes S3 REST endpoints and leaves website endpoints and other hosts custom', () => {
    expect(isS3RestEndpoint('my-bucket.s3.amazonaws.com')).toBe(true)
    expect(isS3RestEndpoint('my-bucket.s3.us-west-2.amazonaws.com')).toBe(true)
    expect(isS3RestEndpoint('my-bucket.s3-us-west-2.amazonaws.com')).toBe(true)
    expect(isS3RestEndpoint('my-bucket.s3-website-us-east-1.amazonaws.com')).toBe(false)
    expect(isS3RestEndpoint('origin.example.com')).toBe(false)
  })
})

describe('CDN.createDistribution origin failover', () => {
  const base = {
    slug: 'my-app',
    environment: 'production' as const,
    origin: { type: 's3' as const, domainName: 'my-bucket.s3.amazonaws.com' },
  }

  it('leaves a distribution without failover exactly as before', () => {
    const { distribution } = CDN.createDistribution(base)
    expect(JSON.stringify(distribution, null, 2)).toBe(JSON.stringify(noFailoverFixture, null, 2))
    expect(distribution.Properties.DistributionConfig.OriginGroups).toBeUndefined()
  })

  it('adds the secondary origin and serves the default behavior from the group', () => {
    const { distribution } = CDN.createDistribution({
      ...base,
      failoverOrigin: { domainName: 'my-bucket-replica.s3.us-west-2.amazonaws.com' },
    })
    const config = distribution.Properties.DistributionConfig

    expect(config.Origins).toHaveLength(2)
    expect(config.Origins[1]).toEqual({
      Id: 'FailoverOrigin',
      DomainName: 'my-bucket-replica.s3.us-west-2.amazonaws.com',
      OriginPath: '',
      S3OriginConfig: { OriginAccessIdentity: '' },
      // Shares the primary's origin access control.
      OriginAccessControlId: { Ref: 'MyAppProductionCdnOAC' } as any,
    })
    expect(config.OriginGroups).toEqual({
      Quantity: 1,
      Items: [
        {
          Id: 'DefaultOrigin-failover-group',
          FailoverCriteria: { StatusCodes: { Quantity: 4, Items: [500, 502, 503, 504] } },
          Members: { Quantity: 2, Items: [{ OriginId: 'DefaultOrigin' }, { OriginId: 'FailoverOrigin' }] },
        },
      ],
    })
    expect(config.DefaultCacheBehavior.TargetOriginId).toBe('DefaultOrigin-failover-group')
  })

  it('makes a non-S3 secondary an HTTPS-only custom origin and applies custom status codes', () => {
    const { distribution } = CDN.createDistribution({
      ...base,
      failoverOrigin: { domainName: 'backup.example.com', id: 'Backup', statusCodes: [503, 404] },
    })
    const config = distribution.Properties.DistributionConfig
    expect(config.Origins[1].CustomOriginConfig).toEqual({ HTTPPort: 80, HTTPSPort: 443, OriginProtocolPolicy: 'https-only' })
    expect(config.OriginGroups?.Items?.[0].FailoverCriteria.StatusCodes.Items).toEqual([404, 503])
    expect(config.OriginGroups?.Items?.[0].Members.Items[1].OriginId).toBe('Backup')
  })

  it('rejects invalid failover status codes', () => {
    expect(() =>
      CDN.createDistribution({ ...base, failoverOrigin: { domainName: 'backup.example.com', statusCodes: [500, 501] } }),
    ).toThrow(/501/)
  })

  it('refuses to put an origin group behind a behavior that allows writes', () => {
    const { distribution } = CDN.createApiDistribution({
      slug: 'my-app',
      environment: 'production',
      albDomainName: 'alb.example.com',
    })
    expect(() => CDN.addOriginFailover(distribution, { domainName: 'alb-dr.example.com' })).toThrow(
      /default cache behavior allows PUT, POST, PATCH, DELETE/,
    )
    // Nothing was half-applied.
    expect(distribution.Properties.DistributionConfig.Origins).toHaveLength(1)
    expect(distribution.Properties.DistributionConfig.OriginGroups).toBeUndefined()
  })

  it('refuses a second origin group', () => {
    const { distribution } = CDN.createDistribution({ ...base, failoverOrigin: { domainName: 'backup.example.com' } })
    expect(() => CDN.addOriginFailover(distribution, { domainName: 'other.example.com', id: 'Other' })).toThrow(
      /already has an origin group/,
    )
  })
})
