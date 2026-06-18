# State Management

ts-cloud does not keep a Terraform-style state file. There is no `StateManager`, no
local `.tfstate`, and nothing to lock or back up by hand. State lives in two places,
both managed for you:

1. **AWS CloudFormation** is the source of truth for *infrastructure* (VPCs, S3
   buckets, Lambda functions, RDS clusters, …). AWS tracks every resource, its
   current properties, and its history.
2. **Release snapshots** track *which build is live* for a deployable app. The
   serverless deploy pipeline writes a small JSON record to S3; compute (EC2) sites
   keep atomic release directories on the box.

## CloudFormation as the source of truth

Every infrastructure deploy is a CloudFormation stack update. Because AWS owns the
state:

- **No state files to manage** — nothing to commit, lock, or sync between machines.
- **No state-lock contention** — CloudFormation serializes updates to a stack.
- **Built-in rollback** — a failed update reverts the stack to its last good state.
- **Real resource history** — every change is recorded in the stack's event log.

Inspect the live state of any stack with the `cloud stack:*` commands:

```bash
# List every CloudFormation stack in the account/region
cloud stack:list

# Full description of one stack (status, parameters, tags)
cloud stack:describe my-app-production

# Just the stack's exported outputs (URLs, ARNs, IDs)
cloud stack:outputs my-app-production

# Recent stack events — useful while a deploy is in flight or after a failure
cloud stack:events my-app-production --limit 50

# Dump the deployed template (json | yaml)
cloud stack:export my-app-production --format yaml --output template.yaml

# Tear a stack down
cloud stack:delete my-app-production
```

## Drift: compare config vs. what's deployed

To see what would change before you deploy, diff your local config against the
deployed stack:

```bash
cloud diff
```

This renders the difference between the template your `cloud.config.ts` generates and
the template CloudFormation currently has applied.

## Release snapshots (serverless apps)

When you run `cloud deploy:serverless`, the orchestrator records the release in the
deployments bucket so it can roll back later. The bucket is named
`{slug}-{environment}-deployments` and the record lives at:

```
releases/{slug}/{env}/current.json
```

The snapshot captures everything needed to restore the previous release without a
rebuild — the artifact SHA, the code source (S3 zip or ECR image), the resolved
per-function environment, and (when provisioned concurrency is enabled) the published
Lambda versions, along with the *prior* values of each so a rollback can flip back
cleanly:

```jsonc
// releases/my-app/production/current.json
{
  "sha": "a1b2c3d4…",
  "code": { /* S3 zip or ECR image reference */ },
  "previousSha": "9f8e7d6c…",
  "previousCode": { /* … */ },
  "functionEnv": { "http": { /* … */ }, "cli": { /* … */ } },
  "previousFunctionEnv": { /* … */ },
  "functionNames": { "http": "my-app-production-http", "cli": "my-app-production-cli" },
  "assetUrl": "https://…",
  "timestamp": "2026-06-18T12:00:00.000Z"
}
```

You don't read or write this file directly — the CLI does. Inspect the current
release and roll back through these commands:

```bash
# Operational summary, including the live release SHA + timestamp
cloud serverless:info --env production

# Re-activate the previous release from the snapshot (no rebuild)
cloud serverless:rollback --env production
```

## Release history (compute / EC2 sites)

PHP/Laravel and other server-app sites deploy to the box via git clone into atomic
release directories, with the live release symlinked into place. That gives each
compute site its own deployment history and instant rollback:

```bash
# Show a site's recent releases
cloud deploy:history my-site --env production --limit 20

# Roll back to the previous release (or a specific one with --to)
cloud deploy:rollback my-site --env production
cloud deploy:rollback my-site --env production --to <release-id>
```

## Config shape

ts-cloud reads a single `cloud.config.ts`. Its top-level shape is
`project` / `environments` / `infrastructure` / `sites` — there is no `stacks`,
`account`, or top-level `region` key:

```typescript
// cloud.config.ts
import type { CloudConfig } from '@stacksjs/ts-cloud'

export default {
  project: {
    name: 'My App',
    slug: 'my-app',
    region: 'us-east-1',
  },
  environments: {
    production: { region: 'us-east-1' },
    staging: { region: 'us-east-1' },
  },
  // infrastructure: { … }
  // sites: { … }
} satisfies CloudConfig
```

Stack names are derived from the project slug and environment — that's why the
`stack:*` commands above take a name like `my-app-production`.

## Next Steps

- [Multi-Region](/features/multi-region) - Deploy across regions
- [Environment Config](/features/environments) - Environment management
