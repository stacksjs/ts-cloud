# Multi-Region Deployments

Deploy your infrastructure across multiple AWS regions for high availability and low latency.

ts-cloud ships a `MultiRegionManager` that orchestrates a single `CloudConfig` across several regions, deploying the primary region first and the rest in parallel, then optionally wiring up global resources (Route 53, CloudFront, WAF), cross-region replication (S3, DynamoDB global tables, Secrets Manager), and failover routing.

## Basic Multi-Region Setup

`MultiRegionManager.deploy()` takes your `CloudConfig` plus a `MultiRegionConfig` describing the regions:

```typescript
import { MultiRegionManager } from '@stacksjs/ts-cloud'
import config from './cloud.config'

const manager = new MultiRegionManager()

const deployment = await manager.deploy(config, {
  regions: [
    { code: 'us-east-1', name: 'US East', isPrimary: true },
    { code: 'us-west-2', name: 'US West' },
    { code: 'eu-west-1', name: 'EU West' },
  ],
})

console.log(deployment.id, deployment.status)
for (const region of deployment.regions) {
  console.log(region.region, region.status, region.outputs)
}
```

Each region's stack is named `{project.slug}-{region}` (e.g. `my-app-us-east-1`). The region marked `isPrimary: true` deploys first; if none is marked, the first entry is treated as primary. Secondary regions then deploy concurrently.

A ready-made singleton is also exported:

```typescript
import { multiRegionManager } from '@stacksjs/ts-cloud'

const deployment = await multiRegionManager.deploy(config, { regions: [/* … */] })
```

## The `MultiRegionConfig` shape

```typescript
interface MultiRegionConfig {
  regions: Array<{
    code: string // e.g. 'us-east-1'
    name: string // human-readable label
    isPrimary?: boolean // deploy this region first
    weight?: number // traffic weight for CloudFront origins
  }>
  globalResources?: {
    route53?: boolean
    cloudfront?: boolean
    waf?: boolean
  }
  replication?: {
    s3?: boolean
    dynamodb?: boolean
    secrets?: boolean
  }
  failover?: {
    enabled: boolean
    healthCheckPath?: string
    failoverThreshold?: number
  }
}
```

## Global Resources

Set the `globalResources` flags to provision the global, latency- and health-aware routing layer in front of your regional stacks:

```typescript
await manager.deploy(config, {
  regions: [
    { code: 'us-east-1', name: 'US East', isPrimary: true },
    { code: 'eu-west-1', name: 'EU West' },
  ],
  globalResources: {
    route53: true, // health checks + record sets per region
    cloudfront: true, // distribution with weighted regional origins
    waf: true, // global Web ACL
  },
})
```

## Active-Active Setup

Run your application in multiple regions simultaneously and front them with Route 53 + CloudFront. The per-region `weight` controls how traffic is distributed across the CloudFront origins:

```typescript
await manager.deploy(config, {
  regions: [
    { code: 'us-east-1', name: 'US East', isPrimary: true, weight: 100 },
    { code: 'us-west-2', name: 'US West', weight: 100 },
    { code: 'eu-west-1', name: 'EU West', weight: 100 },
  ],
  globalResources: { route53: true, cloudfront: true },
})
```

## Active-Passive (Failover)

Enable `failover` for a standby region used for disaster recovery. Route 53 health checks watch `healthCheckPath` and fail over to the secondary region when the primary is unhealthy:

```typescript
await manager.deploy(config, {
  regions: [
    { code: 'us-east-1', name: 'Primary', isPrimary: true },
    { code: 'us-west-2', name: 'Standby' },
  ],
  globalResources: { route53: true },
  failover: {
    enabled: true,
    healthCheckPath: '/health',
    failoverThreshold: 3,
  },
})
```

## Data Replication

Enable cross-region replication for stateful resources:

```typescript
await manager.deploy(config, {
  regions: [
    { code: 'us-east-1', name: 'US East', isPrimary: true },
    { code: 'us-west-2', name: 'US West' },
  ],
  replication: {
    s3: true, // S3 cross-region replication between regional buckets
    dynamodb: true, // DynamoDB global tables across all regions
    secrets: true, // Secrets Manager replicas in every region
  },
})
```

## Inspecting and Tearing Down

The manager keeps deployment state in memory keyed by the generated deployment id:

```typescript
const deployment = await manager.deploy(config, { regions: [/* … */] })

// Look up status later
manager.getDeployment(deployment.id)
manager.listDeployments()

// Destroy global resources, then all regional stacks in parallel
await manager.destroy(deployment.id)
```

A `RegionDeployment` reports `status` (`pending` | `deploying` | `deployed` | `failed` | `rolling-back`), `stackName`, `outputs`, and timing for each region.

## Choosing Regions

ts-cloud also exports region metadata helpers to pick regions programmatically:

```typescript
import {
  getRegion,
  getAllRegions,
  getClosestRegion,
  getRegionsByCompliance,
  getRegionsByPricingTier,
  isValidRegion,
} from '@stacksjs/ts-cloud'

getRegion('us-east-1') // RegionInfo | undefined
isValidRegion('eu-west-1') // true
getClosestRegion({ continent: 'Europe' }) // nearest RegionInfo
getRegionsByPricingTier('reduced') // cheaper regions
```

## Per-Environment Regions

For a simpler single-stack setup, you don't need the multi-region manager at all — you can give each environment its own region in `cloud.config.ts`. See [Environment Config](/features/environments).

## Next Steps

- [Environment Config](/features/environments) - Managing environments
- [Deployment](/guide/deployment) - Deployment strategies
