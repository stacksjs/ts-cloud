import type { CloudConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runConfigHook, runHook } from '../../src/deploy/hooks'

function cfg(hooks: CloudConfig['hooks']): CloudConfig {
  return { project: { name: 'x', slug: 'x' }, hooks } as CloudConfig
}

describe('deploy hooks', () => {
  it('runs a string hook as a shell command in cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hooks-'))
    try {
      await runHook(`echo hi > ${join(dir, 'out.txt')}`, cfg({}), 'beforeBuild')
      expect(existsSync(join(dir, 'out.txt'))).toBe(true)
      expect(readFileSync(join(dir, 'out.txt'), 'utf8').trim()).toBe('hi')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('awaits a function hook with the config', async () => {
    let seen = ''
    await runHook(
      async (c) => {
        seen = c.project.slug
      },
      cfg({}),
      'afterDeploy',
    )
    expect(seen).toBe('x')
  })

  it('is a no-op when the hook is unset', async () => {
    expect(await runConfigHook(cfg({}), 'beforeDeploy')).toBe(true)
    expect(await runConfigHook(cfg(undefined as any), 'beforeDeploy')).toBe(true)
  })

  it('runConfigHook returns false (and logs) when a string hook fails', async () => {
    const errors: string[] = []
    const ok = await runConfigHook(cfg({ beforeDeploy: 'exit 3' }), 'beforeDeploy', { error: (m) => errors.push(m) })
    expect(ok).toBe(false)
    expect(errors[0]).toContain('beforeDeploy hook failed')
  })

  it('runConfigHook runs the named hook and returns true on success', async () => {
    const steps: string[] = []
    const ok = await runConfigHook(cfg({ afterBuild: 'true' }), 'afterBuild', { step: (m) => steps.push(m) })
    expect(ok).toBe(true)
    expect(steps).toContain('Running afterBuild hook')
  })
})
