# Introduction

ts-cloud is a modern infrastructure-as-code framework that lets you define AWS infrastructure using TypeScript configuration files. Unlike AWS CDK or Terraform, ts-cloud takes a fundamentally different approach.

## Why ts-cloud?

### Zero AWS Dependencies

Most infrastructure tools require the AWS SDK, AWS CLI, or both. ts-cloud uses **zero external dependencies** for AWS operations:

- **AWS Signature V4** - Manual request signing for authentication
- **Direct HTTPS** - Native `fetch()` for API calls
- **Credentials** - Parse `~/.aws/credentials` without SDK
- **CloudFormation** - XML/JSON parsing for responses

This means:

- ⚡ **Faster startup and execution** - No SDK initialization overhead
- 📦 **Smaller bundle size** - No heavy dependencies to ship
- 🔒 **Better security** - Reduced supply chain attack surface
- 🎯 **Full control** - You see exactly what's happening

### Type-Safe Configuration

Define your infrastructure with full TypeScript support:

```typescript
import { createStaticSitePreset } from 'ts-cloud/presets'

export default createStaticSitePreset({
  name: 'My Website',
  slug: 'my-website',
  domain: 'example.com',
})
```

Your editor provides autocomplete, type checking catches errors before deployment, and refactoring is safe.

### Production-Ready Presets

Skip weeks of CloudFormation research with battle-tested presets:

| Preset | Use Case |
|--------|----------|
| Static Sites | S3 + CloudFront for SPAs and static websites |
| Node.js Servers | EC2 + ALB + RDS + Redis for traditional apps |
| Serverless Apps | ECS Fargate + ALB + DynamoDB for scalable services |
| Full-Stack Apps | Complete frontend + backend + database stack |
| API Backends | API Gateway + Lambda + DynamoDB for serverless APIs |
| WordPress | Optimized WordPress hosting with RDS + EFS + CloudFront |
| JAMstack | Modern static sites with Lambda@Edge for SSR |
| Microservices | Multi-service architecture with service discovery |
| Real-time Apps | WebSocket API + Lambda + DynamoDB Streams |
| Data Pipelines | Kinesis + Lambda + S3 + Athena + Glue for ETL |
| ML APIs | SageMaker + API Gateway for ML inference |

### CloudFormation Native

ts-cloud generates clean CloudFormation templates you can:

- Review before deployment
- Version control
- Audit for compliance
- Use with existing AWS tooling

## How It Works

1. **Configuration** - Define infrastructure in TypeScript
2. **Generation** - Convert config to CloudFormation templates
3. **Deployment** - Direct HTTPS calls to AWS CloudFormation API
4. **Monitoring** - Track deployment progress with real-time events

## Quick Example

Deploy a static website with HTTPS and CDN in under 10 lines:

```typescript
import { createStaticSitePreset } from 'ts-cloud/presets'

export default createStaticSitePreset({
  name: 'My Docs',
  slug: 'my-docs',
  domain: 'docs.example.com',
})
```

```bash
bun run cloud deploy
```

That's it! You now have:
- ✅ S3 bucket with static website hosting
- ✅ CloudFront CDN with HTTPS
- ✅ Route53 DNS configuration
- ✅ ACM SSL certificate

## Next Steps

- [Installation](/install) - Install ts-cloud
- [Getting Started](/guide/getting-started) - Build your first infrastructure
- [Configuration](/config) - Learn the configuration options
