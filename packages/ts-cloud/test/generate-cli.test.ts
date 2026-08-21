/**
 * `cloud generate` exit-code behaviour.
 *
 * Runs the real CLI as a subprocess, because the thing under test *is* the
 * process outcome: the bug this guards against was a generate that printed
 * "Template validation failed", then wrote the file and exited 0 anyway. CI
 * went green over an empty template that looked authoritative on disk.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

const CLI = join(import.meta.dir, '..', 'bin', 'cli.ts')

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ts-cloud-generate-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function generate(): Promise<{ code: number, out: string }> {
  const proc = Bun.spawn(['bun', CLI, 'generate', '--env', 'production'], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { code, out: stdout + stderr }
}

describe('cloud generate', () => {
  it('fails, explains itself, and writes nothing when no config is found', async () => {
    const { code, out } = await generate()

    expect(code).toBe(1)
    expect(out).toContain('Template validation failed')
    // The diagnostic matters as much as the exit code: "at least one resource
    // is required" reads like a config authoring mistake, when the real cause
    // is almost always that no config was loaded at all.
    expect(out).toContain('No project config was loaded')
    expect(existsSync(join(dir, 'cloudformation', 'production.json'))).toBe(false)
  }, 30_000)

  it('names the shadowing hazard, since that is the usual cause', async () => {
    // A bare `config.ts` beside `cloud.config.ts` wins config discovery and
    // silently replaces the project config with something of another shape.
    await writeFile(join(dir, 'config.ts'), 'export const config = { unrelated: true }\n')
    const { out } = await generate()

    expect(out).toContain('is not shadowed by another config file')
  }, 30_000)

  it('succeeds and writes the template for a real config', async () => {
    await writeFile(join(dir, 'cloud.config.ts'), `export default {
      project: { name: 'Probe', slug: 'probe', region: 'us-east-1' },
      environments: { production: { type: 'production' } },
      infrastructure: {
        storage: { assets: { public: false } },
      },
    }
`)
    const { code, out } = await generate()

    expect(code).toBe(0)
    expect(out).toContain('Template validated successfully')
    expect(existsSync(join(dir, 'cloudformation', 'production.json'))).toBe(true)
  }, 30_000)
})
