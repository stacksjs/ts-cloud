import type { CloudConfig, SshConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The same tripwire the Hetzner driver has: a field on {@link SshConfig} the
 * factory or the resolver never reads is a field the user can set and
 * nothing honours, silently.
 */
describe('ssh config wiring', () => {
  const factorySource = readFileSync(join(import.meta.dir, '..', 'factory.ts'), 'utf8')
  const typesSource = readFileSync(join(import.meta.dir, '..', '..', '..', '..', 'core', 'src', 'types.ts'), 'utf8')
  const resolverSource = readFileSync(join(import.meta.dir, 'config.ts'), 'utf8')
  const driverSource = readFileSync(join(import.meta.dir, 'driver.ts'), 'utf8')

  function fieldsOf(name: string): string[] {
    const block = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(typesSource)?.[1] ?? ''
    return [...block.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1])
  }

  it('finds the SshConfig and SshHostConfig fields (guards the scan itself)', () => {
    expect(fieldsOf('SshConfig')).toEqual(['hosts', 'hostKey', 'sudo', 'profile', 'publicIp', 'lan'])
    expect(fieldsOf('SshHostConfig')).toEqual(['host', 'user', 'port', 'privateKeyPath', 'role'])
  })

  it('reads every SshConfig field somewhere', () => {
    const wiring = factorySource + resolverSource + driverSource
    const unread = fieldsOf('SshConfig').filter((field) => !wiring.includes(`ssh?.${field}`) && !wiring.includes(`ssh.${field}`))
    expect(unread).toEqual([])
  })

  it('reads every SshHostConfig field in the resolver', () => {
    const unread = fieldsOf('SshHostConfig').filter(
      (field) => !resolverSource.includes(`host?.${field}`) && !resolverSource.includes(`host.${field}`),
    )
    expect(unread).toEqual([])
  })

  it('passes every SshConfig field through the factory', () => {
    for (const field of fieldsOf('SshConfig')) expect(factorySource).toContain(`options.config.ssh?.${field}`)
  })
})

describe('SshConfig type', () => {
  it('accepts every documented field', () => {
    const ssh: SshConfig = {
      hosts: [{ host: 'pi.local', user: 'pi', port: 22, privateKeyPath: '~/.ssh/id_ed25519', role: 'app' }],
      hostKey: 'pin',
      sudo: true,
      profile: 'raspberry-pi',
      publicIp: 'auto',
      lan: { hostname: 'pi.local', tls: 'local-ca' },
    }
    const config: Partial<CloudConfig> = { ssh }
    expect(config.ssh?.hosts[0].host).toBe('pi.local')
  })
})
