import { describe, expect, it } from 'bun:test'
import type { AWSRequestOptions } from './client'
import { CloudFrontClient } from './cloudfront'

describe('CloudFront protected media delivery', () => {
  it('registers escaped public keys and deduplicated key groups', async () => {
    const requests: AWSRequestOptions[] = []
    const transport = {
      request: async (request: AWSRequestOptions) => {
        requests.push(request)
        if (request.path.endsWith('/public-key')) return { PublicKey: { Id: 'PK123', PublicKeyConfig: { Name: 'media-key' } } }
        return { KeyGroup: { Id: 'KG123', KeyGroupConfig: { Name: 'media-group' } } }
      },
    }
    const client = new CloudFrontClient(undefined, transport)
    await client.createPublicKey({ name: 'media-key', encodedKey: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----', comment: 'media & keys', callerReference: 'release<1>' })
    const group = await client.createKeyGroup({ name: 'media-group', publicKeyIds: ['PK123', 'PK123'] })

    expect(requests[0].body).toContain('release&lt;1&gt;')
    expect(requests[0].body).toContain('media &amp; keys')
    expect(requests[1].body?.match(/<Item>PK123<\/Item>/g)).toHaveLength(1)
    expect(group).toMatchObject({ Id: 'KG123', Items: ['PK123'] })
  })

  it('creates a media distribution without an SPA error rewrite', async () => {
    let request: AWSRequestOptions | undefined
    const client = new CloudFrontClient(undefined, {
      request: async (value: AWSRequestOptions) => {
        request = value
        return { body: { Distribution: { Id: 'D123', ARN: 'arn:test', DomainName: 'media.example', Status: 'InProgress' } }, headers: { etag: 'etag' } }
      },
    })
    const result = await client.createMediaDistributionForS3({ bucketName: 'media-bucket', bucketRegion: 'us-west-2', originAccessControlId: 'OAC123', trustedKeyGroupIds: ['KG123'] })

    expect(result).toMatchObject({ Id: 'D123', ETag: 'etag' })
    expect(request?.body).toContain('<DefaultRootObject></DefaultRootObject>')
    expect(request?.body).toContain('<KeyGroup>KG123</KeyGroup>')
    expect(request?.body).toContain('<CustomErrorResponses><Quantity>0</Quantity></CustomErrorResponses>')
    expect(request?.body).not.toContain('<ResponsePagePath>/index.html</ResponsePagePath>')
  })

  it('rejects invalid signing resources before making requests', async () => {
    const client = new CloudFrontClient(undefined, { request: async () => { throw new Error('unexpected request') } })
    await expect(client.createPublicKey({ name: 'invalid name', encodedKey: '-----BEGIN PUBLIC KEY-----' })).rejects.toThrow('name is invalid')
    await expect(client.createKeyGroup({ name: 'media', publicKeyIds: [] })).rejects.toThrow('at least one public key')
  })
})
