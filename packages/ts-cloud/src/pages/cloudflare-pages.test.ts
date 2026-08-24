import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectAssets,
  PAGES_MAX_FILE_BYTES,
  pagesAssetHash,
  pagesDnsRecord,
} from './cloudflare-pages'

describe('cloudflare-pages', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pages-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  describe('pagesAssetHash', () => {
    it('is BLAKE3 truncated to 32 hex characters', async () => {
      const hash = await pagesAssetHash('', '')
      // Official BLAKE3 vector for the empty input.
      expect(hash).toBe('af1349b9f5f9a1a6a0404dea36dcc949')
      expect(hash).toHaveLength(32)
    })

    it('folds the extension into the digest', async () => {
      const asHtml = await pagesAssetHash('aGVsbG8=', 'html')
      const asText = await pagesAssetHash('aGVsbG8=', 'txt')
      expect(asHtml).not.toBe(asText)
    })

    it('is stable for the same content and extension', async () => {
      expect(await pagesAssetHash('aGVsbG8=', 'html'))
        .toBe(await pagesAssetHash('aGVsbG8=', 'html'))
    })
  })

  describe('collectAssets', () => {
    it('walks nested directories into site-absolute paths', async () => {
      await Bun.write(join(dir, 'index.html'), '<h1>home</h1>')
      await Bun.write(join(dir, 'guide', 'index.html'), '<h1>guide</h1>')
      await Bun.write(join(dir, 'assets', 'app.css'), 'body{}')

      const assets = await collectAssets(dir)

      expect(assets.map(asset => asset.path)).toEqual([
        '/assets/app.css',
        '/guide/index.html',
        '/index.html',
      ])
    })

    it('includes dotted directories, which is where builds put output', async () => {
      await Bun.write(join(dir, '.well-known', 'security.txt'), 'contact: x')

      const assets = await collectAssets(dir)

      expect(assets.map(asset => asset.path)).toEqual(['/.well-known/security.txt'])
    })

    it('skips reserved paths so they stay configuration, not content', async () => {
      await Bun.write(join(dir, 'index.html'), 'x')
      await Bun.write(join(dir, '_headers'), '/*\n  X-Frame-Options: DENY')
      await Bun.write(join(dir, '_redirects'), '/old /new 301')

      const assets = await collectAssets(dir)

      expect(assets.map(asset => asset.path)).toEqual(['/index.html'])
    })

    it('records the extension without the dot, and empty when there is none', async () => {
      await Bun.write(join(dir, 'page.html'), 'x')
      await Bun.write(join(dir, 'LICENSE'), 'MIT')

      const assets = await collectAssets(dir)
      const byPath = new Map(assets.map(asset => [asset.path, asset]))

      expect(byPath.get('/page.html')?.extension).toBe('html')
      expect(byPath.get('/LICENSE')?.extension).toBe('')
    })

    it('base64-encodes content losslessly, including binary', async () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF])
      await Bun.write(join(dir, 'pixel.png'), bytes)

      const [asset] = await collectAssets(dir)

      expect(asset.size).toBe(6)
      expect(new Uint8Array(Buffer.from(asset.base64, 'base64'))).toEqual(bytes)
    })

    it('rejects a file over the Cloudflare limit rather than failing at upload', async () => {
      await Bun.write(join(dir, 'big.bin'), new Uint8Array(PAGES_MAX_FILE_BYTES + 1))

      await expect(collectAssets(dir)).rejects.toThrow(/over the Cloudflare Pages limit/)
    })

    it('returns nothing for an empty directory', async () => {
      expect(await collectAssets(dir)).toEqual([])
    })
  })

  describe('pagesDnsRecord', () => {
    it('points the hostname at the project subdomain', () => {
      const record = pagesDnsRecord('buddy.sh', 'buddy-5yo.pages.dev')

      expect(record.type).toBe('CNAME')
      expect(record.name).toBe('buddy.sh')
      expect(record.value).toBe('buddy-5yo.pages.dev')
    })

    it('keeps the granted subdomain rather than rebuilding it from the project name', () => {
      // Cloudflare only grants the bare name when it is free, so a project
      // named `buddy` can be served from `buddy-5yo.pages.dev`.
      expect(pagesDnsRecord('buddy.sh', 'buddy-5yo.pages.dev').value).not.toBe('buddy.pages.dev')
    })

    it('accepts a bare label as well as a full host', () => {
      expect(pagesDnsRecord('buddy.sh', 'buddy-5yo').value).toBe('buddy-5yo.pages.dev')
    })

    it('is proxied, because an unproxied CNAME reaches the edge but not the project', () => {
      expect((pagesDnsRecord('www.buddy.sh', 'buddy-5yo') as { proxied?: boolean }).proxied).toBe(true)
    })
  })
})
