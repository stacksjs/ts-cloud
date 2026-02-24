# ts-cloud-core

Core CloudFormation generation library for ts-cloud. Provides the foundational building blocks for defining and generating AWS CloudFormation templates programmatically in TypeScript.

## Installation

```bash
bun add ts-cloud-core
```

```bash
npm install ts-cloud-core
```

## Usage

```typescript
import { defineStack, Resource } from 'ts-cloud-core'

// Define a CloudFormation stack using TypeScript
const stack = defineStack({
  name: 'my-app-stack',
  resources: {
    // Define your AWS resources here
  },
})
```

## Features

- Programmatic CloudFormation template generation
- Full TypeScript type safety via `ts-cloud-aws-types`
- Support for compute, storage, networking, database, CDN, DNS, and more
- Auth, security, and permissions abstractions
- Messaging, queue, and event integrations
- Monitoring, logging, and workflow support
- Container and registry resource definitions
- Template validation

## License

MIT
