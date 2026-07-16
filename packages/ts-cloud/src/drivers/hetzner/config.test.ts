import type { CloudConfig } from '@ts-cloud/core'
import { afterEach, describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'
import {
  expandHome,
  HETZNER_DEFAULTS,
  resolveHetznerApiToken,
  resolveHetznerImage,
  resolveHetznerLocation,
  resolveHetznerSettings,
  resolveHetznerSshPrivateKeyPath,
  resolveHetznerSshPublicKeyPath,
  resolveHetznerSshUser,
} from './config'

const HETZNER_ENV = [
  'HCLOUD_TOKEN',
  'HETZNER_API_TOKEN',
  'HCLOUD_LOCATION',
  'HETZNER_LOCATION',
  'HCLOUD_IMAGE',
  'HETZNER_IMAGE',
  'HCLOUD_SSH_USER',
  'HETZNER_SSH_USER',
  'HCLOUD_SSH_KEY',
  'HETZNER_SSH_KEY',
  'HCLOUD_SSH_PUBLIC_KEY',
  'HETZNER_SSH_PUBLIC_KEY',
]

function clearEnv(): void {
  for (const name of HETZNER_ENV) delete process.env[name]
}
clearEnv()
afterEach(clearEnv)

const config = (hetzner: CloudConfig['hetzner'], compute?: Record<string, any>): CloudConfig => ({
  project: { name: 'acme', slug: 'acme' },
  hetzner,
  ...(compute ? { infrastructure: { compute } } : {}),
}) as CloudConfig

describe('precedence', () => {
  it('falls back to the documented default', () => {
    expect(resolveHetznerLocation()).toBe(HETZNER_DEFAULTS.location)
    expect(resolveHetznerImage()).toBe(HETZNER_DEFAULTS.image)
    expect(resolveHetznerSshUser()).toBe(HETZNER_DEFAULTS.sshUser)
  })

  it('reads the environment when config says nothing', () => {
    process.env.HCLOUD_LOCATION = 'nbg1'
    expect(resolveHetznerLocation()).toBe('nbg1')
  })

  it('prefers config over the environment, so a stray export cannot redirect a deploy', () => {
    process.env.HCLOUD_LOCATION = 'hel1'
    expect(resolveHetznerLocation(config({ location: 'nbg1' }))).toBe('nbg1')
  })

  it('prefers an explicit argument over everything', () => {
    process.env.HCLOUD_LOCATION = 'hel1'
    expect(resolveHetznerLocation(config({ location: 'nbg1' }), 'ash')).toBe('ash')
  })

  it('accepts the HETZNER_* alias for every HCLOUD_* variable', () => {
    process.env.HETZNER_LOCATION = 'hel1'
    process.env.HETZNER_IMAGE = 'debian-12'
    process.env.HETZNER_SSH_USER = 'deploy'
    expect(resolveHetznerLocation()).toBe('hel1')
    expect(resolveHetznerImage()).toBe('debian-12')
    expect(resolveHetznerSshUser()).toBe('deploy')
  })

  it('prefers HCLOUD_* over the HETZNER_* alias', () => {
    process.env.HCLOUD_LOCATION = 'fsn1'
    process.env.HETZNER_LOCATION = 'hel1'
    expect(resolveHetznerLocation()).toBe('fsn1')
  })

  it('ignores blank and whitespace-only values', () => {
    process.env.HCLOUD_LOCATION = '   '
    expect(resolveHetznerLocation(config({ location: '' }))).toBe(HETZNER_DEFAULTS.location)
  })

  /**
   * The regression this module exists for: the dashboard honored
   * HETZNER_LOCATION while the driver only read HCLOUD_LOCATION, so the
   * cockpit reported a location the box was not in. Both now resolve through
   * here, so they cannot disagree.
   */
  it('resolves the same location for the driver and the dashboard', () => {
    process.env.HETZNER_LOCATION = 'hel1'
    expect(resolveHetznerSettings().location).toBe(resolveHetznerLocation())
    expect(resolveHetznerLocation()).toBe('hel1')
  })
})

describe('apiToken', () => {
  it('follows the same precedence as every other field: config beats env', () => {
    process.env.HCLOUD_TOKEN = 'from-env'
    expect(resolveHetznerApiToken(undefined, config({ apiToken: 'from-config' }))).toBe('from-config')
  })

  it('reads the environment when config says nothing, which is the normal case', () => {
    process.env.HCLOUD_TOKEN = 'from-env'
    expect(resolveHetznerApiToken(undefined, config({}))).toBe('from-env')
  })

  it('accepts the HETZNER_API_TOKEN alias', () => {
    process.env.HETZNER_API_TOKEN = 'aliased'
    expect(resolveHetznerApiToken()).toBe('aliased')
  })

  it('is never defaulted — a missing token stays undefined so it fails loudly', () => {
    expect(resolveHetznerApiToken()).toBeUndefined()
    expect(resolveHetznerSettings().apiToken).toBeUndefined()
  })

  it('prefers an explicit argument over both', () => {
    process.env.HCLOUD_TOKEN = 'from-env'
    expect(resolveHetznerApiToken('explicit', config({ apiToken: 'from-config' }))).toBe('explicit')
  })
})

describe('image', () => {
  it('lets compute.image override hetzner.image', () => {
    expect(resolveHetznerImage(config({ image: 'ubuntu-22.04' }, { image: 'golden-123' }))).toBe('golden-123')
  })

  it('uses hetzner.image when compute says nothing', () => {
    expect(resolveHetznerImage(config({ image: 'ubuntu-22.04' }))).toBe('ubuntu-22.04')
  })
})

describe('ssh paths', () => {
  it('expands ~ to the home directory', () => {
    expect(expandHome('~/.ssh/id_ed25519')).toBe(`${homedir()}/.ssh/id_ed25519`)
    expect(expandHome('/abs/path')).toBe('/abs/path')
    // Only a leading `~/` is a home reference.
    expect(expandHome('relative/~/path')).toBe('relative/~/path')
  })

  it('derives the public key from the private key by default', () => {
    const privateKey = resolveHetznerSshPrivateKeyPath(config({ sshPrivateKeyPath: '/keys/deploy' }))
    expect(privateKey).toBe('/keys/deploy')
    expect(resolveHetznerSshPublicKeyPath(config({ sshPrivateKeyPath: '/keys/deploy' }), undefined, privateKey)).toBe('/keys/deploy.pub')
  })

  it('tracks a custom private key when deriving the public key', () => {
    expect(resolveHetznerSettings(config({ sshPrivateKeyPath: '/keys/custom' })).sshPublicKeyPath).toBe('/keys/custom.pub')
  })

  it('honors an explicit public key path', () => {
    expect(resolveHetznerSshPublicKeyPath(config({ sshPublicKeyPath: '~/keys/other.pub' }))).toBe(`${homedir()}/keys/other.pub`)
  })

  it('defaults both paths', () => {
    const settings = resolveHetznerSettings()
    expect(settings.sshPrivateKeyPath).toBe(`${homedir()}/.ssh/id_ed25519`)
    expect(settings.sshPublicKeyPath).toBe(`${homedir()}/.ssh/id_ed25519.pub`)
  })
})

describe('resolveHetznerSettings', () => {
  it('resolves everything together', () => {
    const settings = resolveHetznerSettings(config({ location: 'nbg1', image: 'debian-12', sshUser: 'deploy', apiToken: 't' }))
    expect(settings).toEqual({
      apiToken: 't',
      location: 'nbg1',
      image: 'debian-12',
      sshUser: 'deploy',
      sshPrivateKeyPath: `${homedir()}/.ssh/id_ed25519`,
      sshPublicKeyPath: `${homedir()}/.ssh/id_ed25519.pub`,
    })
  })

  it('applies overrides over config', () => {
    expect(resolveHetznerSettings(config({ location: 'nbg1' }), { location: 'hel1' }).location).toBe('hel1')
  })

  it('works with no config at all', () => {
    expect(resolveHetznerSettings().location).toBe(HETZNER_DEFAULTS.location)
  })
})
