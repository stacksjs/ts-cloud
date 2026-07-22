import { afterEach, describe, expect, it } from 'bun:test'
import { resolveS3Endpoint } from '../src/aws/client'
import { S3Client } from '../src/aws/s3'

const credentials = {
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('S3-compatible custom endpoints', () => {
  it('uses an R2 origin for virtual-hosted presigned GET and PUT requests', () => {
    const client = new S3Client({
      region: 'auto',
      endpoint: 'https://account-id.r2.cloudflarestorage.com',
      credentials,
    })

    const get = new URL(client.generatePresignedGetUrl('assets', 'releases/app.js'))
    const put = new URL(client.generatePresignedPutUrl('assets', 'releases/app.js', 'text/javascript'))

    expect(get.protocol).toBe('https:')
    expect(get.host).toBe('assets.account-id.r2.cloudflarestorage.com')
    expect(get.pathname).toBe('/releases/app.js')
    expect(put.host).toBe(get.host)
    expect(put.pathname).toBe(get.pathname)
  })

  it('keeps the bucket in the path and preserves HTTP for MinIO', () => {
    const client = new S3Client({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:9000',
      forcePathStyle: true,
      credentials,
    })

    const url = new URL(client.generatePresignedGetUrl('assets', 'nested/file.txt'))
    expect(url.origin).toBe('http://127.0.0.1:9000')
    expect(url.pathname).toBe('/assets/nested/file.txt')
  })

  it('round-trips object requests through the configured R2 host', async () => {
    const requests: string[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(String(input))
      return new Response(init?.method === 'GET' ? 'round-trip' : '', { status: 200 })
    }) as typeof fetch

    const client = new S3Client({
      region: 'auto',
      endpoint: 'https://account-id.r2.cloudflarestorage.com',
      credentials,
    })
    await client.putObject({ bucket: 'assets', key: 'round-trip.txt', body: 'round-trip' })
    expect(await client.getObject('assets', 'round-trip.txt')).toBe('round-trip')

    expect(requests.map((request) => new URL(request).host)).toEqual([
      'assets.account-id.r2.cloudflarestorage.com',
      'assets.account-id.r2.cloudflarestorage.com',
    ])
    expect(requests.map((request) => new URL(request).pathname)).toEqual(['/round-trip.txt', '/round-trip.txt'])
  })

  it('uses the same MinIO origin and canonical path for binary and multipart requests', async () => {
    const requests: Array<{ url: string; authorization: string }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      requests.push({ url: String(input), authorization: headers.get('authorization') ?? '' })
      return new Response('', { status: 200, headers: { etag: '"part-1"' } })
    }) as typeof fetch

    const client = new S3Client({
      endpoint: 'http://127.0.0.1:9000',
      forcePathStyle: true,
      credentials,
    })
    await client.putObject({ bucket: 'assets', key: 'binary.dat', body: new Uint8Array([1, 2, 3]) })
    await client.uploadPart('assets', 'archive.tar', 'upload-id', 1, new Uint8Array([4, 5, 6]))

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/assets/binary.dat',
      '/assets/archive.tar',
    ])
    expect(requests.every((request) => request.url.startsWith('http://127.0.0.1:9000/'))).toBe(true)
    expect(requests.every((request) => request.authorization.includes('SignedHeaders='))).toBe(true)
  })

  it('normalizes host-only endpoints and rejects endpoint paths', () => {
    expect(
      resolveS3Endpoint({ region: 'auto', endpoint: 'account-id.r2.cloudflarestorage.com', path: '/' }),
    ).toMatchObject({ protocol: 'https', host: 'account-id.r2.cloudflarestorage.com' })
    expect(() => resolveS3Endpoint({ region: 'auto', endpoint: 'https://example.com/storage', path: '/' })).toThrow(
      'without a path',
    )
  })
})
