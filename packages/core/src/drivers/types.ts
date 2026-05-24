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
  runtime: 'bun' | 'node' | 'deno'
  localTarballPath: string
}

export interface DeploySiteReleaseResult {
  success: boolean
  error?: string
  instanceCount?: number
  perInstance?: RemoteDeployInstanceResult[]
}

/**
 * Resolve the configured cloud provider. Defaults to AWS for backward compatibility.
 */
export function resolveCloudProvider(config: CloudConfig): CloudProviderName {
  if (config.cloud?.provider) return config.cloud.provider
  if (config.hetzner?.apiToken || process.env.HCLOUD_TOKEN || process.env.HETZNER_API_TOKEN) {
    return 'hetzner'
  }
  return 'aws'
}
