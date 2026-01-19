# Cloud Providers

ts-cloud supports AWS CloudFormation with typed resource definitions.

## AWS Resources

### Compute

#### Lambda Functions

```typescript
import { Lambda } from 'ts-cloud'

const lambdaManager = new Lambda()

// Create function
const func = lambdaManager.createFunction({
  name: 'my-handler',
  runtime: 'nodejs20.x',
  handler: 'index.handler',
  code: {
    s3Bucket: 'my-bucket',
    s3Key: 'function.zip',
  },
  memorySize: 256,
  timeout: 30,
  environment: {
    DATABASE_URL: 'postgres://...',
  },
})
```

#### ECS Containers

```typescript
import { ContainerManager } from 'ts-cloud'

const containers = new ContainerManager()

// Create ECS cluster
const cluster = containers.createCluster({
  name: 'my-cluster',
  containerInsights: true,
})

// Create service
const service = containers.createService({
  name: 'web',
  cluster: cluster.ref,
  desiredCount: 3,
  launchType: 'FARGATE',
  taskDefinition: taskDef.ref,
})
```

### Storage

#### S3 Buckets

```typescript
import { StorageAdvancedManager } from 'ts-cloud'

const storage = new StorageAdvancedManager()

// Create bucket with lifecycle
const bucket = storage.createBucket({
  name: 'my-assets',
  versioning: true,
  encryption: 'AES256',
  lifecycleRules: [
    {
      id: 'archive-old',
      status: 'Enabled',
      transitions: [
        { days: 30, storageClass: 'STANDARD_IA' },
        { days: 90, storageClass: 'GLACIER' },
      ],
      expiration: { days: 365 },
    },
  ],
})
```

### Database

#### RDS

```typescript
import { DatabaseManager } from 'ts-cloud'

const database = new DatabaseManager()

// Create Aurora Serverless
const aurora = database.createAuroraServerless({
  clusterIdentifier: 'my-cluster',
  engine: 'aurora-mysql',
  masterUsername: 'admin',
  masterUserPassword: { Ref: 'DatabasePassword' },
  minCapacity: 1,
  maxCapacity: 16,
  autoPause: true,
  autoPauseSeconds: 300,
})

// Create RDS instance
const rds = database.createInstance({
  identifier: 'my-db',
  engine: 'postgres',
  instanceClass: 'db.t3.micro',
  allocatedStorage: 20,
  masterUsername: 'admin',
  masterUserPassword: { Ref: 'DatabasePassword' },
  multiAZ: true,
})
```

### Networking

#### VPC

```typescript
import { NetworkModule } from 'ts-cloud'

const network = new NetworkModule()

// Create VPC with subnets
const vpc = network.createVpc({
  cidrBlock: '10.0.0.0/16',
  enableDnsHostnames: true,
  enableDnsSupport: true,
})

// Add public subnets
const publicSubnets = network.createPublicSubnets({
  vpcId: vpc.ref,
  cidrBlocks: ['10.0.1.0/24', '10.0.2.0/24'],
})

// Add private subnets
const privateSubnets = network.createPrivateSubnets({
  vpcId: vpc.ref,
  cidrBlocks: ['10.0.10.0/24', '10.0.11.0/24'],
})
```

#### Load Balancer

```typescript
import { ALBModule } from 'ts-cloud'

const alb = new ALBModule()

// Create Application Load Balancer
const loadBalancer = alb.create({
  name: 'my-alb',
  subnets: publicSubnets.refs,
  securityGroups: [securityGroup.ref],
  listeners: [
    {
      port: 443,
      protocol: 'HTTPS',
      certificates: [certificateArn],
      defaultAction: {
        type: 'forward',
        targetGroupArn: targetGroup.ref,
      },
    },
  ],
})
```

### CDN

#### CloudFront

```typescript
import { CDNModule } from 'ts-cloud'

const cdn = new CDNModule()

// Create distribution
const distribution = cdn.createDistribution({
  origins: [
    {
      domainName: bucket.domainName,
      id: 'S3Origin',
      s3OriginConfig: {
        originAccessIdentity: oai.ref,
      },
    },
  ],
  defaultCacheBehavior: {
    targetOriginId: 'S3Origin',
    viewerProtocolPolicy: 'redirect-to-https',
    cachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6', // CachingOptimized
  },
  aliases: ['example.com', 'www.example.com'],
  certificate: certificateArn,
})
```

### DNS

#### Route 53

```typescript
import { Route53RoutingManager } from 'ts-cloud'

const dns = new Route53RoutingManager()

// Create hosted zone
const zone = dns.createHostedZone({
  name: 'example.com',
})

// Add A record
const record = dns.createRecord({
  hostedZoneId: zone.ref,
  name: 'www.example.com',
  type: 'A',
  aliasTarget: {
    dnsName: distribution.domainName,
    hostedZoneId: 'Z2FDTNDATAQYW2', // CloudFront zone
  },
})
```

### Security

#### IAM

```typescript
import { SecurityManager } from 'ts-cloud'

const security = new SecurityManager()

// Create role
const role = security.createRole({
  name: 'my-lambda-role',
  assumeRolePolicyDocument: {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'lambda.amazonaws.com' },
        Action: 'sts:AssumeRole',
      },
    ],
  },
  managedPolicyArns: [
    'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
  ],
})
```

#### Secrets Manager

```typescript
import { SecretsManager } from 'ts-cloud'

const secrets = new SecretsManager()

// Create secret
const secret = secrets.createSecret({
  name: 'my-app/database',
  description: 'Database credentials',
  generateSecretString: {
    secretStringTemplate: JSON.stringify({ username: 'admin' }),
    generateStringKey: 'password',
    excludePunctuation: true,
  },
})
```

### Messaging

#### SQS

```typescript
import { QueueManager } from 'ts-cloud'

const queues = new QueueManager()

// Create queue
const queue = queues.createQueue({
  name: 'my-queue',
  visibilityTimeout: 30,
  messageRetentionPeriod: 1209600, // 14 days
  deadLetterQueue: {
    targetArn: dlq.arn,
    maxReceiveCount: 3,
  },
})
```

#### SNS

```typescript
import { SNSModule } from 'ts-cloud'

const sns = new SNSModule()

// Create topic
const topic = sns.createTopic({
  name: 'my-topic',
  displayName: 'My Notifications',
})

// Add subscription
const subscription = sns.createSubscription({
  topicArn: topic.ref,
  protocol: 'https',
  endpoint: 'https://api.example.com/webhook',
})
```

### Cache

#### ElastiCache

```typescript
import { Cache } from 'ts-cloud'

const cache = new Cache()

// Create Redis cluster
const redis = cache.createRedisCluster({
  clusterName: 'my-cache',
  nodeType: 'cache.t3.micro',
  numCacheClusters: 2,
  automaticFailoverEnabled: true,
})
```

## Resource Configuration

### Tags

Apply tags to all resources:

```typescript
import { TemplateBuilder } from 'ts-cloud'

const template = new TemplateBuilder()
  .setDefaultTags({
    Environment: 'prod',
    Project: 'my-app',
    ManagedBy: 'ts-cloud',
  })
  .addResource('Bucket', {
    Type: 'AWS::S3::Bucket',
    Properties: {
      // Tags automatically added
    },
  })
  .build()
```

### Conditions

Use conditions for conditional resources:

```typescript
const template = new TemplateBuilder()
  .addCondition('IsProduction', {
    'Fn::Equals': [{ Ref: 'Environment' }, 'prod'],
  })
  .addResource('ProdOnlyResource', {
    Type: 'AWS::S3::Bucket',
    Condition: 'IsProduction',
    Properties: {
      // Only created in production
    },
  })
  .build()
```

### Dependencies

Explicitly define dependencies:

```typescript
template.addResource('Database', {
  Type: 'AWS::RDS::DBInstance',
  DependsOn: ['VPC', 'SecurityGroup'],
  Properties: {
    // ...
  },
})
```

## Next Steps

- [Getting Started](/guide/getting-started) - Setup guide
- [Deployment](/guide/deployment) - Deploy infrastructure
