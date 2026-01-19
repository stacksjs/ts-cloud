# Configuration

ts-cloud uses a `cloud.config.ts` file to define your infrastructure.

## Basic Configuration

Create a `cloud.config.ts` in your project root:

```typescript
import type { CloudConfig } from 'ts-cloud'

export default {
  name: 'my-app',
  region: 'us-east-1',

  environments: {
    dev: {
      account: '123456789012',
      region: 'us-east-1',
    },
    prod: {
      account: '987654321098',
      region: 'us-west-2',
    },
  },

  stacks: {
    network: './stacks/network.ts',
    database: './stacks/database.ts',
    application: './stacks/application.ts',
  },
} satisfies CloudConfig
```

## Configuration Options

### Core Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | required | Project name, used for resource naming |
| `region` | `string` | `'us-east-1'` | Default AWS region |
| `environments` | `object` | `{}` | Environment-specific settings |
| `stacks` | `object` | `{}` | Stack definitions |

### Environment Configuration

```typescript
environments: {
  dev: {
    account: '123456789012',
    region: 'us-east-1',
    variables: {
      LOG_LEVEL: 'debug',
    },
  },
  staging: {
    account: '123456789012',
    region: 'us-east-1',
    variables: {
      LOG_LEVEL: 'info',
    },
  },
  prod: {
    account: '987654321098',
    region: 'us-west-2',
    variables: {
      LOG_LEVEL: 'warn',
    },
  },
}
```

### Stack Configuration

```typescript
stacks: {
  // Reference external files
  network: './stacks/network.ts',

  // Or define inline
  storage: {
    resources: {
      Bucket: {
        Type: 'AWS::S3::Bucket',
        Properties: {
          BucketName: 'my-bucket',
        },
      },
    },
  },
}
```

## Static Site Configuration

For static site deployments, use `StaticSiteConfig`:

```typescript
import type { StaticSiteConfig } from 'ts-cloud'

const config: StaticSiteConfig = {
  siteName: 'my-docs',
  region: 'us-east-1',

  // Domain configuration
  domain: 'docs.example.com',
  // Or use subdomain + baseDomain
  subdomain: 'docs',
  baseDomain: 'example.com',

  // S3 configuration
  bucket: 'my-docs-bucket', // auto-generated if not specified

  // CloudFront configuration
  defaultRootObject: 'index.html',
  errorDocument: '404.html',
  cacheControl: 'max-age=31536000, public',

  // SSL/TLS
  certificateArn: 'arn:aws:acm:...', // auto-created if not specified
  hostedZoneId: 'Z1234567890', // auto-detected if not specified

  // CloudFormation
  stackName: 'my-docs-stack', // auto-generated if not specified

  // Tags
  tags: {
    Project: 'MyDocs',
    Environment: 'production',
  },
}
```

## Preset Configuration

### Static Site Preset

```typescript
import { createStaticSitePreset } from 'ts-cloud/presets'

export default createStaticSitePreset({
  name: 'My Website',
  slug: 'my-website',
  domain: 'example.com',

  // Optional overrides
  cdn: {
    priceClass: 'PriceClass_100', // US & Europe only
  },
})
```

### Full-Stack Preset

```typescript
import { createFullStackAppPreset } from 'ts-cloud/presets'

export default createFullStackAppPreset({
  name: 'My App',
  slug: 'my-app',
  domain: 'app.example.com',
  apiSubdomain: 'api.example.com',

  // Compute configuration
  compute: {
    cpu: 512,
    memory: 1024,
    desiredCount: 2,
  },

  // Database configuration
  database: {
    engine: 'postgres',
    instanceClass: 'db.t3.medium',
    allocatedStorage: 20,
    multiAz: true,
  },

  // Cache configuration
  cache: {
    engine: 'redis',
    nodeType: 'cache.t3.micro',
    numNodes: 1,
  },
})
```

### API Backend Preset

```typescript
import { createApiBackendPreset } from 'ts-cloud/presets'

export default createApiBackendPreset({
  name: 'My API',
  slug: 'my-api',
  domain: 'api.example.com',

  // Lambda configuration
  lambda: {
    runtime: 'nodejs20.x',
    memorySize: 256,
    timeout: 30,
  },

  // DynamoDB configuration
  dynamodb: {
    billingMode: 'PAY_PER_REQUEST',
    tables: [
      { name: 'users', partitionKey: 'id' },
      { name: 'orders', partitionKey: 'userId', sortKey: 'createdAt' },
    ],
  },
})
```

## Environment Variables

ts-cloud reads credentials from environment variables:

| Variable | Description |
|----------|-------------|
| `AWS_ACCESS_KEY_ID` | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key |
| `AWS_DEFAULT_REGION` | Default region |
| `AWS_PROFILE` | Named profile from `~/.aws/credentials` |
| `AWS_SESSION_TOKEN` | Session token for temporary credentials |

## TypeScript Configuration

For best type checking, add ts-cloud to your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "types": ["ts-cloud"]
  }
}
```

## Next Steps

- [Getting Started](/guide/getting-started) - Create your first stack
- [Providers](/guide/providers) - AWS resource builders
- [Deployment](/guide/deployment) - Deploy your infrastructure
