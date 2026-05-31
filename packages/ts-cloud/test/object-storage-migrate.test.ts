/**
 * Unit tests for cross-provider object-storage migration.
 *
 * These pin the pure helpers (key remapping, include/exclude filtering) and the
 * end-to-end orchestration (copy / skip / dry-run plan / verify) against an
 * in-memory S3 client mock — no network, no credentials. The mock implements
 * just the four methods the migrator calls: listAllObjects, headObject,
 * getObjectBytes and putObject (+ deleteObject for delete-extraneous).
 */

import type { S3Client } from '../src/aws/s3'
import { describe, expect, it } from 'bun:test'
import {
  keyMatchesFilters,
  migrateObjectStorage,
  remapKey,
} from '../src/object-storage/migrate'

interface StoredObject {
  body: Uint8Array
  contentType?: string
}

/** Minimal in-memory S3-compatible store implementing the methods the migrator uses. */
class MockStore {
  objects = new Map<string, StoredObject>()

  seed(key: string, body: Uint8Array | string, contentType?: string): void {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
    this.objects.set(key, { body: bytes, contentType })
  }

  async listAllObjects({ bucket: _bucket, prefix }: { bucket: string, prefix?: string }) {
    return [...this.objects.entries()]
      .filter(([key]) => !prefix || key.startsWith(prefix))
      .map(([key, obj]) => ({ Key: key, LastModified: '', Size: obj.body.byteLength, ETag: undefined }))
  }

  async headObject(_bucket: string, key: string) {
    const obj = this.objects.get(key)
    if (!obj)
      return null
    return { ContentLength: obj.body.byteLength, ContentType: obj.contentType }
  }

  async getObjectBytes(_bucket: string, key: string) {
    const obj = this.objects.get(key)
    if (!obj)
      throw new Error(`not found: ${key}`)
    return { body: obj.body, contentType: obj.contentType, contentLength: obj.body.byteLength }
  }

  async putObject({ key, body, contentType }: { bucket: string, key: string, body: any, contentType?: string }) {
    const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(String(body))
    this.objects.set(key, { body: bytes, contentType })
  }

  async deleteObject(_bucket: string, key: string) {
    this.objects.delete(key)
  }

  /** Cast to the structural S3Client type the migrator expects. */
  asClient(): S3Client {
    return this as unknown as S3Client
  }
}

describe('remapKey', () => {
  it('passes the key through unchanged with no prefixes', () => {
    expect(remapKey('inbox/a.eml')).toBe('inbox/a.eml')
  })

  it('strips the from-prefix', () => {
    expect(remapKey('email/inbox/a.eml', 'email/')).toBe('inbox/a.eml')
  })

  it('prepends the to-prefix', () => {
    expect(remapKey('inbox/a.eml', undefined, 'mail/')).toBe('mail/inbox/a.eml')
  })

  it('strips from-prefix then prepends to-prefix (remap)', () => {
    expect(remapKey('email/inbox/a.eml', 'email/', 'mail/')).toBe('mail/inbox/a.eml')
  })

  it('leaves keys that do not start with from-prefix untouched before adding to-prefix', () => {
    expect(remapKey('other/x', 'email/', 'mail/')).toBe('mail/other/x')
  })
})

describe('keyMatchesFilters', () => {
  it('allows everything with no filters', () => {
    expect(keyMatchesFilters('anything')).toBe(true)
  })

  it('include acts as a whitelist of prefixes', () => {
    expect(keyMatchesFilters('inbox/a', ['inbox/', 'sent/'])).toBe(true)
    expect(keyMatchesFilters('junk/a', ['inbox/', 'sent/'])).toBe(false)
  })

  it('exclude always wins, even over include', () => {
    expect(keyMatchesFilters('inbox/a', ['inbox/'], ['inbox/spam'])).toBe(true)
    expect(keyMatchesFilters('inbox/spam/a', ['inbox/'], ['inbox/spam'])).toBe(false)
  })

  it('excludes server binaries / deploy artifacts in the mail example', () => {
    const exclude = ['mail-server', 'deploy/', '_deploy/', 'imap-server/']
    expect(keyMatchesFilters('mail-server', undefined, exclude)).toBe(false)
    expect(keyMatchesFilters('deploy/build.tar', undefined, exclude)).toBe(false)
    expect(keyMatchesFilters('mailboxes/1/inbox', undefined, exclude)).toBe(true)
  })
})

describe('migrateObjectStorage', () => {
  function mailFixture(): MockStore {
    const src = new MockStore()
    src.seed('mailboxes/1/inbox/a.eml', 'hello inbox', 'message/rfc822')
    src.seed('sent/2.eml', 'sent message')
    // Binary attachment — must survive byte-for-byte.
    src.seed('inbox/att.bin', new Uint8Array([0, 1, 2, 255, 254, 0, 42]), 'application/octet-stream')
    // Deliberately-excluded server artifacts.
    src.seed('mail-server', 'binary blob')
    src.seed('deploy/build.tar', 'artifact')
    return src
  }

  it('copies included keys, excludes artifacts, preserves bytes + content-type', async () => {
    const src = mailFixture()
    const dst = new MockStore()

    const result = await migrateObjectStorage({
      from: { provider: 'aws', bucket: 'src', client: src.asClient() },
      to: { provider: 'hetzner', bucket: 'dst', client: dst.asClient() },
      include: ['mailboxes/', 'inbox/', 'sent/'],
      exclude: ['mail-server', 'deploy/'],
    })

    expect(result.copied).toBe(3)
    expect(result.excluded).toBe(2)
    expect(result.excludedKeys.sort()).toEqual(['deploy/build.tar', 'mail-server'])
    expect(result.errors).toEqual([])

    // Binary attachment preserved exactly.
    const att = dst.objects.get('inbox/att.bin')!
    expect([...att.body]).toEqual([0, 1, 2, 255, 254, 0, 42])
    expect(att.contentType).toBe('application/octet-stream')
    // Excluded artifacts never written.
    expect(dst.objects.has('mail-server')).toBe(false)
  })

  it('is idempotent — skips destination objects already present with same size', async () => {
    const src = mailFixture()
    const dst = new MockStore()
    // Pre-seed one identical object at the destination.
    dst.seed('sent/2.eml', 'sent message')

    const result = await migrateObjectStorage({
      from: { provider: 'aws', bucket: 'src', client: src.asClient() },
      to: { provider: 'hetzner', bucket: 'dst', client: dst.asClient() },
      include: ['mailboxes/', 'inbox/', 'sent/'],
    })

    expect(result.skipped).toBe(1)
    expect(result.copied).toBe(2)
  })

  it('remaps keys with from-prefix strip + to-prefix add', async () => {
    const src = new MockStore()
    src.seed('email/inbox/a.eml', 'a')
    src.seed('email/sent/b.eml', 'b')
    const dst = new MockStore()

    await migrateObjectStorage({
      from: { provider: 'aws', bucket: 'src', prefix: 'email/', client: src.asClient() },
      to: { provider: 'hetzner', bucket: 'dst', prefix: 'mail/', client: dst.asClient() },
    })

    expect([...dst.objects.keys()].sort()).toEqual(['mail/inbox/a.eml', 'mail/sent/b.eml'])
  })

  it('dry-run produces a plan and writes nothing', async () => {
    const src = mailFixture()
    const dst = new MockStore()

    const result = await migrateObjectStorage({
      from: { provider: 'aws', bucket: 'src', client: src.asClient() },
      to: { provider: 'hetzner', bucket: 'dst', client: dst.asClient() },
      include: ['inbox/'],
      dryRun: true,
    })

    expect(dst.objects.size).toBe(0)
    expect(result.copied).toBe(0)
    expect(result.plan).toBeDefined()
    expect(result.plan!.map(p => p.key)).toEqual(['inbox/att.bin'])
    // Everything not under inbox/ shows up as excluded in the plan accounting.
    expect(result.excluded).toBe(4)
  })

  it('verify passes when the destination matches the copied set', async () => {
    const src = mailFixture()
    const dst = new MockStore()

    const result = await migrateObjectStorage({
      from: { provider: 'aws', bucket: 'src', client: src.asClient() },
      to: { provider: 'hetzner', bucket: 'dst', client: dst.asClient() },
      include: ['inbox/', 'sent/', 'mailboxes/'],
      verify: true,
    })

    expect(result.verification).toBeDefined()
    expect(result.verification!.ok).toBe(true)
    expect(result.verification!.matched).toBe(3)
    expect(result.verification!.missing).toEqual([])
  })

  it('verify fails when a copied object is missing or size-mismatched at the destination', async () => {
    const src = mailFixture()
    const dst = new MockStore()

    // Custom dest that silently drops one write and truncates another, to force
    // both a missing key and a size mismatch during verification.
    const original = dst.putObject.bind(dst)
    dst.putObject = async (opts: any) => {
      if (opts.key === 'sent/2.eml')
        return // dropped -> missing
      if (opts.key === 'inbox/att.bin')
        return original({ ...opts, body: new Uint8Array([9]) }) // wrong size -> mismatch
      return original(opts)
    }

    const result = await migrateObjectStorage({
      from: { provider: 'aws', bucket: 'src', client: src.asClient() },
      to: { provider: 'hetzner', bucket: 'dst', client: dst.asClient() },
      include: ['inbox/', 'sent/', 'mailboxes/'],
      verify: true,
    })

    expect(result.verification!.ok).toBe(false)
    expect(result.verification!.missing).toContain('sent/2.eml')
    expect(result.verification!.sizeMismatches.map(m => m.key)).toContain('inbox/att.bin')
  })

  it('delete-extraneous removes destination keys not in the source', async () => {
    const src = new MockStore()
    src.seed('inbox/a.eml', 'a')
    const dst = new MockStore()
    dst.seed('inbox/a.eml', 'a')
    dst.seed('inbox/stale.eml', 'leftover')

    const result = await migrateObjectStorage({
      from: { provider: 'aws', bucket: 'src', client: src.asClient() },
      to: { provider: 'hetzner', bucket: 'dst', client: dst.asClient() },
      deleteExtraneous: true,
    })

    expect(result.deleted).toEqual(['inbox/stale.eml'])
    expect(dst.objects.has('inbox/stale.eml')).toBe(false)
    expect(dst.objects.has('inbox/a.eml')).toBe(true)
  })
})
