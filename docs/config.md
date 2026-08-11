# Configuration

ts-cloud is configured with a single `cloud.config.ts` in your project root. The
top-level shape is `CloudConfig`:

```typescript
import type { CloudConfig } from '@stacksjs/ts-cloud'

export default {
  project: { name: 'My App', slug: 'my-app', region: 'us-east-1' },
  environments: {
    production: { type: 'production' },
  },
} satisfies Partial<CloudConfig>
```

Everything beyond `project` + `environments` is opt-in, and what you add decides
what gets deployed:

| Key | Type | Purpose |
|-----|------|---------|
| `project` | `{ name, slug, region }` | **Required.** `slug` is the prefix for all resource names. |
| `environments` | `Record<string, EnvironmentConfig>` | **Required.** One entry per environment (`production`, `staging`, …). |
| `mode` | `'serverless' \| …` | Optional — auto-detected from the config; rarely set by hand. |
| `infrastructure` | `InfrastructureConfig` | EC2 compute, databases, caches, SES, search, and other managed AWS resources (see [AWS Resources](/features/aws)). |
| `sites` | `Record<string, SiteConfig>` | Static sites + server-served app sites ([Site Deployment Targets](#site-deployment-targets)). |
| `notifications` | `NotificationsConfig` | Slack/Discord/Telegram/email/webhook for deploy, SSL, health-check, backup events. |
| `cloud` | `{ provider: 'aws' \| 'hetzner' }` | Compute provider. Defaults to AWS. |
| `hetzner` | `HetznerConfig` | Hetzner Cloud settings when `cloud.provider` is `hetzner` ([below](#hetzner)). |
| `objectStorage` | `ObjectStorageConfig` | Object-storage provider (AWS S3, Backblaze B2, Hetzner) — independent of `cloud.provider`. |
| `aws` | `AwsConfig` | AWS account/credential overrides. |
| `stateDir` | `string` | Where machine-local state is kept. Defaults to `.ts-cloud` ([below](#state-directory)). |

## State directory

Everything ts-cloud persists on the machine running a deploy lives under one
directory: the dashboard credentials and session key, the auth encryption key,
the control-plane database, the staged dashboard release, cached templates, and
restore scratch space. It defaults to a hidden `.ts-cloud/` in the project root.

Projects that already have a home for machine-local state can point it there
instead of collecting a second state directory in their root:

```typescript
export default {
  project: { name: 'My App', slug: 'my-app', region: 'us-east-1' },
  // A Stacks application keeps every runtime-owned directory under storage/.
  stateDir: 'storage/cloud',
  environments: { production: { type: 'production' } },
} satisfies Partial<CloudConfig>
```

Relative paths resolve against the project root; absolute paths are used as-is.
`TS_CLOUD_STATE_DIR` overrides the config, which is the way to keep a CLI and
the processes it spawns in agreement.

Two things deliberately do NOT follow this setting:

- **`storage/cloud/state/<stack>.json`**, where the drivers record the
  provisioned box. That one is meant to be committed, so CI can find the
  existing server instead of provisioning a duplicate.
- **The dashboard's state on the box.** `stateDir` describes your machine; the
  box keeps users and the session key in its release's own `.ts-cloud/`, which
  the deploy carries across releases.

Never commit the state directory - it holds credentials. Deploy packaging skips
it wherever it is configured to live.

## Hetzner

Set `cloud.provider` to `hetzner` and configure the box under `hetzner`:

```ts
const config: CloudConfig = {
  cloud: { provider: 'hetzner' },
  hetzner: {
    location: 'fsn1',            // fsn1 | nbg1 | hel1 | ash | hil
    image: 'ubuntu-24.04',
    sshUser: 'root',
    sshPrivateKeyPath: '~/.ssh/id_ed25519',
    // apiToken is a secret — leave it out and use HCLOUD_TOKEN
  },
}
```

### Where each setting comes from

Every field is optional, and each resolves through the same chain:

1. an explicit argument (a driver option)
2. `cloud.config.ts` → `hetzner.*`
3. the environment: `HCLOUD_*`, or the `HETZNER_*` alias
4. the documented default

**Config always wins over the environment**, for every field including the token. A stray shell export must not silently redirect a deploy to another datacenter or another Hetzner account. In practice the token is simply left out of `cloud.config.ts` — it is a secret and the file is checked in — so it comes from `HCLOUD_TOKEN`. That is a convention, not a different rule.

| Field | Environment | Default |
|---|---|---|
| `apiToken` | `HCLOUD_TOKEN` / `HETZNER_API_TOKEN` | none — a missing token fails loudly |
| `location` | `HCLOUD_LOCATION` | `fsn1` |
| `image` | `HCLOUD_IMAGE` | `ubuntu-24.04` |
| `sshUser` | `HCLOUD_SSH_USER` | `root` |
| `sshPrivateKeyPath` | `HCLOUD_SSH_KEY` | `~/.ssh/id_ed25519` |
| `sshPublicKeyPath` | `HCLOUD_SSH_PUBLIC_KEY` | `<sshPrivateKeyPath>.pub` |

`infrastructure.compute.image` overrides `hetzner.image` when set: it is the provider-agnostic way to pin an image, and it is what a golden-image bake sets.

## Two app models

ts-cloud deploys apps two ways; pick per environment:

- **Serverless** (Laravel Vapor replacement) — set `environments.<env>.app`
  (`ServerlessAppConfig`). One codebase → http/queue/cli Lambda functions. See
  [Serverless](/features/serverless).
- **Server** (Laravel Forge replacement) — set `infrastructure.compute` + `sites`.
  A provisioned EC2/Hetzner box running nginx + php-fpm. See
  [Laravel / Forge-style](/features/laravel).

```typescript
// Serverless (Vapor-style)
export default {
  project: { name: 'My API', slug: 'my-api', region: 'us-east-1' },
  environments: {
    production: {
      type: 'production',
      app: { kind: 'node', entry: 'src/server.ts', queues: true, scheduler: 'on' },
    },
  },
} satisfies Partial<CloudConfig>
```

### Environment configuration

Each `environments.<env>` entry is an `EnvironmentConfig`:

| Field | Type | Purpose |
|-------|------|---------|
| `type` | `'production' \| 'staging' \| 'development'` | **Required.** Environment class. |
| `region` | `string` | Override the project region for this environment. |
| `variables` | `Record<string, string>` | Plain (non-secret) env vars. |
| `domain` | `string` | Custom domain for this environment. |
| `infrastructure` | `Partial<InfrastructureConfig>` | Per-environment infra overrides (e.g. smaller instances in dev). |
| `app` | `ServerlessAppConfig` | Serverless app manifest (opts into the Lambda pipeline). |

```typescript
environments: {
  staging: { type: 'staging', variables: { LOG_LEVEL: 'debug' } },
  production: { type: 'production', domain: 'my-app.com', variables: { LOG_LEVEL: 'warn' } },
}
```

> Secrets are **not** plain `variables`. For serverless apps they live under
> `environments.<env>.app.secrets` (resolved from AWS Secrets Manager); manage
> them with `cloud secrets:set/get/list/delete`.

## Site Deployment Targets

Each entry in `sites` deploys to one of two **targets**, set explicitly with
`deploy` (or inferred for backward compatibility):

| `deploy` | `start` | Resolved kind | What happens |
|----------|---------|---------------|--------------|
| `'bucket'` (or unset, no `start`) | — | **bucket** | Built `root` is uploaded to object storage (S3 / Hetzner OS) and served via a CDN (CloudFront on AWS). |
| `'server'` (or unset, `start` set) | set | **server-app** | Dynamic app run as a `systemd` service. |
| `'server'` | unset | **server-static** | Static site **built and shipped to the compute box** (to `/var/www/<site>`), optionally fronted by a CDN. |

Two further kinds are **gateway-only**: they ship nothing and are decided by a
single field rather than by `deploy`/`start` — `redirect` (the gateway answers
the domain with a `Location`) and `proxyTo` (the gateway forwards the domain to
an upstream ts-cloud does not manage). See
[Proxy-only sites](#proxy-only-sites) below.

> Proxying and TLS on compute (`server`) targets are handled by
> [rpx](https://github.com/stacksjs/rpx) (proxy + TLS). By default ts-cloud
> provisions the box, runs the systemd app, and ships static assets but leaves
> the proxy to the operator. Opt in to having `buddy deploy` **provision and
> wire rpx for you** from the `sites` model with
> `infrastructure.compute.proxy: { engine: 'rpx' }` — see
> [Reverse proxy: rpx](#reverse-proxy-rpx) below.

Inference rules (when `deploy` is omitted): explicit `deploy` always wins; else
`start` present ⇒ `'server'`; else ⇒ `'bucket'`. This keeps every existing
config working unchanged — a legacy `start` site still deploys to compute, and a
legacy static site still deploys to a bucket.

```typescript
const config: CloudConfig = {
  project: { name: 'Example', slug: 'example', region: 'us-east-1' },
  environments: { production: { type: 'production' } },

  // The server-targeted sites need a compute box to land on.
  infrastructure: {
    compute: { mode: 'server' },
  },

  sites: {
    // Dynamic SSR app → systemd service (proxied by the operator's own rpx)
    app: {
      root: '.output',
      domain: 'example.com',
      start: 'bun run server.ts',
      port: 3000,
    },

    // Docs built AND shipped to the same box (served by the operator's proxy)
    docs: {
      root: 'docs/.bunpress/dist',
      domain: 'example.com/docs',
      deploy: 'server',
      build: 'bun run docs:build',
      cache: { enabled: true, maxAge: 3600 },
    },

    // Blog, also served on the box
    blog: {
      root: 'blog/dist',
      domain: 'example.com/blog',
      deploy: 'server',
    },

    // Classic static site → object storage + CDN
    marketing: {
      root: 'marketing/dist',
      domain: 'www.example.com',
      // deploy omitted ⇒ inferred 'bucket'
    },
  },
}
```

### Proxy-only sites

Set `proxyTo` when a service is already running on the box and must stay under
whatever provisions it. ts-cloud builds, ships and supervises **nothing** for the
site — no release directory, no systemd unit — but the domain still joins the
gateway's TLS set, so it gets `certsDirServerNames`,
`onDemandTls.allowedSuffixes` and the project's `rpx-cert-renew-<slug>` units
like any other site.

```typescript
sites: {
  // Routed here, run and renewed elsewhere.
  registry: { domain: 'registry.example.com', proxyTo: 'localhost:3001' },

  // Several upstreams are load-balanced with infrastructure.compute.proxy.loadBalancer.
  api: { domain: 'api.example.com', proxyTo: ['10.0.0.1:8080', '10.0.0.2:8080'] },
}
```

Reach for it when the service needs something ts-cloud's generated unit cannot
express. The case it was built for is a package registry whose unit carries
`Requires=clamav-daemon.service` and hard memory and task caps: routing it with
`start` + `port` would have handed ts-cloud the unit and silently dropped that
hardening, while leaving it out of `sites` entirely meant the host never made it
into the gateway's certificate set.

`domain` is required. `root`, `start`, `port`, `build` and `preStart` are
ignored, and `cloud deploy` warns if they are set, so a leftover `root` can never
turn the site back into a release that would overwrite the running service. A
`redirect` on the same site wins over `proxyTo`.

### Server-optional contract

A project with only `bucket` sites needs **no** compute server and validates
clean. If a site targets a server (`deploy: 'server'`, or `start` set) but no
`infrastructure.compute` is configured, `cloud deploy` aborts up front with an
actionable error instead of failing silently at runtime — set `deploy: 'bucket'`
or add a server.

### CDN / caching

The `cache` hint applies to either origin:

- **bucket** — front the origin with a CDN (CloudFront on AWS).
- **server-static** — `cache.enabled` / `cache.maxAge` express the intended
  edge caching; the actual `Cache-Control` headers are configured in the
  operator's own proxy (rpx + tlsx), not by ts-cloud.

On **AWS**, a server origin can sit behind CloudFront via the existing
compute-origin routing. On **Hetzner** there is no native CDN — you can place
CloudFront / Cloudflare / bunny in front of the box yourself. ts-cloud does not
provision a Hetzner CDN.

### Reverse proxy: rpx

The reverse-proxy gateway on a compute box is [rpx](https://github.com/stacksjs/rpx)
(its own tooling — this replaces the older Caddy generation). Set
`infrastructure.compute.proxy` and `buddy deploy` will **generate rpx's routes
from the `sites` model** and provision rpx as the gateway on `:80`/`:443`:

```typescript
const config: CloudConfig = {
  // …
  infrastructure: {
    compute: {
      mode: 'server',
      // Opt in: provision rpx and wire it from `sites`. Off by default.
      proxy: {
        engine: 'rpx',
        // version: 'latest',           // npm version/range of @stacksjs/rpx
        // certsDir: '/etc/rpx/certs',  // real per-domain PEMs (SNI)
        // onDemandTls: true,           // lazily issue Let's Encrypt certs
        // onDemandTlsEmail: 'ops@example.com',
      },
    },
  },
  sites: {
    // App + docs + public site sharing ONE domain via path-based routing:
    main:   { domain: 'stacksjs.com', path: '/api', start: 'bun run server.ts', port: 3000, root: '.output' },
    docs:   { domain: 'stacksjs.com', path: '/docs', deploy: 'server', root: 'docs/dist' },
    public: { domain: 'stacksjs.com', deploy: 'server', root: 'public' },
  },
}
```

How it maps:

- each non-bucket site with a `domain` becomes an rpx route, grouped by
  `domain` so several sites can share a host on different `path`s;
- **server-app** → `{ to: domain, path, from: 'localhost:<port>' }`;
- **server-static** → `{ to: domain, path, static: '/var/www/<name>' }`
  (with `cleanUrls` from `pathRewriteStyle`, `spa` from the site's `spa`);
- TLS is served from `certsDir` per SNI server name; `onDemandTls` lazily
  issues real certs for the configured domains.

The example above produces three routes under `stacksjs.com`: `/api/*` proxied
to the app on `:3000`, `/docs*` served from `/var/www/docs`, and `/` served
from `/var/www/public` (longest path prefix wins).

What provisioning does on the box (idempotent, re-runnable):

1. `bun add -g @stacksjs/rpx` (at first boot via cloud-init);
2. writes the generated launcher to `/etc/rpx/gateway.ts`;
3. installs + enables a `rpx-gateway.service` systemd unit that runs the
   gateway on `:80`/`:443`.

On every subsequent `buddy deploy`, after shipping the sites, ts-cloud
regenerates the route config and restarts the gateway — so new
server-app/server-static sites appear automatically. Leaving `proxy` unset
keeps the prior behavior (no gateway installed; you run your own).

## Preset Configuration

### Static Site Preset

```typescript
import { createStaticSitePreset } from 'ts-cloud/presets'

export default createStaticSitePreset({
  name: 'My Website',
  slug: 'my-website',
  domain: 'example.com',

  // Optional overrides
  cdn: {
    priceClass: 'PriceClass_100', // US & Europe only
  },
})
```

### Full-Stack Preset

```typescript
import { createFullStackAppPreset } from 'ts-cloud/presets'

export default createFullStackAppPreset({
  name: 'My App',
  slug: 'my-app',
  domain: 'app.example.com',
  apiSubdomain: 'api.example.com',

  // Compute configuration
  compute: {
    cpu: 512,
    memory: 1024,
    desiredCount: 2,
  },

  // Database configuration
  database: {
    engine: 'postgres',
    instanceClass: 'db.t3.medium',
    allocatedStorage: 20,
    multiAz: true,
  },

  // Cache configuration
  cache: {
    engine: 'redis',
    nodeType: 'cache.t3.micro',
    numNodes: 1,
  },
})
```

### API Backend Preset

```typescript
import { createApiBackendPreset } from 'ts-cloud/presets'

export default createApiBackendPreset({
  name: 'My API',
  slug: 'my-api',
  domain: 'api.example.com',

  // Lambda configuration
  lambda: {
    runtime: 'nodejs20.x',
    memorySize: 256,
    timeout: 30,
  },

  // DynamoDB configuration
  dynamodb: {
    billingMode: 'PAY_PER_REQUEST',
    tables: [
      { name: 'users', partitionKey: 'id' },
      { name: 'orders', partitionKey: 'userId', sortKey: 'createdAt' },
    ],
  },
})
```

## Environment Variables

ts-cloud reads credentials from environment variables:

| Variable | Description |
|----------|-------------|
| `AWS_ACCESS_KEY_ID` | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key |
| `AWS_DEFAULT_REGION` | Default region |
| `AWS_PROFILE` | Named profile from `~/.aws/credentials` |
| `AWS_SESSION_TOKEN` | Session token for temporary credentials |
| `TS_CLOUD_STATE_DIR` | Overrides `stateDir` ([above](#state-directory)) |

## TypeScript Configuration

For best type checking, add ts-cloud to your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "types": ["@stacksjs/ts-cloud"]
  }
}
```

## Next Steps

- [Getting Started](/guide/getting-started) - Create your first stack
- [Providers](/guide/providers) - AWS resource builders
- [Deployment](/guide/deployment) - Deploy your infrastructure
