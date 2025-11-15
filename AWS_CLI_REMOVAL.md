# AWS CLI Removal - Direct API Implementation

## Overview
This document tracks the migration from AWS CLI commands to direct AWS API calls using AWS Signature Version 4 authentication.

## Benefits
- **No External Dependencies**: Eliminates requirement for AWS CLI installation
- **Faster Execution**: Direct HTTPS requests vs spawning processes
- **Better Error Handling**: Parse API responses directly
- **More Control**: Fine-grained request/response handling

## Implementation Status

### ✅ Completed
1. **AWS API Client** (`src/aws/client.ts`)
   - AWS Signature Version 4 implementation
   - Request signing and authentication
   - XML/JSON response parsing
   - Error handling

2. **CloudFormation Client** (REFACTORED)
   - All stack operations use direct API calls
   - createStack, updateStack, deleteStack
   - describeStacks, describeStackEvents
   - Change sets, validation, templates
   - Wait for stack completion

3. **ElastiCache Client** (REFACTORED)
   - Cache cluster management
   - Replication groups
   - Reboot operations

### 🔄 In Progress / TODO
4. **SQS Client** - Needs refactoring to use `AWSClient`
5. **Scheduler/EventBridge Client** - Needs refactoring to use `AWSClient`
6. **S3 Client** - Needs refactoring to use `AWSClient`
7. **CloudFront Client** - Needs refactoring to use `AWSClient`

## Migration Guide

### Before (AWS CLI)
```typescript
private async executeCommand(args: string[]): Promise<any> {
  const proc = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()

  if (proc.exitCode !== 0) {
    throw new Error(`AWS CLI Error: ${stderr || stdout}`)
  }

  return JSON.parse(stdout)
}
```

### After (Direct API)
```typescript
async createStack(options: CreateStackOptions): Promise<{ StackId: string }> {
  const params: Record<string, any> = {
    Action: 'CreateStack',
    StackName: options.stackName,
    Version: '2010-05-15',
  }

  const result = await this.client.request({
    service: 'cloudformation',
    region: this.region,
    method: 'POST',
    path: '/',
    body: new URLSearchParams(params).toString(),
  })

  return { StackId: result.StackId }
}
```

## AWS Signature V4 Process

1. **Canonical Request**: Normalize HTTP request
2. **String to Sign**: Create signing string with timestamp and scope
3. **Signing Key**: Derive key from secret access key
4. **Signature**: HMAC-SHA256 hash of string to sign
5. **Authorization Header**: Add signature to request

## Required Environment Variables

```bash
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_SESSION_TOKEN=your-session-token  # Optional
```

## Next Steps

1. Refactor SQS client (sqs.ts)
2. Refactor Scheduler client (scheduler.ts)
3. Refactor S3 client (s3.ts) - Critical for deployments
4. Refactor CloudFront client (cloudfront.ts)
5. Test all API clients thoroughly
6. Update documentation

## Testing

All existing tests should continue to pass. The refactoring maintains the same interfaces and return types, only changing the internal implementation.

```bash
bun test packages/core/test/
bun test packages/ts-cloud/test/  # If tests exist
```

## API References

- [AWS Signature Version 4](https://docs.aws.amazon.com/general/latest/gr/signature-version-4.html)
- [CloudFormation API](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/)
- [ElastiCache API](https://docs.aws.amazon.com/AmazonElastiCache/latest/APIReference/)
- [SQS API](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/)
- [EventBridge API](https://docs.aws.amazon.com/eventbridge/latest/APIReference/)
- [S3 API](https://docs.aws.amazon.com/AmazonS3/latest/API/)
- [CloudFront API](https://docs.aws.amazon.com/cloudfront/latest/APIReference/)
