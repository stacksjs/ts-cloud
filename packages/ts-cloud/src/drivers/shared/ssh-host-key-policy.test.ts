import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSshArgs } from './remote-exec'
import {
  buildSshArgsFor,
  INTERACTIVE_SSH_HOST_KEY_POLICY,
  interactiveSshOptions,
  resolveSshHostKey,
  SSH_INSECURE_HOST_KEY_OPTS,
  sshKnownHostsPath,
} from './ssh-transport'

describe('host-key policy selection', () => {
  it('defaults an interactive session to a checked key', () => {
    expect(INTERACTIVE_SSH_HOST_KEY_POLICY).toBe('accept-new')
    expect(resolveSshHostKey(undefined, { cwd: '/project' })).toEqual({
      policy: 'accept-new',
      knownHostsFile: sshKnownHostsPath('/project'),
    })
  })

  it('resolves each policy by name', () => {
    expect(resolveSshHostKey('pin', { knownHostsFile: '/k' })).toEqual({ policy: 'pin', knownHostsFile: '/k' })
    expect(resolveSshHostKey('accept-new', { knownHostsFile: '/k' })).toEqual({ policy: 'accept-new', knownHostsFile: '/k' })
    // Available, but only by asking for it.
    expect(resolveSshHostKey('insecure')).toBe('insecure')
    expect(() => resolveSshHostKey('off' as never)).toThrow(/Invalid SSH host-key policy/)
  })

  it('keeps the pinned keys out of the operator\'s own known_hosts', () => {
    const file = sshKnownHostsPath('/project')
    expect(file.startsWith('/project/')).toBe(true)
    expect(file.endsWith('/ssh/known_hosts')).toBe(true)
  })

  it('turns the policy into the ssh options that enforce it', () => {
    const args = (policy: 'pin' | 'accept-new' | 'insecure') =>
      buildSshArgsFor(interactiveSshOptions({ user: 'root', identityFile: '/id', hostKeyPolicy: policy, knownHostsFile: '/k' }), 'box')
    expect(args('pin')).toContain('StrictHostKeyChecking=yes')
    expect(args('pin')).toContain('UserKnownHostsFile=/k')
    expect(args('accept-new')).toContain('StrictHostKeyChecking=accept-new')
    expect(args('accept-new')).not.toContain('UserKnownHostsFile=/dev/null')
    expect(args('insecure')).toEqual(expect.arrayContaining([...SSH_INSECURE_HOST_KEY_OPTS]))
  })

  it('carries port and timeout through only when set', () => {
    expect(interactiveSshOptions({ user: 'root', identityFile: '/id', knownHostsFile: '/k' })).toEqual({
      user: 'root',
      identityFile: '/id',
      hostKey: { policy: 'accept-new', knownHostsFile: '/k' },
    })
    expect(interactiveSshOptions({ user: 'root', identityFile: '/id', knownHostsFile: '/k', port: 2222, connectTimeoutSec: 5 })).toMatchObject({
      port: 2222,
      connectTimeoutSec: 5,
    })
  })
})

describe('deploy behaviour is unchanged', () => {
  it('still reaches a provisioned box without checking its key', () => {
    // The cloud drivers' own argv: the provider API is what identifies the box.
    const args = buildSshArgs({ user: 'root', privateKeyPath: '/id' } as never)
    expect(args).toEqual(expect.arrayContaining(['StrictHostKeyChecking=no', 'UserKnownHostsFile=/dev/null']))
  })

  it('leaves the insecure options byte-for-byte as they were', () => {
    expect([...SSH_INSECURE_HOST_KEY_OPTS]).toEqual(['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR'])
  })

  it('routes the ssh driver through the same resolver, with its own default', () => {
    const driver = readFileSync(join(import.meta.dir, '..', 'ssh', 'driver.ts'), 'utf8')
    expect(driver).toContain('resolveSshHostKey(this.settings.hostKey, { cwd: this.cwd })')
    // `pin`, from SSH_DEFAULTS: not the interactive default.
    expect(readFileSync(join(import.meta.dir, '..', 'ssh', 'config.ts'), 'utf8')).toContain(`hostKey: 'pin'`)
  })
})
