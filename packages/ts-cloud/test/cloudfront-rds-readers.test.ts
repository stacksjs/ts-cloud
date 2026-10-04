/**
 * Regression tests for CloudFront and RDS readers that disagreed with what
 * AWSClient actually returns.
 *
 * - CloudFront sends a write's new ETag as a response header. Five writes
 *   (the origin upsert/remove, updateDistribution, updateCustomErrorResponses
 *   and createFunction) never asked for headers, read `result.ETag` from the
 *   body, and so always reported an empty ETag.
 * - The parser yields `<Aliases><Items><CNAME>..` as `{ CNAME: string | string[] }`,
 *   never the `string[]` that `Distribution.Aliases.Items` declares, so
 *   findDistributionByDomain threw on any account with an aliased distribution
 *   and getDistribution's aliases matched nothing.
 * - An empty `<DBClusterSnapshots/>` parses as `''`, which describeDBClusterSnapshots
 *   wrapped into a one-element list.
 *
 * Bodies are the shapes AWS returned when this was audited, with example
 * identifiers, run through the real parser.
 */

import { describe, expect, it } from 'bun:test'
import { CloudFrontClient } from '../src/aws/cloudfront'
import { RDSClient } from '../src/aws/rds'

const XML = '<?xml version="1.0" encoding="UTF-8"?>\n'
const CF_NS = 'xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/"'
const RDS_NS = 'xmlns="http://rds.amazonaws.com/doc/2014-10-31/"'

/**
 * Answer requests in order with `xml` parsed by the client's own AWSClient,
 * shaped the way AWSClient shapes it: `{ body, headers }` only when the
 * request asked for headers, so a reader that forgets to ask gets no ETag.
 */
function respondInOrder(client: object, replies: Array<{ xml: string, etag?: string }>): Array<Record<string, any>> {
  const aws: any = (client as any).client
  const calls: Array<Record<string, any>> = []
  aws.request = async (options: any) => {
    const reply = replies[calls.length] ?? replies.at(-1)!
    calls.push(options)
    const body = aws.parseXmlResponse(XML + reply.xml)
    return options.returnHeaders ? { body, headers: reply.etag ? { etag: reply.etag } : {} } : body
  }
  return calls
}

function aliasesXml(names: string[]): string {
  if (!names.length)
    return '<Aliases><Quantity>0</Quantity></Aliases>'
  return `<Aliases><Quantity>${names.length}</Quantity><Items>${names.map(n => `<CNAME>${n}</CNAME>`).join('')}</Items></Aliases>`
}

function summaryXml(id: string, aliases: string[]): string {
  return `<DistributionSummary><Id>${id}</Id><ARN>arn:aws:cloudfront::123456789012:distribution/${id}</ARN><Status>Deployed</Status><DomainName>${id.toLowerCase()}.cloudfront.net</DomainName>${aliasesXml(aliases)}<Enabled>true</Enabled></DistributionSummary>`
}

const LIST = `<DistributionList ${CF_NS}><Marker></Marker><MaxItems>100</MaxItems><IsTruncated>false</IsTruncated><Quantity>3</Quantity><Items>${summaryXml('E1NOALIAS', [])}${summaryXml('E2ONEALIAS', ['cdn.example.com'])}${summaryXml('E3TWOALIAS', ['www.example.org', 'example.org'])}</Items></DistributionList>`

const CONFIG_FIELDS = '<CallerReference>ref</CallerReference><Comment></Comment><Enabled>true</Enabled>'
  + '<Origins><Quantity>1</Quantity><Items><Origin><Id>static</Id><DomainName>bucket.s3.amazonaws.com</DomainName><S3OriginConfig><OriginAccessIdentity></OriginAccessIdentity></S3OriginConfig></Origin></Items></Origins>'
  + '<DefaultCacheBehavior><TargetOriginId>static</TargetOriginId><ViewerProtocolPolicy>redirect-to-https</ViewerProtocolPolicy></DefaultCacheBehavior>'

function distributionXml(aliases: string[]): string {
  return `<Distribution ${CF_NS}><Id>E3TWOALIAS</Id><ARN>arn:aws:cloudfront::123456789012:distribution/E3TWOALIAS</ARN><Status>InProgress</Status><DomainName>e3twoalias.cloudfront.net</DomainName><DistributionConfig>${CONFIG_FIELDS}${aliasesXml(aliases)}</DistributionConfig></Distribution>`
}

function configXml(aliases: string[]): string {
  return `<DistributionConfig ${CF_NS}>${CONFIG_FIELDS}${aliasesXml(aliases)}</DistributionConfig>`
}

describe('CloudFront aliases arrive as the declared string list', () => {
  it('listDistributions returns Items as a string[] for none, one and several aliases', async () => {
    const cf = new CloudFrontClient()
    respondInOrder(cf, [{ xml: LIST }])
    const list = await cf.listDistributions()
    expect(list.map(d => d.Aliases)).toEqual([
      { Quantity: 0, Items: [] },
      { Quantity: 1, Items: ['cdn.example.com'] },
      { Quantity: 2, Items: ['www.example.org', 'example.org'] },
    ])
  })

  it('findDistributionByDomain matches an alias instead of throwing on Items.includes', async () => {
    const cf = new CloudFrontClient()
    respondInOrder(cf, [{ xml: LIST }])
    expect((await cf.findDistributionByDomain('example.org'))?.Id).toBe('E3TWOALIAS')
    expect((await cf.findDistributionByDomain('cdn.example.com'))?.Id).toBe('E2ONEALIAS')
    expect((await cf.findDistributionByDomain('e1noalias.cloudfront.net'))?.Id).toBe('E1NOALIAS')
    expect(await cf.findDistributionByDomain('missing.example.com')).toBeNull()
  })

  it('getDistribution returns { Quantity, Items } rather than the raw { CNAME } node', async () => {
    const cf = new CloudFrontClient()
    respondInOrder(cf, [{ xml: distributionXml(['only.example.com']) }])
    expect((await cf.getDistribution('E3TWOALIAS')).Aliases).toEqual({ Quantity: 1, Items: ['only.example.com'] })
  })
})

describe('CloudFront writes report the ETag from the response header', () => {
  it('updateDistribution asks for headers and reads the distribution from the body', async () => {
    const cf = new CloudFrontClient()
    const calls = respondInOrder(cf, [
      { xml: configXml(['www.example.org']), etag: 'E-BEFORE' },
      { xml: distributionXml(['www.example.org', 'example.org']), etag: 'E-AFTER' },
    ])
    const result = await cf.updateDistribution({ distributionId: 'E3TWOALIAS', aliases: ['www.example.org', 'example.org'] })
    expect(calls[1]).toMatchObject({ method: 'PUT', returnHeaders: true, headers: { 'If-Match': 'E-BEFORE' } })
    expect(result.ETag).toBe('E-AFTER')
    expect(result.Distribution).toMatchObject({ Id: 'E3TWOALIAS', Status: 'InProgress', Enabled: true })
  })

  it('updateCustomErrorResponses reports the new ETag and the aliases as a list', async () => {
    const cf = new CloudFrontClient()
    const calls = respondInOrder(cf, [
      { xml: configXml(['www.example.org', 'example.org']), etag: 'E-BEFORE' },
      { xml: distributionXml(['www.example.org', 'example.org']), etag: 'E-AFTER' },
    ])
    const result = await cf.updateCustomErrorResponses({
      distributionId: 'E3TWOALIAS',
      customErrorResponses: [{ errorCode: 404, responsePagePath: '/404.html', responseCode: 404 }],
    })
    expect(calls[1]).toMatchObject({ method: 'PUT', returnHeaders: true })
    expect(result.ETag).toBe('E-AFTER')
    expect(result.Distribution.Aliases).toEqual({ Quantity: 2, Items: ['www.example.org', 'example.org'] })
  })

  it('createFunction returns the ETag publishFunction needs', async () => {
    const cf = new CloudFrontClient()
    const calls = respondInOrder(cf, [{
      xml: `<FunctionSummary ${CF_NS}><Name>index-rewrite</Name><Status>UNPUBLISHED</Status><FunctionConfig><Comment></Comment><Runtime>cloudfront-js-2.0</Runtime></FunctionConfig><FunctionMetadata><FunctionARN>arn:aws:cloudfront::123456789012:function/index-rewrite</FunctionARN><Stage>DEVELOPMENT</Stage><CreatedTime>2026-10-04T04:00:00Z</CreatedTime><LastModifiedTime>2026-10-04T04:00:00Z</LastModifiedTime></FunctionMetadata></FunctionSummary>`,
      etag: 'ETVPDKIKX0DER',
    }])
    const result = await cf.createFunction({ name: 'index-rewrite', code: 'function handler(e) { return e.request }' })
    expect(calls[0]).toMatchObject({ method: 'POST', returnHeaders: true })
    expect(result).toEqual({
      FunctionARN: 'arn:aws:cloudfront::123456789012:function/index-rewrite',
      Name: 'index-rewrite',
      Stage: 'DEVELOPMENT',
      ETag: 'ETVPDKIKX0DER',
    })
  })
})

describe('RDSClient.describeDBClusterSnapshots', () => {
  function body(snapshots: string): string {
    return `<DescribeDBClusterSnapshotsResponse ${RDS_NS}><DescribeDBClusterSnapshotsResult>${snapshots}</DescribeDBClusterSnapshotsResult><ResponseMetadata><RequestId>a1b2c3d4</RequestId></ResponseMetadata></DescribeDBClusterSnapshotsResponse>`
  }
  const snapshot = (id: string) => `<DBClusterSnapshot><DBClusterSnapshotIdentifier>${id}</DBClusterSnapshotIdentifier><Status>available</Status></DBClusterSnapshot>`

  it('returns an empty list for an empty <DBClusterSnapshots/> (it returned [\'\'])', async () => {
    const rds = new RDSClient('us-west-2')
    respondInOrder(rds, [{ xml: body('<DBClusterSnapshots/>') }])
    expect((await rds.describeDBClusterSnapshots()).DBClusterSnapshots).toEqual([])
  })

  it('returns one and several snapshots as lists', async () => {
    const rds = new RDSClient('us-east-1')
    respondInOrder(rds, [{ xml: body(`<DBClusterSnapshots>${snapshot('one')}</DBClusterSnapshots>`) }])
    expect((await rds.describeDBClusterSnapshots()).DBClusterSnapshots).toEqual([
      { DBClusterSnapshotIdentifier: 'one', Status: 'available' },
    ])

    respondInOrder(rds, [{ xml: body(`<DBClusterSnapshots>${snapshot('a')}${snapshot('b')}</DBClusterSnapshots>`) }])
    expect((await rds.describeDBClusterSnapshots()).DBClusterSnapshots.map(s => s.DBClusterSnapshotIdentifier)).toEqual(['a', 'b'])
  })
})
