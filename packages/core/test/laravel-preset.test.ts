import { describe, expect, it } from 'bun:test'
import { createLaravelPreset } from '../src/presets/laravel'

describe('createLaravelPreset', () => {
  const config = createLaravelPreset({
    name: 'Acme',
    slug: 'acme',
    domain: 'acme.com',
    repository: { url: 'git@github.com:acme/app.git', branch: 'main' },
    sslEmail: 'ops@acme.com',
  })

  it('provisions a PHP/nginx server with on-box mysql + redis', () => {
    expect(config.infrastructure?.compute?.runtime).toBe('php')
    expect(config.infrastructure?.compute?.webServer).toBe('nginx')
    expect(config.infrastructure?.compute?.managedServices?.mysql).toBe(true)
    expect(config.infrastructure?.compute?.managedServices?.redis).toBe(true)
  })

  it('enables Forge-equivalent server ops by default', () => {
    expect(config.infrastructure?.compute?.firewall?.enabled).toBe(true)
    expect(config.infrastructure?.compute?.autoUpdates).toBe(true)
    expect(config.infrastructure?.compute?.backups?.enabled).toBe(true)
  })

  it('configures a Laravel site with git deploy, ssl, queue, scheduler', () => {
    const site = config.sites?.main
    expect(site?.type).toBe('laravel')
    expect(site?.repository?.url).toContain('github.com')
    expect(site?.repository?.strategy).toBe('push')
    expect(site?.ssl?.provider).toBe('letsencrypt')
    expect(site?.scheduler).toBe(true)
    expect(site?.queues?.[0].connection).toBe('redis')
  })

  it('derives a db name from the slug and supports tag deploys', () => {
    const tagged = createLaravelPreset({
      name: 'My App',
      slug: 'my-app',
      repository: { url: 'git@github.com:acme/app.git' },
      deployStrategy: 'tag',
    })
    expect(tagged.infrastructure?.appDatabase?.name).toBe('my_app')
    expect(tagged.sites?.main.repository?.strategy).toBe('tag')
  })
})
