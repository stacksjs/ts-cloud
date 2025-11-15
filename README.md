<p align="center"><img src=".github/art/cover.jpg" alt="Social Card of this repo"></p>

[![npm version][npm-version-src]][npm-version-href]
[![GitHub Actions][github-actions-src]][github-actions-href]
[![Commitizen friendly](https://img.shields.io/badge/commitizen-friendly-brightgreen.svg)](http://commitizen.github.io/cz-cli/)
<!-- [![npm downloads][npm-downloads-src]][npm-downloads-href] -->
<!-- [![Codecov][codecov-src]][codecov-href] -->

# ts-cloud

> Zero-dependency AWS infrastructure as TypeScript. Deploy production-ready cloud infrastructure without AWS SDK or CLI.

## Overview

TS Cloud is a modern infrastructure-as-code framework that lets you define AWS infrastructure using TypeScript configuration files. Unlike AWS CDK or Terraform, TS Cloud:

- **Zero AWS Dependencies** - No AWS SDK, no AWS CLI. Direct AWS API calls only.
- **Type-Safe Configuration** - Full TypeScript types for all AWS resources
- **Production-Ready Presets** - 13 battle-tested infrastructure templates
- **Bun-Powered** - Lightning-fast builds and deployments
- **CloudFormation Native** - Generate clean, reviewable CloudFormation templates

## Features

### 🚀 Configuration Presets

Skip the boilerplate with production-ready presets for common architectures:

- **Static Sites** - S3 + CloudFront for SPAs and static websites
- **Node.js Servers** - EC2 + ALB + RDS + Redis for traditional apps
- **Serverless Apps** - ECS Fargate + ALB + DynamoDB for scalable services
- **Full-Stack Apps** - Complete frontend + backend + database stack
- **API Backends** - API Gateway + Lambda + DynamoDB for serverless APIs
- **WordPress** - Optimized WordPress hosting with RDS + EFS + CloudFront
- **JAMstack** - Modern static sites with Lambda@Edge for SSR
- **Microservices** - Multi-service architecture with service discovery
- **Real-time Apps** - WebSocket API + Lambda + DynamoDB Streams
- **Data Pipelines** - Kinesis + Lambda + S3 + Athena + Glue for ETL
- **ML APIs** - SageMaker + API Gateway for ML inference
- **Traditional Web Apps** - Session-based apps with EFS + Redis + ALB

### 🛠️ Infrastructure Builders

Complete CloudFormation template builders for:

- **Network** - VPC, subnets, NAT gateways, routing, security groups
- **Storage** - S3 buckets with versioning, encryption, lifecycle rules, EFS
- **Compute** - EC2 Auto Scaling, ECS Fargate, Lambda functions
- **Database** - RDS (PostgreSQL/MySQL), DynamoDB with streams and GSIs
- **Cache** - ElastiCache Redis/Memcached with replication
- **CDN** - CloudFront distributions with custom domains and Lambda@Edge
- **API Gateway** - HTTP, REST, and WebSocket APIs
- **Queue** - SQS queues with dead letter queues
- **Messaging** - SNS topics and subscriptions
- **Monitoring** - CloudWatch dashboards, alarms, and log groups
- **Security** - ACM certificates, WAF rules, security groups

### ☁️ Direct AWS Integration

No SDK, no CLI - pure AWS Signature V4 API calls:

- **CloudFormation** - CreateStack, UpdateStack, DeleteStack, DescribeStacks
- **S3** - PutObject, multipart upload, sync directory
- **CloudFront** - Cache invalidations with wait support
- **Credentials** - Resolve from env vars, ~/.aws/credentials, or IAM roles

## Quick Start

### Installation

```bash
bun add ts-cloud
```

### Your First Deployment

Create a `cloud.config.ts`:

```typescript
import { createStaticSitePreset } from 'ts-cloud/presets'

export default createStaticSitePreset({
  name: 'My Website',
  slug: 'my-website',
  domain: 'example.com',
})
```

Deploy:

```bash
bun run cloud deploy
```

That's it! You now have:
- ✅ S3 bucket with static website hosting
- ✅ CloudFront CDN with HTTPS
- ✅ Route53 DNS configuration
- ✅ ACM SSL certificate

### More Examples

#### Full-Stack Application

```typescript
import { createFullStackAppPreset } from 'ts-cloud/presets'

export default createFullStackAppPreset({
  name: 'My App',
  slug: 'my-app',
  domain: 'app.example.com',
  apiSubdomain: 'api.example.com',
})
```

Includes:
- Frontend: S3 + CloudFront
- Backend: ECS Fargate with auto-scaling
- Database: PostgreSQL RDS with Multi-AZ
- Cache: Redis ElastiCache
- Queue: SQS for background jobs

#### Serverless API

```typescript
import { createApiBackendPreset } from 'ts-cloud/presets'

export default createApiBackendPreset({
  name: 'My API',
  slug: 'my-api',
  domain: 'api.example.com',
})
```

Includes:
- API Gateway HTTP API
- Lambda functions with auto-scaling
- DynamoDB tables with on-demand billing
- CloudWatch monitoring and alarms

## Configuration

### Extending Presets

You can extend any preset with custom configuration:

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
          instanceType: 't3.large', // Upgrade instance type
          autoScaling: {
            max: 20, // Increase max instances
          },
        },
      },
    },
  }
)
```

### Composing Presets

Combine multiple presets:

```typescript
import { composePresets, createStaticSitePreset, createApiBackendPreset } from 'ts-cloud/presets'

export default composePresets(
  createStaticSitePreset({ name: 'Frontend', slug: 'frontend', domain: 'example.com' }),
  createApiBackendPreset({ name: 'Backend', slug: 'backend' }),
  {
    // Custom overrides
    infrastructure: {
      monitoring: {
        alarms: [{ metric: 'Errors', threshold: 10 }],
      },
    },
  }
)
```

## Advanced Usage

### Custom CloudFormation

Generate templates programmatically:

```typescript
import { CloudFormationBuilder } from 'ts-cloud/cloudformation'

const builder = new CloudFormationBuilder(config)
const template = builder.build()

console.log(JSON.stringify(template, null, 2))
```

### Direct AWS API Calls

Use the AWS clients directly:

```typescript
import { CloudFormationClient, S3Client, CloudFrontClient } from 'ts-cloud/aws'

// CloudFormation
const cfn = new CloudFormationClient('us-east-1')
await cfn.createStack({
  stackName: 'my-stack',
  templateBody: JSON.stringify(template),
})

// S3
const s3 = new S3Client('us-east-1')
await s3.putObject({
  bucket: 'my-bucket',
  key: 'file.txt',
  body: 'Hello World',
})

// CloudFront
const cloudfront = new CloudFrontClient()
await cloudfront.createInvalidation({
  distributionId: 'E1234567890',
  paths: ['/*'],
})
```

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Build
bun run build

# Type check
bun run typecheck
```

## Architecture

### How It Works

1. **Configuration** - Define infrastructure in TypeScript
2. **CloudFormation Generation** - Convert config to CloudFormation templates
3. **AWS API Calls** - Direct HTTPS calls to AWS CloudFormation API
4. **Deployment** - Create/update stacks with change sets
5. **Monitoring** - Track deployment progress with real-time events

### No Dependencies

TS Cloud uses **zero external dependencies** for AWS operations:

- **AWS Signature V4** - Manual request signing for authentication
- **Direct HTTPS** - Native `fetch()` for API calls
- **Credentials** - Parse ~/.aws/credentials without SDK
- **CloudFormation** - XML/JSON parsing for responses

This means:
- ⚡ Faster startup and execution
- 📦 Smaller bundle size
- 🔒 Better security (no supply chain attacks)
- 🎯 Full control over AWS interactions

## Contributing

Please see [CONTRIBUTING](.github/CONTRIBUTING.md) for details.

## Community

For help, discussion about best practices, or any other conversation that would benefit from being searchable:

[Discussions on GitHub](https://github.com/stacksjs/ts-cloud/discussions)

For casual chit-chat with others using this package:

[Join the Stacks Discord Server](https://discord.gg/stacksjs)

## Postcardware

"Software that is free, but hopes for a postcard." We love receiving postcards from around the world showing where Stacks is being used! We showcase them on our website too.

Our address: Stacks.js, 12665 Village Ln #2306, Playa Vista, CA 90094, United States 🌎

## Sponsors

We would like to extend our thanks to the following sponsors for funding Stacks development. If you are interested in becoming a sponsor, please reach out to us.

- [JetBrains](https://www.jetbrains.com/)
- [The Solana Foundation](https://solana.com/)

## License

The MIT License (MIT). Please see [LICENSE](LICENSE.md) for more information.

Made with 💙

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/ts-cloud?style=flat-square
[npm-version-href]: https://npmjs.com/package/ts-cloud
[github-actions-src]: https://img.shields.io/github/actions/workflow/status/stacksjs/ts-cloud/ci.yml?style=flat-square&branch=main
[github-actions-href]: https://github.com/stacksjs/ts-cloud/actions?query=workflow%3Aci

<!-- [codecov-src]: https://img.shields.io/codecov/c/gh/stacksjs/ts-cloud/main?style=flat-square
[codecov-href]: https://codecov.io/gh/stacksjs/ts-cloud -->
