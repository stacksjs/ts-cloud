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
import { createLaravelPreset } from '@stacksjs/ts-cloud'

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
cloud deploy --env production
```

This provisions the server (first run) and deploys the app: clone, then
`composer install`, `artisan migrate --force`, config/route/view/event cache,
`storage:link`, an atomic flip of the `current` symlink, and a queue restart.
SSL is issued and the queue worker + scheduler are started.

## Full configuration

```ts
import type { CloudConfig } from '@stacksjs/ts-cloud'

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

## SSL certificates

By default every site with a `domain` gets a free **Let's Encrypt** certificate
issued by certbot (HTTP-01), with auto-renewal and an nginx reload on renewal.
You can also bring your own certificate, or issue a **wildcard** via DNS-01.

```ts
sites: {
  main: {
    // Let's Encrypt (default when a domain is set)
    ssl: { provider: 'letsencrypt', email: 'ops@acme.com' },
  },
}
```

**Custom certificate** — install an operator-provided cert/key (Forge's "Install
Existing Certificate"):

```ts
ssl: { provider: 'custom', certPath: '/etc/ssl/acme.crt', keyPath: '/etc/ssl/acme.key' }
```

**Wildcard / DNS-01** — `*.acme.com` requires DNS-01 validation through your DNS
provider (cloudflare, route53, digitalocean, google). The credentials are written
to a root-only INI; route53 can use the instance role instead.

```ts
ssl: {
  provider: 'letsencrypt',
  email: 'ops@acme.com',
  wildcard: true,
  dns: {
    provider: 'cloudflare',
    credentials: { dns_cloudflare_api_token: process.env.CLOUDFLARE_DNS_TOKEN! },
    propagationSeconds: 30,
  },
}
```

## Database users

Beyond the application user, provision extra database logins — read-only
reporting accounts, per-service users, etc. (Forge's "Database Users"). Each can
be granted full or read-only access to one or more databases, and re-provisioning
resets the password.

```ts
infrastructure: {
  appDatabase: {
    engine: 'mysql',
    name: 'acme',
    username: 'acme',
    password: process.env.DB_PASSWORD,
    users: [
      { username: 'reporter', password: process.env.RO_PASSWORD, access: 'readonly' },
      { username: 'analytics', password: process.env.AN_PASSWORD, databases: ['acme', 'metrics'] },
    ],
  },
}
```

`access: 'readonly'` grants `SELECT` only on MySQL/MariaDB (and `CONNECT` +
`USAGE` + `SELECT`, including future tables, on Postgres). The default is full
read/write.

## PHP settings & OPcache

PHP boxes are tuned for production by default (Forge's "Optimize for
Production"): OPcache is enabled with timestamp validation **off** (every deploy
restarts php-fpm, so a fresh release always recompiles), larger interned-string
and accelerated-file buffers, and a bigger realpath cache. Override or extend
with custom `php.ini` directives.

```ts
infrastructure: {
  compute: {
    php: {
      versions: ['8.3'],
      optimizeForProduction: true, // default
      ini: {
        memory_limit: '512M',
        upload_max_filesize: '128M',
        post_max_size: '128M',
      },
    },
  },
}
```

Set `optimizeForProduction: false` to skip the OPcache tuning (your `ini`
overrides still apply). The directives are written as a managed `php.ini`
drop-in discovered at runtime, so they work regardless of where PHP is installed.

## Nginx configuration

Inject custom directives into a site's generated `server { … }` block (Forge's
"Edit Nginx Configuration"), and define **reusable templates** shared across
sites.

```ts
infrastructure: {
  compute: {
    // Reusable directive blocks, referenced by name from a site.
    nginxTemplates: {
      hardening: [
        'add_header X-Robots-Tag "noindex, nofollow";',
        'location ~* \\.(env|git) { deny all; }',
      ],
    },
  },
},
sites: {
  main: {
    nginx: {
      template: 'hardening',                       // inject the shared block
      clientMaxBodySize: '256M',                   // per-vhost upload ceiling
      serverSnippet: ['gzip on;', 'location /health { return 200; }'],
    },
  },
}
```

The resolved template lines plus the per-site `serverSnippet` are inserted after
the managed root/locations, so the framework defaults still apply.

## Deployment history

Every deploy tees its full output to a per-release log and appends a record to a
history log on the box (Forge's deployment log) — both successful and failed
deploys are captured. Inspect it with the CLI:

```sh
cloud deploy:history            # most recent deploys for the first site
cloud deploy:history main --limit 50
```

Logs live under `<site>/.ts-cloud/` (outside `releases/`, so they survive
pruning); per-deploy logs are capped to the release keep-count.

## Scheduler & heartbeat monitoring

Enable the Laravel scheduler (a per-minute `php artisan schedule:run` cron) and,
optionally, attach a **heartbeat monitor** (healthchecks.io / Oh Dear style) that
is pinged only after a successful run — so you're alerted if the scheduler stops.

```ts
sites: {
  main: {
    scheduler: true, // simplest form

    // …or with heartbeat monitoring:
    scheduler: {
      heartbeatUrl: 'https://hc-ping.com/your-uuid',
      heartbeatMethod: 'GET', // GET (default) | POST | HEAD
    },
  },
}
```

## Rollback & recipes (CLI)

Roll a site back to a previous release, or run a reusable script across every
server (Forge's "Recipes"):

```sh
# Roll back to the previous release (atomic flip + php-fpm/queue restart)
cloud deploy:rollback main

# Roll back to a specific release id
cloud deploy:rollback main --to 20240601120000

# Run a local bash script on every server, as a chosen user
cloud deploy:recipe clear-opcache ./recipes/clear-opcache.sh --user www-data
```

### CLI reference (Forge-parity commands)

| Command | What it does |
| --- | --- |
| `cloud deploy --env production` | Provision (first run) + deploy all sites |
| `cloud deploy:rollback [site] [--to <id>]` | Roll a site back to a previous release |
| `cloud deploy:history [site] [--limit <n>]` | Show on-box deployment history |
| `cloud deploy:recipe <name> <script> [--user <u>]` | Run a bash recipe across servers |

## Per-site options

Beyond deploys + SSL, each site supports the Forge per-site knobs:

```ts
sites: {
  admin: {
    domain: 'admin.acme.com',
    // Dedicated OS user + php-fpm pool (Forge "User Isolation") — a compromised
    // site can't read another site's files.
    isolation: true,
    // HTTP Basic auth at nginx (htpasswd), hashed on the box.
    auth: { username: 'ops', password: process.env.ADMIN_PASSWORD, realm: 'Admin' },
    // Post-deploy health check — pinged from the deployer; a failure flags the deploy.
    healthCheck: { path: '/up' },
    // nginx redirects (Forge "Redirects").
    redirects: { '/old': '/new' },
    // Private-registry auth written before composer/npm install.
    credentials: {
      composerAuth: { 'github-oauth': { 'github.com': process.env.COMPOSER_TOKEN } },
      npmrc: '//registry.npmjs.org/:_authToken=${NPM_TOKEN}',
    },
  },
}
```

### SSH keys

Operator SSH keys are declarative — list them under `infrastructure.compute.sshKeys`
and they're written to the box's `authorized_keys` on the next deploy (Forge's
account/server keys):

```ts
infrastructure: {
  compute: {
    sshKeys: [
      { name: 'chris@laptop', publicKey: 'ssh-ed25519 AAAA… chris@laptop' },
      { name: 'ci-deploy', publicKey: process.env.CI_DEPLOY_PUBKEY! },
    ],
  },
}
```

Connect with `cloud server:ssh <name>`.

## What gets provisioned

| Area | Forge | ts-cloud |
| --- | --- | --- |
| Web server | nginx + php-fpm | nginx + php-fpm (per-site PHP version) |
| TLS | Let's Encrypt | Let's Encrypt (certbot) + custom certs, auto-renew |
| Wildcard SSL | DNS-01 | DNS-01 (cloudflare/route53/digitalocean/google) |
| Deploys | git, zero-downtime | git, zero-downtime atomic releases |
| Deployment history | per-deploy log | per-deploy + history log on the box |
| Rollback | one-click | `cloud deploy:rollback` (atomic) |
| Database | MySQL/MariaDB/Postgres | same, on-box or managed |
| Database users | read-only + full | read-only + full grants, password reset |
| PHP tuning | Optimize for Production | OPcache + custom `php.ini` (default on) |
| Nginx config | per-site + templates | per-site snippets + reusable templates |
| Cache/Search | Redis/Memcached/Meilisearch | same |
| Queues | workers / Horizon | systemd workers / Horizon |
| Scheduler | cron + heartbeat | cron (`schedule:run`) + heartbeat ping |
| Daemons | systemd | systemd |
| Recipes | run scripts on servers | `cloud deploy:recipe` (login shell, any user) |
| Firewall | UFW | UFW (+ Hetzner cloud firewall) |
| Maintenance | auto updates | unattended-upgrades |
| Backups | scheduled | scheduled (ts-backups to object storage) |
| Notifications | Slack/Discord/Telegram/email/webhook | same |

## Management dashboard (auto-deployed)

Every server provision/deploy automatically ships the ts-cloud management
dashboard — a stx app with **Server** and **Serverless** views (health,
services, sites, deployments, queues, functions, scheduler, data, secrets) — as
a server-static site. No config needed; the prebuilt UI ships inside the package.

The **Server** view shows host health (CPU/memory/disk), service status, sites
with SSL + deployment state, recent deployments, queue workers, the scheduler,
SSH keys, and backups:

![ts-cloud Server dashboard](/images/dashboard-server.png)

Every card drills into a dedicated page (`/server/metrics`, `/services`,
`/sites`, `/deployments`, `/workers`, `/ssh-keys`, `/backups`) with deeper
detail and the matching `cloud server:*` commands. Build it with live values via
`cloud dashboard:build` (otherwise it renders representative sample data).

The **Serverless** view (for the Lambda pipeline) covers function metrics,
queues, the scheduler, the WAF, data services, recent deployments with rollback,
assets/CDN, and secrets:

![ts-cloud Serverless dashboard](/images/dashboard-serverless.png)

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
