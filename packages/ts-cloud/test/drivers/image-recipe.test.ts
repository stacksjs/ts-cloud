import type { CloudConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { buildImageRecipe } from '../../src/drivers/shared/image-recipe'
import { buildComputeProvisionScripts } from '../../src/drivers/shared/compute-provision'

const config: CloudConfig = {
  project: { name: 'Acme', slug: 'acme', region: 'us-east-1' },
  environments: { production: { type: 'production' } },
  notifications: { slack: { webhookUrl: 'https://hooks.slack.com/x' } },
  infrastructure: {
    compute: {
      runtime: 'php',
      webServer: 'nginx',
      php: { versions: ['8.3'], default: '8.3' },
      managedServices: { mysql: true, redis: true },
      sshKeys: [{ name: 'me', publicKey: 'ssh-ed25519 AAAA' }],
      backups: { enabled: true, bucket: 'b' },
    },
    appDatabase: { engine: 'mysql', name: 'acme', username: 'acme', password: 'pw' },
  },
}

describe('buildComputeProvisionScripts', () => {
  it('composes php + services + hardening from config', () => {
    const p = buildComputeProvisionScripts(config)
    const all = [...(p.phpProvision || []), ...(p.servicesProvision || [])].join('\n')
    expect(p.runtime).toBe('php')
    expect(p.phpBox).toBe(true)
    expect(all).toContain('php8.3-fpm')
    expect(all).toContain('apt-get install -y mysql-server')
    expect(all).toContain('ufw --force enable')
    expect(all).toContain('unattended-upgrades')
  })
})

describe('buildImageRecipe', () => {
  const recipe = buildImageRecipe(config)

  it('bakes the full stack (installs run, not skipped)', () => {
    expect(recipe).toContain('#!/bin/bash')
    expect(recipe).toContain('php8.3-fpm')
    expect(recipe).toContain('apt-get install -y nginx')
    expect(recipe).toContain('apt-get install -y mysql-server')
  })

  it('stays generic — excludes per-project SSH keys, app DB, and backups', () => {
    expect(recipe).not.toContain('ssh-ed25519 AAAA')
    expect(recipe).not.toContain('CREATE DATABASE')
    expect(recipe).not.toContain('ts-cloud-backup')
  })

  it('can include project state when generic is false', () => {
    const full = buildImageRecipe(config, { generic: false })
    expect(full).toContain('ssh-ed25519 AAAA')
  })

  it('appends a size-optimization pass by default', () => {
    expect(recipe).toContain('apt-get clean')
    expect(recipe).toContain('rm -rf /var/lib/apt/lists/*')
    expect(recipe).toContain('/root/.composer/cache')
    expect(recipe).toContain('truncate -s 0 /etc/machine-id')
    expect(recipe).toContain('cloud-init clean')
    expect(recipe).toContain('fstrim -av')
  })

  it('can skip optimization', () => {
    const raw = buildImageRecipe(config, { optimize: false })
    expect(raw).not.toContain('apt-get clean')
  })
})
