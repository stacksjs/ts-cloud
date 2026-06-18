# Environment Configuration

Manage multiple environments (development, staging, production) with ts-cloud.

A `CloudConfig` has a single `project` block plus an `environments` map. Each entry is keyed by name and described by an `EnvironmentConfig`. The `type` field is required and must be one of `'production' | 'staging' | 'development'`.

## Defining Environments

Configure environments in your `cloud.config.ts`:

```typescript
import type { CloudConfig } from '@stacksjs/ts-cloud'

export default {
  project: {
    name: 'My App',
    slug: 'my-app',
    region: 'us-east-1',
  },

  environments: {
    development: {
      type: 'development',
      variables: {
        LOG_LEVEL: 'debug',
        API_URL: 'https://api-dev.example.com',
      },
    },
    staging: {
      type: 'staging',
      domain: 'staging.example.com',
      variables: {
        LOG_LEVEL: 'info',
        API_URL: 'https://api-staging.example.com',
      },
    },
    production: {
      type: 'production',
      domain: 'example.com',
      variables: {
        LOG_LEVEL: 'warn',
        API_URL: 'https://api.example.com',
      },
    },
  },
} satisfies CloudConfig
```

There is no top-level `name`, `region`, or `stacks` — those live under `project`. There is no per-environment `account` field, and no environment-level `secrets` map (for serverless apps, secrets live under `environments.<env>.app.secrets`, shown below).

## The `EnvironmentConfig` shape

```typescript
interface EnvironmentConfig {
  type: 'production' | 'staging' | 'development'
  region?: string // override project.region for this environment
  variables?: Record<string, string> // plain env vars
  domain?: string // custom domain for this environment
  infrastructure?: Partial<InfrastructureConfig> // per-env infra overrides
  app?: ServerlessAppConfig // serverless app manifest (opt-in)
}
```

## Per-Environment Domains

Give each environment its own domain. Sites and serverless apps use this to wire up certificates and DNS:

```typescript
environments: {
  staging: { type: 'staging', domain: 'staging.example.com' },
  production: { type: 'production', domain: 'example.com' },
}
```

## Environment-Specific Infrastructure

The `infrastructure` key on an environment is a `Partial<InfrastructureConfig>` merged over the top-level `infrastructure`. Use it to scale resources up in production and keep them small in development:

```typescript
import type { CloudConfig } from '@stacksjs/ts-cloud'

export default {
  project: { name: 'My App', slug: 'my-app', region: 'us-east-1' },

  // Shared defaults for all environments
  infrastructure: {
    compute: { instances: 1, instanceType: 't3.micro' },
    database: 'postgres',
  },

  environments: {
    development: {
      type: 'development',
      // inherits the small defaults above
    },
    production: {
      type: 'production',
      domain: 'example.com',
      infrastructure: {
        compute: {
          instances: 3,
          instanceType: 't3.large',
          autoScaling: { min: 2, max: 10, scaleUpThreshold: 70 },
        },
      },
    },
  },
} satisfies CloudConfig
```

## Per-Environment Regions

Override the project's default region for a specific environment:

```typescript
project: { name: 'My App', slug: 'my-app', region: 'us-east-1' },

environments: {
  staging: { type: 'staging' }, // us-east-1 (project default)
  production: { type: 'production', region: 'eu-west-1' },
}
```

For deploying one config across *many* regions at once, see [Multi-Region](/features/multi-region).

## Deploying to an Environment

The CLI selects the environment with `--env`. It defaults to `staging` when omitted, and accepts `production`, `staging`, or `development`:

```bash
# Deploy a specific environment
cloud deploy --env development
cloud deploy --env staging
cloud deploy --env production
```

The main CloudFormation stack is named `{project.slug}-{environment}` (e.g. `my-app-production`), unless you override it with `project.stackName`. `cloud deploy --env production` also loads an environment-specific dotenv file (e.g. `.env.production`) before reading config.

## Serverless App Secrets

For serverless (Lambda) applications, the app manifest lives under `environments.<env>.app`. Secrets are resolved from Secrets Manager / SSM at deploy time and injected as environment variables — there is no environment-level `secrets` map:

```typescript
environments: {
  production: {
    type: 'production',
    domain: 'app.example.com',
    app: {
      runtime: 'nodejs20.x',
      entry: 'src/server.ts',
      memory: 1024,
      // plaintext env vars
      env: { APP_ENV: 'production' },
      // names resolved from Secrets Manager / SSM at deploy time
      secrets: ['DATABASE_URL', 'STRIPE_SECRET'],
      // or a name → source map
      // secrets: { DATABASE_URL: 'prod/database-url' },
    },
  },
}
```

## Next Steps

- [Multi-Region](/features/multi-region) - Deploying across regions
- [Deployment](/guide/deployment) - Deployment strategies
