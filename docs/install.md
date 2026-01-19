# Installation

ts-cloud is distributed as an npm package and works best with Bun for optimal performance.

## Package Managers

::: code-group

```sh [bun]
bun add ts-cloud
```

```sh [npm]
npm install ts-cloud
```

```sh [pnpm]
pnpm add ts-cloud
```

```sh [yarn]
yarn add ts-cloud
```

:::

## Requirements

- **Bun** (recommended) or Node.js 18+
- **AWS Account** with appropriate permissions
- **AWS Credentials** configured via environment variables or `~/.aws/credentials`

## AWS Credentials Setup

ts-cloud needs AWS credentials to deploy infrastructure. You have several options:

### Environment Variables (Recommended for CI/CD)

```bash
export AWS_ACCESS_KEY_ID=your-access-key
export AWS_SECRET_ACCESS_KEY=your-secret-key
export AWS_DEFAULT_REGION=us-east-1
```

### AWS Credentials File

Create or edit `~/.aws/credentials`:

```ini
[default]
aws_access_key_id = your-access-key
aws_secret_access_key = your-secret-key
region = us-east-1
```

### Using Named Profiles

```ini
[production]
aws_access_key_id = prod-access-key
aws_secret_access_key = prod-secret-key
region = us-east-1

[development]
aws_access_key_id = dev-access-key
aws_secret_access_key = dev-secret-key
region = us-west-2
```

Then set the profile:

```bash
export AWS_PROFILE=production
```

## Verify Installation

Create a simple test file:

```typescript
// test.ts
import { CloudFormationClient } from 'ts-cloud'

const client = new CloudFormationClient('us-east-1')
const stacks = await client.listStacks()
console.log('Connected! Found', stacks.length, 'stacks')
```

Run it:

```bash
bun run test.ts
```

If you see your stack count, you're ready to go!

## Required IAM Permissions

For full ts-cloud functionality, your IAM user/role needs these permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "cloudformation:*",
        "s3:*",
        "cloudfront:*",
        "route53:*",
        "acm:*",
        "ec2:*",
        "ecs:*",
        "rds:*",
        "elasticache:*",
        "lambda:*",
        "apigateway:*",
        "dynamodb:*",
        "sqs:*",
        "sns:*",
        "logs:*",
        "iam:PassRole"
      ],
      "Resource": "*"
    }
  ]
}
```

::: tip
For production, scope these permissions down to only what your infrastructure needs.
:::

## Next Steps

- [Getting Started](/guide/getting-started) - Create your first deployment
- [Usage Examples](/usage) - See common patterns
- [Configuration Reference](/config) - Full configuration options
