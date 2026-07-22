import type { CloudConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { redactForDashboard, serializeDashboardConfig } from './dashboard-config-module'

function config(): CloudConfig {
  return {
    project: { name: 'stacks', slug: 'stacks', region: 'us-east-1' },
    cloud: { provider: 'hetzner' },
    hetzner: { apiToken: 'hcloud-super-secret', location: 'fsn1' },
    aws: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'aws-super-secret' },
    environments: {
      production: { type: 'production', variables: { APP_KEY: 'base64:secret', LOG_LEVEL: 'info' } },
    },
    infrastructure: {
      compute: { provider: 'hetzner', runtime: 'bun' },
      databases: { main: { engine: 'postgres', password: 'db-super-secret' } },
    },
    sites: {
      main: {
        domain: 'stacksjs.com',
        root: 'dist',
        env: { STRIPE_KEY: 'sk_live_secret', APP_URL: 'https://stacksjs.com' },
      },
      docs: { domain: 'stacksjs.com', path: '/docs', root: 'dist/docs' },
    },
    hooks: { beforeDeploy: () => Promise.resolve() },
  } as unknown as CloudConfig
}

describe('redactForDashboard', () => {
  /**
   * The Hetzner token controls the whole cloud account and, unlike a site's own
   * secrets, is otherwise not on the box at all — shipping it would turn a
   * dashboard compromise into an account compromise.
   */
  it('strips the cloud account credentials', () => {
    const safe = redactForDashboard(config())
    expect(safe.hetzner.apiToken).toBeUndefined()
    expect(safe.aws).toBeUndefined()
    const text = JSON.stringify(safe)
    expect(text).not.toContain('hcloud-super-secret')
    expect(text).not.toContain('aws-super-secret')
    expect(text).not.toContain('AKIAEXAMPLE')
  })

  it('keeps the non-secret hetzner settings', () => {
    expect(redactForDashboard(config()).hetzner.location).toBe('fsn1')
  })

  it('keeps env KEYS but blanks their values', () => {
    const safe = redactForDashboard(config())
    // The dashboard only ever displays which vars a site defines.
    expect(Object.keys(safe.sites.main.env)).toEqual(['STRIPE_KEY', 'APP_URL'])
    expect(safe.sites.main.env.STRIPE_KEY).toBe('')
    expect(safe.sites.main.env.APP_URL).toBe('')
    expect(JSON.stringify(safe)).not.toContain('sk_live_secret')
  })

  it('blanks environment variable values', () => {
    const safe = redactForDashboard(config())
    expect(Object.keys(safe.environments.production.variables)).toEqual(['APP_KEY', 'LOG_LEVEL'])
    expect(JSON.stringify(safe)).not.toContain('base64:secret')
  })

  it('blanks database passwords', () => {
    const safe = redactForDashboard(config())
    expect(safe.infrastructure.databases.main.password).toBe('')
    expect(safe.infrastructure.databases.main.engine).toBe('postgres')
  })

  it('keeps everything the dashboard actually reads', () => {
    const safe = redactForDashboard(config())
    expect(safe.project.slug).toBe('stacks')
    expect(safe.sites.main.domain).toBe('stacksjs.com')
    expect(safe.sites.docs.path).toBe('/docs')
    expect(safe.infrastructure.compute.runtime).toBe('bun')
    expect(safe.environments.production.type).toBe('production')
  })

  it('drops functions rather than choking on them', () => {
    const safe = redactForDashboard(config())
    // Deploy hooks could never run on the box and do not serialize.
    expect(safe.hooks).toEqual({})
  })

  it('tolerates a bare config', () => {
    expect(() => redactForDashboard({} as CloudConfig)).not.toThrow()
    expect(() => redactForDashboard(undefined as any)).not.toThrow()
  })
})

describe('serializeDashboardConfig', () => {
  /**
   * The whole point: a real config imports things (Stacks' does
   * `import { servers } from '~/cloud/servers'`), and none of that resolves in
   * the dashboard's release dir on the box.
   */
  it('emits a self-contained module with no imports', () => {
    const text = serializeDashboardConfig(config())
    expect(text).not.toMatch(/^\s*import\s/m)
    expect(text).not.toContain('~/')
    expect(text).toContain('export default')
  })

  it('round-trips to the redacted config when imported, as the box does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tscloud-cfgmod-'))
    try {
      const file = join(dir, 'cloud.config.ts')
      writeFileSync(file, serializeDashboardConfig(config()))
      // Import it exactly the way the dashboard's config loader will on the box.
      const mod = await import(pathToFileURL(file).href)
      expect(mod.default.project.slug).toBe('stacks')
      expect(mod.default.sites.main.domain).toBe('stacksjs.com')
      expect(mod.default.sites.docs.path).toBe('/docs')
      expect(mod.default.hetzner.apiToken).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('carries no secrets', () => {
    const text = serializeDashboardConfig(config())
    for (const secret of [
      'hcloud-super-secret',
      'aws-super-secret',
      'sk_live_secret',
      'db-super-secret',
      'base64:secret',
    ])
      expect(text).not.toContain(secret)
  })
})
