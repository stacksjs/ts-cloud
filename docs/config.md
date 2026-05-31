# Configuration

ts-cloud uses a `cloud.config.ts` file to define your infrastructure.

## Basic Configuration

Create a `cloud.config.ts` in your project root:

```typescript
import type { CloudConfig } from 'ts-cloud'

export default {
  name: 'my-app',
  region: 'us-east-1',

  environments: {
    dev: {
      account: '123456789012',
      region: 'us-east-1',
    },
    prod: {
      account: '987654321098',
      region: 'us-west-2',
    },
  },

  stacks: {
    network: './stacks/network.ts',
    database: './stacks/database.ts',
    application: './stacks/application.ts',
  },
} satisfies CloudConfig
```

## Configuration Options

### Core Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | required | Project name, used for resource naming |
| `region` | `string` | `'us-east-1'` | Default AWS region |
| `environments` | `object` | `{}` | Environment-specific settings |
| `stacks` | `object` | `{}` | Stack definitions |

### Environment Configuration

```typescript
environments: {
  dev: {
    account: '123456789012',
    region: 'us-east-1',
    variables: {
      LOG_LEVEL: 'debug',
    },
  },
  staging: {
    account: '123456789012',
    region: 'us-east-1',
    variables: {
      LOG_LEVEL: 'info',
    },
  },
  prod: {
    account: '987654321098',
    region: 'us-west-2',
    variables: {
      LOG_LEVEL: 'warn',
    },
  },
}
```

### Stack Configuration

```typescript
stacks: {
  // Reference external files
  network: './stacks/network.ts',

  // Or define inline
  storage: {
    resources: {
      Bucket: {
        Type: 'AWS::S3::Bucket',
        Properties: {
          BucketName: 'my-bucket',
        },
      },
    },
  },
}
```

## Static Site Configuration

For static site deployments, use `StaticSiteConfig`:

```typescript
import type { StaticSiteConfig } from 'ts-cloud'

const config: StaticSiteConfig = {
  siteName: 'my-docs',
  region: 'us-east-1',

  // Domain configuration
  domain: 'docs.example.com',
  // Or use subdomain + baseDomain
  subdomain: 'docs',
  baseDomain: 'example.com',

  // S3 configuration
  bucket: 'my-docs-bucket', // auto-generated if not specified

  // CloudFront configuration
  defaultRootObject: 'index.html',
  errorDocument: '404.html',
  cacheControl: 'max-age=31536000, public',

  // SSL/TLS
  certificateArn: 'arn:aws:acm:...', // auto-created if not specified
  hostedZoneId: 'Z1234567890', // auto-detected if not specified

  // CloudFormation
  stackName: 'my-docs-stack', // auto-generated if not specified

  // Tags
  tags: {
    Project: 'MyDocs',
    Environment: 'production',
  },
}
```

## Site Deployment Targets

Each entry in `sites` deploys to one of two **targets**, set explicitly with
`deploy` (or inferred for backward compatibility):

| `deploy` | `start` | Resolved kind | What happens |
|----------|---------|---------------|--------------|
| `'bucket'` (or unset, no `start`) | — | **bucket** | Built `root` is uploaded to object storage (S3 / Hetzner OS) and served via a CDN (CloudFront on AWS). |
| `'server'` (or unset, `start` set) | set | **server-app** | Dynamic app run as a `systemd` service. |
| `'server'` | unset | **server-static** | Static site **built and shipped to the compute box** (to `/var/www/<site>`), optionally fronted by a CDN. |

> Proxying and TLS on compute (`server`) targets are handled by the operator's
> own tooling (e.g. [rpx](https://github.com/stacksjs/rpx) for proxying +
> [tlsx](https://github.com/stacksjs/tlsx) for TLS), **not** ts-cloud. ts-cloud
> provisions the box, runs the systemd app, and ships static assets — it does
> not install or configure a reverse proxy.

Inference rules (when `deploy` is omitted): explicit `deploy` always wins; else
`start` present ⇒ `'server'`; else ⇒ `'bucket'`. This keeps every existing
config working unchanged — a legacy `start` site still deploys to compute, and a
legacy static site still deploys to a bucket.

```typescript
const config: CloudConfig = {
  project: { name: 'Example', slug: 'example', region: 'us-east-1' },
  environments: { production: { type: 'production' } },

  // The server-targeted sites need a compute box to land on.
  infrastructure: {
    compute: { mode: 'server' },
  },

  sites: {
    // Dynamic SSR app → systemd service (proxied by the operator's own rpx)
    app: {
      root: '.output',
      domain: 'example.com',
      start: 'bun run server.ts',
      port: 3000,
    },

    // Docs built AND shipped to the same box (served by the operator's proxy)
    docs: {
      root: 'docs/.vitepress/dist',
      domain: 'docs.example.com',
      deploy: 'server',
      build: 'bun run docs:build',
      cache: { enabled: true, maxAge: 3600 },
    },

    // Blog, also served on the box
    blog: {
      root: 'blog/dist',
      domain: 'blog.example.com',
      deploy: 'server',
    },

    // Classic static site → object storage + CDN
    marketing: {
      root: 'marketing/dist',
      domain: 'www.example.com',
      // deploy omitted ⇒ inferred 'bucket'
    },
  },
}
```

### Server-optional contract

A project with only `bucket` sites needs **no** compute server and validates
clean. If a site targets a server (`deploy: 'server'`, or `start` set) but no
`infrastructure.compute` is configured, `cloud deploy` aborts up front with an
actionable error instead of failing silently at runtime — set `deploy: 'bucket'`
or add a server.

### CDN / caching

The `cache` hint applies to either origin:

- **bucket** — front the origin with a CDN (CloudFront on AWS).
- **server-static** — `cache.enabled` / `cache.maxAge` express the intended
  edge caching; the actual `Cache-Control` headers are configured in the
  operator's own proxy (rpx + tlsx), not by ts-cloud.

On **AWS**, a server origin can sit behind CloudFront via the existing
compute-origin routing. On **Hetzner** there is no native CDN — you can place
CloudFront / Cloudflare / bunny in front of the box yourself. ts-cloud does not
provision a Hetzner CDN.

## Preset Configuration

### Static Site Preset

```typescript
import { createStaticSitePreset } from 'ts-cloud/presets'

export default createStaticSitePreset({
  name: 'My Website',
  slug: 'my-website',
  domain: 'example.com',

  // Optional overrides
  cdn: {
    priceClass: 'PriceClass_100', // US & Europe only
  },
})
```

### Full-Stack Preset

```typescript
import { createFullStackAppPreset } from 'ts-cloud/presets'

export default createFullStackAppPreset({
  name: 'My App',
  slug: 'my-app',
  domain: 'app.example.com',
  apiSubdomain: 'api.example.com',

  // Compute configuration
  compute: {
    cpu: 512,
    memory: 1024,
    desiredCount: 2,
  },

  // Database configuration
  database: {
    engine: 'postgres',
    instanceClass: 'db.t3.medium',
    allocatedStorage: 20,
    multiAz: true,
  },

  // Cache configuration
  cache: {
    engine: 'redis',
    nodeType: 'cache.t3.micro',
    numNodes: 1,
  },
})
```

### API Backend Preset

```typescript
import { createApiBackendPreset } from 'ts-cloud/presets'

export default createApiBackendPreset({
  name: 'My API',
  slug: 'my-api',
  domain: 'api.example.com',

  // Lambda configuration
  lambda: {
    runtime: 'nodejs20.x',
    memorySize: 256,
    timeout: 30,
  },

  // DynamoDB configuration
  dynamodb: {
    billingMode: 'PAY_PER_REQUEST',
    tables: [
      { name: 'users', partitionKey: 'id' },
      { name: 'orders', partitionKey: 'userId', sortKey: 'createdAt' },
    ],
  },
})
```

## Environment Variables

ts-cloud reads credentials from environment variables:

| Variable | Description |
|----------|-------------|
| `AWS_ACCESS_KEY_ID` | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key |
| `AWS_DEFAULT_REGION` | Default region |
| `AWS_PROFILE` | Named profile from `~/.aws/credentials` |
| `AWS_SESSION_TOKEN` | Session token for temporary credentials |

## TypeScript Configuration

For best type checking, add ts-cloud to your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "types": ["@stacksjs/ts-cloud"]
  }
}
```

## Next Steps

- [Getting Started](/guide/getting-started) - Create your first stack
- [Providers](/guide/providers) - AWS resource builders
- [Deployment](/guide/deployment) - Deploy your infrastructure
