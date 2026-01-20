# Environment Configuration

Manage multiple environments (dev, staging, prod) with ts-cloud.

## Defining Environments

Configure environments in your `cloud.config.ts`:

```typescript
import type { CloudConfig } from 'ts-cloud'

export default {
  name: 'my-app',

  environments: {
    dev: {
      account: '111111111111',
      region: 'us-east-1',
      variables: {
        LOG_LEVEL: 'debug',
        API_URL: 'https://api-dev.example.com',
      },
    },
    staging: {
      account: '222222222222',
      region: 'us-east-1',
      variables: {
        LOG_LEVEL: 'info',
        API_URL: 'https://api-staging.example.com',
      },
    },
    prod: {
      account: '333333333333',
      region: 'us-east-1',
      variables: {
        LOG_LEVEL: 'warn',
        API_URL: 'https://api.example.com',
      },
    },
  },
} satisfies CloudConfig
```

## Environment-Specific Resources

Scale resources based on environment:

```typescript
import { defineStack, getEnvironment } from 'ts-cloud'

export default defineStack({
  name: 'application',

  resources: (ctx) => {
    const env = getEnvironment()
    const isProd = env === 'prod'

    return {
      Database: {
        Type: 'AWS::RDS::DBInstance',
        Properties: {
          DBInstanceClass: isProd ? 'db.r5.large' : 'db.t3.micro',
          MultiAZ: isProd,
          AllocatedStorage: isProd ? 100 : 20,
        },
      },

      Cache: {
        Type: 'AWS::ElastiCache::CacheCluster',
        Properties: {
          CacheNodeType: isProd ? 'cache.r5.large' : 'cache.t3.micro',
          NumCacheNodes: isProd ? 3 : 1,
        },
      },
    }
  },
})
```

## Using Conditions

Use CloudFormation conditions for environment logic:

```typescript
import { TemplateBuilder } from 'ts-cloud'

const template = new TemplateBuilder()
  .addParameter('Environment', {
    Type: 'String',
    AllowedValues: ['dev', 'staging', 'prod'],
  })
  .addCondition('IsProd', {
    'Fn::Equals': [{ Ref: 'Environment' }, 'prod'],
  })
  .addCondition('IsNotProd', {
    'Fn::Not': [{ Condition: 'IsProd' }],
  })
  .addResource('ProdOnlyAlarm', {
    Type: 'AWS::CloudWatch::Alarm',
    Condition: 'IsProd',
    Properties: {
      // Only created in production
    },
  })
  .build()
```

## Deploying to Environments

```bash
# Deploy to specific environment
cloud deploy --env dev
cloud deploy --env staging
cloud deploy --env prod

# Deploy all stacks to an environment
cloud deploy --all --env prod
```

## Environment Variables

Access environment variables in your infrastructure:

```typescript
import { Fn } from 'ts-cloud'

const template = new TemplateBuilder()
  .addResource('Function', {
    Type: 'AWS::Lambda::Function',
    Properties: {
      Environment: {
        Variables: {
          LOG_LEVEL: Fn.Ref('LogLevel'),
          DATABASE_URL: Fn.Sub('{{resolve:secretsmanager:${Environment}/database:SecretString:url}}'),
        },
      },
    },
  })
  .build()
```

## Secrets Per Environment

Manage secrets separately for each environment:

```typescript
export default {
  environments: {
    dev: {
      secrets: {
        database: 'dev/database-credentials',
        api: 'dev/api-keys',
      },
    },
    prod: {
      secrets: {
        database: 'prod/database-credentials',
        api: 'prod/api-keys',
      },
    },
  },
}
```

## Next Steps

- [Deployment](/guide/deployment) - Deployment strategies
- [CI/CD Integration](/advanced/cicd) - Automate deployments
