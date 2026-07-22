import { describe, expect, it } from 'bun:test'
import { addSshKeyToCloudConfig, describeSshKeys, removeSshKeyFromCloudConfig } from './ssh-config-editor'

const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEFnZmFrZWtleWJvZHlmb3J0ZXN0b25seTEyMzQ chris@macbook'
const publicKey2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISecondFakeKeyBodyForChainedEditTests deploy@ci'

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

// Parse the rewritten config as TypeScript so a structurally invalid result
// (e.g. accumulated `],,` commas) fails loudly instead of silently corrupting
// the user's cloud.config.ts.
function assertValidTs(code: string): void {
  expect(code).not.toContain('],,')
  expect(code).not.toContain(',,')
  new Bun.Transpiler({ loader: 'ts' }).transformSync(code)
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
    assertValidTs(removed)
  })

  it('keeps the config valid across repeated add/remove edits (no comma accumulation)', () => {
    // Reproduces the dashboard flow: add a key, add another, then remove them.
    // The previous renderer left a trailing comma that doubled on every edit
    // (`],` → `],,` → `],,,`), eventually making cloud.config.ts unparseable.
    const step1 = addSshKeyToCloudConfig({
      configText: configText(),
      name: 'chris@macbook',
      publicKey,
      existingKeys: [],
    })
    assertValidTs(step1)

    const step2 = addSshKeyToCloudConfig({
      configText: step1,
      name: 'deploy@ci',
      publicKey: publicKey2,
      existingKeys: [{ name: 'chris@macbook', publicKey }],
    })
    assertValidTs(step2)
    expect(step2).toContain('deploy@ci')

    const step3 = removeSshKeyFromCloudConfig({
      configText: step2,
      name: 'deploy@ci',
      existingKeys: [
        { name: 'chris@macbook', publicKey },
        { name: 'deploy@ci', publicKey: publicKey2 },
      ],
    })
    assertValidTs(step3)
    expect(step3).toContain('chris@macbook')
    expect(step3).not.toContain('deploy@ci')

    const step4 = removeSshKeyFromCloudConfig({
      configText: step3,
      name: 'chris@macbook',
      existingKeys: [{ name: 'chris@macbook', publicKey }],
    })
    assertValidTs(step4)
    expect(step4).toContain('sshKeys: []')
    // Indentation must not accumulate across edits — canonical 6-space indent.
    expect(step2).toContain('\n      sshKeys: [')
    expect(step4).toContain('\n      sshKeys: []')
    expect(step4).not.toMatch(/\n {7,}sshKeys:/)
  })

  it('inserts a valid array when the preceding compute property has no trailing comma', () => {
    const noTrailingComma = `export default {
  infrastructure: {
    compute: {
      webServer: 'rpx'
    },
  },
}
`
    const updated = addSshKeyToCloudConfig({
      configText: noTrailingComma,
      name: 'chris@macbook',
      publicKey,
      existingKeys: [],
    })
    assertValidTs(updated)
    expect(updated).toContain("name: 'chris@macbook'")
  })

  it('rejects duplicate names and invalid public keys', () => {
    expect(() =>
      addSshKeyToCloudConfig({
        configText: configText(),
        name: 'chris@macbook',
        publicKey,
        existingKeys: [{ name: 'chris@macbook', publicKey }],
      }),
    ).toThrow('already exists')

    expect(() =>
      addSshKeyToCloudConfig({
        configText: configText(),
        name: 'bad-key',
        publicKey: 'nope',
        existingKeys: [],
      }),
    ).toThrow('OpenSSH public key')
  })

  it('describes keys with type and SHA256 fingerprint', () => {
    const [key] = describeSshKeys([{ name: 'chris@macbook', publicKey }])

    expect(key.name).toBe('chris@macbook')
    expect(key.type).toBe('ssh-ed25519')
    expect(key.fingerprint.startsWith('SHA256:')).toBe(true)
  })
})
