# tscloud/serverless

The ts-cloud serverless runtime bridge for running **Laravel on AWS Lambda** — a
drop-in replacement for `laravel/vapor-core` when deploying with
[ts-cloud](https://github.com/stacksjs/ts-cloud)'s serverless Laravel pipeline
(`cloud deploy:serverless`, `kind: 'php'`).

## What it does

ts-cloud's PHP Lambda runtime runs three functions from one codebase:

- **HTTP** — php-fpm behind API Gateway v2 (or Octane mode)
- **Queue** — one SQS message per invocation
- **CLI** — the scheduler (`schedule:run`) and on-demand artisan commands

This package provides the queue bridge: the `tscloud:sqs-handle` artisan command
that the Lambda queue runtime invokes once per delivered SQS message. The job is
fired in-process — no `queue:work` polling — so it never double-delivers against
Lambda's own SQS poller. A failed job exits non-zero, which the runtime reports
as a batch-item failure so Lambda retries (and eventually DLQs) the message.

Everything else Laravel needs serverless (S3 filesystem, SQS queue connection,
DynamoDB/Redis cache + sessions, `ASSET_URL`, `/tmp` paths, `stderr` logging) is
configured via environment variables injected by the ts-cloud deployer, so this
package stays intentionally small.

## Install

```sh
composer require tscloud/serverless
```

The service provider is auto-discovered. No further configuration is required;
the ts-cloud deployer sets `QUEUE_CONNECTION=sqs` and the rest of the env.

## Also provided

- **`tscloud:db-query`** — runs a SQL statement and prints JSON; backs
  `cloud serverless:db-shell` for ad-hoc access to a private serverless database
  from inside the VPC (no bastion).
- **`POST /tscloud/signed-storage-url`** — issues a pre-signed S3 upload URL (the
  `Vapor.store()` flow) for direct browser → S3 uploads. Guard it with an
  `uploadFiles` gate/policy.

## Override the queue command

The runtime calls `tscloud:sqs-handle` by default. To use your own command, set
`TSCLOUD_QUEUE_COMMAND` in your environment to the artisan command name; it will
receive the raw message body in `TSCLOUD_SQS_RECORD`.
