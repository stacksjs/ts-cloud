import type { CloudConfig } from '../types'

/**
 * Laravel Preset — a Forge-style single server.
 *
 * Provisions one box (Hetzner by default) running nginx + php-fpm + Composer,
 * MySQL + Redis on the box, host firewall (UFW), automatic security updates,
 * monitoring, and scheduled backups. The app is deployed from git into atomic
 * zero-downtime releases, served over HTTPS via Let's Encrypt, with the queue
 * worker and scheduler enabled.
 */
export function createLaravelPreset(options: {
  name: string
  slug: string
  /** App domain (also used for the Let's Encrypt cert). */
  domain?: string
  /** Git repository to deploy. */
  repository: { url: string, branch?: string, provider?: 'github' | 'gitlab' | 'bitbucket' | 'custom' }
  /** PHP version. @default '8.3' */
  phpVersion?: string
  /** Server size (provider-specific token). @default 'small' */
  size?: string
  /** App database name. @default slug */
  database?: string
  /** Database password (set via env in real configs). */
  databasePassword?: string
  /** Contact email for Let's Encrypt. */
  sslEmail?: string
  /** Deploy strategy. @default 'push' */
  deployStrategy?: 'push' | 'tag'
  /** Provider. @default 'hetzner' */
  provider?: 'hetzner' | 'aws'
}): Partial<CloudConfig> {
  const {
    name,
    slug,
    domain,
    repository,
    phpVersion = '8.3',
    size = 'small',
    database = slug.replace(/-/g, '_'),
    databasePassword,
    sslEmail,
    deployStrategy = 'push',
    provider = 'hetzner',
  } = options

  return {
    project: { name, slug, region: 'us-east-1' },
    mode: 'server',
    cloud: { provider },
    environments: {
      production: { type: 'production', domain },
    },
    infrastructure: {
      compute: {
        mode: 'server',
        size: size as any,
        runtime: 'php',
        webServer: 'nginx',
        php: { versions: [phpVersion], default: phpVersion },
        services: { mysql: true, redis: true },
        firewall: { enabled: true },
        autoUpdates: true,
        monitoring: true,
        backups: { enabled: true, schedule: '0 2 * * *', retentionCount: 7 },
      },
      database: {
        engine: 'mysql',
        name: database,
        username: database,
        password: databasePassword,
      },
    },
    sites: {
      main: {
        root: '.',
        type: 'laravel',
        domain,
        phpVersion,
        repository: { ...repository, strategy: deployStrategy },
        scheduler: true,
        queues: [{ connection: 'redis', queue: 'default', processes: 1 }],
        ssl: { provider: 'letsencrypt', email: sslEmail },
      },
    },
  }
}
