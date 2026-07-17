import { describe, expect, it } from 'bun:test'
import { buildAuthorizedKeysScript } from '../../src/drivers/shared/ssh-keys'

describe('buildAuthorizedKeysScript', () => {
  it('reconciles a managed block of keys', () => {
    const script = buildAuthorizedKeysScript([
      { name: 'chris@laptop', publicKey: 'ssh-ed25519 AAAAC3xxx' },
      { name: 'ci-deploy', publicKey: 'ssh-ed25519 AAAAC3yyy' },
    ]).join('\n')
    expect(script).toContain('# >>> ts-cloud managed keys >>>')
    expect(script).toContain('ssh-ed25519 AAAAC3xxx chris@laptop')
    expect(script).toContain('ssh-ed25519 AAAAC3yyy ci-deploy')
    expect(script).toContain('# <<< ts-cloud managed keys <<<')
    // Strips any prior managed block before re-appending (idempotent).
    expect(script).toContain('sed -i')
    expect(script).toContain('chmod 600 /root/.ssh/authorized_keys')
  })

  it('honours a custom authorized_keys path', () => {
    const script = buildAuthorizedKeysScript(
      [{ name: 'k', publicKey: 'ssh-rsa AAAA' }],
      { path: '/home/deploy/.ssh/authorized_keys' },
    ).join('\n')
    expect(script).toContain('mkdir -p /home/deploy/.ssh')
    expect(script).toContain('/home/deploy/.ssh/authorized_keys')
  })

  it('still strips the managed block when the key list is emptied (key revocation)', () => {
    const script = buildAuthorizedKeysScript([]).join('\n')
    // The prior block is removed but nothing is appended.
    expect(script).toContain('sed -i')
    expect(script).not.toContain('TS_CLOUD_KEYS_EOF')
    expect(buildAuthorizedKeysScript().join('\n')).toContain('sed -i')
  })
})
