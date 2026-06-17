# Deploying Laravel (a Laravel Forge replacement)

ts-cloud can provision and deploy a Laravel (or any PHP) app on your own box —
a drop-in replacement for Laravel Forge. It provisions **nginx + php-fpm +
Composer**, on-box **MySQL/MariaDB/Postgres + Redis/Memcached/Meilisearch**,
deploys from **git into zero-downtime atomic releases** (Envoyer-style), issues
**Let's Encrypt** certificates, runs **queue workers + the scheduler + daemons**,
and adds **UFW**, **automatic security updates**, **monitoring**, **scheduled
backups**, and **Slack/Discord/Telegram/email/webhook notifications**.

## Quick start (preset)

```ts
// cloud.config.ts
import { createLaravelPreset } from 'ts-cloud'

export default createLaravelPreset({
  name: 'Acme',
  slug: 'acme',
  domain: 'acme.com',
  repository: { url: 'git@github.com:acme/app.git', branch: 'main' },
  phpVersion: '8.3',
  sslEmail: 'ops@acme.com',
  databasePassword: process.env.DB_PASSWORD,
})
```

```sh
cloud deploy production
```

This provisions the server (first run) and deploys the app: clone, then
`composer install`, `artisan migrate --force`, config/route/view/event cache,
`storage:link`, an atomic flip of the `current` symlink, and a queue restart.
SSL is issued and the queue worker + scheduler are started.

## Full configuration

```ts
import type { CloudConfig } from 'ts-cloud'

export default {
  project: { name: 'Acme', slug: 'acme', region: 'us-east-1' },
  cloud: { provider: 'hetzner' },
  environments: { production: { type: 'production', domain: 'acme.com' } },

  notifications: {
    slack: { webhookUrl: process.env.SLACK_WEBHOOK! },
  },

  infrastructure: {
    compute: {
      runtime: 'php',
      webServer: 'nginx', // or 'rpx'
      php: { versions: ['8.3', '8.2'], default: '8.3' },
      managedServices: { mysql: true, redis: true, meilisearch: true },
      firewall: { enabled: true, allowedPorts: [8080] },
      autoUpdates: true, // unattended-upgrades
      monitoring: true,
      backups: { enabled: true, schedule: '0 2 * * *', retentionCount: 7, bucket: 'acme-backups' },
    },
    appDatabase: { engine: 'mysql', name: 'acme', username: 'acme', password: process.env.DB_PASSWORD },
  },

  sites: {
    main: {
      root: '.',
      type: 'laravel', // laravel | php | statamic | wordpress | static | spa
      domain: 'acme.com',
      aliases: ['www.acme.com'],
      phpVersion: '8.3',
      repository: { url: 'git@github.com:acme/app.git', branch: 'main', strategy: 'push' },
      ssl: { provider: 'letsencrypt', email: 'ops@acme.com' },
      scheduler: true,
      queues: [
        { connection: 'redis', queue: 'default,emails', processes: 2, tries: 3, timeout: 90 },
      ],
      daemons: [
        { command: 'php artisan reverb:start', name: 'reverb' },
      ],
      sharedPaths: ['storage', '.env'],
      keepReleases: 5,
    },
  },
} satisfies CloudConfig
```

## Deploy strategies

- **Push to deploy** (`strategy: 'push'`, default) — deploys the tip of `branch`.
- **Tag deploy** (`strategy: 'tag'`) — deploys a specific `tag`, or the highest
  tag matching `tagPattern`. Useful for promoting tagged releases.

```ts
repository: { url: '…', strategy: 'tag', tagPattern: 'v*' }
```

## Zero-downtime releases

Every deploy clones into `releases/<id>`, links the shared `storage`/`.env`,
runs the deploy script, then atomically flips `current`. A failed step leaves
the previous release serving. The last `keepReleases` (default 4) are retained
for rollback.

## What gets provisioned

| Area | Forge | ts-cloud |
| --- | --- | --- |
| Web server | nginx + php-fpm | nginx + php-fpm (per-site PHP version) |
| TLS | Let's Encrypt | Let's Encrypt (certbot) + custom certs, auto-renew |
| Deploys | git, zero-downtime | git, zero-downtime atomic releases |
| Database | MySQL/MariaDB/Postgres | same, on-box or managed |
| Cache/Search | Redis/Memcached/Meilisearch | same |
| Queues | workers / Horizon | systemd workers / Horizon |
| Scheduler | cron | cron (`schedule:run`) |
| Daemons | systemd | systemd |
| Firewall | UFW | UFW (+ Hetzner cloud firewall) |
| Maintenance | auto updates | unattended-upgrades |
| Backups | scheduled | scheduled (ts-backups to object storage) |
| Notifications | Slack/Discord/Telegram/email/webhook | same |

## Management dashboard (auto-deployed)

Every server provision/deploy automatically ships the ts-cloud management
dashboard — a stx app with **Server** and **Serverless** views (health,
services, sites, deployments, queues, functions, scheduler, data, secrets) — as
a server-static site. No config needed; the prebuilt UI ships inside the package.

It is served behind HTTP Basic auth **only when `TS_CLOUD_UI_PASSWORD` is set**;
if it is unset the dashboard is served without auth (and a warning is logged — set
a password for any internet-facing box). Env knobs:

| Env | Purpose |
| --- | --- |
| `TS_CLOUD_UI_PASSWORD` | htpasswd password (unset ⇒ no auth) |
| `TS_CLOUD_UI_USERNAME` | htpasswd user (default `admin`) |
| `TS_CLOUD_UI_DOMAIN`   | dashboard host (else `dashboard.<apex>`) |
| `TS_CLOUD_UI_DISABLE`  | set truthy to skip auto-deploy |

The host defaults to `dashboard.<your-apex-domain>`; set `TS_CLOUD_UI_DOMAIN` to
override. Disable entirely with `TS_CLOUD_UI_DISABLE=1`.
