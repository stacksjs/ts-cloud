import { describe, expect, it } from 'bun:test'
import { generateKeyPairSync, verify } from 'node:crypto'
import {
  buildMediaCdnPlan,
  createCloudFrontPolicy,
  createMediaAccessToken,
  mediaObjectHeaders,
  signCloudFrontCookies,
  verifyMediaAccessToken,
} from './media'

describe('media delivery', () => {
  it('builds protected CDN behavior without caching manifests or keys', () => {
    const plan = buildMediaCdnPlan({
      bucket: 'media-assets',
      region: 'us-west-2',
      prefix: '/production/',
      protected: true,
      trustedKeyGroupIds: ['group-one', 'group-one'],
    })
    expect(plan.originDomain).toBe('media-assets.s3.us-west-2.amazonaws.com')
    expect(plan.originPath).toBe('/production')
    expect(plan.behaviors[0].cacheControl).toBe('private, no-store')
    expect(plan.behaviors.at(-1)?.cacheControl).toContain('immutable')
    expect(plan.trustedKeyGroupIds).toEqual(['group-one'])
    expect(mediaObjectHeaders('/keys/asset.key', true)['Cache-Control']).toBe('private, no-store')
  })

  it('creates a minimal custom policy and valid RSA signature cookies', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
    const options = { resource: 'https://media.example.com/private/*', expiresAt: 2_000_000_000_000 }
    const policy = createCloudFrontPolicy(options)
    const cookies = signCloudFrontCookies(options, { keyPairId: 'K123', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) })
    const signature = Buffer.from(cookies['CloudFront-Signature'].replaceAll('-', '+').replaceAll('_', '=').replaceAll('~', '/'), 'base64')
    expect(cookies['CloudFront-Key-Pair-Id']).toBe('K123')
    expect(verify('RSA-SHA1', Buffer.from(policy), publicKey, signature)).toBe(true)
  })

  it('binds short-lived access tokens to resource and audience', () => {
    const token = createMediaAccessToken({
      resource: 'asset/segment-1.m4s',
      secret: 'secret',
      expiresAt: 2_000_000_000_000,
      audience: 'viewer-42',
      keyId: 'key-7',
    })
    expect(verifyMediaAccessToken(token, {
      secret: 'secret',
      now: 1_900_000_000_000,
      resource: 'asset/segment-1.m4s',
      audience: 'viewer-42',
    })).toEqual({ resource: 'asset/segment-1.m4s', expiresAt: 2_000_000_000, audience: 'viewer-42', keyId: 'key-7' })
    expect(verifyMediaAccessToken(token, { secret: 'secret', now: 1_900_000_000_000, audience: 'other' })).toBeNull()
  })
})
