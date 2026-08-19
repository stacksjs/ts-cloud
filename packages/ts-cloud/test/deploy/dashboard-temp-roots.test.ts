import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneDashboardTempRoots } from '../../src/deploy/local-dashboard-server'

let root: string | undefined

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe('pruneDashboardTempRoots', () => {
  it('removes orphaned PID roots and empty legacy roots only', () => {
    root = mkdtempSync(join(tmpdir(), 'ts-cloud-temp-root-test-'))
    const active = join(root, 'ts-cloud-dashboard-123-active')
    const orphaned = join(root, 'ts-cloud-dashboard-456-orphaned')
    const emptyLegacy = join(root, 'ts-cloud-dashboard-empty')
    const populatedLegacy = join(root, 'ts-cloud-dashboard-populated')
    for (const path of [active, orphaned, emptyLegacy, populatedLegacy]) mkdirSync(path)
    writeFileSync(join(active, 'index.html'), 'active')
    writeFileSync(join(orphaned, 'index.html'), 'orphaned')
    writeFileSync(join(populatedLegacy, 'index.html'), 'legacy')

    expect(pruneDashboardTempRoots(root, (pid) => pid === 123)).toBe(2)
    expect(existsSync(active)).toBe(true)
    expect(existsSync(populatedLegacy)).toBe(true)
    expect(existsSync(orphaned)).toBe(false)
    expect(existsSync(emptyLegacy)).toBe(false)
  })
})
