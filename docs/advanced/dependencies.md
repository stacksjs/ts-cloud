# Resource Dependencies

Manage dependencies between resources and stacks in ts-cloud.

## Implicit Dependencies

CloudFormation automatically detects dependencies when you reference resources:

```typescript
const template = new TemplateBuilder()
  .addResource('VPC', {
    Type: 'AWS::EC2::VPC',
    Properties: {
      CidrBlock: '10.0.0.0/16',
    },
  })
  .addResource('Subnet', {
    Type: 'AWS::EC2::Subnet',
    Properties: {
      VpcId: { Ref: 'VPC' }, // Implicit dependency on VPC
      CidrBlock: '10.0.1.0/24',
    },
  })
  .build()
```

## Explicit Dependencies

Use `DependsOn` for dependencies that aren't captured by references:

```typescript
template.addResource('WaitCondition', {
  Type: 'AWS::CloudFormation::WaitCondition',
  DependsOn: ['Instance', 'Database'], // Wait for both
  Properties: {
    Handle: { Ref: 'WaitHandle' },
    Timeout: '300',
  },
})
```

## Dependency Graph

Visualize and analyze resource dependencies:

```typescript
import { DependencyGraph } from 'ts-cloud'

const graph = new DependencyGraph(template)

// Get deployment order
const order = graph.getDeploymentOrder()
console.log('Deploy in order:', order)
// ['VPC', 'InternetGateway', 'Subnet', 'RouteTable', ...]

// Find what depends on a resource
const dependents = graph.getDependents('VPC')
console.log('Resources depending on VPC:', dependents)

// Find what a resource depends on
const dependencies = graph.getDependencies('Instance')
console.log('Instance depends on:', dependencies)

// Check for circular dependencies
const circular = graph.findCircularDependencies()
if (circular.length > 0) {
  throw new Error(`Circular dependencies: ${circular}`)
}
```

## Cross-Stack Dependencies

Reference resources across stacks:

```typescript
// network-stack.ts
export default defineStack({
  name: 'network',
  outputs: {
    VpcId: {
      Value: { Ref: 'VPC' },
      Export: { Name: 'Network-VpcId' },
    },
    SubnetIds: {
      Value: { 'Fn::Join': [',', subnetRefs] },
      Export: { Name: 'Network-SubnetIds' },
    },
  },
})

// application-stack.ts
export default defineStack({
  name: 'application',
  resources: {
    Function: {
      Type: 'AWS::Lambda::Function',
      Properties: {
        VpcConfig: {
          SubnetIds: {
            'Fn::Split': [',', { 'Fn::ImportValue': 'Network-SubnetIds' }],
          },
        },
      },
    },
  },
})
```

## Stack Dependencies

Define stack deployment order:

```typescript
// cloud.config.ts
export default {
  stacks: {
    network: './stacks/network.ts',
    database: {
      path: './stacks/database.ts',
      dependsOn: ['network'],
    },
    cache: {
      path: './stacks/cache.ts',
      dependsOn: ['network'],
    },
    application: {
      path: './stacks/application.ts',
      dependsOn: ['network', 'database', 'cache'],
    },
  },
}
```

## Parallel Deployment

Deploy independent resources in parallel:

```typescript
// These stacks have no dependencies on each other
// and will deploy in parallel
export default {
  stacks: {
    monitoring: './stacks/monitoring.ts',
    logging: './stacks/logging.ts',
    alerts: './stacks/alerts.ts',
  },
}
```

## Handling Circular Dependencies

Break circular dependencies with explicit ordering:

```typescript
// Instead of circular references, use parameters
const template = new TemplateBuilder()
  .addParameter('SecurityGroupId', { Type: 'String' })
  .addResource('Instance', {
    Type: 'AWS::EC2::Instance',
    Properties: {
      SecurityGroupIds: [{ Ref: 'SecurityGroupId' }],
    },
  })
  .build()
```

## Next Steps

- [Rollback Strategies](/advanced/rollback) - Handle deployment failures
- [CI/CD Integration](/advanced/cicd) - Automate deployments
