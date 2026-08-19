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
})
