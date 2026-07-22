import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { artifactKey, packageServerlessApp, sha256 } from './package'

describe('artifactKey + sha256', () => {
  it('namespaces by project/env and hash', () => {
    expect(artifactKey('demo', 'production', 'abc')).toBe('deployments/demo/production/abc.zip')
  })

  it('hashes deterministically', () => {
    expect(sha256('hello')).toBe(sha256('hello'))
    expect(sha256('hello')).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('packageServerlessApp', () => {
  let projectRoot: string

  beforeAll(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'tscloud-app-'))
    writeFileSync(
      join(projectRoot, 'server.ts'),
      `export default {
        fetch(_req: Request) { return new Response('ok') },
        queue(_payload: unknown) {},
        cli(_event: { command: string }) { return { statusCode: 0, output: '' } },
      }\n`,
    )
  })

  afterAll(() => rmSync(projectRoot, { recursive: true, force: true }))

  it('bundles + zips a Node/Bun app into a single artifact', async () => {
    const artifact = await packageServerlessApp({
      projectRoot,
      app: { kind: 'node', entry: 'server.ts' },
      skipBuild: true,
    })

    expect(artifact.zip.readUInt32LE(0)).toBe(0x04034b50) // valid ZIP
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(artifact.handlers).toEqual({ http: 'index.http', queue: 'index.queue', cli: 'index.cli' })
    expect(artifact.bundleBytes).toBeGreaterThan(0)
  })

  it('throws a clear error when entry is missing', async () => {
    await expect(packageServerlessApp({ projectRoot, app: { kind: 'node' }, skipBuild: true })).rejects.toThrow(
      /entry.*required/,
    )
  })
})
