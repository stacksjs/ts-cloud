import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setStateDir } from '@ts-cloud/core'
import { driverStatePath as hetznerDriverStatePath } from '../../src/drivers/hetzner/state'
import { resizeCheckpointPath } from '../../src/drivers/hetzner/resize-state'
import { driverStateDir, driverStatePath, readDriverState, writeDriverState } from '../../src/drivers/shared/driver-state'

/**
 * Driver state has two homes: the legacy, committed `storage/cloud/state/`
 * and `<stateDir>/state/` once a project configures a state directory. A
 * Stacks application configures `storage/cloud`, so for it both spellings
 * must name the same file; the dashboard used to derive the path by hand
 * and could not know that.
 */
function reset(): void {
  setStateDir(null)
  delete process.env.TS_CLOUD_STATE_DIR
}

beforeEach(reset)
afterEach(reset)

describe('driver state location', () => {
  it('stays in the committed storage/cloud/state when nothing configures a state directory', () => {
    expect(driverStateDir('/srv/app')).toBe('/srv/app/storage/cloud/state')
    expect(driverStatePath('acme-production', '/srv/app')).toBe('/srv/app/storage/cloud/state/acme-production.json')
  })

  it('follows a configured state directory', () => {
    setStateDir('.ts-cloud')
    expect(driverStatePath('acme-production', '/srv/app')).toBe('/srv/app/.ts-cloud/state/acme-production.json')
  })

  it('resolves to the identical path for a Stacks app (stateDir: storage/cloud)', () => {
    const legacy = driverStatePath('acme-production', '/srv/app')
    setStateDir('storage/cloud')
    expect(driverStatePath('acme-production', '/srv/app')).toBe(legacy)
  })

  it('lets the environment override the config', () => {
    setStateDir('storage/cloud')
    process.env.TS_CLOUD_STATE_DIR = 'var/ts-cloud'
    expect(driverStatePath('acme-production', '/srv/app')).toBe('/srv/app/var/ts-cloud/state/acme-production.json')
  })

  it('pins state to an absolute directory regardless of cwd', () => {
    setStateDir('/var/lib/ts-cloud')
    expect(driverStatePath('acme-production', '/srv/app')).toBe('/var/lib/ts-cloud/state/acme-production.json')
  })

  it('is the path the Hetzner shim and the resize checkpoint use', () => {
    setStateDir('.ts-cloud')
    expect(hetznerDriverStatePath('acme-production')).toBe(driverStatePath('acme-production'))
    expect(resizeCheckpointPath('acme-production')).toBe(join(driverStateDir(), 'acme-production-resize.json'))
  })
})

describe('driver state file', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ts-cloud-driver-state-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips an ssh state record and reads back null when absent', async () => {
    expect(await readDriverState('pi-production', dir)).toBeNull()
    await writeDriverState('pi-production', { provider: 'ssh', stackName: 'pi-production', host: 'pi.local', sshUser: 'pi', sshPort: 22 }, dir)
    const state = await readDriverState('pi-production', dir)
    expect(state?.provider).toBe('ssh')
    expect(state && 'host' in state ? state.host : undefined).toBe('pi.local')
  })

  it('leaves no temp file behind', async () => {
    await writeDriverState('pi-production', { provider: 'ssh', stackName: 'pi-production', host: 'pi.local', sshUser: 'pi', sshPort: 22 }, dir)
    const files = [...new Bun.Glob('*').scanSync({ cwd: driverStateDir(dir) })]
    expect(files).toEqual(['pi-production.json'])
  })
})
