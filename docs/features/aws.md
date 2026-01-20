# AWS Resources

ts-cloud provides comprehensive support for AWS resources through typed CloudFormation builders.

## Supported Services

### Compute

| Service | Resources |
|---------|-----------|
| Lambda | Functions, Layers, Event Source Mappings |
| ECS | Clusters, Services, Task Definitions |
| EC2 | Instances, Auto Scaling Groups, Launch Templates |

### Storage

| Service | Resources |
|---------|-----------|
| S3 | Buckets, Bucket Policies, Lifecycle Rules |
| EFS | File Systems, Mount Targets, Access Points |
| EBS | Volumes, Snapshots |

### Database

| Service | Resources |
|---------|-----------|
| RDS | Instances, Clusters, Parameter Groups |
| DynamoDB | Tables, Global Secondary Indexes, Streams |
| ElastiCache | Redis/Memcached Clusters, Replication Groups |

### Networking

| Service | Resources |
|---------|-----------|
| VPC | VPCs, Subnets, Route Tables, NAT Gateways |
| ALB/NLB | Load Balancers, Target Groups, Listeners |
| CloudFront | Distributions, Origin Access Identities |
| Route 53 | Hosted Zones, Record Sets |
| API Gateway | REST APIs, HTTP APIs, WebSocket APIs |

### Security

| Service | Resources |
|---------|-----------|
| IAM | Roles, Policies, Instance Profiles |
| ACM | Certificates |
| Secrets Manager | Secrets |
| KMS | Keys, Aliases |

### Messaging

| Service | Resources |
|---------|-----------|
| SQS | Queues, Dead Letter Queues |
| SNS | Topics, Subscriptions |
| EventBridge | Event Buses, Rules |

## Resource Builders

Each resource type has a dedicated builder with full TypeScript support:

```typescript
import { S3Bucket, Lambda, DynamoDBTable } from 'ts-cloud'

// S3 with lifecycle rules
const bucket = new S3Bucket({
  bucketName: 'my-assets',
  versioning: true,
  encryption: 'AES256',
  lifecycleRules: [
    {
      id: 'archive',
      transitions: [
        { days: 30, storageClass: 'STANDARD_IA' },
        { days: 90, storageClass: 'GLACIER' },
      ],
    },
  ],
})

// Lambda with VPC
const func = new Lambda({
  functionName: 'my-handler',
  runtime: 'nodejs20.x',
  handler: 'index.handler',
  memorySize: 256,
  timeout: 30,
  vpcConfig: {
    subnetIds: privateSubnets,
    securityGroupIds: [securityGroup.id],
  },
})

// DynamoDB with GSI
const table = new DynamoDBTable({
  tableName: 'users',
  partitionKey: { name: 'id', type: 'S' },
  sortKey: { name: 'createdAt', type: 'N' },
  globalSecondaryIndexes: [
    {
      indexName: 'email-index',
      partitionKey: { name: 'email', type: 'S' },
    },
  ],
})
```

## Next Steps

- [State Management](/features/state) - Managing infrastructure state
- [Multi-Region](/features/multi-region) - Deploying across regions
