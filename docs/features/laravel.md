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

### Push-to-deploy (CI pipeline)

ts-cloud deploys from your machine or CI (git-clone-on-server), so Forge's deploy
webhook becomes a provider-native pipeline. Set the repo's `provider` and run
`cloud quick-deploy` to scaffold a workflow that runs `cloud deploy` on every
push to the deploy branch:

```ts
repository: { url: 'git@github.com:acme/app.git', branch: 'main', provider: 'github' }
```

```sh
cloud quick-deploy            # writes the CI file for the configured provider
cloud quick-deploy --force    # overwrite an existing file
```

| `provider` | Generated file |
| --- | --- |
| `github` | `.github/workflows/deploy.yml` |
| `gitlab` | `.gitlab-ci.yml` |
| `bitbucket` | `bitbucket-pipelines.yml` |

`custom` (or no repository) skips generation — wire your own pipeline to call
`cloud deploy`.

## Site types

`type` selects the deploy script + nginx template:

| `type` | Web root | Deploy script |
| --- | --- | --- |
| `laravel` | `public/` | composer + `artisan migrate`/cache/queue restart |
| `statamic` | `public/` | full Laravel deploy (composer + artisan) |
| `wordpress` | release root | optional composer, no artisan; WP hardening |
| `php` | release root | optional composer, no artisan |
| `static` | release root | files only (clone + activate) |
| `spa` | release root | files only, SPA fallback to `index.html` |

**WordPress** vhosts add hardening automatically: `xmlrpc.php` is denied,
`wp-config.php`/`readme.html`/`license.txt` are blocked, and PHP execution inside
`wp-content/uploads` is refused. (Bedrock serves from `web/` — set
`webDirectory: 'web'`.) **Statamic** is treated as a Laravel app.

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

### HSTS & TLS hardening

Force HTTPS in browsers with an HSTS header, and pin the TLS protocol versions
nginx serves. Both live under the site's `ssl`:

```ts
ssl: {
  provider: 'letsencrypt',
  email: 'ops@acme.com',
  // true ⇒ `max-age=31536000; includeSubDomains`; or customize:
  hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
  // Restrict to modern TLS (applies to the custom-cert :443 block).
  tlsProtocols: ['TLSv1.2', 'TLSv1.3'],
}
```

`hsts: true` emits a one-year `Strict-Transport-Security` header with
`includeSubDomains`. Only enable `preload` once every subdomain is HTTPS-only.

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

The pantry `php.net` build already bundles the full Laravel extension matrix
(mbstring, xml, curl, pdo_mysql, pdo_pgsql, redis, gd, bcmath, zip, intl,
openssl, sodium, …). `php.extensions` is accepted for documentation/intent but
that build is fixed — extra extensions (e.g. `imagick`, `swoole`) require a
custom PHP build in pantry, not a runtime flag.

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
| `cloud quick-deploy [--force]` | Scaffold a push-to-deploy CI pipeline |
| `cloud db:restore-backup [from]` | Restore the app database from a backup |

## Per-site options

Beyond deploys + SSL, each site supports the Forge per-site knobs:

```ts
sites: {
  admin: {
    domain: 'admin.acme.com',
    // HTTP Basic auth at nginx (htpasswd), hashed on the box.
    auth: { username: 'ops', password: process.env.ADMIN_PASSWORD, realm: 'Admin' },
    // Post-deploy health check — after the release is live the site is curled on
    // the box (via its Host header); a non-2xx/3xx response fails the deploy.
    healthCheck: { path: '/up' },
    // nginx redirects (Forge "Redirects").
    redirects: { '/old': '/new' },
    // Per-site user isolation: a dedicated OS user + php-fpm pool (see below).
    isolation: true,
    // Per-site IP access control (Forge "Security Rules"). With `allow`, every
    // other IP is denied; `deny` blocks specific addresses.
    security: { allow: ['203.0.113.0/24'], deny: ['198.51.100.7'] },
    // Private-registry auth written before composer/npm install.
    credentials: {
      composerAuth: { 'github-oauth': { 'github.com': process.env.COMPOSER_TOKEN } },
      npmrc: '//registry.npmjs.org/:_authToken=${NPM_TOKEN}',
    },
  },
}
```

### Site isolation (per-site user + php-fpm pool)

Set `isolation: true` on a site for Forge-style **User Isolation**: ts-cloud
creates a dedicated system user (`web_<site>`), runs that site's PHP in its own
php-fpm pool (its own worker processes on a per-site port), and jails the pool
to the site's directory tree via `open_basedir`. nginx (`www-data`) is added to
the site's group so it can still serve static files. A compromise or runaway in
one isolated site can't read another site's files or starve the shared pool.

```ts
sites: {
  app:   { domain: 'acme.com',     type: 'laravel', isolation: true },
  blog:  { domain: 'blog.acme.com', type: 'wordpress', isolation: true },
}
```

> Requires a pantry build whose php-fpm `include`s the pool dir
> (`/var/lib/pantry/php-fpm/pool.d/*.conf`); recent pantry releases ship this.

### Deploy hooks

Project-level `hooks` run a shell command or a TypeScript function at each
lifecycle stage of `cloud deploy`. String hooks run locally (in the deploy CWD);
function hooks receive the resolved config. A failing **string** hook in
`beforeBuild`/`beforeDeploy` aborts the deploy. (Server-side steps belong in
`site.deployScript`; these run on the deploying machine.)

```ts
// cloud.config.ts — top level, not inside a site
export default {
  // …project, infrastructure, sites…
  hooks: {
    beforeBuild:  'bun run build',
    afterBuild:   'echo assets built',
    beforeDeploy: config => assertEnv(config),
    afterDeploy:  'curl -fsS https://acme.com/up',
  },
}
```

The four stages run in order: `beforeDeploy` → `beforeBuild` → (build) →
`afterBuild` → (deploy) → `afterDeploy`.

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

## Backups

Scheduled database backups (Forge's "Database Backups") run on the box via cron
and sync to object storage (S3 or Hetzner). Configure under
`infrastructure.compute.backups`:

```ts
infrastructure: {
  compute: {
    backups: {
      enabled: true,
      schedule: '0 2 * * *',     // cron (default nightly)
      retentionCount: 7,         // keep the last N dumps
      bucket: 'acme-backups',    // object-storage bucket
      // endpoint: '…',          // Hetzner/S3-compatible endpoint (optional)
    },
  },
}
```

**Restore** a database from a dump on the box (Forge's restore). With no argument
the newest matching dump is used; pass a path to restore a specific one:

```sh
# Restore appDatabase from the latest on-box backup
cloud db:restore-backup

# Restore from a specific dump file
cloud db:restore-backup /var/backups/ts-cloud/acme_20240601.sql.gz
```

## Server monitoring & alerts

A dependency-free collector writes a metrics snapshot to
`/var/lib/ts-cloud/metrics.json` every minute (Forge's server metrics): load,
CPU count, memory + swap, disk, uptime, network throughput (rx/tx bytes), and
per-service TCP health (nginx, php-fpm, MySQL/Postgres, Redis, Meilisearch). The
dashboard reads it; `cloud server:monitoring <name>` prints it.

Pass an object to `monitoring` to set **resource alert thresholds**. When a
threshold is breached the box calls the on-box notifier (the same
Slack/Discord/Telegram/webhook channels) once per OK→alert transition, and again
on recovery — so a hot box doesn't spam every minute:

```ts
infrastructure: {
  compute: {
    monitoring: {
      alerts: {
        cpuLoadPerCore: 2,  // 1-min load ÷ CPUs (default 2)
        memPercent: 90,     // used memory % (default 90)
        diskPercent: 90,    // root fs usage % (default 90)
      },
    },
  },
}
```

`monitoring: true` (the default for PHP boxes) enables the collector with
default thresholds; `monitoring: false` disables it entirely.

## Server, database & firewall CLI

`cloud deploy` provisions and deploys from `cloud.config.ts`; for day-to-day
operations there's a full Forge-style CLI — see the **[CLI reference](/cli)**
for the complete list. The most-used commands:

| Command | What it does |
| --- | --- |
| `cloud server:list` / `server:ssh <name>` | List servers / SSH in |
| `cloud server:logs <name>` / `server:monitoring <name>` | Tail logs / show metrics |
| `cloud db:list` / `db:create <name>` / `db:backup <name>` | Database management |
| `cloud db:users:add <name> <user>` | Add a database user |
| `cloud firewall:block <ip>` / `firewall:unblock <ip>` | Firewall / WAF rules |
| `cloud ssl:renew <domain>` | Renew a certificate |
| `cloud backup:list` / `backup:start <arn>` | Backups |

## What gets provisioned

| Area | Forge | ts-cloud |
| --- | --- | --- |
| Web server | nginx + php-fpm | nginx + php-fpm (per-site PHP version) |
| TLS | Let's Encrypt | Let's Encrypt (certbot) + custom certs, auto-renew |
| HSTS / TLS hardening | toggle | `ssl.hsts` + `ssl.tlsProtocols` |
| Security rules | per-site allow/deny | `site.security` (IP allow/deny) |
| Wildcard SSL | DNS-01 | DNS-01 (cloudflare/route53/digitalocean/google) |
| Deploys | git, zero-downtime | git, zero-downtime atomic releases |
| Push to deploy | webhook | provider CI pipeline (`cloud quick-deploy`) |
| Deploy hooks | before/after | `hooks` (string command or function) |
| Deployment history | per-deploy log | per-deploy + history log on the box |
| Health checks | post-deploy ping | `site.healthCheck` gate (fails the deploy) |
| Rollback | one-click | `cloud deploy:rollback` (atomic) |
| Site isolation | per-site user + pool | `isolation: true` (user + php-fpm pool + jail) |
| Database | MySQL/MariaDB/Postgres | same, on-box or managed |
| Database users | read-only + full | read-only + full grants, password reset |
| Backup restore | one-click | `cloud db:restore-backup [from]` |
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
| Monitoring | server metrics | metrics + network/per-service health + resource alerts |
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

It is **secure by default**: on every deploy the dashboard is served behind HTTP
Basic auth. Set `TS_CLOUD_UI_PASSWORD` to pin your own password; if you don't, a
strong one is generated, saved to `.ts-cloud/dashboard-credentials.json` (so it
stays stable across deploys and you can read it back), and printed once in the
deploy log. Serving the dashboard publicly is an explicit opt-in via
`TS_CLOUD_UI_PUBLIC=1`. Env knobs:

| Env | Purpose |
| --- | --- |
| `TS_CLOUD_UI_PASSWORD` | htpasswd password (unset ⇒ auto-generated + saved) |
| `TS_CLOUD_UI_PUBLIC`   | set truthy to serve WITHOUT auth (opt-out, insecure) |
| `TS_CLOUD_UI_USERNAME` | htpasswd user (default `admin`) |
| `TS_CLOUD_UI_DOMAIN`   | dashboard host (else `dashboard.<apex>`) |
| `TS_CLOUD_UI_DISABLE`  | set truthy to skip auto-deploy |

The host defaults to `dashboard.<your-apex-domain>`; set `TS_CLOUD_UI_DOMAIN` to
override. Disable entirely with `TS_CLOUD_UI_DISABLE=1`.
