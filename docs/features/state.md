# State Management

ts-cloud leverages CloudFormation for state management, providing reliable tracking of your infrastructure.

## How State Works

Unlike Terraform which maintains its own state file, ts-cloud uses CloudFormation as the source of truth:

- **No state files to manage** - CloudFormation tracks everything
- **No state locking issues** - AWS handles concurrency
- **Built-in drift detection** - Compare actual vs expected state
- **Automatic rollback** - Failed deployments revert automatically

## Stack Outputs

Export values from stacks for cross-stack references:

```typescript
import { defineStack } from 'ts-cloud'

export default defineStack({
  name: 'network',

  resources: {
    VPC: {
      Type: 'AWS::EC2::VPC',
      Properties: {
        CidrBlock: '10.0.0.0/16',
      },
    },
  },

  outputs: {
    VpcId: {
      Value: { Ref: 'VPC' },
      Export: { Name: 'NetworkStack-VpcId' },
    },
  },
})
```

## Cross-Stack References

Import values from other stacks:

```typescript
import { Fn } from 'ts-cloud'

export default defineStack({
  name: 'application',

  resources: {
    Instance: {
      Type: 'AWS::EC2::Instance',
      Properties: {
        SubnetId: Fn.ImportValue('NetworkStack-SubnetId'),
      },
    },
  },
})
```

## Drift Detection

Check if resources have been modified outside of ts-cloud:

```typescript
import { CloudFormationClient } from 'ts-cloud'

const client = new CloudFormationClient('us-east-1')

// Detect drift
const drift = await client.detectStackDrift('my-stack')

// Check drift status
const status = await client.describeStackDriftDetectionStatus(drift.id)

if (status.driftedResources.length > 0) {
  console.log('Drifted resources:', status.driftedResources)
}
```

## Stack Dependencies

Define explicit dependencies between stacks:

```typescript
// cloud.config.ts
export default {
  stacks: {
    network: './stacks/network.ts',
    database: {
      path: './stacks/database.ts',
      dependsOn: ['network'],
    },
    application: {
      path: './stacks/application.ts',
      dependsOn: ['network', 'database'],
    },
  },
}
```

## Next Steps

- [Multi-Region](/features/multi-region) - Deploy across regions
- [Environment Config](/features/environments) - Environment management
