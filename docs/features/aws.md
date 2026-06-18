# AWS Resources

ts-cloud generates CloudFormation from a declarative `infrastructure` block on your `CloudConfig`. You describe the resources you want — databases, caches, queues, functions, storage, email, search, and more — and ts-cloud compiles them to a template (no per-resource classes to instantiate).

## How it works

The `CloudFormationBuilder` takes a `CloudConfig` and produces a CloudFormation template:

```typescript
import { CloudFormationBuilder } from '@stacksjs/ts-cloud'
import config from './cloud.config'

const builder = new CloudFormationBuilder(config)
const template = builder.build() // CloudFormationTemplate
```

For hand-rolled templates there's also a low-level `TemplateBuilder` and the `Fn` intrinsic-function helpers (see [Resource Builders](#low-level-template-builder) below). The everyday path, though, is the declarative config.

## The `infrastructure` block

Everything below lives under `infrastructure` in your `cloud.config.ts`:

```typescript
import type { CloudConfig } from '@stacksjs/ts-cloud'

export default {
  project: { name: 'My App', slug: 'my-app', region: 'us-east-1' },
  environments: { production: { type: 'production' } },

  infrastructure: {
    // …resources described in the sections below
  },
} satisfies CloudConfig
```

### Compute (EC2)

```typescript
infrastructure: {
  // Single instance — no load balancer
  compute: {
    instances: 1,
    instanceType: 't3.micro',
  },
}
```

```typescript
infrastructure: {
  // Multiple instances — load balancer auto-enabled
  compute: {
    instances: 3,
    instanceType: 't3.small',
    autoScaling: { min: 2, max: 10, scaleUpThreshold: 70 },
  },
}
```

### Containers (ECS Fargate)

```typescript
infrastructure: {
  containers: {
    api: {
      cpu: 512,
      memory: 1024,
      port: 3000,
      healthCheck: '/health',
      desiredCount: 2,
      autoScaling: { min: 1, max: 10, targetCpuUtilization: 70 },
    },
  },
}
```

### Functions (Lambda)

```typescript
infrastructure: {
  functions: {
    apiHandler: {
      runtime: 'nodejs20.x',
      handler: 'index.handler',
      memorySize: 256,
      timeout: 30,
      environment: { LOG_LEVEL: 'info' },
      events: [{ type: 'http', path: '/users', method: 'GET' }],
    },
  },
}
```

### Storage (S3 / EFS)

```typescript
infrastructure: {
  storage: {
    assets: {
      public: true,
      versioning: true,
      encryption: true,
      lifecycleRules: [
        {
          id: 'archive',
          enabled: true,
          transitions: [
            { days: 30, storageClass: 'STANDARD_IA' },
            { days: 90, storageClass: 'GLACIER' },
          ],
        },
      ],
    },
  },
}
```

### Databases (RDS / DynamoDB)

Single-database shorthand (Forge-style) wires `DATABASE_URL` into the app:

```typescript
infrastructure: {
  database: 'postgres', // 'sqlite' | 'mysql' | 'postgres'
}
```

Named databases with explicit settings:

```typescript
infrastructure: {
  databases: {
    primary: {
      type: 'rds',
      engine: 'postgres',
      instanceType: 'db.t3.micro',
    },
  },
}
```

### Cache (ElastiCache)

```typescript
infrastructure: {
  cache: {
    type: 'redis',
    redis: {
      nodeType: 'cache.t3.micro',
      numCacheNodes: 1,
      automaticFailoverEnabled: false,
    },
  },
}
```

### Queues (SQS)

```typescript
infrastructure: {
  queues: {
    jobs: { visibilityTimeout: 120, deadLetterQueue: true },
    orders: { fifo: true, contentBasedDeduplication: true },
  },
}
```

### Messaging (SNS)

```typescript
infrastructure: {
  messaging: {
    topics: {
      alerts: {
        subscriptions: [{ protocol: 'email', endpoint: 'ops@example.com' }],
      },
    },
  },
}
```

### Email (SES)

```typescript
infrastructure: {
  email: {
    domain: 'example.com',
    configurationSet: true,
    enableDkim: true,
  },
}
```

### Search (OpenSearch)

```typescript
infrastructure: {
  search: {
    instanceType: 't3.small.search',
    instanceCount: 1,
    volumeSize: 10,
  },
}
```

### AI (Bedrock)

```typescript
infrastructure: {
  ai: {
    models: ['anthropic.claude-3-5-sonnet-20241022-v2:0'],
    allowStreaming: true,
    service: 'lambda',
  },
}
```

### Networking, CDN, DNS & SSL

```typescript
infrastructure: {
  network: {
    cidr: '10.0.0.0/16',
    subnets: { public: 2, private: 2 },
    natGateway: 'single',
  },
  cdn: { enabled: true },
  dns: { domain: 'example.com', provider: 'route53' },
  ssl: { /* certificate configuration */ },
}
```

### Other `infrastructure` keys

The `InfrastructureConfig` surface also includes:

- `apiGateway` — REST / HTTP / WebSocket API Gateway
- `fileSystem` — EFS file systems
- `loadBalancer` — ALB/NLB configuration
- `monitoring` — CloudWatch alarms, dashboards, log retention
- `security` — WAF, KMS, ACM certificates, security groups
- `jumpBox` — bastion host for SSH access into the VPC
- `realtime` — Echo/Pusher-compatible WebSocket broadcasting
- `redirects` — domain (S3) and path (CloudFront Function) redirects
- `streaming` — Kinesis data streams
- `analytics` — Firehose, Athena, Glue
- `machineLearning` — SageMaker endpoints and training jobs
- `workflow` — Step Functions pipelines

## Low-level template builder

When you need raw CloudFormation, compose it directly with `TemplateBuilder` and `Fn`:

```typescript
import { Fn, TemplateBuilder } from '@stacksjs/ts-cloud'

const template = new TemplateBuilder()
  .addParameter('Environment', {
    Type: 'String',
    AllowedValues: ['development', 'staging', 'production'],
  })
  .addResource('Function', {
    Type: 'AWS::Lambda::Function',
    Properties: {
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      Environment: { Variables: { LOG_LEVEL: Fn.Ref('Environment') } },
    },
  })
  .addOutput('FunctionName', { Value: Fn.Ref('Function') })
  .build()
```

Validate any generated template with `validateTemplate`:

```typescript
import { validateTemplate } from '@stacksjs/ts-cloud'

const result = validateTemplate(template)
if (!result.valid)
  console.error(result.errors)
```

## Next Steps

- [Environment Config](/features/environments) - Managing environments
- [Multi-Region](/features/multi-region) - Deploying across regions
