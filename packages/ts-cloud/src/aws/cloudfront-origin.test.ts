import { describe, expect, it } from 'bun:test'
import type { AWSRequestOptions } from './client'
import { CloudFrontClient } from './cloudfront'

function fixture(input: { pathTarget?: string } = {}) {
  const requests: AWSRequestOptions[] = []
  const config = {
    CallerReference: 'existing',
    Comment: 'keep me',
    Enabled: true,
    Origins: {
      Quantity: 1,
      Items: {
        Origin: { Id: 'static', DomainName: 'bucket.s3.amazonaws.com', S3OriginConfig: { OriginAccessIdentity: '' } },
      },
    },
    DefaultCacheBehavior: {
      TargetOriginId: 'static',
      ViewerProtocolPolicy: 'redirect-to-https',
      AllowedMethods: { Quantity: 2, Items: { Method: ['GET', 'HEAD'] } },
    },
    CacheBehaviors: input.pathTarget
      ? {
          Quantity: 1,
          Items: {
            CacheBehavior: {
              PathPattern: '/api/*',
              TargetOriginId: input.pathTarget,
              ViewerProtocolPolicy: 'redirect-to-https',
            },
          },
        }
      : { Quantity: 0 },
    ViewerCertificate: { CloudFrontDefaultCertificate: true },
    Restrictions: { GeoRestriction: { RestrictionType: 'none', Quantity: 0 } },
  }
  const transport = {
    request: async (request: AWSRequestOptions) => {
      requests.push(request)
      if (request.method === 'GET') return { headers: { etag: 'etag-before' }, body: structuredClone(config) }
      return { ETag: 'etag-after', Distribution: { Id: 'E123456789ABC' } }
    },
  }
  return { client: new CloudFrontClient(undefined, transport), requests }
}

describe('existing CloudFront origin patches', () => {
  it('previews and applies an isolated API origin without replacing the static default', async () => {
    const target = fixture()
    const preview = await target.client.upsertExistingDistributionOrigin('E123456789ABC', {
      id: 'api-lambda',
      domainName: 'abc.lambda-url.us-east-1.on.aws',
      pathPattern: '/api/*',
      dryRun: true,
    })
    expect(preview).toMatchObject({ changed: true, applied: false, pathPattern: '/api/*', etag: 'etag-before' })
    expect(target.requests).toHaveLength(1)
    const applied = await target.client.upsertExistingDistributionOrigin('E123456789ABC', {
      id: 'api-lambda',
      domainName: 'abc.lambda-url.us-east-1.on.aws',
      pathPattern: '/api/*',
    })
    expect(applied).toMatchObject({ changed: true, applied: true, etag: 'etag-after' })
    const update = target.requests.at(-1)!
    expect(update).toMatchObject({ method: 'PUT', headers: { 'If-Match': 'etag-before' } })
    expect(update.body).toContain('<TargetOriginId>static</TargetOriginId>')
    expect(update.body).toContain('<PathPattern>/api/*</PathPattern>')
    expect(update.body).toContain('<DomainName>abc.lambda-url.us-east-1.on.aws</DomainName>')
    expect(update.body).toContain('<OriginRequestPolicyId>b689b0a8-53d0-40ab-baf2-68738e2966ac</OriginRequestPolicyId>')
  })
  it('refuses to hijack a path owned by another live origin', async () => {
    const target = fixture({ pathTarget: 'existing-api' })
    await expect(
      target.client.upsertExistingDistributionOrigin('E123456789ABC', {
        id: 'api-lambda',
        domainName: 'abc.lambda-url.us-east-1.on.aws',
        pathPattern: '/api/*',
      }),
    ).rejects.toThrow('already targets existing-api')
    expect(target.requests).toHaveLength(1)
  })
  it('previews an exact rollback and refuses ambiguous origin removal', async () => {
    const target = fixture({ pathTarget: 'api-lambda' })
    const preview = await target.client.removeExistingDistributionOrigin('E123456789ABC', {
      id: 'api-lambda',
      domainName: 'abc.lambda-url.us-east-1.on.aws',
      pathPattern: '/api/*',
      dryRun: true,
    })
    expect(preview).toMatchObject({ changed: true, applied: false, originRemoved: false })
    const mismatched = fixture({ pathTarget: 'another-origin' })
    await expect(
      mismatched.client.removeExistingDistributionOrigin('E123456789ABC', {
        id: 'api-lambda',
        domainName: 'abc.lambda-url.us-east-1.on.aws',
        pathPattern: '/api/*',
      }),
    ).rejects.toThrow('no longer targets api-lambda')
  })
  it('rejects default behavior takeover, URLs, and traversal before any provider call', async () => {
    const target = fixture()
    await expect(
      target.client.upsertExistingDistributionOrigin('E123456789ABC', {
        id: 'api',
        domainName: 'https://evil.example/path',
        pathPattern: '/api/*',
      }),
    ).rejects.toThrow('hostname')
    await expect(
      target.client.upsertExistingDistributionOrigin('E123456789ABC', {
        id: 'api',
        domainName: 'api.example.com',
        pathPattern: '/*',
      }),
    ).rejects.toThrow('non-default')
    await expect(
      target.client.upsertExistingDistributionOrigin('E123456789ABC', {
        id: 'api',
        domainName: 'api.example.com',
        pathPattern: '/api/*',
        originPath: '/../admin',
      }),
    ).rejects.toThrow('traversal-free')
    expect(target.requests).toHaveLength(0)
  })
})
