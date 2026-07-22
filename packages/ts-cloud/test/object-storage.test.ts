/**
 * Multi-provider object storage tests.
 *
 * AWS S3, Backblaze B2 and Hetzner Object Storage share the S3 API + SigV4, so
 * the same S3Client drives all three. These tests pin:
 *   - the pure endpoint/path resolver (host + canonical path per addressing style)
 *   - the provider preset endpoints
 *   - config resolution from explicit values and environment variables
 *   - that a constructed client signs against the correct provider host
 *
 * Crucially, with no endpoint and no path-style the resolver retains the AWS host
 * and path while making the default HTTPS transport explicit.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolveS3Endpoint } from '../src/aws/client'
import { createObjectStorageClient, providerEndpoint, resolveObjectStorage } from '../src/object-storage'

describe('resolveS3Endpoint', () => {
  it('preserves AWS virtual-hosted behavior when no endpoint is given', () => {
    expect(resolveS3Endpoint({ region: 'us-east-1', path: '/file.txt', bucket: 'my-bucket' })).toEqual({
      protocol: 'https',
      host: 'my-bucket.s3.us-east-1.amazonaws.com',
      path: '/file.txt',
    })
  })

  it('uses the bare regional host when no bucket is scoped (e.g. ListBuckets)', () => {
    expect(resolveS3Endpoint({ region: 'eu-west-1', path: '/' })).toEqual({
      protocol: 'https',
      host: 's3.eu-west-1.amazonaws.com',
      path: '/',
    })
  })

  it('leaves a bucket-in-path request untouched (path-style already encoded)', () => {
    expect(resolveS3Endpoint({ region: 'us-east-1', path: '/my-bucket?policy=' })).toEqual({
      protocol: 'https',
      host: 's3.us-east-1.amazonaws.com',
      path: '/my-bucket?policy=',
    })
  })

  it('builds Backblaze B2 virtual-hosted hosts', () => {
    expect(
      resolveS3Endpoint({
        region: 'us-west-004',
        path: '/pkg.tgz',
        bucket: 'pantry',
        endpoint: 's3.us-west-004.backblazeb2.com',
      }),
    ).toEqual({ protocol: 'https', host: 'pantry.s3.us-west-004.backblazeb2.com', path: '/pkg.tgz' })
  })

  it('builds Hetzner virtual-hosted hosts', () => {
    expect(
      resolveS3Endpoint({
        region: 'fsn1',
        path: '/pkg.tgz',
        bucket: 'pantry',
        endpoint: 'fsn1.your-objectstorage.com',
      }),
    ).toEqual({ protocol: 'https', host: 'pantry.fsn1.your-objectstorage.com', path: '/pkg.tgz' })
  })

  it('moves the bucket into the path for path-style addressing', () => {
    expect(
      resolveS3Endpoint({
        region: 'fsn1',
        path: '/pkg.tgz',
        bucket: 'pantry',
        endpoint: 'fsn1.your-objectstorage.com',
        forcePathStyle: true,
      }),
    ).toEqual({ protocol: 'https', host: 'fsn1.your-objectstorage.com', path: '/pantry/pkg.tgz' })
  })

  it('handles a bucket-root request in path-style mode', () => {
    expect(
      resolveS3Endpoint({
        region: 'us-west-004',
        path: '/',
        bucket: 'pantry',
        endpoint: 's3.us-west-004.backblazeb2.com',
        forcePathStyle: true,
      }),
    ).toEqual({ protocol: 'https', host: 's3.us-west-004.backblazeb2.com', path: '/pantry' })
  })
})

describe('providerEndpoint', () => {
  it('returns undefined for AWS (uses the default endpoint)', () => {
    expect(providerEndpoint('aws', 'us-east-1')).toBeUndefined()
  })

  it('returns the Backblaze B2 endpoint', () => {
    expect(providerEndpoint('backblaze', 'eu-central-003')).toBe('s3.eu-central-003.backblazeb2.com')
  })

  it('returns the Hetzner endpoint', () => {
    expect(providerEndpoint('hetzner', 'nbg1')).toBe('nbg1.your-objectstorage.com')
  })
})

describe('resolveObjectStorage', () => {
  // Snapshot and restore the env vars these tests touch so they don't leak.
  const TOUCHED = [
    'OBJECT_STORAGE_PROVIDER',
    'STORAGE_PROVIDER',
    'S3_ENDPOINT',
    'S3_REGION',
    'S3_FORCE_PATH_STYLE',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'B2_REGION',
    'B2_APPLICATION_KEY_ID',
    'B2_KEY_ID',
    'B2_APPLICATION_KEY',
    'B2_SECRET_KEY',
    'HETZNER_S3_REGION',
    'HETZNER_REGION',
    'HETZNER_S3_ACCESS_KEY',
    'HETZNER_S3_SECRET_KEY',
  ]
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = {}
    for (const k of TOUCHED) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('defaults to AWS us-east-1 with no endpoint', () => {
    const r = resolveObjectStorage()
    expect(r.provider).toBe('aws')
    expect(r.region).toBe('us-east-1')
    expect(r.endpoint).toBeUndefined()
    expect(r.forcePathStyle).toBe(false)
    expect(r.publicBaseUrl('bkt')).toBe('https://bkt.s3.us-east-1.amazonaws.com')
  })

  it('derives the Backblaze endpoint and credentials from config + env', () => {
    process.env.B2_APPLICATION_KEY_ID = 'keyid123'
    process.env.B2_APPLICATION_KEY = 'appkey456'
    const r = resolveObjectStorage({ provider: 'backblaze', region: 'us-west-004' })
    expect(r.endpoint).toBe('s3.us-west-004.backblazeb2.com')
    expect(r.credentials).toEqual({ accessKeyId: 'keyid123', secretAccessKey: 'appkey456', sessionToken: undefined })
    expect(r.publicBaseUrl('pantry')).toBe('https://pantry.s3.us-west-004.backblazeb2.com')
  })

  it('reads the provider and region from environment variables', () => {
    process.env.OBJECT_STORAGE_PROVIDER = 'hetzner'
    process.env.HETZNER_S3_REGION = 'nbg1'
    process.env.HETZNER_S3_ACCESS_KEY = 'hk'
    process.env.HETZNER_S3_SECRET_KEY = 'hs'
    const r = resolveObjectStorage()
    expect(r.provider).toBe('hetzner')
    expect(r.region).toBe('nbg1')
    expect(r.endpoint).toBe('nbg1.your-objectstorage.com')
    expect(r.credentials).toEqual({ accessKeyId: 'hk', secretAccessKey: 'hs', sessionToken: undefined })
  })

  it('honors an explicit S3_ENDPOINT override and path-style env flag', () => {
    process.env.STORAGE_PROVIDER = 'backblaze'
    process.env.B2_REGION = 'us-west-004'
    process.env.S3_ENDPOINT = 'my.custom.gateway'
    process.env.S3_FORCE_PATH_STYLE = 'true'
    const r = resolveObjectStorage()
    expect(r.endpoint).toBe('my.custom.gateway')
    expect(r.forcePathStyle).toBe(true)
    expect(r.publicBaseUrl('bkt')).toBe('https://my.custom.gateway/bkt')
  })

  it('falls back to generic S3_* credentials for non-AWS providers', () => {
    process.env.S3_ACCESS_KEY_ID = 'genericid'
    process.env.S3_SECRET_ACCESS_KEY = 'genericsecret'
    const r = resolveObjectStorage({ provider: 'backblaze', region: 'us-west-004' })
    expect(r.credentials).toEqual({
      accessKeyId: 'genericid',
      secretAccessKey: 'genericsecret',
      sessionToken: undefined,
    })
  })

  it('leaves credentials undefined for AWS when nothing is set (uses profile/role chain)', () => {
    const r = resolveObjectStorage({ provider: 'aws' })
    expect(r.credentials).toBeUndefined()
  })
})

describe('createObjectStorageClient signs against the right host', () => {
  const creds = { accessKeyId: 'AKIDTEST', secretAccessKey: 'secrettest' }

  it('signs AWS presigned URLs against the AWS endpoint', () => {
    const s3 = createObjectStorageClient({ provider: 'aws', region: 'us-east-1', credentials: creds })
    const url = s3.generatePresignedGetUrl('my-bucket', 'a/b.txt', 60)
    expect(url.startsWith('https://my-bucket.s3.us-east-1.amazonaws.com/a/b.txt?')).toBe(true)
    expect(url).toContain('X-Amz-Signature=')
  })

  it('signs Backblaze presigned URLs against the B2 endpoint', () => {
    const s3 = createObjectStorageClient({ provider: 'backblaze', region: 'us-west-004', credentials: creds })
    const url = s3.generatePresignedGetUrl('pantry', 'pkg.tgz', 60)
    expect(url.startsWith('https://pantry.s3.us-west-004.backblazeb2.com/pkg.tgz?')).toBe(true)
  })

  it('signs Hetzner presigned URLs against the Hetzner endpoint', () => {
    const s3 = createObjectStorageClient({ provider: 'hetzner', region: 'fsn1', credentials: creds })
    const url = s3.generatePresignedGetUrl('pantry', 'pkg.tgz', 60)
    expect(url.startsWith('https://pantry.fsn1.your-objectstorage.com/pkg.tgz?')).toBe(true)
  })
})
