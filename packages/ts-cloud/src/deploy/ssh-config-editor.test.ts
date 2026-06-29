import { describe, expect, it } from 'bun:test'
import { addSshKeyToCloudConfig, describeSshKeys, removeSshKeyFromCloudConfig } from './ssh-config-editor'

const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEFnZmFrZWtleWJvZHlmb3J0ZXN0b25seTEyMzQ chris@macbook'

function configText(extra = ''): string {
  return `export default {
  project: { name: 'Stacks', slug: 'stacks' },
  infrastructure: {
    compute: {
      webServer: 'rpx',
${extra}
    },
  },
}
`
}

describe('ssh config editor', () => {
  it('adds compute sshKeys to an existing compute block', () => {
    const updated = addSshKeyToCloudConfig({
      configText: configText(),
      name: 'chris@macbook',
      publicKey,
      existingKeys: [],
    })

    expect(updated).toContain('sshKeys: [')
    expect(updated).toContain("name: 'chris@macbook'")
    expect(updated).toContain(publicKey)
  })

  it('removes an existing key', () => {
    const withKey = addSshKeyToCloudConfig({
      configText: configText(),
      name: 'chris@macbook',
      publicKey,
      existingKeys: [],
    })
    const removed = removeSshKeyFromCloudConfig({
      configText: withKey,
      name: 'chris@macbook',
      existingKeys: [{ name: 'chris@macbook', publicKey }],
    })

    expect(removed).toContain('sshKeys: []')
    expect(removed).not.toContain(publicKey)
  })

  it('rejects duplicate names and invalid public keys', () => {
    expect(() => addSshKeyToCloudConfig({
      configText: configText(),
      name: 'chris@macbook',
      publicKey,
      existingKeys: [{ name: 'chris@macbook', publicKey }],
    })).toThrow('already exists')

    expect(() => addSshKeyToCloudConfig({
      configText: configText(),
      name: 'bad-key',
      publicKey: 'nope',
      existingKeys: [],
    })).toThrow('OpenSSH public key')
  })

  it('describes keys with type and SHA256 fingerprint', () => {
    const [key] = describeSshKeys([{ name: 'chris@macbook', publicKey }])

    expect(key.name).toBe('chris@macbook')
    expect(key.type).toBe('ssh-ed25519')
    expect(key.fingerprint.startsWith('SHA256:')).toBe(true)
  })
})
