# Deployment

Deploy your infrastructure to AWS using ts-cloud.

## AWS Credentials

### Environment Variables

```bash
export AWS_ACCESS_KEY_ID=your-access-key
export AWS_SECRET_ACCESS_KEY=your-secret-key
export AWS_REGION=us-east-1
```

### Credentials File

```ini
# ~/.aws/credentials
[default]
aws_access_key_id = your-access-key
aws_secret_access_key = your-secret-key

[production]
aws_access_key_id = prod-access-key
aws_secret_access_key = prod-secret-key
```

### Using Profiles

```typescript
import { AWSCredentials } from 'ts-cloud'

const credentials = new AWSCredentials({
  profile: 'production',
})
```

## CLI Deployment

### Deploy Single Stack

```bash
# Deploy to default region
cloud deploy --stack my-app

# Deploy to specific region
cloud deploy --stack my-app --region us-west-2

# Deploy with profile
cloud deploy --stack my-app --profile production
```

### Deploy All Stacks

```bash
# Deploy all stacks in dependency order
cloud deploy --all

# Deploy specific environment
cloud deploy --all --env production
```

### Preview Changes

```bash
# Show what will change
cloud diff --stack my-app

# Detailed change output
cloud diff --stack my-app --verbose
```

### Destroy Stack

```bash
# Destroy single stack
cloud destroy --stack my-app

# Force destroy (skip confirmation)
cloud destroy --stack my-app --force
```

## Programmatic Deployment

### Deploy Stack

```typescript
import { CloudFormationClient, deploy } from 'ts-cloud'

const client = new CloudFormationClient({
  region: 'us-east-1',
})

const template = stack.toJSON()

const result = await deploy({
  client,
  stackName: 'my-app',
  template,
  parameters: {
    Environment: 'production',
    DatabasePassword: 'secret-from-ssm',
  },
  capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
})

console.log('Stack deployed:', result.stackId)
```

### Monitor Deployment

```typescript
import { waitForStack } from 'ts-cloud'

const status = await waitForStack({
  client,
  stackName: 'my-app',
  desiredStatus: 'CREATE_COMPLETE',
  timeout: 300000, // 5 minutes
  onProgress: (event) => {
    console.log(`${event.resourceType}: ${event.resourceStatus}`)
  },
})

if (status.success) {
  console.log('Deployment complete!')
}
else {
  console.error('Deployment failed:', status.reason)
}
```

## Blue-Green Deployment

### Setup Blue-Green

```typescript
import { BlueGreenManager } from 'ts-cloud'

const blueGreen = new BlueGreenManager({
  stackPrefix: 'my-app',
  region: 'us-east-1',
})

// Deploy to blue environment
await blueGreen.deployBlue(template)

// Run health checks
const healthy = await blueGreen.checkHealth('blue')

if (healthy) {
  // Switch traffic to blue
  await blueGreen.switchToBlue()

  // Cleanup old green environment
  await blueGreen.cleanupGreen()
}
else {
  // Rollback
  await blueGreen.destroyBlue()
}
```

## Canary Deployment

### Gradual Rollout

```typescript
import { CanaryManager } from 'ts-cloud'

const canary = new CanaryManager({
  stackName: 'my-app',
  stages: [
    { percentage: 10, duration: 300 },  // 10% for 5 minutes
    { percentage: 25, duration: 300 },  // 25% for 5 minutes
    { percentage: 50, duration: 600 },  // 50% for 10 minutes
    { percentage: 100, duration: 0 },   // Full rollout
  ],
  rollbackThreshold: {
    errorRate: 0.05,  // 5% error rate triggers rollback
  },
})

await canary.deploy(template)
```

## Multi-Region Deployment

### Deploy to Multiple Regions

```typescript
import { MultiRegionDeployment } from 'ts-cloud'

const multiRegion = new MultiRegionDeployment({
  regions: ['us-east-1', 'us-west-2', 'eu-west-1'],
  stackName: 'my-global-app',
})

// Deploy to all regions
await multiRegion.deploy(template)

// Deploy with region-specific parameters
await multiRegion.deploy(template, {
  'us-east-1': { Environment: 'prod-us' },
  'eu-west-1': { Environment: 'prod-eu' },
})
```

## Multi-Account Deployment

### Cross-Account Deployment

```typescript
import { MultiAccountDeployment } from 'ts-cloud'

const multiAccount = new MultiAccountDeployment({
  accounts: {
    dev: '111111111111',
    staging: '222222222222',
    prod: '333333333333',
  },
  assumeRole: 'arn:aws:iam::${accountId}:role/DeploymentRole',
})

// Deploy to specific account
await multiAccount.deployTo('prod', template)

// Deploy to all accounts
await multiAccount.deployToAll(template)
```

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
        run: |
          bun run cloud deploy --stack my-app
```

### GitLab CI

```yaml
# .gitlab-ci.yml
deploy:
  stage: deploy
  image: oven/bun:latest
  script:
    - bun install
    - bun run cloud deploy --stack my-app
  only:
    - main
  variables:
    AWS_ACCESS_KEY_ID: $AWS_ACCESS_KEY_ID
    AWS_SECRET_ACCESS_KEY: $AWS_SECRET_ACCESS_KEY
    AWS_REGION: us-east-1
```

### CircleCI

```yaml
# .circleci/config.yml
version: 2.1

jobs:
  deploy:
    docker:
      - image: oven/bun:latest
    steps:
      - checkout
      - run: bun install
      - run:
          name: Deploy
          command: bun run cloud deploy --stack my-app

workflows:
  main:
    jobs:
      - deploy:
          filters:
            branches:
              only: main
```

## Preview Environments

### Create Preview Environment

```typescript
import { PreviewEnvironmentManager } from 'ts-cloud'

const preview = new PreviewEnvironmentManager({
  baseStackName: 'my-app',
  ttl: 86400, // 24 hours
})

// Create preview for PR
const previewEnv = await preview.create({
  branchName: 'feature/new-feature',
  prNumber: 123,
})

console.log('Preview URL:', previewEnv.url)

// Cleanup after PR merge
await preview.destroy('feature/new-feature')
```

### GitHub PR Integration

```typescript
import { GitHubPreviewIntegration } from 'ts-cloud'

const github = new GitHubPreviewIntegration({
  token: process.env.GITHUB_TOKEN,
  repo: 'owner/repo',
})

// Comment preview URL on PR
await github.commentPreviewUrl(prNumber, previewEnv.url)
```

## Rollback

### Automatic Rollback

```typescript
import { deploy } from 'ts-cloud'

await deploy({
  stackName: 'my-app',
  template,
  rollbackConfiguration: {
    rollbackTriggers: [
      {
        arn: alarmArn,
        type: 'AWS::CloudWatch::Alarm',
      },
    ],
    monitoringTimeInMinutes: 5,
  },
})
```

### Manual Rollback

```bash
# Rollback to previous version
cloud rollback --stack my-app

# Rollback to specific version
cloud rollback --stack my-app --version v1.2.3
```

## Cost Estimation

### Estimate Deployment Cost

```typescript
import { estimateCost } from 'ts-cloud'

const estimate = await estimateCost(template)

console.log('Estimated monthly cost:', estimate.monthly)
console.log('Cost breakdown:', estimate.breakdown)
```

## Next Steps

- [Getting Started](/guide/getting-started) - Setup guide
- [Cloud Providers](/guide/providers) - Resource types
