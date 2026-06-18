# Serverless apps (a Laravel Vapor replacement)

ts-cloud can deploy a whole application to AWS Lambda from a single config — the
serverless counterpart to the [Forge-style server deploys](/features/laravel).
One codebase becomes **three Lambda functions sharing one artifact**:

- **HTTP** — fronted by API Gateway v2 (custom domain optional)
- **Queue** — an SQS worker (one job per invocation, with a dead-letter queue)
- **CLI** — an EventBridge schedule (`schedule:run` every minute) plus on-demand
  commands (migrations, artisan, deploy hooks)

It also wires a DynamoDB cache table, CDN-backed versioned assets (`ASSET_URL`),
build/deploy hooks, atomic activation, rollback/redeploy, maintenance mode, and
secret injection — the Vapor feature set, for both **Node/Bun** and
**PHP/Laravel** runtimes.

The auto-deployed [management dashboard](/features/laravel#management-dashboard-auto-deployed)
includes a Serverless view of your functions, queues, scheduler, data services,
deployments, and secrets — every card drills into a dedicated page:

![ts-cloud Serverless dashboard](/images/dashboard-serverless.png)

By default the dashboard renders representative sample data so the design is
self-contained. To bake in **live** values from your real deployment, build it
with `cloud dashboard:build --env <env>` — this reads the actual stack
(`serverlessInfo` + CloudWatch metrics + SQS depth + Lambda config) and injects
it into the pages at build time (no backend, no client JS). The action buttons
are shown as copyable CLI commands, since the dashboard is a read-only static
site.

Each section links to a focused detail page (`/serverless/functions`, `/queues`,
`/scheduler`, `/data`, `/metrics`, `/cost`, `/deployments`, `/firewall`,
`/assets`, `/secrets`) with deeper data — e.g. the Functions page shows per-function
invocation trends, p50/p95/p99 latency, max memory, recent activity, and the
injected environment:

![ts-cloud Serverless functions detail](/images/dashboard-serverless-functions.png)

## Node/Bun quick start

```ts
// cloud.config.ts
import { createServerlessNodePreset } from 'ts-cloud'

export default createServerlessNodePreset({
  name: 'My API',
  slug: 'my-api',
  entry: 'src/server.ts',
  domain: 'api.example.com',
  build: ['bun install', 'bun run build'],
  deploy: ['migrate'],
  assets: 'public',
})
```

Your `entry` exports the handlers the adapter bridges to each event source:

```ts
// src/server.ts
export default {
  fetch(req: Request) {
    return new Response('hello from lambda')
  },
  queue(payload: unknown) {
    // process one SQS job
  },
  cli({ command }: { command: string }) {
    // run scheduled / on-demand commands (e.g. 'schedule:run', 'migrate')
    return { statusCode: 0, output: `ran ${command}` }
  },
}
```

```sh
cloud deploy:serverless --env production
```

## PHP / Laravel quick start

A true Vapor clone: real Laravel runs on Lambda via a custom `provided.al2023`
PHP runtime layer (php-fpm + the FastCGI bridge for HTTP; php-cli for queue and
scheduler).

```sh
# Build + publish the ts-cloud PHP runtime layer once (requires Docker).
cloud serverless:build-php-layer --php 8.3 --arch x86_64
# → prints a layer ARN
```

```ts
// cloud.config.ts
import { createServerlessLaravelPreset } from 'ts-cloud'

export default createServerlessLaravelPreset({
  name: 'My App',
  slug: 'my-app',
  domain: 'my-app.com',
  layers: ['arn:aws:lambda:us-east-1:123:layer:tscloud-php-83-x86_64:1'],
})
```

```sh
cloud deploy:serverless --env production
```

Install the ts-cloud Laravel bridge (the `laravel/vapor-core` replacement):

```sh
composer require tscloud/serverless
```

Laravel is configured for the read-only Lambda filesystem automatically:
`LOG_CHANNEL=stderr`, `QUEUE_CONNECTION=sqs`, `FILESYSTEM_DISK=s3`,
`CACHE_STORE`/`SESSION_DRIVER` on DynamoDB (or Redis), and all framework caches
under `/tmp`. Build hooks bake the artisan caches (`config:cache`, `route:cache`,
`event:cache`, `view:cache`) into the immutable artifact; the deploy hook runs
`migrate --force` via the CLI function. Queue jobs are unwrapped by the
`tscloud/serverless` bridge command (`tscloud:sqs-handle`), so each job runs once
per invocation without double-delivery.

### Octane, large apps, and managed data

- **Octane** — set `octane: true` to boot Laravel once per container and serve
  in-process (no php-fpm). Lower latency; requires an Octane-safe app.
- **Large apps (> 250 MB)** — set `packaging: 'image'` to ship a container image
  to ECR (up to 10 GB) instead of a ZIP (see [Container-image packaging](#container-image-packaging)).
- **arm64** — set `architecture: 'arm64'` (build the layer with `--arch arm64`).
- **Managed data** — attach `cache: { driver: 'elasticache' }`,
  `database: { connection: 'aurora-serverless' }`, and `rdsProxy: true`. These all
  require a VPC — give `vpc: { id, subnets }` (the `id` is needed so the managed
  security group lands in your VPC). The deployer injects `REDIS_HOST` and the
  full `DB_*` set (`DB_HOST` → the RDS Proxy endpoint, `DB_USERNAME`/`DB_PASSWORD`
  resolved from the auto-created Secrets Manager secret, `DB_DATABASE=app`). A
  `firewall` (WAF) provisions a Web ACL with your rules, and `warm: N` keeps N
  containers warm.

> **WAF note:** AWS WAF can't be associated directly with an API Gateway **HTTP
> API (v2)** stage (only REST APIs, ALBs, AppSync, etc.). `firewall` therefore
> creates the Web ACL (rules + CloudWatch metrics, surfaced as the `WafAclArn`
> output) but doesn't auto-attach it; to enforce it, front the API with a
> CloudFront distribution and attach the ACL there.

> **All of the above is verified end-to-end against real AWS** — Node + PHP HTTP,
> SQS queue workers, the EventBridge scheduler, on-demand CLI/artisan, maintenance
> mode, rollback/redeploy, container-image packaging, and the full data stack
> (Aurora Serverless v2 + RDS Proxy + ElastiCache + EFS) with live `db-shell`
> queries.

## Container-image packaging

For apps that exceed the 250 MB zip/layer limit, ship a container image to ECR
instead (Lambda runs images up to 10 GB):

```ts
app: { kind: 'node', entry: 'src/server.ts', packaging: 'image' }
// PHP: a multi-stage image bakes the runtime in — no separate layer needed
app: { kind: 'php', packaging: 'image' }
```

`cloud deploy:serverless` builds the image (`docker`), creates/uses an ECR repo
`{slug}-{env}`, authenticates without touching your local credential store, and
deploys the functions as `PackageType: Image`. Requires Docker; Node uses the AWS
Lambda Node base image, PHP a self-contained multi-stage build.

## Warming (cold starts)

Two strategies, pick by cost vs. guarantee:

- **`warm: N`** — cheap. A scheduled EventBridge rule pings N container(s) every
  few minutes (the runtime short-circuits the ping). Reduces cold starts; you
  only pay for the pings. `warmFunctions: ['http','queue','cli']` chooses which
  functions to ping (default `['http']`).
- **`provisionedConcurrency: N`** — zero cold starts. Opts into the **alias model**:
  each function gets a `live` alias that all traffic (HTTP/queue/scheduler) routes
  through, and every deploy publishes a new version and atomically flips the alias
  to it. AWS keeps N environments always-warm. You pay for the reserved capacity.

```ts
app: { kind: 'node', entry: 'src/server.ts', provisionedConcurrency: 2 }
```

> With `provisionedConcurrency`, deploys are blue/green: the new version is
> published and the alias flips only after the code is live, and `serverless:rollback`
> instantly flips the alias back to the previous version. (A raw out-of-band
> CloudFormation stack update resets the alias to its bootstrap version — re-run
> `deploy:serverless`/`--redeploy` to restore.) Verified end-to-end on real AWS:
> alias → published version, API Gateway routing through the alias, and
> provisioned concurrency reaching `READY`.

## Runtimes

All three runtimes follow one model. Common Node versions use the AWS **managed**
runtime (zero config); everything else — Bun, and Node versions AWS doesn't offer
a managed runtime for (e.g. 24) — runs on a **custom `provided.al2023` layer** that
ts-cloud builds (a binary + `bootstrap` + a shared Runtime API loop), exactly like
the PHP/Laravel runtime.

| Config | Lambda runtime | Layer |
| --- | --- | --- |
| `kind: 'node'` (18/20/22) | `nodejs{N}.x` (managed) | none |
| `kind: 'node', runtimeVersion: '24'` | `provided.al2023` | `serverless:build-node-layer` |
| `kind: 'bun'` | `provided.al2023` | `serverless:build-bun-layer` |
| `kind: 'php'` | `provided.al2023` | `serverless:build-php-layer` |

Custom-runtime layers are built once and referenced by ARN (via `app.layers` or
`TSCLOUD_{NODE,BUN,PHP}_LAYER_ARN`). The Node and Bun layers need no Docker — the
official binary is downloaded and zipped:

```sh
cloud serverless:build-node-layer --node 24 --arch arm64   # → prints a layer ARN
cloud serverless:build-bun-layer  --bun 1.3.13
```

```ts
// run the latest Node on Lambda
app: { kind: 'node', runtimeVersion: '24', entry: 'src/server.ts' }
// or run Bun (use Bun.* APIs)
app: { kind: 'bun', entry: 'src/server.ts' }
```

> ts-cloud's Bun layer pairs the official Bun binary with a unified Runtime API
> loop that handles all three function modes (http/queue/cli). If you only need
> HTTP and prefer Oven's [official `bun-lambda` layer](https://github.com/oven-sh/bun/blob/main/packages/bun-lambda/README.md),
> publish it yourself and point `app.layers` at its ARN — the http function works
> with a `fetch` handler, though the queue/scheduler functions expect ts-cloud's
> loop.

## Operations

| Command | What it does |
| --- | --- |
| `cloud deploy:serverless --env <env>` | Build, package, deploy, activate |
| `cloud serverless:info --env <env>` | Operational summary (URL, versions, provisioned concurrency, queues, scheduler) |
| `cloud deploy:serverless --redeploy` | Re-activate the last build (no rebuild) |
| `cloud serverless:rollback --env <env>` | Roll back to the previous build |
| `cloud command "<cmd>" --env <env>` | Run a command on the CLI function (recorded to history) |
| `cloud command:history --env <env>` / `command:again [id]` | List past commands / re-run one |
| `cloud down --env <env> --secret <s>` | Maintenance mode (503 + bypass header) |
| `cloud up --env <env>` | Exit maintenance mode |
| `cloud function:list` / `function:invoke` / `function:logs` | Inspect functions |
| `cloud secrets:set/get/list/delete` | Manage per-env secrets (Secrets Manager) |
| `cloud logs --env <env> [--function http\|queue\|cli\|all] [--tail]` | Tail CloudWatch logs across the function trio |
| `cloud metrics --env <env> [--since 1h]` | Invocations / errors / error-rate / throttles / duration per function |
| `cloud metrics:dashboard --env <env>` | Print the CloudWatch console URL for this app |
| `cloud alarms` / `alarms:create` | List / create CloudWatch alarms on Lambda metrics |
| `cloud env:pull --env <env> [--function http]` | Download a function's env to `.env.<env>` |
| `cloud env:push --env <env> [--replace]` | Upload `.env.<env>` to the functions (merges over live env by default) |
| `cloud env:list` / `env:compare <a> <b>` | List configured environments / diff two environments' config |
| `cloud serverless:db-scale <min> <max> --env <env>` | Rescale the Aurora Serverless v2 cluster (ACUs) |
| `cloud serverless:db-restore --env <env> --to <ISO>\|--latest` | Point-in-time restore the Aurora cluster (as a new cluster) |
| `cloud serverless:db-shell "<sql>" --env <env>` | Run SQL against the private Aurora DB via the CLI function |

## Configuration reference

Everything is declared under `environments.<env>.app` (the `vapor.yml`
equivalent). See `ServerlessAppConfig` for the full field set: `runtime`,
`memory`/`timeout`, `warm`/`warmFunctions`/`provisionedConcurrency`, `logRetention`, `queues`/`queueConcurrency`/
`queueTimeout`/`queueTries`, `scheduler` (`on`/`off`/`sub-minute`),
`build`/`deploy` hooks, `octane`, `vpc`, `rdsProxy`, `database`, `cache`,
`storage`, `firewall`, `domain`, `assets`, `env`, `secrets`, the per-function
`tmpStorage`/`cliTmpStorage`/`queueTmpStorage`, and (PHP)
`phpVersion`/`architecture`/`layers`. Only API Gateway **HTTP API (v2)** is
supported (`gatewayVersion: 1` throws).

### Queues

`queues: true` provisions one default SQS queue (+ a shared DLQ). Pass an array
to declare several, with optional **per-queue concurrency** — a per-queue value
overrides the global `queueConcurrency`:

```ts
app: { queues: ['default', { emails: 10 }, { invoices: 2 }], queueConcurrency: 5 }
```

Each queue's visibility timeout is set to 6× the function timeout (AWS's
recommendation, capped at SQS's 12-hour max) so a long job is never re-delivered
to a second worker mid-run.

### Custom domains

Set `domain` (a string or array) plus either `certificateArn` (a pre-issued
regional ACM cert) or `hostedZoneId` (ts-cloud then issues + DNS-validates the
cert and creates the Route53 alias automatically):

```ts
app: { kind: 'php', domain: 'app.acme.com', hostedZoneId: 'Z0123…' }
// or, non-Route53 DNS: point a CNAME at the emitted CustomDomainTarget output
app: { kind: 'node', entry: 'src/server.ts', domain: 'app.acme.com', certificateArn: 'arn:aws:acm:…' }
```

### Direct browser uploads (`Vapor.store`)

The `tscloud/serverless` package registers `POST /tscloud/signed-storage-url`,
which returns a pre-signed S3 PUT (the `Vapor.store()` flow) — the browser
uploads straight to S3, then hands the `key` back to your app. Guard it by
defining an `uploadFiles` gate/policy.

### Sub-minute scheduler

`scheduler: 'sub-minute'` keeps the 1-minute EventBridge trigger but loops
`schedule:run` within each invocation so tasks scheduled more often than once a
minute fire (Laravel/PHP).

### Shared filesystem (EFS)

Mount a shared Elastic File System on all functions (Vapor's `/mnt/local`). Set
`efs: true` to provision an EFS file system + access point, or attach an existing
one by ARN. Requires a VPC:

```ts
app: { kind: 'php', vpc: { id: 'vpc-…', subnets: ['subnet-a', 'subnet-b'] }, efs: true }
// or: efs: { accessPointArn: 'arn:aws:elasticfilesystem:…', mountPath: '/mnt/local' }
```

### Custom asset CDN host

Serve assets from your own host (Vapor `asset-domain`) instead of the default
CloudFront domain. CloudFront only accepts a **us-east-1** ACM cert — give a
`hostedZoneId` and ts-cloud auto-issues + DNS-validates one for you (when the app
is in us-east-1), or supply a pre-issued `assetCertificateArn`:

```ts
// auto-issued cert (us-east-1 app + hosted zone) — Vapor-style, zero cert setup
app: { assets: 'public', assetDomain: 'cdn.acme.com', hostedZoneId: 'Z…' }
// or bring your own us-east-1 cert (required if the app isn't in us-east-1)
app: { assets: 'public', assetDomain: 'cdn.acme.com', assetCertificateArn: 'arn:aws:acm:us-east-1:…', hostedZoneId: 'Z…' }
```

> Verified end-to-end against real AWS: the auto-issued cert validates, CloudFront
> fronts the versioned assets bucket, the Route53 alias resolves, and assets serve
> over `https://<assetDomain>/…` (with `ASSET_URL` injected into the app).

Other asset knobs: `dotFilesAsAssets` (upload dotfiles — excluded by default),
`serveAssets` and `redirectRobotsTxt` (injected as env for the app to honor).

### Database access (private Aurora)

With `database: { connection: 'aurora-serverless' }` + `rdsProxy: true`, ts-cloud
provisions an Aurora Serverless v2 cluster (initial database `app`), an RDS Proxy
with its target group, and a generated credentials secret — and injects the full
`DB_*` env into your functions, so the app connects through the proxy out of the box.

Run ad-hoc SQL against the (private) database through the in-VPC CLI function —
no bastion required (needs the `tscloud/serverless` PHP bridge's `tscloud:db-query`):

```sh
cloud serverless:db-shell "select count(*) from users" --env production
```
