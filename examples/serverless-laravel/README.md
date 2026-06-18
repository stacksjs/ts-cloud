# Serverless Laravel example

Deploy a real Laravel app to AWS Lambda with ts-cloud — the Laravel Vapor
workflow. This directory holds the **`cloud.config.ts`**; you bring a Laravel
app (ts-cloud doesn't ship one, since a real app is yours to own).

## 1. Create (or use) a Laravel app

```sh
composer create-project laravel/laravel my-app
cd my-app
cp /path/to/this/cloud.config.ts ./cloud.config.ts
```

The config expects the standard Laravel layout — `public/index.php` (the FPM
front controller the HTTP function serves) and `artisan` (the queue/scheduler/CLI
functions run `php artisan …`). A fresh `laravel/laravel` already has both.

## 2. Install the ts-cloud Laravel bridge

The `laravel/vapor-core` replacement — provides the SQS queue handler
(`tscloud:sqs-handle`), the signed-upload route (`POST /tscloud/signed-storage-url`),
and `tscloud:db-query` for `serverless:db-shell`:

```sh
composer require tscloud/serverless
```

## 3. Build the PHP runtime layer once (requires Docker)

```sh
cloud serverless:build-php-layer --php 8.3 --arch x86_64
# → prints a layer ARN
```

Put the ARN in `cloud.config.ts` (`layers: [...]`) or export
`TSCLOUD_PHP_LAYER_ARN`. (Skip this if you set `packaging: 'image'`, which bakes
the runtime into a container image instead.)

## 4. Deploy

```sh
cloud deploy:serverless --env production
```

Build hooks bake the artisan caches (`config:cache`, `route:cache`, …) into the
immutable artifact; the deploy hook runs `migrate --force` via the CLI function.
Laravel is auto-configured for the read-only Lambda filesystem
(`LOG_CHANNEL=stderr`, `QUEUE_CONNECTION=sqs`, `FILESYSTEM_DISK=s3`, caches under
`/tmp`). See [the serverless docs](../../docs/features/serverless.md) for custom
domains, managed data (Aurora/Redis/RDS-Proxy), EFS, warming, and operations
(`logs`, `metrics`, `command`, `serverless:info`, rollback, maintenance mode).
