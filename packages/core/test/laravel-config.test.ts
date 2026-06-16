import type { CloudConfig, ComputeConfig, DaemonConfig, QueueWorkerConfig, SiteConfig } from '../src/types'
import { describe, expect, it } from 'bun:test'

// Chunk 1 is a pure type-model addition (no behavior yet), so these tests pin
// the shape of the new Laravel/PHP config surface: that a representative config
// is assignable, and that the new fields land where deploy logic will read them.
describe('Laravel/PHP config model', () => {
  it('accepts a Laravel site with the Forge feature set', () => {
    const site: SiteConfig = {
      root: '.',
      type: 'laravel',
      domain: 'example.com',
      phpVersion: '8.3',
      webDirectory: 'public',
      repository: { url: 'git@github.com:acme/app.git', branch: 'main', provider: 'github' },
      sharedPaths: ['storage', '.env'],
      keepReleases: 4,
      zeroDowntime: true,
      scheduler: true,
      queues: [{ connection: 'redis', queue: 'default,emails', processes: 2, tries: 3 }],
      daemons: [{ command: 'php artisan reverb:start', processes: 1, restart: 'always' }],
      ssl: { provider: 'letsencrypt', email: 'ops@example.com' },
      aliases: ['www.example.com'],
      redirects: { '/old': 'https://example.com/new' },
      healthCheck: { path: '/up' },
    }

    expect(site.type).toBe('laravel')
    expect(site.repository?.url).toContain('github.com')
    expect(site.queues?.[0].processes).toBe(2)
  })

  it('accepts compute PHP + on-box services provisioning', () => {
    const compute: ComputeConfig = {
      mode: 'server',
      webServer: 'nginx',
      php: { versions: ['8.3', '8.2'], default: '8.3', extensions: ['imagick'] },
      services: { mysql: true, redis: true, meilisearch: { version: '1.6' } },
    }

    expect(compute.php?.versions).toContain('8.3')
    expect(compute.webServer).toBe('nginx')
    expect(compute.services?.mysql).toBe(true)
  })

  it('keeps queue worker and daemon shapes distinct', () => {
    const worker: QueueWorkerConfig = { horizon: true, memory: 256 }
    const daemon: DaemonConfig = { command: 'node worker.js', directory: '/var/www/app/current' }
    expect(worker.horizon).toBe(true)
    expect(daemon.command).toBe('node worker.js')
  })

  it('composes into a full CloudConfig', () => {
    const config: CloudConfig = {
      project: { name: 'acme', slug: 'acme', region: 'us-east-1' },
      environments: { production: { type: 'production' } },
      infrastructure: { compute: { webServer: 'nginx', php: { versions: ['8.3'] } } },
      sites: { main: { root: '.', type: 'laravel', domain: 'acme.test' } },
    }
    expect(config.sites?.main.type).toBe('laravel')
  })
})
