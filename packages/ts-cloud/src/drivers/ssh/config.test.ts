import type { CloudConfig } from '@ts-cloud/core'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'
import {
  resolveSshHostKeyPolicy,
  resolveSshHosts,
  resolveSshPort,
  resolveSshPrivateKeyPath,
  resolveSshProfile,
  resolveSshSettings,
  resolveSshSudo,
  resolveSshUser,
  SSH_DEFAULTS,
} from './config'

const ENV = ['TS_CLOUD_SSH_HOST', 'TS_CLOUD_SSH_USER', 'TS_CLOUD_SSH_PORT', 'TS_CLOUD_SSH_KEY', 'TS_CLOUD_SSH_HOST_KEY', 'TS_CLOUD_SSH_PROFILE']

function clearEnv(): void {
  for (const name of ENV) delete process.env[name]
}
beforeEach(clearEnv)
afterEach(clearEnv)

const base: CloudConfig = {
  project: { name: 'Pi', slug: 'pi', region: 'home' },
  environments: { production: { type: 'production' } },
}

describe('ssh config resolution', () => {
  it('reads hosts from config before the environment, and fails loudly without either', () => {
    process.env.TS_CLOUD_SSH_HOST = 'env.local'
    expect(resolveSshHosts({ ...base, ssh: { hosts: [{ host: 'cfg.local' }] } })).toEqual([{ host: 'cfg.local' }])
    expect(resolveSshHosts(base)).toEqual([{ host: 'env.local' }])
    expect(resolveSshHosts(base, [{ host: 'explicit.local' }])).toEqual([{ host: 'explicit.local' }])
    clearEnv()
    expect(() => resolveSshHosts(base)).toThrow('No ssh host configured')
    expect(() => resolveSshHosts({ ...base, ssh: { hosts: [] } })).toThrow('No ssh host configured')
  })

  it('resolves the user explicit > host config > env > root', () => {
    process.env.TS_CLOUD_SSH_USER = 'envuser'
    expect(resolveSshUser({ host: 'h', user: 'pi' }, 'deploy')).toBe('deploy')
    expect(resolveSshUser({ host: 'h', user: 'pi' })).toBe('pi')
    expect(resolveSshUser({ host: 'h' })).toBe('envuser')
    clearEnv()
    expect(resolveSshUser({ host: 'h' })).toBe('root')
  })

  it('resolves the port with the same precedence and rejects nonsense', () => {
    process.env.TS_CLOUD_SSH_PORT = '2200'
    expect(resolveSshPort({ host: 'h', port: 2222 }, 2223)).toBe(2223)
    expect(resolveSshPort({ host: 'h', port: 2222 })).toBe(2222)
    expect(resolveSshPort({ host: 'h' })).toBe(2200)
    clearEnv()
    expect(resolveSshPort({ host: 'h' })).toBe(22)
    process.env.TS_CLOUD_SSH_PORT = 'twenty-two'
    expect(() => resolveSshPort({ host: 'h' })).toThrow('Invalid SSH port from TS_CLOUD_SSH_PORT')
    expect(() => resolveSshPort({ host: 'h', port: 70000 })).toThrow('Invalid SSH port')
  })

  it('expands ~ in the private key path and defaults to id_ed25519', () => {
    expect(resolveSshPrivateKeyPath({ host: 'h' })).toBe(`${homedir()}/.ssh/id_ed25519`)
    expect(resolveSshPrivateKeyPath({ host: 'h', privateKeyPath: '~/.ssh/pi' })).toBe(`${homedir()}/.ssh/pi`)
    process.env.TS_CLOUD_SSH_KEY = '/keys/ci'
    expect(resolveSshPrivateKeyPath({ host: 'h' })).toBe('/keys/ci')
    expect(resolveSshPrivateKeyPath({ host: 'h' }, '/keys/explicit')).toBe('/keys/explicit')
  })

  it('pins host keys by default and rejects an unknown policy', () => {
    expect(resolveSshHostKeyPolicy(base)).toBe('pin')
    expect(resolveSshHostKeyPolicy({ ...base, ssh: { hosts: [], hostKey: 'insecure' } })).toBe('insecure')
    process.env.TS_CLOUD_SSH_HOST_KEY = 'accept-new'
    expect(resolveSshHostKeyPolicy(base)).toBe('accept-new')
    expect(resolveSshHostKeyPolicy({ ...base, ssh: { hosts: [], hostKey: 'pin' } })).toBe('pin')
    expect(() => resolveSshHostKeyPolicy(base, 'trust-me')).toThrow("Invalid ssh.hostKey 'trust-me'")
  })

  it('turns sudo on for any user that is not root unless told otherwise', () => {
    expect(resolveSshSudo(base, 'root')).toBe(false)
    expect(resolveSshSudo(base, 'pi')).toBe(true)
    expect(resolveSshSudo({ ...base, ssh: { hosts: [], sudo: false } }, 'pi')).toBe(false)
    expect(resolveSshSudo({ ...base, ssh: { hosts: [], sudo: false } }, 'pi', true)).toBe(true)
  })

  it('defaults the profile to generic and validates it', () => {
    expect(resolveSshProfile(base)).toBe('generic')
    process.env.TS_CLOUD_SSH_PROFILE = 'raspberry-pi'
    expect(resolveSshProfile(base)).toBe('raspberry-pi')
    expect(resolveSshProfile({ ...base, ssh: { hosts: [], profile: 'generic' } })).toBe('generic')
    expect(() => resolveSshProfile(base, 'toaster')).toThrow("Invalid ssh.profile 'toaster'")
  })

  it('resolves everything at once, per host', () => {
    const settings = resolveSshSettings({
      ...base,
      ssh: { hosts: [{ host: 'pi.local', user: 'pi', port: 2222 }], profile: 'raspberry-pi', lan: { hostname: 'pi.local' } },
    })
    expect(settings.hosts).toEqual([
      { host: 'pi.local', user: 'pi', port: 2222, privateKeyPath: `${homedir()}/.ssh/id_ed25519`, role: 'app' },
    ])
    expect(settings.sudo).toBe(true)
    expect(settings.profile).toBe('raspberry-pi')
    expect(settings.hostKey).toBe(SSH_DEFAULTS.hostKey)
    expect(settings.publicIp).toBe('auto')
    expect(settings.lan).toEqual({ hostname: 'pi.local' })
  })
})
