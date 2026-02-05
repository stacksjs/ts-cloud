# Usage

ts-cloud can be used as a library for programmatic infrastructure management or via CLI commands.

## Using Presets

The fastest way to deploy infrastructure is with presets:

### Static Website

```typescript
import { createStaticSitePreset } from 'ts-cloud/presets'

export default createStaticSitePreset({
  name: 'My Website',
  slug: 'my-website',
  domain: 'example.com',
})
```

**Includes:** S3 bucket, CloudFront CDN, Route53 DNS, ACM certificate

### Full-Stack Application

```typescript
import { createFullStackAppPreset } from 'ts-cloud/presets'

export default createFullStackAppPreset({
  name: 'My App',
  slug: 'my-app',
  domain: 'app.example.com',
  apiSubdomain: 'api.example.com',
})
```

**Includes:** S3 + CloudFront frontend, ECS Fargate backend, PostgreSQL RDS, Redis ElastiCache, SQS queues

### Serverless API

```typescript
import { createApiBackendPreset } from 'ts-cloud/presets'

export default createApiBackendPreset({
  name: 'My API',
  slug: 'my-api',
  domain: 'api.example.com',
})
```

**Includes:** API Gateway HTTP API, Lambda functions, DynamoDB tables, CloudWatch monitoring

## Using AWS Clients Directly

For more control, use the AWS clients directly:

### CloudFormation

```typescript
import { CloudFormationClient } from 'ts-cloud'

const cfn = new CloudFormationClient('us-east-1')

// Create a stack
await cfn.createStack({
  stackName: 'my-stack',
  templateBody: JSON.stringify(template),
  capabilities: ['CAPABILITY_IAM'],
})

// Wait for completion
await cfn.waitForStack('my-stack', 'stack-create-complete')

// List stacks
const stacks = await cfn.listStacks()

// Get stack outputs
const outputs = await cfn.getStackOutputs('my-stack')
```

### S3

```typescript
import { S3Client } from 'ts-cloud'

const s3 = new S3Client('us-east-1')

// Upload a file
await s3.putObject({
  bucket: 'my-bucket',
  key: 'file.txt',
  body: 'Hello World',
  contentType: 'text/plain',
})

// Upload a directory
await s3.syncDirectory({
  bucket: 'my-bucket',
  sourceDir: './dist',
  prefix: '',
})
```

### CloudFront

```typescript
import { CloudFrontClient } from 'ts-cloud'

const cloudfront = new CloudFrontClient()

// Invalidate cache
await cloudfront.createInvalidation({
  distributionId: 'E1234567890',
  paths: ['/*'],
})

// Wait for invalidation
await cloudfront.waitForInvalidation({
  distributionId: 'E1234567890',
  invalidationId: 'I1234567890',
})
```

## Extending Presets

Customize any preset with overrides:

```typescript
import { createNodeJsServerPreset, extendPreset } from 'ts-cloud/presets'

export default extendPreset(
  createNodeJsServerPreset({
    name: 'My App',
    slug: 'my-app',
  }),
  {
    infrastructure: {
      compute: {
        server: {
          instanceType: 't3.large',
          autoScaling: {
            min: 2,
            max: 20,
          },
        },
      },
      database: {
        instanceClass: 'db.r5.large',
        multiAz: true,
      },
    },
  }
)
```

## Composing Presets

Combine multiple presets into one deployment:

```typescript
import {
  composePresets,
  createStaticSitePreset,
  createApiBackendPreset,
} from 'ts-cloud/presets'

export default composePresets(
  createStaticSitePreset({
    name: 'Frontend',
    slug: 'frontend',
    domain: 'example.com',
  }),
  createApiBackendPreset({
    name: 'Backend',
    slug: 'backend',
    domain: 'api.example.com',
  }),
  {
    // Custom overrides
    infrastructure: {
      monitoring: {
        alarms: [
          { metric: 'Errors', threshold: 10 },
        ],
      },
    },
  }
)
```

## Deploying Static Sites

The most common use case is deploying a static site:

```typescript
import { deployStaticSiteFull } from 'ts-cloud'

const result = await deployStaticSiteFull({
  siteName: 'my-docs',
  region: 'us-east-1',
  domain: 'docs.example.com',
  sourceDir: './dist',
  defaultRootObject: 'index.html',
  errorDocument: '404.html',
  onProgress: (stage, detail) => {
    console.log(`[${stage}] ${detail}`)
  },
})

console.log('Deployed to:', result.domain)
```

## CLI Commands

### Project Management

```bash
# Initialize project
cloud init my-project

# Generate CloudFormation templates
cloud generate

# Validate templates
cloud validate

# Preview changes
cloud diff --stack my-stack
```

### Security Scanning

```bash
# Run security scan on current directory
cloud deploy:security-scan

# Scan specific directory (e.g., frontend build)
cloud deploy:security-scan --source ./dist

# Set severity threshold (critical, high, medium, low)
cloud deploy:security-scan --fail-on high

# Skip specific patterns (false positives)
cloud deploy:security-scan --skip-patterns "JWT Token,Generic API Key"
```

### Deployment

```bash
# Deploy a stack (includes automatic security scan)
cloud deploy --stack my-stack

# Deploy all stacks
cloud deploy --all

# Deploy static site to S3 + CloudFront
cloud deploy:static --source ./dist --bucket my-bucket

# Deploy container to ECS
cloud deploy:container --cluster my-cluster --service my-service

# Skip security scan (not recommended for production)
cloud deploy --skip-security-scan

# Destroy a stack
cloud destroy --stack my-stack
```

## Next Steps

- [Configuration](/config) - Full configuration reference
- [Providers](/guide/providers) - AWS resource builders
- [Deployment](/guide/deployment) - Deployment strategies
