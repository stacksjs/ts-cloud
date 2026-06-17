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
  to ECR (up to 10 GB) instead of a ZIP. The PHP runtime is baked into the image.
- **arm64** — set `architecture: 'arm64'` (build the layer with `--arch arm64`).
- **Managed data** — attach `cache: { driver: 'elasticache' }`,
  `database: { connection: 'aurora-serverless' }`, and `rdsProxy: true` (all
  require `vpc: { subnets: [...] }`); the deployer injects `DB_HOST`/`REDIS_HOST`
  into the functions. A `firewall` (WAF) can front the HTTP API, and `warm: N`
  keeps N containers warm via scheduled pings.

## Operations

| Command | What it does |
| --- | --- |
| `cloud deploy:serverless --env <env>` | Build, package, deploy, activate |
| `cloud deploy:serverless --redeploy` | Re-activate the last build (no rebuild) |
| `cloud serverless:rollback --env <env>` | Roll back to the previous build |
| `cloud command "<cmd>" --env <env>` | Run a command on the CLI function |
| `cloud down --env <env> --secret <s>` | Maintenance mode (503 + bypass header) |
| `cloud up --env <env>` | Exit maintenance mode |
| `cloud function:list` / `function:invoke` / `function:logs` | Inspect functions |
| `cloud secrets:set/get/list/delete` | Manage per-env secrets (Secrets Manager) |

## Configuration reference

Everything is declared under `environments.<env>.app` (the `vapor.yml`
equivalent). See `ServerlessAppConfig` for the full field set: `runtime`,
`memory`/`timeout`, `gatewayVersion`, `warm`, `queues`/`queueConcurrency`/
`queueTimeout`/`queueTries`, `scheduler`, `build`/`deploy` hooks, `octane`,
`vpc`, `rdsProxy`, `database`, `cache`, `storage`, `firewall`, `domain`,
`assets`, `env`, `secrets`, and (PHP) `phpVersion`/`architecture`/`layers`.
