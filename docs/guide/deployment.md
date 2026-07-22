# Deployment

Deploy your infrastructure to AWS using the `cloud` CLI.

## The Deploy Command

`cloud deploy` is the primary way to ship. It loads `cloud.config.ts`, runs a security scan, and then deploys based on what your config declares — there is no separate "stack" to name. The deploy model is driven by your `project` / `environments` / `infrastructure` / `sites` config (see [Configuration](/config)).

```bash
# Deploy the default (staging) environment
cloud deploy

# Deploy a specific environment
cloud deploy --env production

# Deploy only one site
cloud deploy --env production --site marketing

# Non-interactive (CI) — skip the confirmation prompt
cloud deploy --env production --yes
```

`cloud deploy` auto-detects what to do from your config:

- **Sites + DNS configured** → deploys each site (S3 + CloudFront) via the configured DNS provider.
- **`infrastructure.compute` with `mode: 'server'` (or a Hetzner provider)** → provisions a single server (Forge-style) and deploys your sites onto it as systemd services. No CloudFormation.
- **Other `infrastructure` resources** → generates a CloudFormation template, validates it, and creates/updates the environment stack (named `{slug}-{environment}` unless overridden by `project.stackName`).

If a generated stack ends up with no resources (e.g. a site-only project), the stack step is skipped — sites were already deployed.

### Environment-Scoped `.env`

Before loading config, `cloud deploy --env <env>` loads the matching environment file (e.g. `.env.production`), so each environment deploys with its own variables.

## Pre-Deployment Security Scanning

ts-cloud scans your code for leaked secrets before every deployment. This prevents accidental exposure of API keys, credentials, and other sensitive data.

### Automatic Scanning

Security scans run automatically with all deploy commands:

```bash
# Scans project root before infrastructure deployment
cloud deploy --env production

# Scans source directory before S3 upload
cloud deploy:static --source ./dist --bucket my-bucket

# Scans build context before Docker build
cloud deploy:container --cluster my-cluster --service my-service
```

### Standalone Security Scan

Run a security scan without deploying:

```bash
# Scan current directory
cloud deploy:security-scan

# Scan a specific directory
cloud deploy:security-scan --source ./dist

# Set severity threshold (critical | high | medium | low)
cloud deploy:security-scan --fail-on high
```

### Scan Output

```
→ Running pre-deployment security scan...
ℹ Scanned 127 files in 245ms
ℹ   Critical: 0
ℹ   High: 0
ℹ   Medium: 0
ℹ   Low: 0
✓ Security scan passed
```

### Bypassing Security Scans

For development or testing (not recommended for production):

```bash
# Skip the scan entirely
cloud deploy --skip-security-scan

# Raise the threshold so only higher-severity findings block the deploy
cloud deploy --security-fail-on high
```

See the [Security Guide](/features/security) for detected patterns and best practices.

## AWS Credentials

ts-cloud resolves AWS credentials automatically (environment variables, then the shared credentials file, then instance/task metadata). Before any AWS call, `cloud deploy` prints the resolved IAM identity so you can confirm which account you are deploying to.

### Environment Variables

```bash
export AWS_ACCESS_KEY_ID=your-access-key
export AWS_SECRET_ACCESS_KEY=your-secret-key
export AWS_REGION=us-east-1
```

### Credentials File and Profiles

```ini
# ~/.aws/credentials
[default]
aws_access_key_id = your-access-key
aws_secret_access_key = your-secret-key

[production]
aws_access_key_id = prod-access-key
aws_secret_access_key = prod-secret-key
```

Select a profile with the standard `AWS_PROFILE` environment variable:

```bash
AWS_PROFILE=production cloud deploy --env production
```

The deploy region comes from `project.region` in `cloud.config.ts` (falling back to `us-east-1`).

## Other Deploy Commands

### Serverless Applications

For a serverless app environment (one defining `app` in its `EnvironmentConfig`), deploy the http/queue/cli Lambda functions, assets, and hooks:

```bash
# Deploy the serverless app (build + upload + atomic activation)
cloud deploy:serverless --env production

# Re-activate the last build without rebuilding
cloud deploy:serverless --env production --redeploy

# Skip local build hooks or remote deploy hooks (e.g. migrations)
cloud deploy:serverless --env production --skip-build --skip-hooks
```

### Server (EC2) Applications

```bash
# Deploy configured sites onto the EC2 compute box (Forge-style, via SSM)
cloud deploy:server --env production
```

### Static Sites

```bash
cloud deploy:static \
  --source ./dist \
  --bucket my-bucket \
  --distribution E1234567890ABC \
  --cache-control "public, max-age=31536000"
```

### Containers

```bash
cloud deploy:container \
  --cluster my-cluster \
  --service my-service \
  --repository my-repo \
  --image latest
```

## Rollback

### Compute Sites

Roll a deployed compute (server) site back to a previous release:

```bash
# Roll back to the previous release
cloud deploy:rollback --env production

# Roll back a specific site to a specific release id
cloud deploy:rollback my-app --env production --to 2026-06-16-abc1234

# Inspect release history first
cloud deploy:history my-app --env production
```

### Serverless Apps

```bash
# Roll a serverless app back to its previous build
cloud serverless:rollback --env production
```

## Stack Operations

CloudFormation stacks (created by `cloud deploy` for non-server infrastructure) can be inspected and removed directly:

```bash
# Show what would change before deploying
cloud diff --env production

# List, describe, and read outputs from deployed stacks
cloud stack:list
cloud stack:describe my-app-production
cloud stack:outputs my-app-production

# Delete a stack and all its resources (prompts for confirmation)
cloud stack:delete my-app-production
```

To tear down a single-server (non-CloudFormation) compute box and its firewall:

```bash
cloud destroy --env production --force
```

## Programmatic Deployment

The CLI is the recommended path, but the same primitives are available from `@ts-cloud/core` / `ts-cloud` if you need to drive deployments yourself. `CloudFormationClient` wraps the CloudFormation API directly (no AWS SDK).

```typescript
import { CloudFormationClient } from '@stacksjs/ts-cloud'

const cfn = new CloudFormationClient('us-east-1')

await cfn.createStack({
  stackName: 'my-app-production',
  templateBody, // JSON string of a CloudFormation template
  capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
  tags: [
    { Key: 'Project', Value: 'my-app' },
    { Key: 'Environment', Value: 'production' },
  ],
})

// Block until the stack reaches its terminal state
await cfn.waitForStack('my-app-production', 'stack-create-complete')

// Read outputs as a flat key/value map
const outputs = await cfn.getStackOutputs('my-app-production')
console.log(outputs)
```

Use `updateStack` for an existing stack and `deleteStack(stackName)` to remove one. To build a template in code, use the [`TemplateBuilder`](/api/builders) or `CloudFormationBuilder`.

## Advanced Deployment Strategies

ts-cloud ships standalone managers for blue/green and canary rollouts. They model the deployment (traffic weights, health/metric thresholds) and can emit the CloudFormation snippets that perform the cut-over. They are lower-level building blocks — `cloud deploy` does not invoke them automatically.

### Blue-Green

`BlueGreenManager` tracks two environments and switches the active one once health checks pass.

```typescript
import { BlueGreenManager } from '@stacksjs/ts-cloud'

const manager = new BlueGreenManager()

// Build an ALB-based blue/green deployment
const deployment = manager.createALBDeployment({
  name: 'my-app',
  listenerArn: 'arn:aws:elasticloadbalancing:...:listener/...',
  blueTargetGroupArn: 'arn:aws:elasticloadbalancing:...:targetgroup/blue',
  greenTargetGroupArn: 'arn:aws:elasticloadbalancing:...:targetgroup/green',
  autoPromote: true,
  healthCheckConfig: {
    healthyThreshold: 3,
    unhealthyThreshold: 2,
    interval: 30,
    timeout: 5,
    path: '/health',
  },
})

// Deploy to the inactive environment, run health checks, then switch traffic
const result = await manager.executeDeployment(deployment.id)
if (!result.success)
  await manager.rollback(deployment.id)

// Emit the CloudFormation listener rule for the active environment
const listenerRule = manager.generateALBListenerCF(deployment)
```

`BlueGreenManager` also provides `createRoute53Deployment(...)` and `createECSDeployment(...)`, plus `getDeployment(id)`, `listDeployments()`, and `getDeploymentHistory(id)`.

### Canary

`CanaryManager` rolls a new version out in stages, shifting traffic and checking metric thresholds at each step before promoting.

```typescript
import { CanaryManager } from '@stacksjs/ts-cloud'

const manager = new CanaryManager()

// Lambda canary using a built-in strategy (CONSERVATIVE | BALANCED | AGGRESSIVE | LINEAR_10)
const deployment = manager.createLambdaCanaryDeployment({
  name: 'my-app',
  baselineVersionArn: 'arn:aws:lambda:...:function:my-app:1',
  canaryVersionArn: 'arn:aws:lambda:...:function:my-app:2',
  strategy: 'CONSERVATIVE',
  errorRateThreshold: 1, // percent — exceeding this rolls back
  latencyThreshold: 1000, // ms (P99)
})

const result = await manager.executeDeployment(deployment.id)
if (result.rolledBack)
  console.error('Canary rolled back:', result.reason)
```

Stages are `{ name, trafficPercentage, durationMinutes, alarmThresholds }`. You can also define them by hand via `createDeployment(...)`, build an ECS canary with `createECSCanaryDeployment(...)`, and emit CloudFormation with `generateLambdaAliasCF(...)` / `generateALBListenerRuleCF(...)`.

### Multi-Region

`MultiRegionManager` deploys a `CloudConfig` across several regions and tracks per-region status.

```typescript
import { MultiRegionManager } from '@stacksjs/ts-cloud'

const manager = new MultiRegionManager()

const deployment = await manager.deploy(config, {
  regions: [
    { code: 'us-east-1', name: 'US East', isPrimary: true },
    { code: 'eu-west-1', name: 'EU West' },
  ],
  globalResources: { route53: true, cloudfront: true },
  failover: { enabled: true, healthCheckPath: '/health' },
})

console.log(deployment.status, deployment.regions)
```

### Preview environments

Preview environments are persistent control-plane records backed by durable create, update, and teardown jobs. Signed pull-request and branch events deploy an exact immutable SHA to a collision-safe stack and stable HTTPS URL; TTL and retention cleanup remove only resources carrying the preview's complete tag set.

Configure the policy and inspect lifecycle state under **Operations → Preview environments**, or use `cloud env:preview` and the automation API. See [Preview environments](/features/preview-environments) for the complete workflow and security model.

## CI/CD Integration

### GitHub Actions

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - name: Deploy
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: us-east-1
        run: bunx cloud deploy --env production --yes
```

### GitLab CI

```yaml
# .gitlab-ci.yml
deploy:
  stage: deploy
  image: oven/bun:latest
  script:
    - bun install
    - bunx cloud deploy --env production --yes
  only:
    - main
  variables:
    AWS_ACCESS_KEY_ID: $AWS_ACCESS_KEY_ID
    AWS_SECRET_ACCESS_KEY: $AWS_SECRET_ACCESS_KEY
    AWS_REGION: us-east-1
```

In CI, `cloud deploy` auto-confirms when `CI=true` is set, so `--yes` is optional in most pipelines.

## Next Steps

- [Getting Started](/guide/getting-started) — setup guide
- [Configuration](/config) — the `project` / `environments` / `infrastructure` / `sites` schema
- [Cloud Providers](/guide/providers) — resource types
