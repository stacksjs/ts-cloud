/**
 * Regression tests for S3 object-key URI encoding in the signing paths.
 *
 * Strict S3-compatible backends (e.g. Hetzner Object Storage / Ceph RGW)
 * re-encode the received request path per RFC 3986 before verifying a SigV4
 * signature. Keys containing reserved characters — most notably `+`, which
 * appears in SemVer build metadata like `0.17.0-dev.131+73c51c142` — were
 * being signed and sent raw, so the server canonicalized `+` to `%2B` and
 * the signature no longer matched (`SignatureDoesNotMatch`, HTTP 403).
 *
 * These tests pin that every key-bearing URL the client produces encodes
 * `+` as `%2B` while preserving `/` as the path separator, so uploads and
 * downloads of `+`-versioned artifacts succeed.
 */

import { describe, expect, it } from 'bun:test'
import { S3Client } from '../src/aws/s3'

const KEY = 'binaries/ziglang.org/0.17.0-dev.131+73c51c142/linux-x86-64/ziglang.org-0.17.0-dev.131+73c51c142.tar.gz'

function client(): S3Client {
  return new S3Client('fsn1', undefined, {
    endpoint: 'https://fsn1.your-objectstorage.com',
    forcePathStyle: false,
    credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secretexamplekey' },
  })
}

describe('S3 object-key URI encoding (+ in SemVer build metadata)', () => {
  it('generatePresignedGetUrl encodes + as %2B and keeps / separators', () => {
    const url = client().generatePresignedGetUrl('pantry-registry', KEY)
    const path = new URL(url).pathname
    expect(path).toContain('%2B')
    expect(path).not.toContain('+')
    // Path separators must survive so the object is addressed correctly.
    expect(path).toContain('/binaries/ziglang.org/')
    expect(path.endsWith('.tar.gz')).toBe(true)
  })

  it('generatePresignedPutUrl encodes + as %2B', () => {
    const url = client().generatePresignedPutUrl('pantry-registry', KEY, 'application/gzip')
    const path = new URL(url).pathname
    expect(path).toContain('%2B')
    expect(path).not.toContain('+')
  })

  it('getSignedUrl encodes + as %2B', async () => {
    const url = await client().getSignedUrl({ bucket: 'pantry-registry', key: KEY })
    const path = new URL(url).pathname
    expect(path).toContain('%2B')
    expect(path).not.toContain('+')
  })

  it('leaves plain keys (no reserved chars) untouched', () => {
    const plain = 'binaries/bun.sh/1.3.14/darwin-arm64/bun.sh-1.3.14.tar.gz'
    const url = client().generatePresignedGetUrl('pantry-registry', plain)
    // Host construction varies by provider/path-style; assert only that the
    // key round-trips verbatim (no percent-encoding introduced) and ends correctly.
    expect(url).toContain(`/${plain}?`)
    expect(url.split('?')[0]).not.toContain('%')
  })

  // String-body putObject (e.g. the `.sha256` sidecar), getObject and
  // deleteObject route through AWSClient.request — capture the signed path.
  function captureRequestPath(c: S3Client): { last: () => string } {
    let lastPath = ''
    // @ts-expect-error — stub the private AWSClient.request to record the path
    c.client.request = async (opts: { path: string }) => {
      lastPath = opts.path
      return ''
    }
    return { last: () => lastPath }
  }

  it('string-body putObject encodes + in the signed path', async () => {
    const c = client()
    const cap = captureRequestPath(c)
    await c.putObject({ bucket: 'pantry-registry', key: `${KEY}.sha256`, body: 'abc123  file\n', contentType: 'text/plain' })
    expect(cap.last()).toContain('%2B')
    expect(cap.last()).not.toContain('+')
  })

  it('getObject and deleteObject encode + in the signed path', async () => {
    const c = client()
    const cap = captureRequestPath(c)
    await c.getObject('pantry-registry', KEY)
    expect(cap.last()).toContain('%2B')
    await c.deleteObject('pantry-registry', KEY)
    expect(cap.last()).toContain('%2B')
    expect(cap.last()).not.toContain('+')
  })
})
