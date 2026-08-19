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
import { buildRpxConfig, buildRpxProvisionScript } from '../shared/rpx-gateway'
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
    if (site && typeof site.port === 'number' && ![22, 80, 443].includes(site.port)) extra.add(site.port)
  }
  for (const port of extra) rules.push({ port, protocol: 'tcp', cidr: '0.0.0.0/0' })
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
  const rpxProvision =
    compute.proxy?.engine === 'rpx'
      ? buildRpxProvisionScript({
          proxy: compute.proxy,
          config: buildRpxConfig(config.sites ?? {}, { proxy: compute.proxy, slug: config.project.slug }),
          slug: config.project.slug,
          bunBin: compute.runtime === 'node' || compute.runtime === 'deno' ? undefined : '/usr/local/bin/bun',
        })
      : undefined

  return buildUbuntuBootstrapScript({
    runtime: provision.runtime,
    runtimeVersion: provision.runtimeVersion,
    systemPackages: compute.systemPackages,
    database: config.infrastructure?.database,
    phpProvision: provision.phpProvision,
    servicesProvision: provision.servicesProvision,
    rpxProvision,
    baked: compute.bakedImage === true,
    swapGb: compute.swapGb,
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

/** The security group name ts-cloud gives a project's app box. */
export function awsSecurityGroupName(slug: string, environment: string): string {
  return `${slug}-${environment}-app-sg`
}

/**
 * Tags ts-cloud puts on every AWS resource it creates for a project — the same
 * vocabulary the instances are tagged with, so teardown can tell what it owns
 * from what it merely found.
 */
export function awsResourceTags(slug: string, environment: string, role = 'app'): { Key: string; Value: string }[] {
  return [
    { Key: 'Project', Value: slug },
    { Key: 'Environment', Value: environment },
    { Key: 'Role', Value: role },
    { Key: 'ManagedBy', Value: 'ts-cloud' },
  ]
}

/** Whether a resource's tags mark it as belonging to this project and environment. */
export function matchesAwsProjectTags(
  tags: { Key?: string; Value?: string }[] | undefined,
  slug: string,
  environment: string,
): boolean {
  if (!tags?.length) return false
  const value = (key: string): string | undefined => tags.find((tag) => tag.Key === key)?.Value
  return value('Project') === slug && value('Environment') === environment
}

/** A security group as teardown needs to judge it. */
export interface AwsSecurityGroupCandidate {
  GroupId?: string
  GroupName?: string
  VpcId?: string
  Tags?: { Key?: string; Value?: string }[]
}

export interface SelectSecurityGroupOptions {
  slug: string
  environment: string
  /** VPC the project's instances were in, when it could still be read. */
  vpcId?: string
}

/**
 * Pick the security group teardown should delete: the one provisioning would
 * have reused.
 *
 * Provisioning scopes its lookup to a VPC, because a same-named group in
 * another VPC belongs to something else — teardown has to be at least as
 * careful, or it deletes another VPC's group (or fails forever against one
 * still in use, reporting nothing).
 *
 * A group tagged for a different project or environment is never a candidate.
 * Groups created before ts-cloud tagged them carry no tags at all; those are
 * still deleted, but only when the VPC pins them to this project's box.
 */
export function selectProjectSecurityGroup(
  groups: AwsSecurityGroupCandidate[],
  options: SelectSecurityGroupOptions,
): AwsSecurityGroupCandidate | undefined {
  const name = awsSecurityGroupName(options.slug, options.environment)

  return groups.find((group) => {
    if (group.GroupName !== name) return false
    if (options.vpcId && group.VpcId && group.VpcId !== options.vpcId) return false

    // Tagged for someone else: not ours, whatever it is called.
    const tagged = !!group.Tags?.some((tag) => tag.Key === 'Project')
    if (tagged) return matchesAwsProjectTags(group.Tags, options.slug, options.environment)

    // Untagged (pre-tagging releases): only when the VPC places it on this
    // project's box, so an unrelated group of the same name is left alone.
    return !!options.vpcId && group.VpcId === options.vpcId
  })
}
