import { afterEach, describe, expect, it } from 'bun:test'
import { DEFAULT_STATE_DIR, isStatePath, resolveStatePath, setStateDir, stateDir, statePath } from './state-dir'

function reset(): void {
  setStateDir(null)
  delete process.env.TS_CLOUD_STATE_DIR
}

afterEach(reset)

describe('state directory', () => {
  it('defaults to a hidden .ts-cloud in the project root', () => {
    expect(stateDir()).toBe(DEFAULT_STATE_DIR)
    expect(statePath('dashboard-users.json')).toBe('.ts-cloud/dashboard-users.json')
    expect(resolveStatePath('/srv/app', 'dashboard-users.json')).toBe('/srv/app/.ts-cloud/dashboard-users.json')
  })

  it('follows the configured directory', () => {
    setStateDir('storage/cloud')
    expect(stateDir()).toBe('storage/cloud')
    expect(statePath('dashboard-secret')).toBe('storage/cloud/dashboard-secret')
    expect(resolveStatePath('/srv/app', 'dashboard-secret')).toBe('/srv/app/storage/cloud/dashboard-secret')
  })

  it('lets the environment override the config', () => {
    setStateDir('storage/cloud')
    process.env.TS_CLOUD_STATE_DIR = 'var/ts-cloud'
    expect(resolveStatePath('/srv/app', 'control-plane.sqlite')).toBe('/srv/app/var/ts-cloud/control-plane.sqlite')
  })

  it('ignores a blank configured value', () => {
    setStateDir('   ')
    expect(stateDir()).toBe(DEFAULT_STATE_DIR)
  })

  it('pins state to an absolute directory regardless of the cwd passed in', () => {
    setStateDir('/var/lib/ts-cloud')
    expect(resolveStatePath('/srv/app', 'volumes')).toBe('/var/lib/ts-cloud/volumes')
  })

  it('recognizes paths inside the state directory', () => {
    setStateDir('storage/cloud')
    expect(isStatePath('storage/cloud', '/srv/app')).toBe(true)
    expect(isStatePath('storage/cloud/dashboard-secret', '/srv/app')).toBe(true)
    expect(isStatePath('/srv/app/storage/cloud/cache/templates', '/srv/app')).toBe(true)
  })

  it('does not mistake a sibling for the state directory', () => {
    setStateDir('storage/cloud')
    // A prefix match on the string would wrongly claim both of these.
    expect(isStatePath('storage/cloudy', '/srv/app')).toBe(false)
    expect(isStatePath('storage/framework', '/srv/app')).toBe(false)
    expect(isStatePath('.ts-cloud', '/srv/app')).toBe(false)
  })
})
