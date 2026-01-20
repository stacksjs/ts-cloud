# Multi-Region Deployments

Deploy your infrastructure across multiple AWS regions for high availability and low latency.

## Basic Multi-Region Setup

```typescript
import { MultiRegionDeployment } from 'ts-cloud'

const deployment = new MultiRegionDeployment({
  regions: ['us-east-1', 'us-west-2', 'eu-west-1'],
  stackName: 'my-global-app',
})

// Deploy to all regions
await deployment.deploy(template)
```

## Region-Specific Configuration

Override settings per region:

```typescript
await deployment.deploy(template, {
  'us-east-1': {
    Environment: 'prod-us-east',
    InstanceType: 't3.large',
  },
  'us-west-2': {
    Environment: 'prod-us-west',
    InstanceType: 't3.medium',
  },
  'eu-west-1': {
    Environment: 'prod-eu',
    InstanceType: 't3.medium',
  },
})
```

## Global Resources

Some AWS resources are global and only need to be deployed once:

```typescript
import { defineStack } from 'ts-cloud'

export default defineStack({
  name: 'global',
  region: 'us-east-1', // Always deploy to us-east-1

  resources: {
    // CloudFront distributions
    Distribution: {
      Type: 'AWS::CloudFront::Distribution',
      // ...
    },

    // ACM certificates for CloudFront (must be in us-east-1)
    Certificate: {
      Type: 'AWS::CertificateManager::Certificate',
      // ...
    },

    // Route 53 hosted zones
    HostedZone: {
      Type: 'AWS::Route53::HostedZone',
      // ...
    },
  },
})
```

## Active-Active Setup

Run your application in multiple regions simultaneously:

```typescript
// cloud.config.ts
export default {
  name: 'my-app',

  regions: {
    primary: 'us-east-1',
    secondary: ['us-west-2', 'eu-west-1'],
  },

  routing: {
    type: 'latency', // Route users to nearest region
    healthCheck: {
      path: '/health',
      interval: 30,
    },
  },
}
```

## Active-Passive (Failover)

Set up a standby region for disaster recovery:

```typescript
export default {
  name: 'my-app',

  regions: {
    primary: 'us-east-1',
    failover: 'us-west-2',
  },

  routing: {
    type: 'failover',
    healthCheck: {
      path: '/health',
      failureThreshold: 3,
    },
  },
}
```

## Data Replication

Configure cross-region data replication:

```typescript
// S3 cross-region replication
const bucket = new S3Bucket({
  bucketName: 'my-data',
  replication: {
    destinationBucket: 'my-data-replica',
    destinationRegion: 'us-west-2',
  },
})

// DynamoDB global tables
const table = new DynamoDBTable({
  tableName: 'users',
  globalTable: {
    regions: ['us-east-1', 'us-west-2', 'eu-west-1'],
  },
})
```

## Next Steps

- [Environment Config](/features/environments) - Managing environments
- [Deployment](/guide/deployment) - Deployment strategies
