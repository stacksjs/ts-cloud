# Custom Providers

Extend ts-cloud with custom resource providers for specialized use cases.

## Creating a Custom Provider

```typescript
import { defineProvider, type ResourceDefinition } from 'ts-cloud'

export const myCustomProvider = defineProvider({
  name: 'my-provider',
  version: '1.0.0',

  resources: {
    MyCustomResource: {
      create: async (props: MyResourceProps) => {
        // Create the resource
        return { id: 'resource-id', outputs: {} }
      },

      update: async (id: string, props: MyResourceProps) => {
        // Update the resource
        return { outputs: {} }
      },

      delete: async (id: string) => {
        // Delete the resource
      },
    },
  },
})
```

## Using Custom Resources

Register and use your custom provider:

```typescript
import { CloudFormationBuilder } from 'ts-cloud'
import { myCustomProvider } from './providers/my-provider'

const builder = new CloudFormationBuilder({
  providers: [myCustomProvider],
})

builder.addResource('MyResource', {
  Type: 'MyProvider::MyCustomResource',
  Properties: {
    // Your custom properties
  },
})
```

## CloudFormation Custom Resources

Create Lambda-backed custom resources:

```typescript
import { CustomResource } from 'ts-cloud'

const customResource = new CustomResource({
  serviceToken: lambdaArn,
  properties: {
    Action: 'CreateUser',
    Username: 'admin',
  },
})

// In your Lambda handler
export async function handler(event: CloudFormationCustomResourceEvent) {
  switch (event.RequestType) {
    case 'Create':
      // Handle create
      break
    case 'Update':
      // Handle update
      break
    case 'Delete':
      // Handle delete
      break
  }

  return {
    PhysicalResourceId: 'unique-id',
    Data: {
      OutputKey: 'OutputValue',
    },
  }
}
```

## Provider Hooks

Add lifecycle hooks to providers:

```typescript
export const myProvider = defineProvider({
  name: 'my-provider',

  hooks: {
    beforeCreate: async (resource) => {
      // Validate or transform before creation
      console.log('Creating:', resource.name)
    },

    afterCreate: async (resource, result) => {
      // Post-creation actions
      console.log('Created:', result.id)
    },

    beforeDelete: async (resource) => {
      // Cleanup before deletion
    },
  },

  resources: {
    // ...
  },
})
```

## Third-Party Integrations

Example: Stripe integration provider:

```typescript
export const stripeProvider = defineProvider({
  name: 'stripe',

  resources: {
    Product: {
      create: async (props) => {
        const product = await stripe.products.create({
          name: props.name,
          description: props.description,
        })
        return { id: product.id, outputs: { productId: product.id } }
      },
      // ...
    },

    Price: {
      create: async (props) => {
        const price = await stripe.prices.create({
          product: props.productId,
          unit_amount: props.amount,
          currency: props.currency,
        })
        return { id: price.id, outputs: { priceId: price.id } }
      },
      // ...
    },
  },
})
```

## Next Steps

- [Resource Dependencies](/advanced/dependencies) - Managing dependencies
- [Rollback Strategies](/advanced/rollback) - Handling failures
