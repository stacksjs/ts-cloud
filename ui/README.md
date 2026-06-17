# @ts-cloud/ui

The ts-cloud management dashboard — a Forge- **and** Vapor-style overview of your
infrastructure, built with [stx](https://github.com/stacksjs/stx) and served as a
static site **behind HTTP Basic auth** (password from an env value). Two views,
switchable from the nav: **Server** (`/`) and **Serverless** (`/serverless`).

## Server view (`/`) — Forge-style

- **Server health** — CPU load, memory, disk, uptime (from the box's metrics agent).
- **Services** — nginx, php-fpm, database, redis, meilisearch status.
- **SSH Keys** — list authorized keys and add a new one (name + public key) inline.
- **Sites** — domain, type, PHP version, SSL, last deploy, status.
- **Deployments** — recent releases with sha, branch, status, duration.
- **Queues & Scheduler** — worker processes and scheduler state.
- **Backups** — destination, retention, last run.

## Serverless view (`/serverless`) — Vapor-style

- **Headline metrics** — invocations, error rate, p95 latency, cold starts, est. cost.
- **Functions** — the http/queue/cli Lambdas with memory, timeout, invocations, errors, p95.
- **Queues** — visible/in-flight/processed/DLQ per SQS queue.
- **Scheduler & WAF** — schedule expression + last run; firewall rules + blocked count.
- **Data** — Aurora Serverless, RDS Proxy, ElastiCache/DynamoDB status.
- **Deployments** — releases with sha, author, duration + one-click rollback.
- **Assets & CDN** — bucket, CloudFront domain, `ASSET_URL`.
- **Secrets** — masked list with last-updated.
- **Actions** — deploy, roll back, and toggle maintenance mode (down/up).

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
