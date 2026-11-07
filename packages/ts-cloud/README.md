# @stacksjs/ts-cloud

A lightweight, performant infrastructure-as-code library and CLI for deploying both server-based (EC2) and serverless applications on AWS.

## Installation

```bash
bun add @stacksjs/ts-cloud
```

```bash
npm install @stacksjs/ts-cloud
```

## Usage

```typescript
import { defineStack } from '@stacksjs/ts-cloud'

const stack = defineStack({
  name: 'my-app',
  resources: {
    // Define your infrastructure
  },
})

// Deploy the stack
await stack.deploy()
```

### CLI

```bash
# Initialize a new project
cloud init

# Deploy your stack
cloud stack deploy

# Manage resources
cloud database status
cloud cdn invalidate
cloud storage list
cloud secrets set MY_SECRET value

# Monitoring & logs
cloud logs tail --stack my-app
cloud cost estimate
cloud status
```

Runtime lifecycle, exec and file-transfer commands require normal execution:
`runtime:action`, `runtime:exec`, `runtime:download` and `runtime:upload` reject
`--dry-run` before loading project configuration or creating operation state.
They do not provide a preview. Use read-only runtime inventory to inspect the
target, then use the exact workload name with `--confirm` for the operation.

## Features

- TypeScript-first infrastructure as code
- Full AWS CloudFormation support with type safety
- CLI for managing deployments, databases, CDN, storage, secrets, and more
- Server-based (EC2) and serverless deployment support
- DNS and SSL management
- Container and registry support
- Event-driven architecture (EventBridge, SNS, SQS)
- Scheduler, notifications, and email integration
- Environment and team management
- Cost estimation and analytics
- Cross-platform compiled binaries (Linux, macOS, Windows)

## License

MIT
