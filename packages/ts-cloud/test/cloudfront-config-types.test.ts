/**
 * Pins RawDistributionConfig, the declared return type of getDistributionConfig,
 * to what the method actually returns.
 *
 * The type used to say every list was a string[] or an array of objects. The
 * parsed config holds each list as a CloudFront `{ Quantity, Items }` node
 * whose `Items` names the element (`{ Method: [..] }`), nests CachedMethods
 * inside AllowedMethods, and omits `Items` when Quantity is 0. Code written to
 * the old type found nothing: `cloud cdn:show` printed no origins because its
 * `Array.isArray(Origins.Items)` guard was never true.
 *
 * The fixture has the structure of a live config captured during the audit,
 * with example names and identifiers.
 */

import type { RawDistributionConfig } from '../src/aws/cloudfront'
import { describe, expect, it } from 'bun:test'
import { AWSClient } from '../src/aws/client'
import { CloudFrontClient } from '../src/aws/cloudfront'
import { asList } from '../src/aws/xml-result'

const NS = 'xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/"'

const methods = (names: string[]) => `<Quantity>${names.length}</Quantity><Items>${names.map(m => `<Method>${m}</Method>`).join('')}</Items>`
const behaviorBody = (target: string, allowed: string[]) =>
  `<TargetOriginId>${target}</TargetOriginId><TrustedSigners><Enabled>false</Enabled><Quantity>0</Quantity></TrustedSigners>`
  + `<TrustedKeyGroups><Enabled>false</Enabled><Quantity>0</Quantity></TrustedKeyGroups><ViewerProtocolPolicy>redirect-to-https</ViewerProtocolPolicy>`
  + `<AllowedMethods>${methods(allowed)}<CachedMethods>${methods(['HEAD', 'GET'])}</CachedMethods></AllowedMethods>`
  + `<SmoothStreaming>false</SmoothStreaming><Compress>true</Compress><LambdaFunctionAssociations><Quantity>0</Quantity></LambdaFunctionAssociations>`

function configXml(callerReference: string, cacheBehaviors: string): string {
  return `<DistributionConfig ${NS}><CallerReference>${callerReference}</CallerReference>`
    + `<Aliases><Quantity>2</Quantity><Items><CNAME>example.com</CNAME><CNAME>www.example.com</CNAME></Items></Aliases>`
    + `<DefaultRootObject>index.html</DefaultRootObject>`
    + `<Origins><Quantity>2</Quantity><Items>`
    + `<Origin><Id>S3-example-com</Id><DomainName>example-com.s3.us-east-1.amazonaws.com</DomainName><OriginPath></OriginPath><S3OriginConfig><OriginAccessIdentity></OriginAccessIdentity></S3OriginConfig><ConnectionAttempts>3</ConnectionAttempts><ConnectionTimeout>10</ConnectionTimeout><OriginAccessControlId>E2EXAMPLEOAC1</OriginAccessControlId></Origin>`
    + `<Origin><Id>EC2-API-Origin</Id><DomainName>api.example.com</DomainName><OriginPath></OriginPath><CustomOriginConfig><HTTPPort>3008</HTTPPort><HTTPSPort>443</HTTPSPort><OriginProtocolPolicy>http-only</OriginProtocolPolicy></CustomOriginConfig><ConnectionAttempts>3</ConnectionAttempts><ConnectionTimeout>10</ConnectionTimeout></Origin>`
    + `</Items></Origins>`
    + `<DefaultCacheBehavior>${behaviorBody('S3-example-com', ['HEAD', 'GET'])}`
    + `<FunctionAssociations><Quantity>1</Quantity><Items><FunctionAssociation><FunctionARN>arn:aws:cloudfront::123456789012:function/url-rewrite</FunctionARN><EventType>viewer-request</EventType></FunctionAssociation></Items></FunctionAssociations>`
    + `<CachePolicyId>658327ea-f89d-4fab-a63d-7e88639e58f6</CachePolicyId></DefaultCacheBehavior>`
    + cacheBehaviors
    + `<CustomErrorResponses><Quantity>2</Quantity><Items>`
    + `<CustomErrorResponse><ErrorCode>403</ErrorCode><ResponsePagePath>/404.html</ResponsePagePath><ResponseCode>404</ResponseCode><ErrorCachingMinTTL>300</ErrorCachingMinTTL></CustomErrorResponse>`
    + `<CustomErrorResponse><ErrorCode>404</ErrorCode><ResponsePagePath>/404.html</ResponsePagePath><ResponseCode>404</ResponseCode><ErrorCachingMinTTL>300</ErrorCachingMinTTL></CustomErrorResponse>`
    + `</Items></CustomErrorResponses>`
    + `<Comment></Comment><PriceClass>PriceClass_100</PriceClass><Enabled>true</Enabled>`
    + `<ViewerCertificate><CloudFrontDefaultCertificate>false</CloudFrontDefaultCertificate><SSLSupportMethod>sni-only</SSLSupportMethod><MinimumProtocolVersion>TLSv1.2_2021</MinimumProtocolVersion></ViewerCertificate>`
    + `<Restrictions><GeoRestriction><RestrictionType>none</RestrictionType><Quantity>0</Quantity></GeoRestriction></Restrictions>`
    + `<HttpVersion>http2and3</HttpVersion><IsIPV6Enabled>true</IsIPV6Enabled></DistributionConfig>`
}

const TWO_BEHAVIORS = `<CacheBehaviors><Quantity>2</Quantity><Items>`
  + `<CacheBehavior><PathPattern>/api</PathPattern>${behaviorBody('EC2-API-Origin', ['HEAD', 'DELETE', 'POST', 'GET', 'OPTIONS', 'PUT', 'PATCH'])}</CacheBehavior>`
  + `<CacheBehavior><PathPattern>/api/*</PathPattern>${behaviorBody('EC2-API-Origin', ['HEAD', 'DELETE', 'POST', 'GET', 'OPTIONS', 'PUT', 'PATCH'])}</CacheBehavior>`
  + `</Items></CacheBehaviors>`

async function configFrom(xml: string): Promise<{ client: CloudFrontClient, config: RawDistributionConfig }> {
  const parser: any = new AWSClient()
  const client = new CloudFrontClient(undefined, {
    request: async () => ({
      body: parser.parseXmlResponse(`<?xml version="1.0"?>\n${xml}`),
      headers: { etag: 'E2QWRUHAPOMQZL' },
    }),
  })
  return { client, config: (await client.getDistributionConfig('E1EXAMPLE')).DistributionConfig }
}

describe('getDistributionConfig returns what RawDistributionConfig declares', () => {
  it('holds every list as a { Quantity, Items: { <Element>: .. } } node', async () => {
    const { config } = await configFrom(configXml('b82282d9-9d48-20a9-5e28-08e59f7594bb', TWO_BEHAVIORS))

    expect(asList(config.Origins.Items?.Origin).map(o => o.Id)).toEqual(['S3-example-com', 'EC2-API-Origin'])
    expect(config.Aliases).toEqual({ Quantity: 2, Items: { CNAME: ['example.com', 'www.example.com'] } })
    expect(config.DefaultCacheBehavior.AllowedMethods?.Items?.Method).toEqual(['HEAD', 'GET'])
    expect(asList(config.DefaultCacheBehavior.FunctionAssociations?.Items?.FunctionAssociation)).toEqual([
      { FunctionARN: 'arn:aws:cloudfront::123456789012:function/url-rewrite', EventType: 'viewer-request' },
    ])
    expect(asList(config.CacheBehaviors?.Items?.CacheBehavior).map(b => b.PathPattern)).toEqual(['/api', '/api/*'])
    expect(asList(config.CustomErrorResponses?.Items?.CustomErrorResponse).map(r => r.ErrorCode)).toEqual([403, 404])
  })

  it('nests CachedMethods inside AllowedMethods, not beside it', async () => {
    const { config } = await configFrom(configXml('ref', TWO_BEHAVIORS))
    expect(config.DefaultCacheBehavior.AllowedMethods?.CachedMethods).toEqual({ Quantity: 2, Items: { Method: ['HEAD', 'GET'] } })
    expect('CachedMethods' in config.DefaultCacheBehavior).toBe(false)
  })

  it('omits Items for an empty list, and keeps a single element bare', async () => {
    const { config: none } = await configFrom(configXml('ref', '<CacheBehaviors><Quantity>0</Quantity></CacheBehaviors>'))
    expect(none.CacheBehaviors).toEqual({ Quantity: 0 })
    expect(none.DefaultCacheBehavior.LambdaFunctionAssociations).toEqual({ Quantity: 0 })

    const one = `<CacheBehaviors><Quantity>1</Quantity><Items><CacheBehavior><PathPattern>/api/*</PathPattern>${behaviorBody('EC2-API-Origin', ['GET', 'HEAD'])}</CacheBehavior></Items></CacheBehaviors>`
    const { config: single } = await configFrom(configXml('ref', one))
    expect(Array.isArray(single.CacheBehaviors?.Items?.CacheBehavior)).toBe(false)
    expect(asList(single.CacheBehaviors?.Items?.CacheBehavior)).toHaveLength(1)
  })

  it('returns a numeric CallerReference as a number and a UUID as a string', async () => {
    expect((await configFrom(configXml('1584918236', ''))).config.CallerReference).toBe(1584918236)
    expect((await configFrom(configXml('b82282d9-9d48-20a9-5e28-08e59f7594bb', ''))).config.CallerReference)
      .toBe('b82282d9-9d48-20a9-5e28-08e59f7594bb')
  })

  it('is the shape updates send back: build then re-parse gives the same config', async () => {
    for (const reference of ['1584918236', 'b82282d9-9d48-20a9-5e28-08e59f7594bb']) {
      const { client, config } = await configFrom(configXml(reference, TWO_BEHAVIORS))
      const rebuilt = (client as any).buildDistributionConfigXml(config) as string
      const { config: reparsed } = await configFrom(rebuilt.replace('<DistributionConfig', `<DistributionConfig ${NS}`).replace(/^<\?xml[^>]*>\s*/, ''))
      expect(reparsed).toEqual(config)
    }
  })
})
