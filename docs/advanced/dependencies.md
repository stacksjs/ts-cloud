# Resource Dependencies

How resources are ordered and wired together in the CloudFormation templates ts-cloud generates.

ts-cloud follows CloudFormation's dependency model: dependencies are expressed through intrinsic-function references (`Ref`, `Fn::GetAtt`) and explicit `DependsOn`, and CloudFormation creates resources in the resulting order. When you write a `cloud.config.ts`, the builders handle this for you. When you build templates by hand, you control it directly.

## Intrinsic Function Helpers

`@ts-cloud/core` exports an `Fn` helper for the CloudFormation intrinsic functions. Its methods are camelCase and return the raw `{ "Fn::..." }` / `{ "Ref": ... }` objects CloudFormation expects:

```typescript
import { Fn } from '@stacksjs/ts-cloud'

Fn.ref('VPC') // => { Ref: 'VPC' }
Fn.getAtt('Instance', 'PublicIp') // => { 'Fn::GetAtt': ['Instance', 'PublicIp'] }
Fn.sub('${AWS::StackName}-bucket') // => { 'Fn::Sub': '${AWS::StackName}-bucket' }
Fn.join(',', [Fn.ref('SubnetA'), Fn.ref('SubnetB')])
Fn.split(',', '10.0.1.0/24,10.0.2.0/24')
Fn.importValue('Network-SubnetIds')
```

There is also an `Arn` helper for common ARN patterns and a `Pseudo` object for pseudo-parameters (`Pseudo.Region`, `Pseudo.AccountId`, …).

## Implicit Dependencies

When one resource references another with `Fn.ref` or `Fn.getAtt`, CloudFormation infers the dependency and creates the referenced resource first — no `DependsOn` needed:

```typescript
import { Fn, TemplateBuilder } from '@stacksjs/ts-cloud'

const template = new TemplateBuilder('Network')
  .addResource('VPC', {
    Type: 'AWS::EC2::VPC',
    Properties: {
      CidrBlock: '10.0.0.0/16',
    },
  })
  .addResource('Subnet', {
    Type: 'AWS::EC2::Subnet',
    Properties: {
      VpcId: Fn.ref('VPC'), // implicit dependency on VPC
      CidrBlock: '10.0.1.0/24',
    },
  })
  .build()
```

`TemplateBuilder` is a thin, chainable builder: `addResource`, `addResources`, `addParameter`, `addOutput`, `build()`, `toJSON()`. It does not reorder resources — CloudFormation resolves creation order from the references at deploy time.

## Explicit Dependencies

Use `DependsOn` for ordering that isn't captured by a reference (for example, an IAM policy that must exist before an instance that uses it, or a wait condition):

```typescript
template.addResource('WaitCondition', {
  Type: 'AWS::CloudFormation::WaitCondition',
  DependsOn: ['Instance', 'Database'], // wait for both
  Properties: {
    Handle: Fn.ref('WaitHandle'),
    Timeout: '300',
  },
})
```

`DependsOn` accepts a single logical ID (`string`) or an array of them.

### From the High-Level Builder

When you build a template from a `CloudConfig`, `CloudFormationBuilder.addResource(...)` takes a `dependsOn` option and tracks it so circular dependencies can be detected:

```typescript
import { CloudFormationBuilder } from '@stacksjs/ts-cloud'

const builder = new CloudFormationBuilder(config)

builder.addResource('AppInstance', 'AWS::EC2::Instance', {
  ImageId: 'ami-0abc',
  InstanceType: 't3.micro',
}, {
  dependsOn: 'InstanceProfile',
})
```

During `build()`, the builder runs a topological pass over the tracked dependencies and throws `Circular dependency detected involving resource: <id>` if it finds a cycle.

## Dependency Graph

`DependencyGraph` analyzes a set of resources, deriving dependencies from both `DependsOn` and any `Ref` / `Fn::GetAtt` found in a resource's `Properties` (AWS pseudo-parameters like `AWS::Region` are ignored):

```typescript
import { DependencyGraph } from '@stacksjs/ts-cloud'

const graph = new DependencyGraph()

graph.addResource('VPC', { Type: 'AWS::EC2::VPC', Properties: { CidrBlock: '10.0.0.0/16' } })
graph.addResource('Subnet', {
  Type: 'AWS::EC2::Subnet',
  Properties: { VpcId: { Ref: 'VPC' }, CidrBlock: '10.0.1.0/24' },
})

// Creation order (dependencies first); throws on a circular dependency
const order = graph.topologicalSort()
// => ['VPC', 'Subnet']

// Validate that every referenced resource actually exists
graph.validate() // throws: Resource "X" depends on "Y" which does not exist

// Find which resources depend on a given one
const dependents = graph.getDependents('VPC')
// => ['Subnet']
```

Available methods: `addResource(logicalId, resource)`, `topologicalSort()`, `validate()`, and `getDependents(logicalId)`.

## Cross-Stack Dependencies

To share a value from one stack with another, export it as a stack output and import it elsewhere with `Fn.importValue`. Exports are stack outputs that declare an `Export.Name`:

```typescript
// Network stack — export the subnet IDs
const network = new TemplateBuilder('Network')
  .addResource('VPC', { Type: 'AWS::EC2::VPC', Properties: { CidrBlock: '10.0.0.0/16' } })
  .addOutput('SubnetIds', {
    Value: Fn.join(',', [Fn.ref('SubnetA'), Fn.ref('SubnetB')]),
    Export: { Name: 'Network-SubnetIds' },
  })
  .build()

// Application stack — import them
const app = new TemplateBuilder('Application')
  .addResource('Function', {
    Type: 'AWS::Lambda::Function',
    Properties: {
      VpcConfig: {
        SubnetIds: Fn.split(',', Fn.importValue('Network-SubnetIds')),
      },
    },
  })
  .build()
```

The exporting stack must be deployed before the importing one, and CloudFormation will block deletion of an export while another stack still imports it.

## Breaking Circular Dependencies

CloudFormation cannot deploy a cycle (and `CloudFormationBuilder` / `DependencyGraph` will throw if they detect one). Break the cycle by passing one side in as a parameter instead of referencing it directly:

```typescript
import { Fn, TemplateBuilder } from '@stacksjs/ts-cloud'

const template = new TemplateBuilder('App')
  .addParameter('SecurityGroupId', { Type: 'AWS::EC2::SecurityGroup::Id' })
  .addResource('Instance', {
    Type: 'AWS::EC2::Instance',
    Properties: {
      SecurityGroupIds: [Fn.ref('SecurityGroupId')],
    },
  })
  .build()
```

## Next Steps

- [Rollback Strategies](/advanced/rollback) — handle deployment failures
- [CI/CD Integration](/advanced/cicd) — automate deployments
