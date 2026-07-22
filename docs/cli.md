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

## Application onboarding

| Command | Description |
|---|---|
| `cloud app:detect [root]` | Detect frameworks and build strategies without executing project code. |
| `cloud app:plan <draft> [--secrets <names>]` | Validate and normalize a secret-free application draft. |
| `cloud app:draft:save <draft>` / `app:drafts` | Save, resume, and list versioned wizard drafts. |
| `cloud app:import <site> [--connection <id>]` | Convert an existing configured site into an application draft. |
| `cloud app:export <draft>` | Export a deterministic `ts-cloud.dev/v1` manifest. |
| `cloud app:deploy <draft> --confirm <environment>` | Confirm the exact target and queue the application operation. |
| `cloud app:artifact:add <file>` | Inspect and store a bounded ZIP or TAR source artifact. |
| `cloud app:registry:add/test/rotate/disconnect` | Manage encrypted, write-only private-registry credentials. |

See [Application onboarding](/features/application-onboarding) for draft JSON, build strategy, registry, and API examples.

## Compose applications and templates

| Command | Description |
|---|---|
| `cloud compose:preview <file>` / `compose:import <file>` | Diagnose without mutation, then persist a normalized multi-service manifest. |
| `cloud compose:list` / `compose:export <id>` / `compose:diff <id> <file>` | Inspect applications, round-trip an editable file, or review field changes. |
| `cloud compose:deploy\|redeploy\|start\|stop <id>` | Queue a durable stack lifecycle operation. |
| `cloud compose:scale <id> <service> <replicas>` | Scale one service within provider and policy limits. |
| `cloud compose:logs <id> <service>` / `compose:shell <id> <service> [command...]` | Read service logs or run an authorized command. |
| `cloud compose:delete <id> [--remove-volumes] --confirm <text>` | Preserve named volumes by default; require a stronger confirmation to delete data. |
| `cloud compose:templates` / `compose:template <id>` / `compose:catalog <file>` | Use pinned built-ins or validate a checksum-pinned local/custom catalog. |

See [Compose applications and templates](/features/compose-applications) for supported fields, diagnostics, topology UX, catalogs, and safety boundaries.

## Durable operations

| Command | Description |
|---|---|
| `cloud ops:list [--state <state>] [--all-projects]` | List authorized durable jobs, attempts, checkpoints, blocking reasons, and timing. |
| `cloud ops:show <id> [--after <cursor>]` | Inspect one job and ordered sanitized logs after a sequence cursor. |
| `cloud ops:cancel <id> [--yes]` | Cancel queued work or request cooperative cancellation of running work. |
| `cloud ops:retry <id> --class <error> [--delay <ms>]` | Retry a terminal job only within its allow-list and attempt limit. |
| `cloud ops:concurrency` | Show persisted project, environment, provider, and build limits. |
| `cloud ops:concurrency:set ... --confirm "update queue limits"` | Audit and update concurrency limits. |
| `cloud ops:history:clear [--before <date>] [--yes]` | Clear only terminal history whose retention deadline has elapsed. |

See [Durable deployment queue](/features/deployment-queue) for worker recovery, locking, cancellation, SSE cursor resume, and retention behavior.

## Preview environments

| Command | Description |
|---|---|
| `cloud env:preview <branch> --sha <commit> [--pr <n>]` | Create or update an isolated preview at an exact immutable commit. |
| `cloud env:preview <branch> --get-url\|--extend <hours>\|--rebuild` | Inspect or operate on the persistent preview identity. |
| `cloud env:preview <branch> --destroy` | Confirm and queue teardown of only tagged preview resources. |
| `cloud env:previews [--site <name>]` | List status, source, URL, expiry, and cost. |
| `cloud env:cleanup --dry-run [--max-age <hours>] [--keep <n>]` | Preview TTL/retention cleanup candidates. Omit `--dry-run` to queue teardown. |

See [Preview environments](/features/preview-environments) for policy, source lifecycle, fork safety, API, and cleanup behavior.

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
