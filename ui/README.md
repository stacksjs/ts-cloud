# @ts-cloud/ui

The ts-cloud management dashboard — a Forge-style overview of your server and
deployments, built with [stx](https://github.com/stacksjs/stx) and served as a
static site **behind HTTP Basic auth** (password from an env value).

## What it shows

- **Server health** — CPU load, memory, disk, uptime (from the box's metrics agent).
- **Services** — nginx, php-fpm, database, redis, meilisearch status.
- **SSH Keys** — list authorized keys and add a new one (name + public key) inline.
- **Sites** — domain, type, PHP version, SSL, last deploy, status.
- **Deployments** — recent releases with sha, branch, status, duration.
- **Queues & Scheduler** — worker processes and scheduler state.
- **Backups** — destination, retention, last run.

## Build

```sh
bun install
bun run build        # → dist/ (static HTML)
bun run dev          # live preview
```

Pages use `<script server>` so the dashboard renders to static HTML at build
time. `ui/build.ts` (in ts-cloud) injects the resolved cloud config + the box's
`/var/lib/ts-cloud/metrics.json` into the page; the sample data in
`pages/index.stx` is used when none is present.

## Deployment

ts-cloud deploys this as a site behind htpasswd:

```ts
sites: {
  dashboard: {
    root: 'ui/dist',
    type: 'static',
    domain: 'dashboard.acme.com',
    auth: { username: 'admin', password: process.env.TS_CLOUD_UI_PASSWORD },
  },
}
```
