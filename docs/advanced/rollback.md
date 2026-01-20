# Rollback Strategies

Handle deployment failures gracefully with ts-cloud's rollback capabilities.

## Automatic Rollback

CloudFormation automatically rolls back failed deployments:

```typescript
import { deploy } from 'ts-cloud'

await deploy({
  stackName: 'my-app',
  template,
  onRollback: (event) => {
    console.log('Rolling back:', event.resourceType, event.reason)
  },
})
```

## Rollback Triggers

Configure CloudWatch alarms to trigger rollbacks:

```typescript
await deploy({
  stackName: 'my-app',
  template,
  rollbackConfiguration: {
    rollbackTriggers: [
      {
        arn: 'arn:aws:cloudwatch:us-east-1:123456789:alarm:HighErrorRate',
        type: 'AWS::CloudWatch::Alarm',
      },
      {
        arn: 'arn:aws:cloudwatch:us-east-1:123456789:alarm:HighLatency',
        type: 'AWS::CloudWatch::Alarm',
      },
    ],
    monitoringTimeInMinutes: 10,
  },
})
```

## Manual Rollback

Roll back to a previous stack state:

```bash
# Rollback to previous version
cloud rollback --stack my-app

# Rollback to specific version
cloud rollback --stack my-app --version v1.2.3

# Rollback with confirmation
cloud rollback --stack my-app --confirm
```

Programmatically:

```typescript
import { CloudFormationClient } from 'ts-cloud'

const client = new CloudFormationClient('us-east-1')

// Get previous template
const previousTemplate = await client.getTemplate('my-app', 'PREVIOUS')

// Deploy previous version
await client.updateStack({
  stackName: 'my-app',
  templateBody: previousTemplate,
})
```

## Disable Rollback for Debugging

During development, you may want to inspect failed resources:

```typescript
await deploy({
  stackName: 'my-app-dev',
  template,
  disableRollback: true, // Keep failed resources for inspection
})
```

```bash
cloud deploy --stack my-app-dev --no-rollback
```

## Change Sets for Safe Deployments

Preview changes before applying:

```typescript
import { CloudFormationClient } from 'ts-cloud'

const client = new CloudFormationClient('us-east-1')

// Create change set
const changeSet = await client.createChangeSet({
  stackName: 'my-app',
  templateBody: JSON.stringify(template),
  changeSetName: 'my-changes',
})

// Review changes
console.log('Changes:', changeSet.changes)

// Execute if approved
if (approved) {
  await client.executeChangeSet({
    stackName: 'my-app',
    changeSetName: 'my-changes',
  })
}
else {
  // Delete change set without applying
  await client.deleteChangeSet({
    stackName: 'my-app',
    changeSetName: 'my-changes',
  })
}
```

## Blue-Green Deployments

Zero-downtime deployments with instant rollback:

```typescript
import { BlueGreenManager } from 'ts-cloud'

const blueGreen = new BlueGreenManager({
  stackPrefix: 'my-app',
  region: 'us-east-1',
})

// Deploy new version
await blueGreen.deployGreen(newTemplate)

// Test new version
const healthy = await blueGreen.healthCheck('green')

if (healthy) {
  // Switch traffic
  await blueGreen.switchToGreen()
  // Cleanup old version
  await blueGreen.cleanupBlue()
}
else {
  // Rollback - just destroy green
  await blueGreen.destroyGreen()
}
```

## Canary Rollback

Automatic rollback based on metrics:

```typescript
import { CanaryDeployment } from 'ts-cloud'

const canary = new CanaryDeployment({
  stackName: 'my-app',
  stages: [
    { percentage: 10, duration: 300 },
    { percentage: 50, duration: 600 },
    { percentage: 100, duration: 0 },
  ],
  rollbackThreshold: {
    errorRate: 0.05, // 5% errors triggers rollback
    latencyP99: 1000, // 1s p99 latency triggers rollback
  },
  onRollback: async (stage, reason) => {
    // Notify team
    await slack.send(`Deployment rolled back at ${stage}%: ${reason}`)
  },
})

await canary.deploy(template)
```

## Stack Policies

Prevent accidental deletion of critical resources:

```typescript
await deploy({
  stackName: 'my-app',
  template,
  stackPolicy: {
    Statement: [
      {
        Effect: 'Deny',
        Action: 'Update:Delete',
        Principal: '*',
        Resource: 'LogicalResourceId/Database',
      },
      {
        Effect: 'Allow',
        Action: 'Update:*',
        Principal: '*',
        Resource: '*',
      },
    ],
  },
})
```

## Next Steps

- [CI/CD Integration](/advanced/cicd) - Automate deployments
- [Deployment](/guide/deployment) - Deployment guide
