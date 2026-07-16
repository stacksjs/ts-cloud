import type { CloudConfig, HetznerConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `hetzner.image` was documented with a default but the factory never passed
 * it, so setting it in cloud.config.ts did nothing — silently, which is the
 * worst way for config to fail. These tests pin the wiring so a field added to
 * {@link HetznerConfig} cannot be left unread.
 */
describe('hetzner config wiring', () => {
  const factorySource = readFileSync(join(import.meta.dir, '..', 'factory.ts'), 'utf8')
  const typesSource = readFileSync(join(import.meta.dir, '..', '..', '..', '..', 'core', 'src', 'types.ts'), 'utf8')

  /** Field names declared on the HetznerConfig interface. */
  function hetznerConfigFields(): string[] {
    const block = /export interface HetznerConfig \{([\s\S]*?)\n\}/.exec(typesSource)?.[1] ?? ''
    return [...block.matchAll(/^\s{2}(\w+)\??:/gm)].map(m => m[1])
  }

  it('finds the HetznerConfig fields (guards the scan itself)', () => {
    const fields = hetznerConfigFields()
    expect(fields).toContain('apiToken')
    expect(fields).toContain('location')
    expect(fields.length).toBeGreaterThanOrEqual(5)
  })

  it('reads every HetznerConfig field somewhere', () => {
    const resolverSource = readFileSync(join(import.meta.dir, 'config.ts'), 'utf8')
    const driverSource = readFileSync(join(import.meta.dir, 'driver.ts'), 'utf8')
    const wiring = factorySource + resolverSource + driverSource

    // Each field must be referenced as `hetzner?.<field>` or `hetzner.<field>`
    // by the factory, the resolver or the driver — otherwise setting it in
    // cloud.config.ts silently does nothing.
    const unread = hetznerConfigFields().filter(field => !wiring.includes(`hetzner?.${field}`) && !wiring.includes(`hetzner.${field}`))
    expect(unread).toEqual([])
  })

  it('passes the driver-constructed fields through the factory', () => {
    // `image` is deliberately absent: it is resolved per-call from the config
    // because infrastructure.compute.image can override it.
    for (const field of ['apiToken', 'sshPrivateKeyPath', 'sshPublicKeyPath', 'sshUser', 'location'])
      expect(factorySource).toContain(`options.config.hetzner?.${field}`)
  })
})

describe('HetznerConfig type', () => {
  it('accepts every documented field', () => {
    // A compile-time check that the interface still carries these fields.
    const hetzner: HetznerConfig = {
      apiToken: 'token',
      location: 'nbg1',
      image: 'ubuntu-24.04',
      sshPrivateKeyPath: '~/.ssh/id_ed25519',
      sshPublicKeyPath: '~/.ssh/id_ed25519.pub',
      sshUser: 'root',
    }
    const config: Partial<CloudConfig> = { hetzner }
    expect(config.hetzner?.sshPublicKeyPath).toBe('~/.ssh/id_ed25519.pub')
  })
})
