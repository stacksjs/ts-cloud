# CLI reference

ts-cloud ships one binary — `cloud`. Every command accepts `--help` for its full
option set (`cloud <command> --help`), and most accept `--env <environment>`.
This page groups the surface by area; the deep dives live in the feature pages.

## Project

| Command | Description |
|---|---|
| `cloud init [--name <n>]` | Scaffold a `cloud.config.ts` (interactive). |
| `cloud init:serverless` / `init:server` / `init:hybrid` | Scaffold a serverless, server, or hybrid project. |
| `cloud config` | Show the resolved configuration. |
| `cloud config:validate` | Validate `cloud.config.ts`. |
| `cloud config:env` / `config:secrets` | Inspect resolved env vars / secret bindings. |
| `cloud generate` / `generate:preview` | Generate CloudFormation templates. |
| `cloud diff` | Diff config against deployed infrastructure. |
| `cloud doctor` | Check the local toolchain + AWS access. |

## Deploy

| Command | Description |
|---|---|
| `cloud deploy --env <env>` | Deploy the environment (server or serverless, auto-detected) + secret scan. |
| `cloud deploy --env <env> --site <name>` | Deploy a single configured site. |
| `cloud deploy:serverless --env <env> [--redeploy]` | Deploy the Lambda app (http/queue/cli). |
| `cloud deploy:server --env <env>` | Provision + deploy the EC2/Forge-style box. |
| `cloud deploy:static --source <dir> --bucket <b>` | Deploy a static site to S3 + CloudFront. |
| `cloud deploy:container` | Build + deploy a container to ECS. |
| `cloud deploy:rollback --env <env>` | Roll back the last deploy. |
| `cloud deploy:history` / `deploy:status` | Deployment history / current status. |
| `cloud deploy:security-scan [--source <dir>] [--fail-on <sev>]` | Secret scan only. |
| `cloud diff` · `cloud destroy` · `cloud stack:delete <name>` | Preview · tear down a single server · delete a CFN stack. |

## Serverless operations (Vapor-style)

| Command | Description |
|---|---|
| `cloud serverless:info --env <env>` | Operational summary (URL, versions, PC, queues, scheduler). |
| `cloud serverless:rollback --env <env>` | Flip back to the previous build. |
| `cloud command "<cmd>" --env <env>` | Run a command on the CLI function (recorded). |
| `cloud command:history` / `command:again [id]` | List / re-run past commands. |
| `cloud down --env <env> [--secret <s>]` / `up --env <env>` | Maintenance mode on/off. |
| `cloud logs --env <env> [--function http\|queue\|cli\|all] [--tail]` | Tail CloudWatch logs. |
| `cloud metrics --env <env> [--since 1h]` / `metrics:dashboard` | Function metrics / console URL. |
| `cloud alarms` / `alarms:create` | List / create CloudWatch alarms. |
| `cloud env:pull` / `env:push` / `env:list` / `env:compare` | Function env file pull/push; list/diff environments. |
| `cloud secrets:set/get/list/delete` | Per-env secrets (Secrets Manager). |
| `cloud serverless:db-shell "<sql>"` / `db-scale <min> <max>` / `db-restore` | Aurora SQL / rescale / point-in-time restore. |
| `cloud serverless:build-php-layer` / `build-node-layer` / `build-bun-layer` | Build runtime layers. |
| `cloud function:list` / `function:invoke` / `function:logs` | Raw Lambda inspection. |
| `cloud dashboard:build [--env]` | Build the management dashboard with live data. |

See [Serverless](/features/serverless) for the full `app` config.

## Server management (Forge-style)

| Command | Description |
|---|---|
| `cloud server:list` / `server:create <name>` / `server:destroy <name>` | Manage servers. |
| `cloud server:ssh <name>` / `server:logs <name>` / `server:monitoring <name>` | Connect / logs / metrics. |
| `cloud server:deploy <name>` / `server:reboot` / `server:resize <name> <type>` | Deploy / reboot / resize. |
| `cloud server:recipe <name> <recipe>` | Run a reusable script across servers. |
| `cloud server:worker:add/list/restart/remove` | Queue workers (Supervisor). |
| `cloud server:cron:add/list/remove` | Scheduled jobs / cron. |
| `cloud server:firewall:add/list/remove` | UFW rules. |
| `cloud server:ssl:install <domain>` / `server:ssl:renew` | Certificates. |
| `cloud server:snapshot <name>` / `server:snapshot:restore` | Snapshots / restore. |
| `cloud server:update <name>` / `server:secure <name>` | OS updates / hardening. |

See [Laravel / Forge-style](/features/laravel) for the `infrastructure.compute` + `sites` config.

## Databases

`cloud db:create` · `db:list` · `db:connect` · `db:tunnel` · `db:users:add` · `db:users:list` ·
`db:backup` · `db:restore` · `db:snapshot[:list|:restore]` · `db:seed` · `db:slow-queries` ·
`db:migrations:run` · `db:migrations:rollback` · `db:migrations:status`.

## Queues, scheduler & events

`cloud queue:create/list/send/receive/purge/stats/delete` · `scheduler:create/list/enable/disable/describe/groups/delete` ·
`events:create/list/enable/disable/target/buses/describe/delete`.

## Domains, DNS & SSL

`cloud domain:add/list/verify/ssl` · `dns:add/delete/records` · `ssl:list/renew`.

## Networking, storage, CDN & cache

`cloud network:create-vpc/create-subnet/create-sg/sg-rule/list/...` · `storage:create/list/ls/sync/policy/delete` ·
`cdn:create/invalidate/status/disable/list/delete` · `cache:create/list/stats/flush/reboot/delete` ·
`assets:deploy/invalidate`.

## Backups

`cloud backup:create-vault/create/schedule/list/start/jobs/recovery-points/restore/restore-jobs/add-selection/vaults`.

## Email, IAM & audit

`cloud email:verify/identities/send/templates/template:create/stats/delete` ·
`iam:whoami/users/user/roles/role/groups/policies/policy/simulate` ·
`audit:start/stop/trail/trails/events/event/create/delete`.

## Cost, status & tunnel

`cloud cost` · `cost:analyze` · `cost:breakdown` · `optimize` · `resources` · `resources:unused` ·
`status` · `status:alarms` · `status:costs` ·
`tunnel` · `tunnel:server/deploy/status/info/logs/test/destroy`.

> This is the surface map, not every flag. Run `cloud <command> --help` for the
> authoritative options of any command.
