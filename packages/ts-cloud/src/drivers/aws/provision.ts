/**
 * AWS EC2 provisioning composition for the Forge/PHP path — the pure, testable
 * pieces shared by {@link import('./driver').AwsDriver.provisionComputeInfrastructure}.
 *
 * Mirrors the Hetzner path: boot a single **Ubuntu** box (same base as Hetzner,
 * so the apt provisioning + nginx vhosts + php-fpm sockets are identical) with
 * the shared bootstrap as UserData, fronted by a security group. The live API
 * orchestration (AMI resolve, VPC/subnet, runInstances, wait) lives in the
 * driver; this module builds the inputs.
 */
import type { CloudConfig } from '@ts-cloud/core'
import { buildComputeProvisionScripts } from '../shared/compute-provision'
import { buildUbuntuBootstrapScript } from '../shared/ubuntu-bootstrap'

/**
 * SSM public parameter for the latest Canonical Ubuntu 24.04 (Noble) AMI —
 * region-agnostic, so we never hardcode region-specific AMI ids.
 */
export const UBUNTU_AMI_SSM_PARAM = '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id'

/** A security-group ingress rule. */
export interface AwsIngressRule {
  port: number
  protocol: 'tcp'
  cidr: string
}

/**
 * Ingress rules for a PHP/app box: SSH (deploy fallback), HTTP, HTTPS, and any
 * extra app ports any site declares. Deploys themselves run over SSM.
 */
export function awsComputeIngressRules(config: CloudConfig): AwsIngressRule[] {
  const rules: AwsIngressRule[] = [
    { port: 22, protocol: 'tcp', cidr: '0.0.0.0/0' },
    { port: 80, protocol: 'tcp', cidr: '0.0.0.0/0' },
    { port: 443, protocol: 'tcp', cidr: '0.0.0.0/0' },
  ]
  const extra = new Set<number>()
  for (const site of Object.values(config.sites || {})) {
    if (site && typeof site.port === 'number' && ![22, 80, 443].includes(site.port))
      extra.add(site.port)
  }
  for (const port of extra)
    rules.push({ port, protocol: 'tcp', cidr: '0.0.0.0/0' })
  return rules
}

/**
 * Build the EC2 UserData (raw bash, not yet base64) from the shared Ubuntu
 * bootstrap — the exact same recipe Hetzner uses. Honors a baked golden image
 * (`compute.bakedImage`) by skipping the install-heavy steps.
 */
export function buildAwsUserData(config: CloudConfig): string {
  const compute = config.infrastructure?.compute ?? {}
  const provision = buildComputeProvisionScripts(config)
  return buildUbuntuBootstrapScript({
    runtime: provision.runtime,
    runtimeVersion: provision.runtimeVersion,
    systemPackages: compute.systemPackages,
    database: config.infrastructure?.database,
    phpProvision: provision.phpProvision,
    servicesProvision: provision.servicesProvision,
    baked: compute.bakedImage === true,
  })
}

/** Base64-encode UserData for the EC2 RunInstances API. */
export function encodeUserData(userData: string): string {
  return Buffer.from(userData, 'utf8').toString('base64')
}

/**
 * Resolve the AMI to boot: an explicit `compute.image` (a golden AMI), else the
 * caller resolves {@link UBUNTU_AMI_SSM_PARAM} via SSM. Returns the explicit id
 * or `null` to signal "resolve Ubuntu via SSM".
 */
export function resolveAwsImageId(config: CloudConfig): string | null {
  return config.infrastructure?.compute?.image ?? null
}
