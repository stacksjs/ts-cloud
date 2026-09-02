import type { CloudConfig, EnvironmentType, SiteConfig } from '../types'

export type CloudProviderName = 'aws' | 'hetzner' | 'ssh'

/**
 * Exhaustive provider map. Provider-specific contract tests key off this type,
 * so adding a provider without adding its resilience coverage is a type error.
 */
export type CloudProviderContract<T> = { [Provider in CloudProviderName]: T }

export interface ComputeTarget {
  id: string
  name?: string
  publicIp?: string
  /**
   * Public IPv6 address, normalized to something an AAAA record can point at
   * (see `normalizePublicIpv6` — providers report anything from a plain
   * address to a routed block).
   */
  publicIpv6?: string
  privateIp?: string
  status?: string
}

export interface ComputeStackOutputs {
  deployBucketName?: string
  deployStoragePath?: string
  appInstanceId?: string
  appPublicIp?: string
  /**
   * Public IPv6 address of the app box, when the provider gives it one. Drivers
   * narrow a routed block to the address the interface actually holds before
   * reporting it here, so this is always something an AAAA record can point at.
   */
  appPublicIpv6?: string
  sshUser?: string
  /** Fleet: private IP of the dedicated services box (DB/cache/search). */
  servicesPrivateIp?: string
  /** Fleet: public IP of the load balancer fronting the app servers. */
  loadBalancerIp?: string
}

export interface RemoteDeployInstanceResult {
  instanceId: string
  status: string
  output?: string
  error?: string
}

export interface RemoteDeployResult {
  success: boolean
  instanceCount: number
  perInstance: RemoteDeployInstanceResult[]
  error?: string
}

export interface ProvisionComputeOptions {
  config: CloudConfig
  environment: EnvironmentType
}

export interface FindComputeTargetsOptions {
  slug: string
  environment: EnvironmentType
  role?: string
  /**
   * Region to search, for drivers that have one. Defaults to the driver's own.
   * A driver method that resolved a region from config passes it here, so the
   * lookup and whatever is done with the results cannot disagree about where
   * the instances are.
   */
  region?: string
  /**
   * Project stack name (`resolveProjectStackName(config, environment)`), used
   * by drivers that can pin targets from local state when label/tag scans
   * don't match — e.g. a project riding a shared box whose labels belong to
   * another project. Defaults to `<slug>-<environment>` when omitted.
   */
  stackName?: string
}

export interface UploadReleaseOptions {
  config: CloudConfig
  environment: EnvironmentType
  localPath: string
  remoteKey: string
  targets?: ComputeTarget[]
}

export interface UploadReleaseResult {
  /** Server-local path or remote URI the deploy script reads from */
  artifactRef: string
}

export interface RunRemoteDeployOptions {
  targets: ComputeTarget[]
  commands: string[]
  comment?: string
  timeoutSeconds?: number
  tags?: Record<string, string>
}

/**
 * Cloud infrastructure driver — abstracts compute provisioning and Forge-style
 * app deploys across providers (AWS EC2+SSM+S3, Hetzner Cloud+SSH, etc.).
 *
 * DNS remains provider-agnostic via the separate `DnsProvider` abstraction.
 */
export interface CloudDriver {
  readonly name: CloudProviderName

  /** Whether this driver uses CloudFormation for infrastructure */
  readonly usesCloudFormation: boolean

  /** Provision compute infrastructure (Hetzner). AWS uses InfrastructureGenerator + CFN. */
  provisionComputeInfrastructure?(options: ProvisionComputeOptions): Promise<ComputeStackOutputs>

  /**
   * Tear down the lightweight single-server compute (instance + security
   * group/firewall + local state) provisioned by
   * {@link provisionComputeInfrastructure}. Returns a human-readable summary of
   * what was destroyed. Not for CloudFormation-managed stacks.
   */
  destroyCompute?(options: ProvisionComputeOptions): Promise<{ destroyed: string[] }>

  /** Read outputs needed for deploy (stack outputs, state file, or live API) */
  getComputeOutputs(options: ProvisionComputeOptions): Promise<ComputeStackOutputs>

  /** Upload a release tarball to provider-specific staging storage */
  uploadRelease(options: UploadReleaseOptions): Promise<UploadReleaseResult>

  /** Find compute targets matching project tags/labels */
  findComputeTargets(options: FindComputeTargetsOptions): Promise<ComputeTarget[]>

  /** Run a shell script on every target (SSM, SSH, etc.) */
  runRemoteDeploy(options: RunRemoteDeployOptions): Promise<RemoteDeployResult>

  /**
   * Enumerate every resource this driver's credential can see — and therefore,
   * on providers without per-resource scoping, write to and delete.
   *
   * Exists so nothing above the driver has to assume "one all-powerful token"
   * is the only credential shape. Attaching to another project's box works by
   * LISTING the provider with the attaching project's own credential, so the
   * radius is a property of that credential rather than of the config, and only
   * the driver holding it can report it. A driver whose credential IS narrowly
   * scoped simply enumerates less, and the same reporting comes out right
   * without a special case.
   *
   * Optional: a driver that cannot enumerate omits it, and callers report no
   * radius rather than a wrong one.
   *
   * @see https://github.com/stacksjs/ts-cloud/issues/169
   */
  listReachableResources?(): Promise<ReachableResource[]>
}

/**
 * One resource a provider credential can reach, reduced to what attribution
 * needs: a name to print and the labels that say who owns it.
 *
 * Deliberately structural and provider-agnostic — a Hetzner server satisfies it
 * as-is, and another driver can satisfy it without importing anything.
 */
export interface ReachableResource {
  name: string
  labels?: Record<string, string>
}

export interface DeploySiteReleaseOptions {
  config: CloudConfig
  environment: EnvironmentType
  siteName: string
  site: SiteConfig
  slug: string
  sha: string
  runtime: 'bun' | 'node' | 'deno' | 'php'
  /**
   * Local release tarball to ship. Required for tarball deploys (bun/node/deno
   * apps and server-static sites); omitted for PHP/Laravel sites, which clone
   * from git on the box instead.
   */
  localTarballPath?: string
}

export interface DeploySiteReleaseResult {
  success: boolean
  error?: string
  instanceCount?: number
  perInstance?: RemoteDeployInstanceResult[]
}

/**
 * Resolve the configured cloud provider. Defaults to AWS for backward compatibility.
 *
 * An explicit `cloud.provider` always wins. Without one, the config itself is
 * the tell: a project that lists `ssh.hosts` is deploying to hosts it already
 * owns, and a project with a Hetzner token is deploying to Hetzner. The ssh
 * provider is never inferred from the environment alone (`TS_CLOUD_SSH_HOST`
 * is a per-machine override, not a statement of intent); the Hetzner token
 * check keeps the behaviour it always had.
 */
export function resolveCloudProvider(config: CloudConfig): CloudProviderName {
  if (config.cloud?.provider) return config.cloud.provider
  if (config.ssh?.hosts?.length) return 'ssh'
  if (config.hetzner?.apiToken) return 'hetzner'
  return 'aws'
}
