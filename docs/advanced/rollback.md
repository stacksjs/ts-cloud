# Rollback Strategies

ts-cloud makes failed deploys recoverable at three levels: CloudFormation's own
automatic rollback, the CLI rollback commands for app deploys, and the
blue-green / canary managers for traffic-level safety.

## Automatic rollback (CloudFormation)

Infrastructure deploys go through CloudFormation, which **automatically rolls a
failed `CREATE`/`UPDATE` back** to the last good state — no configuration needed.
The serverless deploy orchestrator also detects a stack left in a stale
`ROLLBACK_COMPLETE`/`CREATE_FAILED` state from a prior failed create and
deletes + recreates it so the next `cloud deploy:serverless` succeeds.

```sh
cloud deploy --env production       # a failed stack op auto-reverts
cloud diff                          # preview changes before deploying
```

## App rollback (CLI)

Once an app is live, roll the **code** back without touching infrastructure:

```sh
# Serverless (Lambda): re-activate the previous build — flips the `live` alias
# (provisioned-concurrency model) or restores the prior code + env. Never deletes
# the stack.
cloud serverless:rollback --env production

# Server (EC2/Forge-style): atomically flip a site's `current` symlink back to
# the previous release, then restart php-fpm + queue workers.
cloud deploy:rollback main
cloud deploy:rollback main --to 20240601120000   # a specific release id
```

Both are atomic and fast — serverless flips an alias/version; compute flips a
symlink. The serverless deployer also snapshots each release
(`releases/{slug}/{env}/current.json` in the artifact bucket) so a rollback
restores the prior code **and** environment, not just the binary.

## Programmatic stack control

For custom tooling, drive CloudFormation directly with `CloudFormationClient`
(real methods: `createStack`, `updateStack`, `deleteStack`, `waitForStack`,
`getStackOutputs`, `getTemplate`):

```typescript
import { CloudFormationClient } from '@stacksjs/ts-cloud'

const cf = new CloudFormationClient('us-east-1')

// Re-apply the currently deployed template (e.g. after an out-of-band change).
const { TemplateBody } = await cf.getTemplate('my-app-production')
await cf.updateStack({ stackName: 'my-app-production', templateBody: TemplateBody })
await cf.waitForStack('my-app-production', 'stack-update-complete')
```

## Traffic-level rollback (blue-green & canary)

For zero-downtime cutovers with instant rollback, ts-cloud ships
`BlueGreenManager` (ALB target-group swap) and `CanaryManager` (weighted Lambda
shifting with automatic rollback on error-rate/latency thresholds). Both expose
`executeDeployment(id)` and `rollback(id)`. See
[Deployment](/guide/deployment#blue-green) for the real APIs and
end-to-end examples.
