import type { CloudConfig, EnvironmentType, SiteConfig } from '../types'

export type CloudProviderName = 'aws' | 'hetzner'

export interface ComputeTarget {
  id: string
  name?: string
  publicIp?: string
  privateIp?: string
  status?: string
}

export interface ComputeStackOutputs {
  deployBucketName?: string
  deployStoragePath?: string
  appInstanceId?: string
  appPublicIp?: string
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
 * Environment-based auto-detection is handled when constructing the Hetzner driver.
 */
export function resolveCloudProvider(config: CloudConfig): CloudProviderName {
  if (config.cloud?.provider) return config.cloud.provider
  if (config.hetzner?.apiToken) return 'hetzner'
  return 'aws'
}
