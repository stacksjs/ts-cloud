/**
 * Regression tests for the S3Client XML response parsing.
 *
 * The XML parser in AWSClient.parseXmlResponse strips the single-root wrapper
 * (so `<ListAllMyBucketsResult>` becomes the top-level object). Earlier code
 * looked for `result.ListAllMyBucketsResult.Buckets.Bucket`, which silently
 * returned `undefined` and caused listBuckets/list/listAll/listObjectsV2 to
 * report 0 results regardless of how many actually existed (issue #105).
 *
 * These tests pin the contract: pass in the unwrapped shape that the parser
 * actually produces, and the wrappers must walk it correctly.
 */

import { describe, expect, it } from 'bun:test'
import { S3Client } from '../src/aws/s3'

function withMockedRequest(client: S3Client, response: any): void {
  // @ts-expect-error — reach into the private AWSClient to stub one call
  client.client.request = async () => response
}

describe('S3Client XML response parsing (issue #105)', () => {
  it('listBuckets returns buckets when given the unwrapped shape', async () => {
    const client = new S3Client('us-east-1')
    withMockedRequest(client, {
      '@_xmlns': 'http://s3.amazonaws.com/doc/2006-03-01/',
      Owner: { ID: 'test-owner' },
      Buckets: {
        Bucket: [
          { Name: 'bucket-a', CreationDate: '2024-01-01T00:00:00.000Z' },
          { Name: 'bucket-b', CreationDate: '2024-02-01T00:00:00.000Z' },
        ],
      },
    })

    const result = await client.listBuckets()
    expect(result.Buckets).toHaveLength(2)
    expect(result.Buckets[0].Name).toBe('bucket-a')
    expect(result.Buckets[1].Name).toBe('bucket-b')
  })

  it('listBuckets handles a single bucket (XML parser produces an object, not an array)', async () => {
    const client = new S3Client('us-east-1')
    withMockedRequest(client, {
      Owner: { ID: 'test' },
      Buckets: { Bucket: { Name: 'only-one', CreationDate: '2024-01-01T00:00:00.000Z' } },
    })

    const result = await client.listBuckets()
    expect(result.Buckets).toHaveLength(1)
    expect(result.Buckets[0].Name).toBe('only-one')
  })

  it('listBuckets returns empty array on an empty account', async () => {
    const client = new S3Client('us-east-1')
    withMockedRequest(client, { Owner: { ID: 'test' }, Buckets: '' })

    const result = await client.listBuckets()
    expect(result.Buckets).toEqual([])
  })

  it('listBuckets still works if a future parser keeps the ListAllMyBucketsResult wrapper', async () => {
    const client = new S3Client('us-east-1')
    withMockedRequest(client, {
      ListAllMyBucketsResult: {
        Owner: { ID: 'test' },
        Buckets: {
          Bucket: [{ Name: 'wrapped-bucket', CreationDate: '2024-01-01T00:00:00.000Z' }],
        },
      },
    })

    const result = await client.listBuckets()
    expect(result.Buckets).toHaveLength(1)
    expect(result.Buckets[0].Name).toBe('wrapped-bucket')
  })

  it('list returns objects when given the unwrapped shape', async () => {
    const client = new S3Client('us-east-1')
    withMockedRequest(client, {
      Name: 'my-bucket',
      MaxKeys: 1000,
      IsTruncated: false,
      Contents: [
        { Key: 'file-a.txt', LastModified: '2024-01-01', Size: '100', ETag: '"abc"' },
        { Key: 'file-b.txt', LastModified: '2024-01-02', Size: '200', ETag: '"def"' },
      ],
    })

    const objects = await client.list({ bucket: 'my-bucket' })
    expect(objects).toHaveLength(2)
    expect(objects[0].Key).toBe('file-a.txt')
    expect(objects[0].Size).toBe(100)
    expect(objects[1].Key).toBe('file-b.txt')
  })

  it('getBucketVersioning reads Status from the unwrapped shape (live: it read undefined)', async () => {
    const client = new S3Client('us-west-2')
    withMockedRequest(client, { '@_xmlns': 'http://s3.amazonaws.com/doc/2006-03-01/', Status: 'Enabled' })
    expect(await client.getBucketVersioning('b')).toEqual({ Status: 'Enabled' })

    withMockedRequest(client, { VersioningConfiguration: { Status: 'Suspended' } })
    expect(await client.getBucketVersioning('b')).toEqual({ Status: 'Suspended' })

    withMockedRequest(client, { '@_xmlns': 'http://s3.amazonaws.com/doc/2006-03-01/' })
    expect(await client.getBucketVersioning('b')).toEqual({ Status: undefined })
  })
})

/**
 * The bucket-configuration getters read `result.<RootElement>`, which the
 * root-stripping parser never produces, so each returned undefined for a bucket
 * that has the configuration. These fixtures go through the real
 * parseXmlResponse, so the expected shapes cannot drift from what it emits.
 * The bodies are the ones S3 returned for live buckets, trimmed.
 */
describe('S3Client bucket configuration getters read through the stripped root', () => {
  const XML = '<?xml version="1.0" encoding="UTF-8"?>\n'
  const NS = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"'

  function withXmlResponse(client: S3Client, xml: string): void {
    // @ts-expect-error — reach into the private AWSClient to stub one call
    const aws: any = client.client
    aws.request = async () => aws.parseXmlResponse(xml)
  }

  const cases: Array<{
    getter: string
    root: string
    xml: string
    expected: any
  }> = [
    {
      getter: 'getBucketLifecycleConfiguration',
      root: 'LifecycleConfiguration',
      xml: `<LifecycleConfiguration ${NS}><Rule><ID>CleanupOldVersions</ID><Filter><Prefix></Prefix></Filter><Status>Enabled</Status><NoncurrentVersionExpiration><NoncurrentDays>365</NoncurrentDays></NoncurrentVersionExpiration></Rule></LifecycleConfiguration>`,
      expected: { Rule: { ID: 'CleanupOldVersions', Filter: { Prefix: '' }, Status: 'Enabled', NoncurrentVersionExpiration: { NoncurrentDays: 365 } } },
    },
    {
      getter: 'getBucketCors',
      root: 'CORSConfiguration',
      xml: `<CORSConfiguration ${NS}><CORSRule><AllowedHeader>*</AllowedHeader><AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedOrigin>*</AllowedOrigin></CORSRule></CORSConfiguration>`,
      expected: { CORSRule: { AllowedHeader: '*', AllowedMethod: ['GET', 'PUT'], AllowedOrigin: '*' } },
    },
    {
      getter: 'getBucketEncryption',
      root: 'ServerSideEncryptionConfiguration',
      xml: `<ServerSideEncryptionConfiguration ${NS}><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm></ApplyServerSideEncryptionByDefault><BucketKeyEnabled>false</BucketKeyEnabled></Rule></ServerSideEncryptionConfiguration>`,
      expected: { Rule: { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: false } },
    },
    {
      getter: 'getBucketNotificationConfiguration',
      root: 'NotificationConfiguration',
      xml: `<NotificationConfiguration ${NS}><QueueConfiguration><Id>uploads</Id><Queue>arn:aws:sqs:us-east-1:123456789012:uploads</Queue><Event>s3:ObjectCreated:*</Event></QueueConfiguration></NotificationConfiguration>`,
      expected: { QueueConfiguration: { Id: 'uploads', Queue: 'arn:aws:sqs:us-east-1:123456789012:uploads', Event: 's3:ObjectCreated:*' } },
    },
    {
      getter: 'getBucketWebsite',
      root: 'WebsiteConfiguration',
      xml: `<WebsiteConfiguration ${NS}><IndexDocument><Suffix>index.html</Suffix></IndexDocument><ErrorDocument><Key>404.html</Key></ErrorDocument></WebsiteConfiguration>`,
      expected: { IndexDocument: { Suffix: 'index.html' }, ErrorDocument: { Key: '404.html' } },
    },
    {
      getter: 'getBucketReplication',
      root: 'ReplicationConfiguration',
      xml: `<ReplicationConfiguration ${NS}><Role>arn:aws:iam::123456789012:role/replication</Role><Rule><ID>to-west</ID><Status>Enabled</Status><Priority>1</Priority><Destination><Bucket>arn:aws:s3:::replica</Bucket></Destination></Rule></ReplicationConfiguration>`,
      expected: { Role: 'arn:aws:iam::123456789012:role/replication', Rule: { ID: 'to-west', Status: 'Enabled', Priority: 1, Destination: { Bucket: 'arn:aws:s3:::replica' } } },
    },
    {
      getter: 'getPublicAccessBlock',
      root: 'PublicAccessBlockConfiguration',
      xml: `<PublicAccessBlockConfiguration ${NS}><BlockPublicAcls>false</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>true</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>`,
      expected: { BlockPublicAcls: false, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
    },
    {
      getter: 'getBucketLogging',
      root: 'BucketLoggingStatus',
      xml: `<BucketLoggingStatus ${NS}><LoggingEnabled><TargetBucket>logs</TargetBucket><TargetPrefix>site/</TargetPrefix></LoggingEnabled></BucketLoggingStatus>`,
      expected: { LoggingEnabled: { TargetBucket: 'logs', TargetPrefix: 'site/' } },
    },
    {
      getter: 'getBucketAcl',
      root: 'AccessControlPolicy',
      xml: `<AccessControlPolicy ${NS}><Owner><ID>owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Group"><URI>http://acs.amazonaws.com/groups/global/AllUsers</URI></Grantee><Permission>READ</Permission></Grant></AccessControlList></AccessControlPolicy>`,
      expected: {
        Owner: { ID: 'owner' },
        AccessControlList: {
          Grant: {
            Grantee: { '@_xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance', '@_xsi:type': 'Group', 'URI': 'http://acs.amazonaws.com/groups/global/AllUsers' },
            Permission: 'READ',
          },
        },
      },
    },
  ]

  for (const { getter, root, xml, expected } of cases) {
    it(`${getter} returns the configuration from a real S3 body (it returned undefined)`, async () => {
      const client = new S3Client('us-east-1')
      withXmlResponse(client, XML + xml)
      expect(await (client as any)[getter]('b')).toEqual(expected)
    })

    it(`${getter} still reads a body that keeps the <${root}> wrapper`, async () => {
      const client = new S3Client('us-east-1')
      withMockedRequest(client, { [root]: expected })
      expect(await (client as any)[getter]('b')).toEqual(expected)
    })
  }

  it('getObjectAcl reads the policy through the stripped root', async () => {
    const client = new S3Client('us-east-1')
    withXmlResponse(client, `${XML}<AccessControlPolicy ${NS}><Owner><ID>owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>owner</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>`)
    const acl = await client.getObjectAcl('b', 'k')
    expect(acl.Owner).toEqual({ ID: 'owner' })
    expect(acl.AccessControlList.Grant.Permission).toBe('FULL_CONTROL')
  })

  it('an unconfigured notification or logging body is empty, not undefined and not the xmlns attribute', async () => {
    const client = new S3Client('us-east-1')
    withXmlResponse(client, `${XML}<NotificationConfiguration ${NS}/>`)
    expect(await client.getBucketNotificationConfiguration('b')).toEqual({})

    withXmlResponse(client, `${XML}<BucketLoggingStatus ${NS}/>`)
    expect(await client.getBucketLogging('b')).toEqual({})
  })

  it('getBucketLocation reads the region from the root text (it always said us-east-1)', async () => {
    const client = new S3Client('us-east-1')
    withXmlResponse(client, `${XML}<LocationConstraint ${NS}>us-west-2</LocationConstraint>`)
    expect(await client.getBucketLocation('b')).toBe('us-west-2')

    // Without the xmlns attribute the parser yields a bare string.
    withXmlResponse(client, `${XML}<LocationConstraint>eu-central-1</LocationConstraint>`)
    expect(await client.getBucketLocation('b')).toBe('eu-central-1')

    withMockedRequest(client, { LocationConstraint: 'ap-southeast-2' })
    expect(await client.getBucketLocation('b')).toBe('ap-southeast-2')

    // An empty constraint is how S3 reports us-east-1.
    withXmlResponse(client, `${XML}<LocationConstraint ${NS}/>`)
    expect(await client.getBucketLocation('b')).toBe('us-east-1')
  })

  it('a 404 (no such configuration) still resolves to null', async () => {
    const client = new S3Client('us-east-1')
    // @ts-expect-error — reach into the private AWSClient to stub one call
    client.client.request = async () => {
      throw Object.assign(new Error('AWS Error [NoSuchCORSConfiguration]'), { statusCode: 404 })
    }
    expect(await client.getBucketCors('b')).toBeNull()
  })
})
