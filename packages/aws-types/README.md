# ts-cloud-aws-types

AWS CloudFormation resource type definitions for TypeScript, without any dependency on the AWS SDK.

## Installation

```bash
bun add ts-cloud-aws-types
```

```bash
npm install ts-cloud-aws-types
```

## Usage

```typescript
import type {
  EC2Instance,
  S3Bucket,
  LambdaFunction,
  Route53HostedZone,
} from 'ts-cloud-aws-types'

// Use fully typed AWS resource definitions
const instance: EC2Instance = {
  Type: 'AWS::EC2::Instance',
  Properties: {
    InstanceType: 't3.micro',
    ImageId: 'ami-0abcdef1234567890',
  },
}
```

## Features

- Comprehensive TypeScript type definitions for AWS CloudFormation resources
- Covers a wide range of AWS services (EC2, S3, Lambda, ECS, RDS, Route53, CloudWatch, SNS, SQS, and many more)
- Zero runtime dependencies -- types only
- No AWS SDK required
- Used internally by `ts-cloud-core` and `@stacksjs/ts-cloud`

## License

MIT
