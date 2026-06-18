# Getting Started

ts-cloud is an Infrastructure as Code library for TypeScript that generates AWS CloudFormation templates.

## Installation

::: code-group

```sh [npm]
npm install ts-cloud
```

```sh [pnpm]
pnpm add ts-cloud
```

```sh [bun]
bun add ts-cloud
```

:::

## Basic Usage

### Creating a Stack

```typescript
import { CloudFormation } from '@stacksjs/ts-cloud'

const stack = new CloudFormation('my-app-stack', {
  Description: 'My application infrastructure',
})

// Add resources
stack.addResource('MyResource', {
  Type: 'AWS::S3::Bucket',
  Properties: {
    BucketName: 'my-bucket',
  },
})

// Generate template
const template = stack.toJSON()
```

### Template Builder

Use the fluent template builder API:

```typescript
import { TemplateBuilder } from '@stacksjs/ts-cloud'

const template = new TemplateBuilder()
  .description('My infrastructure')
  .addParameter('Environment', {
    Type: 'String',
    Default: 'dev',
    AllowedValues: ['dev', 'staging', 'prod'],
  })
  .addResource('VPC', {
    Type: 'AWS::EC2::VPC',
    Properties: {
      CidrBlock: '10.0.0.0/16',
      EnableDnsHostnames: true,
      Tags: [
        { Key: 'Name', Value: { Ref: 'AWS::StackName' } },
      ],
    },
  })
  .addOutput('VpcId', {
    Value: { Ref: 'VPC' },
    Export: { Name: 'VpcId' },
  })
  .build()
```

## Intrinsic Functions

Use CloudFormation intrinsic functions:

```typescript
import { Fn, Pseudo } from '@stacksjs/ts-cloud'

const template = new TemplateBuilder()
  .addResource('Bucket', {
    Type: 'AWS::S3::Bucket',
    Properties: {
      // Reference parameter
      BucketName: Fn.Sub('${Environment}-${AppName}-bucket'),

      // Join strings
      Tags: [
        {
          Key: 'FullName',
          Value: Fn.Join('-', [
            Pseudo.StackName,
            'bucket',
          ]),
        },
      ],
    },
  })
  .build()
```

### Available Functions

```typescript
// Reference
Fn.Ref('ResourceName')

// Get attribute
Fn.GetAtt('ResourceName', 'AttributeName')

// Join
Fn.Join('-', ['a', 'b', 'c'])

// Sub (substitute)
Fn.Sub('${AWS::StackName}-resource')

// If condition
Fn.If('ConditionName', 'trueValue', 'falseValue')

// Select from list
Fn.Select(0, ['a', 'b', 'c'])

// Split string
Fn.Split(',', 'a,b,c')

// Base64 encode
Fn.Base64('string')

// Pseudo parameters
Pseudo.StackName
Pseudo.StackId
Pseudo.Region
Pseudo.AccountId
```

## Resource Naming

Generate consistent resource names:

```typescript
import { ResourceNaming } from '@stacksjs/ts-cloud'

const naming = new ResourceNaming({
  prefix: 'myapp',
  environment: 'prod',
  separator: '-',
})

const bucketName = naming.name('assets')
// 'myapp-prod-assets'

const functionName = naming.name('handler', { suffix: 'lambda' })
// 'myapp-prod-handler-lambda'
```

## Configuration File

Create a `cloud.config.ts` file:

```typescript
import type { CloudConfig } from '@stacksjs/ts-cloud'

export default {
  project: { name: 'My App', slug: 'my-app', region: 'us-east-1' },
  environments: {
    staging: { type: 'staging' },
    production: { type: 'production', domain: 'my-app.com' },
  },
} satisfies Partial<CloudConfig>
```

What you add to this config decides what deploys — a serverless `app`, an
`infrastructure.compute` server + `sites`, or managed AWS resources. See the
[Configuration reference](/config) for the full shape, and the
[Serverless](/features/serverless) / [Laravel](/features/laravel) pages for the
two app models.

> Most users never hand-write CloudFormation — the config + presets generate it.
> If you need to drop down to raw resources, the CloudFormation builders
> (`CloudFormationBuilder`, the `S3Bucket`/`Lambda`/etc. builders) and
> `validateTemplate` are exported for that.

## Template Validation

When building templates programmatically, validate them before deployment:

```typescript
import { validateTemplate, validateResourceLimits } from '@stacksjs/ts-cloud'

const template = stack.toJSON()

// Validate template structure
const result = validateTemplate(template)
if (!result.valid) {
  console.error('Validation errors:', result.errors)
}

// Check resource limits
const limitsResult = validateResourceLimits(template)
if (!limitsResult.valid) {
  console.warn('Resource limit warnings:', limitsResult.warnings)
}
```

## Dependency Graph

Visualize resource dependencies:

```typescript
import { DependencyGraph } from '@stacksjs/ts-cloud'

const graph = new DependencyGraph(template)

// Get deployment order
const order = graph.getDeploymentOrder()
console.log('Deploy in order:', order)

// Check for circular dependencies
const circular = graph.findCircularDependencies()
if (circular.length > 0) {
  console.error('Circular dependencies found:', circular)
}
```

## Stack Diff

Compare templates before deployment:

```typescript
import { diffStacks } from '@stacksjs/ts-cloud'

const currentTemplate = await loadCurrentTemplate()
const newTemplate = stack.toJSON()

const diff = diffStacks(currentTemplate, newTemplate)

console.log('Resources to add:', diff.added)
console.log('Resources to remove:', diff.removed)
console.log('Resources to update:', diff.modified)
```

## CLI Commands

```bash
# Initialize a project (interactive, or pass --name)
cloud init --name my-project

# Generate CloudFormation templates
cloud generate

# Validate the cloud.config
cloud config:validate

# Show a diff against deployed infrastructure
cloud diff

# Deploy an environment (server or serverless, per your config)
cloud deploy --env production

# Tear down a CloudFormation stack
cloud stack:delete my-project-production
```

See the [CLI reference](/cli) for the full command surface.

## Next Steps

- [Cloud Providers](/guide/providers) - AWS resource types
- [Deployment](/guide/deployment) - Deploy infrastructure
