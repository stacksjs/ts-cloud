# Providers & the Driver Architecture

ts-cloud does **not** have a pluggable, user-defined provider API. There is no `defineProvider`, no `create`/`update`/`delete` resource lifecycle, and no provider registry you extend from your own code. Instead, the supported providers are built in, and you select them through configuration.

This page documents the real provider model: how a provider is chosen, what the internal driver abstraction looks like, and where you'd hook in if you wanted to add a provider to the framework itself.

## How a provider is selected

You pick a compute provider in `cloud.config.ts` via `cloud.provider` (`'aws'` | `'hetzner'`) and object storage via `objectStorage.provider`. See [Cloud Providers](/guide/providers) for the full config reference.

At runtime, ts-cloud resolves the compute provider with `resolveCloudProvider(config)`:

```typescript
import { resolveCloudProvider } from '@stacksjs/ts-cloud'

const provider = resolveCloudProvider(config)
// 1. config.cloud.provider, if set
// 2. 'hetzner' if config.hetzner.apiToken is present
// 3. 'aws' otherwise
```

## The `CloudDriver` abstraction

Internally, each provider is a **driver** implementing the `CloudDriver` interface. A driver abstracts compute provisioning and Forge-style app deploys across providers (AWS EC2 + SSM + S3, Hetzner Cloud + SSH). DNS stays provider-agnostic via a separate `DnsProvider` abstraction.

The interface (from `packages/core/src/drivers/types.ts`):

```typescript
export interface CloudDriver {
  readonly name: CloudProviderName            // 'aws' | 'hetzner'
  readonly usesCloudFormation: boolean        // true for AWS, false for Hetzner

  // Provision compute (Hetzner). AWS uses InfrastructureGenerator + CloudFormation.
  provisionComputeInfrastructure?(options: ProvisionComputeOptions): Promise<ComputeStackOutputs>

  // Tear down the lightweight single-server compute provisioned above.
  destroyCompute?(options: ProvisionComputeOptions): Promise<{ destroyed: string[] }>

  // Read outputs needed for deploy (stack outputs, state file, or live API).
  getComputeOutputs(options: ProvisionComputeOptions): Promise<ComputeStackOutputs>

  // Upload a release tarball to provider-specific staging storage.
  uploadRelease(options: UploadReleaseOptions): Promise<UploadReleaseResult>

  // Find compute targets matching project tags/labels.
  findComputeTargets(options: FindComputeTargetsOptions): Promise<ComputeTarget[]>

  // Run a shell script on every target (SSM, SSH, etc.).
  runRemoteDeploy(options: RunRemoteDeployOptions): Promise<RemoteDeployResult>
}
```

Two drivers implement it, both exported from the package root:

- `AwsDriver` — `usesCloudFormation = true`. Infrastructure is generated as CloudFormation templates and deployed via signed AWS API calls; remote commands run over SSM.
- `HetznerDriver` — `usesCloudFormation = false`. Servers are created over the Hetzner Cloud API and deployed to over SSH.

## Getting a driver

Use `createCloudDriver` to construct the right driver for a config, or `cloudDrivers` (a cached `CloudDriverFactory` instance) to reuse drivers per project/region:

```typescript
import { createCloudDriver, cloudDrivers } from '@stacksjs/ts-cloud'

// One-off: provider inferred from config, or forced via the `provider` option
const driver = createCloudDriver({ config })
const forced = createCloudDriver({ config, provider: 'hetzner' })

// Cached factory — returns the same driver for a given provider/slug/region
const cached = cloudDrivers.getDriver(config)

console.log(driver.name, driver.usesCloudFormation)
```

`createCloudDriver` constructs:

- `AwsDriver` with the region from `config.project.region`.
- `HetznerDriver` with `apiToken`, `sshPrivateKeyPath`, `sshUser`, and `location` from the `hetzner` block.

You normally don't call these yourself — the CLI does, based on your config. They're exported for advanced/programmatic use.

## AWS infrastructure generation

For AWS, infrastructure is emitted as CloudFormation. The `InfrastructureGenerator` turns your config into a template, and lower-level builders compose templates directly:

- `CloudFormationBuilder` and `TemplateBuilder` assemble resources, conditions, and dependencies.
- Resource builders live in `packages/core/src/cloudformation/` (VPC, S3, EC2, ECS, RDS, DynamoDB, CloudFront, and more).

See [Cloud Providers](/guide/providers) for the resource builders and configuration, and [Resource Dependencies](/advanced/dependencies) for ordering.

## Object storage providers

Object storage has its own selection (`objectStorage.provider`: `'aws'` | `'backblaze'` | `'hetzner'`) because all three are S3-compatible. A single client drives all of them; only the endpoint, addressing style, and credentials differ.

```typescript
import { createObjectStorageClient, resolveObjectStorage } from '@stacksjs/ts-cloud'

const resolved = resolveObjectStorage({ provider: 'hetzner', region: 'fsn1' })
const s3 = createObjectStorageClient({ provider: 'hetzner', region: 'fsn1' })
```

See [Cloud Providers](/guide/providers#choosing-an-object-storage-provider) for the full config and credential resolution.

## Adding a new provider

There is no plugin entry point — adding a provider means contributing to the framework:

1. Implement the `CloudDriver` interface for the new provider.
2. Add its name to `CloudProviderName` (`packages/core/src/drivers/types.ts`).
3. Wire it into `createCloudDriver` (`packages/ts-cloud/src/drivers/factory.ts`).
4. For a CloudFormation-style provider, generate templates; for an SSH-style provider, follow `HetznerDriver`'s provision-then-deploy approach.

## Next Steps

- [Cloud Providers](/guide/providers) - Choosing and configuring a provider
- [Resource Dependencies](/advanced/dependencies) - Managing dependencies
- [Rollback Strategies](/advanced/rollback) - Handling failures
