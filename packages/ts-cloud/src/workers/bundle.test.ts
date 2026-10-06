import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleWorker } from './bundle'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-cloud-worker-bundle-'))
  // A tiny Worker with a local import, so bundling has something to inline,
  // and a runtime-provided `cloudflare:` import that must stay external.
  writeFileSync(join(dir, 'greeting.ts'), 'export const greeting = (name: string): string => `hello ${name}`\n')
  writeFileSync(join(dir, 'tiles.ts'), [
    `import { greeting } from './greeting'`,
    `import { WorkerEntrypoint } from 'cloudflare:workers'`,
    `export class Api extends WorkerEntrypoint {}`,
    `export default { async fetch(request: Request): Promise<Response> { return new Response(greeting(new URL(request.url).pathname)) } }`,
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'broken.ts'), 'export default { fetch( }\n')
  // Importing a file Bun treats as an asset emits it next to the bundle,
  // which a single-module upload cannot carry.
  writeFileSync(join(dir, 'logo.png'), new Uint8Array([0x89, 0x50, 0x4E, 0x47]))
  writeFileSync(join(dir, 'with-asset.ts'), `import logo from './logo.png'\nexport default { fetch: () => new Response(logo) }\n`)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('bundleWorker', () => {
  it('bundles the entry into one minified ES module named after it', async () => {
    const bundle = await bundleWorker(join(dir, 'tiles.ts'))

    expect(bundle.name).toBe('tiles.js')
    expect(bundle.type).toBe('application/javascript+module')
    expect(bundle.size).toBe(new TextEncoder().encode(bundle.content).byteLength)
    // The local import is inlined, the runtime import is left alone, and the
    // default export survives as an ES module export.
    expect(bundle.content).toContain('hello')
    expect(bundle.content).not.toContain('./greeting')
    expect(bundle.content).toContain('cloudflare:workers')
    expect(bundle.content).toMatch(/export\s*\{/)
  })

  it('fails clearly on a missing entry', async () => {
    await expect(bundleWorker(join(dir, 'missing.ts'))).rejects.toThrow('Worker entry not found')
  })

  it('refuses a build that emits more than one file', async () => {
    await expect(bundleWorker(join(dir, 'with-asset.ts'))).rejects.toThrow(/produced 2 files .*single module/)
  })

  it('fails clearly when the entry does not compile', async () => {
    await expect(bundleWorker(join(dir, 'broken.ts'))).rejects.toThrow(/Bundling Worker .*broken\.ts failed/)
  })
})
