/**
 * AWS worker groups: EC2 capacity that grows with a queue and shrinks to zero.
 *
 * A worker group is an EC2 Auto Scaling group whose instances boot, set
 * themselves up with the same converge script a declared box gets, run one
 * long-lived worker process (a CI runner, a queue worker), and terminate
 * themselves - lowering the group's desired capacity - when that process exits.
 * Something outside (a scheduler) raises the desired capacity when work waits.
 *
 * Why that split: only the machine knows whether it is mid-task, so the machine
 * is the only thing that ever removes itself. The scaler only adds capacity,
 * plus reaping instances that never became workers at all (nothing can be
 * running on those), so a broken boot script does not bill for hours.
 *
 * Built on an Auto Scaling group with a mixed instances policy and
 * `price-capacity-optimized` spot allocation - not Spot Fleet, which AWS keeps
 * as a legacy API with no planned investment, and not EC2 Fleet's `instant`
 * mode, which would leave replacement and placement across pools to us.
 *
 * Every AWS call goes through a replaceable transport, so the exact parameters
 * are tested without an account.
 */

import type { BoxConfig } from '@ts-cloud/core'
import { AWSClient, detectCredentialSource } from '../../aws/client'
import { buildBoxConvergeScript } from '../shared/box-converge'

export interface AwsWorkerGroupConfig {
  /** The Auto Scaling group's name, and the prefix of everything it owns. */
  name: string
  region: string
  /** Types the mixed instances policy may launch, in preference order. */
  instanceTypes: string[]
  market: {
    spot: boolean
    /** Always-on-demand instances, before any spot. */
    onDemandBaseCapacity: number
    /** Of capacity above the base, the share that is on-demand (0-100). */
    onDemandPercentageAboveBase: number
  }
  min: number
  max: number
  diskGb: number
  /** An instance that has not become a worker after this long is reaped. */
  registrationGraceSeconds: number
  /** SSM public parameter naming the image. Defaults to Ubuntu 24.04 LTS, x86. */
  imageParameter?: string
  /** Extra tags on every instance. */
  tags?: Record<string, string>
  /**
   * Where the instances run.
   *
   * - `'default'` (the default): every default subnet of the region's default VPC.
   * - `'dedicated'`: a network the group owns - a VPC, an internet gateway and
   *   one public subnet per availability zone, found by tag and created once.
   *   For an account whose default VPC is gone, and for keeping workers out of
   *   a network that also holds production.
   * - `{ subnetIds }`: subnets you already have, which must give instances a
   *   route out.
   */
  network?: 'default' | 'dedicated' | { subnetIds: string[] }
  /** The dedicated network's address range. Defaults to 10.88.0.0/16, split into /20s. */
  networkCidr?: string
}

export const UBUNTU_2404_X86_IMAGE = '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id'

/** The most user data EC2 accepts, before base64. */
export const EC2_USER_DATA_LIMIT = 16_384

export interface AwsTransport {
  request: (options: { service: string, region: string, method: string, path: string, headers?: Record<string, string>, body?: string }) => Promise<any>
}

/** One instance as the group reports it, with when it launched. */
export interface WorkerInstance {
  id: string
  /** `Pending`, `InService`, `Terminating`, ... */
  lifecycle: string
  launchedAt: Date | null
}

/** A worker the queue knows about, named after the instance it runs on. */
export interface Worker {
  name: string
  /** Whether it is free to take work right now. */
  idle: boolean
}

/** Lists come back as `member` (Auto Scaling, IAM) or `item` (EC2), one or many. */
export function queryList<T = any>(value: any): T[] {
  const inner = value?.member ?? value?.item ?? value
  if (inner === undefined || inner === null || inner === '')
    return []
  return Array.isArray(inner) ? inner : [inner]
}

/** `FooResponse.FooResult`, or EC2's shape, which has no Result layer. */
export function queryResult(answer: any, action: string): any {
  const response = answer?.[`${action}Response`] ?? answer
  return response?.[`${action}Result`] ?? response
}

/** Flatten a structure into Query parameters: `Name.member.1` (Auto Scaling, IAM) or `Name.1` (EC2). */
export function flattenQuery(value: unknown, style: 'member' | 'ec2', prefix = '', into: Record<string, string> = {}): Record<string, string> {
  if (value === undefined || value === null)
    return into
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenQuery(item, style, `${prefix}${style === 'member' ? '.member' : ''}.${index + 1}`, into))
    return into
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      flattenQuery(item, style, prefix ? `${prefix}.${key}` : key, into)
    return into
  }
  into[prefix] = String(value)
  return into
}

const VERSIONS: Record<string, string> = { autoscaling: '2011-01-01', ec2: '2016-11-15', iam: '2010-05-08', sts: '2011-06-15' }

export class AwsWorkerGroupApi {
  constructor(private readonly transport: AwsTransport, readonly region: string) {}

  async query(service: 'autoscaling' | 'ec2' | 'iam' | 'sts', action: string, params: Record<string, unknown> = {}): Promise<any> {
    const answer = await this.transport.request({
      service,
      // IAM is global and signs in us-east-1.
      region: service === 'iam' ? 'us-east-1' : this.region,
      method: 'POST',
      path: '/',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ Action: action, Version: VERSIONS[service]!, ...flattenQuery(params, service === 'ec2' ? 'ec2' : 'member') }).toString(),
    })
    return queryResult(answer, action)
  }

  async accountId(): Promise<string> {
    return String((await this.query('sts', 'GetCallerIdentity')).Account ?? '')
  }

  async image(parameter: string = UBUNTU_2404_X86_IMAGE): Promise<string> {
    const answer = await this.transport.request({
      service: 'ssm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AmazonSSM.GetParameter' },
      body: JSON.stringify({ Name: parameter }),
    })
    const image = String(answer?.Parameter?.Value ?? '')
    if (!/^ami-[0-9a-f]+$/.test(image))
      throw new Error(`Could not resolve an image from ${parameter} in ${this.region}`)
    return image
  }

  async describeGroup(name: string): Promise<{ desired: number, min: number, max: number, instances: WorkerInstance[] } | null> {
    const group = queryList((await this.query('autoscaling', 'DescribeAutoScalingGroups', { AutoScalingGroupNames: [name] }))?.AutoScalingGroups)[0]
    if (!group)
      return null
    const instances: WorkerInstance[] = queryList(group.Instances).map((instance: any) => ({ id: String(instance.InstanceId), lifecycle: String(instance.LifecycleState), launchedAt: null }))
    const times = await this.launchTimes(instances.map(instance => instance.id))
    return {
      desired: Number(group.DesiredCapacity ?? 0),
      min: Number(group.MinSize ?? 0),
      max: Number(group.MaxSize ?? 0),
      instances: instances.map(instance => ({ ...instance, launchedAt: times.get(instance.id) ?? null })),
    }
  }

  /** Launch times, which the group's own description does not carry. */
  async launchTimes(ids: string[]): Promise<Map<string, Date>> {
    const times = new Map<string, Date>()
    if (ids.length === 0)
      return times
    for (const reservation of queryList((await this.query('ec2', 'DescribeInstances', { InstanceId: ids }))?.reservationSet)) {
      for (const instance of queryList(reservation?.instancesSet)) {
        const at = Date.parse(String(instance.launchTime ?? ''))
        if (Number.isFinite(at))
          times.set(String(instance.instanceId), new Date(at))
      }
    }
    return times
  }

  async setDesired(name: string, desired: number): Promise<void> {
    await this.query('autoscaling', 'SetDesiredCapacity', { AutoScalingGroupName: name, DesiredCapacity: desired, HonorCooldown: false })
  }

  async terminate(instanceId: string): Promise<void> {
    await this.query('autoscaling', 'TerminateInstanceInAutoScalingGroup', { InstanceId: instanceId, ShouldDecrementDesiredCapacity: true })
  }
}

/**
 * The API for a region, signed with whatever credentials this process has
 * (environment, AWS_PROFILE or `profile`, or an instance role). Null when there
 * are none, so a scheduled job on a machine that has not configured AWS stays
 * quiet rather than failing every minute.
 */
export function awsWorkerGroupApi(region: string, options: { profile?: string } = {}): AwsWorkerGroupApi | null {
  if (!options.profile && detectCredentialSource().source === 'none')
    return null
  const client = new AWSClient(undefined, { profile: options.profile, maxRetries: 3 })
  return new AwsWorkerGroupApi({ request: request => client.request(request) }, region)
}

function sh(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/**
 * User data for a worker instance: converge `box`, refuse `user` the metadata
 * service, run `command` as `user`, and when it exits terminate the instance
 * and lower the group's desired capacity.
 *
 * The metadata service hands anybody who asks the user data (and so any secret
 * passed to the worker through it) and the instance role's credentials. The
 * worker is told what it needs on its command line (`$INSTANCE_ID` and
 * `$REGION` are set), so it has no reason to ask; a task it runs has none
 * either. If the self-termination call fails the instance powers off instead.
 */
export function buildWorkerUserData(options: { box: BoxConfig, user: string, command: string, env?: Record<string, string> }): string {
  if (!/^[a-z_][a-z0-9_-]*$/.test(options.user))
    throw new Error(`Not a user name: "${options.user}"`)
  const converge = Buffer.from(buildBoxConvergeScript(options.box)).toString('base64')
  const env = Object.entries(options.env ?? {}).map(([key, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key))
      throw new Error(`Not an environment variable name: "${key}"`)
    return `${key}=${sh(value)}`
  }).join(' ')

  const script = [
    '#!/bin/bash',
    '# Written by ts-cloud buildWorkerUserData. Do not edit on the instance.',
    'set -uo pipefail',
    'umask 077',
    'exec >>/var/log/ts-cloud-worker.log 2>&1',
    'IMDS=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")',
    'meta() { curl -fsS -H "X-aws-ec2-metadata-token: $IMDS" "http://169.254.169.254/latest/meta-data/$1"; }',
    'INSTANCE_ID=$(meta instance-id)',
    'REGION=$(meta placement/region)',
    'finish() {',
    '  echo "worker exited; terminating $INSTANCE_ID"',
    '  aws autoscaling terminate-instance-in-auto-scaling-group --region "$REGION" --instance-id "$INSTANCE_ID" --should-decrement-desired-capacity || shutdown -h now',
    '}',
    'trap finish EXIT',
    'command -v aws >/dev/null || snap install aws-cli --classic',
    `echo ${sh(converge)} | base64 -d > /root/ts-cloud-converge.sh`,
    'bash /root/ts-cloud-converge.sh',
    `iptables -I OUTPUT -m owner --uid-owner ${options.user} -d 169.254.169.254/32 -j REJECT || exit 1`,
    `ip6tables -I OUTPUT -m owner --uid-owner ${options.user} -d fd00:ec2::254/128 -j REJECT 2>/dev/null || true`,
    `cd ~${options.user} && sudo -u ${options.user} -H env ${env} ${options.command}`,
    '',
  ].join('\n')

  if (script.length > EC2_USER_DATA_LIMIT)
    throw new Error(`User data is ${script.length} bytes; EC2 allows ${EC2_USER_DATA_LIMIT}`)
  return script
}

export interface WorkerGroupPlan {
  desired: number
  /** Instances to terminate, lowering desired capacity with each. */
  reap: string[]
  reasons: string[]
}

const LIVE = new Set(['Pending', 'Pending:Wait', 'Pending:Proceed', 'InService'])

/**
 * One scaling decision: how many instances the group should want, and which
 * never-registered instances to reap. Only ever raises the desired capacity.
 *
 * Instances already asked for but not yet workers are subtracted from the
 * waiting work before asking for more - otherwise every tick during a boot
 * asks again for the same tasks - and idle workers count as capacity.
 */
export function planWorkerGroup(input: {
  config: Pick<AwsWorkerGroupConfig, 'min' | 'max' | 'registrationGraceSeconds'>
  currentDesired: number
  instances: WorkerInstance[]
  workers: Worker[]
  waiting: number
  now?: Date
}): WorkerGroupPlan {
  const now = input.now ?? new Date()
  const reasons: string[] = []
  const live = input.instances.filter(instance => LIVE.has(instance.lifecycle))
  const registered = new Set(input.workers.map(worker => worker.name))

  const reap = live
    .filter(instance => !registered.has(instance.id))
    .filter(instance => instance.launchedAt !== null && (now.getTime() - instance.launchedAt.getTime()) / 1000 > input.config.registrationGraceSeconds)
    .map(instance => instance.id)
  for (const id of reap)
    reasons.push(`${id} never registered within ${input.config.registrationGraceSeconds}s; reaping it`)

  const base = input.currentDesired - reap.length
  const workersUp = live.filter(instance => registered.has(instance.id)).length
  const arriving = Math.max(0, base - workersUp)
  const idle = input.workers.filter(worker => worker.idle).length
  const uncovered = Math.max(0, input.waiting - arriving - idle)
  const desired = Math.min(input.config.max, Math.max(input.config.min, base, base + uncovered))

  if (uncovered > 0)
    reasons.push(`${input.waiting} waiting, ${arriving} arriving, ${idle} idle: asking for ${desired - base} more`)
  if (base + uncovered > input.config.max)
    reasons.push(`capped at max ${input.config.max}`)

  return { desired, reap, reasons }
}

/**
 * Apply one plan: reap, then raise the desired capacity if the plan asks for more.
 */
export async function applyWorkerGroupPlan(api: AwsWorkerGroupApi, name: string, currentDesired: number, plan: WorkerGroupPlan): Promise<void> {
  for (const id of plan.reap)
    await api.terminate(id)
  if (plan.desired > currentDesired - plan.reap.length)
    await api.setDesired(name, plan.desired)
}

function missing(error: unknown, ...codes: string[]): boolean {
  const text = `${(error as any)?.code ?? ''} ${(error as any)?.name ?? ''} ${(error as any)?.message ?? ''}`
  return codes.some(code => text.includes(code))
}

/** Tags for a resource the group owns, in EC2's `TagSpecification` shape. */
function ownedTags(config: AwsWorkerGroupConfig, resourceType: string, name: string): Record<string, unknown> {
  return { TagSpecification: [{ ResourceType: resourceType, Tag: [{ Key: 'Name', Value: name }, { Key: 'ts-cloud:worker-group', Value: config.name }] }] }
}

/** The `index`th /20 of a /16, for one subnet per availability zone. */
export function subnetCidr(networkCidr: string, index: number): string {
  const [base] = networkCidr.split('/')
  const [a, b] = String(base).split('.')
  if (index < 0 || index > 15)
    throw new Error(`A /16 holds sixteen /20 subnets, not ${index + 1}`)
  return `${a}.${b}.${index * 16}.0/20`
}

/**
 * Where the group's instances run: the default VPC, subnets given, or a
 * network the group owns, created on first use and found by tag after.
 * Returns an empty VPC id only on a dry run that would create one.
 */
async function resolveNetwork(api: AwsWorkerGroupApi, config: AwsWorkerGroupConfig, dry: boolean, report: string[]): Promise<{ vpcId: string, subnets: string[] }> {
  const network = config.network ?? 'default'

  if (typeof network === 'object') {
    const found = queryList((await api.query('ec2', 'DescribeSubnets', { SubnetId: network.subnetIds }))?.subnetSet)
    if (found.length !== network.subnetIds.length)
      throw new Error(`Not every subnet exists: ${network.subnetIds.join(', ')}`)
    const vpcs = [...new Set(found.map((subnet: any) => String(subnet.vpcId)))]
    if (vpcs.length !== 1)
      throw new Error(`The subnets span ${vpcs.length} VPCs; a group's subnets share one`)
    report.push(`vpc ${vpcs[0]}, ${found.length} given subnets`)
    return { vpcId: vpcs[0]!, subnets: network.subnetIds }
  }

  if (network === 'default') {
    const vpc = queryList((await api.query('ec2', 'DescribeVpcs', { Filter: [{ Name: 'isDefault', Value: ['true'] }] }))?.vpcSet)[0]
    if (!vpc?.vpcId)
      throw new Error(`No default VPC in ${api.region}; set network: 'dedicated' for a network the group owns`)
    const subnets = queryList((await api.query('ec2', 'DescribeSubnets', { Filter: [{ Name: 'vpc-id', Value: [vpc.vpcId] }, { Name: 'default-for-az', Value: ['true'] }] }))?.subnetSet).map((subnet: any) => String(subnet.subnetId))
    if (subnets.length === 0)
      throw new Error(`The default VPC ${vpc.vpcId} has no default subnets`)
    report.push(`vpc ${vpc.vpcId}, ${subnets.length} subnets`)
    return { vpcId: String(vpc.vpcId), subnets }
  }

  // Dedicated: a VPC, an internet gateway, a public route table, and one
  // public subnet per zone - each found by the group's tag before it is made.
  const cidr = config.networkCidr ?? '10.88.0.0/16'
  const owned = [{ Name: 'tag:ts-cloud:worker-group', Value: [config.name] }]
  const zones = queryList((await api.query('ec2', 'DescribeAvailabilityZones', { Filter: [{ Name: 'state', Value: ['available'] }, { Name: 'zone-type', Value: ['availability-zone'] }] }))?.availabilityZoneInfo)
    .map((zone: any) => String(zone.zoneName))
    .sort()
    .slice(0, 16)

  let vpcId = String(queryList((await api.query('ec2', 'DescribeVpcs', { Filter: owned }))?.vpcSet)[0]?.vpcId ?? '')
  if (!vpcId) {
    report.push(`${dry ? 'would create' : 'created'} network ${config.name} (${cidr}, ${zones.length} public subnets)`)
    if (dry)
      return { vpcId: '', subnets: zones.map(zone => `(new subnet in ${zone})`) }
    vpcId = String((await api.query('ec2', 'CreateVpc', { CidrBlock: cidr, ...ownedTags(config, 'vpc', `${config.name}-vpc`) }))?.vpc?.vpcId ?? '')
    await api.query('ec2', 'ModifyVpcAttribute', { VpcId: vpcId, 'EnableDnsHostnames.Value': true })
  }
  else {
    report.push(`network ${vpcId}`)
  }

  let gateway = String(queryList((await api.query('ec2', 'DescribeInternetGateways', { Filter: [{ Name: 'attachment.vpc-id', Value: [vpcId] }] }))?.internetGatewaySet)[0]?.internetGatewayId ?? '')
  if (!gateway && !dry) {
    gateway = String((await api.query('ec2', 'CreateInternetGateway', ownedTags(config, 'internet-gateway', `${config.name}-igw`)))?.internetGateway?.internetGatewayId ?? '')
    await api.query('ec2', 'AttachInternetGateway', { InternetGatewayId: gateway, VpcId: vpcId })
    report.push(`attached internet gateway ${gateway}`)
  }

  let routeTable = String(queryList((await api.query('ec2', 'DescribeRouteTables', { Filter: [{ Name: 'vpc-id', Value: [vpcId] }, ...owned] }))?.routeTableSet)[0]?.routeTableId ?? '')
  if (!routeTable && !dry) {
    routeTable = String((await api.query('ec2', 'CreateRouteTable', { VpcId: vpcId, ...ownedTags(config, 'route-table', `${config.name}-public`) }))?.routeTable?.routeTableId ?? '')
    await api.query('ec2', 'CreateRoute', { RouteTableId: routeTable, DestinationCidrBlock: '0.0.0.0/0', GatewayId: gateway })
    report.push(`public route table ${routeTable}`)
  }

  const existing = queryList((await api.query('ec2', 'DescribeSubnets', { Filter: [{ Name: 'vpc-id', Value: [vpcId] }] }))?.subnetSet)
  const subnets: string[] = []
  for (const [index, zone] of zones.entries()) {
    const found = existing.find((subnet: any) => String(subnet.availabilityZone) === zone)
    if (found) {
      subnets.push(String(found.subnetId))
      continue
    }
    report.push(`${dry ? 'would create' : 'created'} subnet ${subnetCidr(cidr, index)} in ${zone}`)
    if (dry)
      continue
    const subnet = String((await api.query('ec2', 'CreateSubnet', { VpcId: vpcId, AvailabilityZone: zone, CidrBlock: subnetCidr(cidr, index), ...ownedTags(config, 'subnet', `${config.name}-${zone}`) }))?.subnet?.subnetId ?? '')
    await api.query('ec2', 'ModifySubnetAttribute', { SubnetId: subnet, 'MapPublicIpOnLaunch.Value': true })
    await api.query('ec2', 'AssociateRouteTable', { RouteTableId: routeTable, SubnetId: subnet })
    subnets.push(subnet)
  }
  report.push(`${subnets.length} public subnets`)
  return { vpcId, subnets }
}

/**
 * Bring a worker group's AWS resources to its declaration. Idempotent: found
 * by name, created when missing; a rerun writes a new launch template version
 * and the group's sizes, and never lowers a running group's desired capacity.
 *
 * Owns, all named after the group: a security group with no inbound rules; an
 * instance role whose one permission is terminating this group's instances; a
 * launch template (IMDSv2 only, gp3 root disk, the given user data); and the
 * group, spread across every default subnet of the default VPC with new
 * instances protected from scale-in.
 */
export async function convergeAwsWorkerGroup(api: AwsWorkerGroupApi, config: AwsWorkerGroupConfig, options: { userData: string, dryRun?: boolean, sleep?: (ms: number) => Promise<void> }): Promise<string[]> {
  const report: string[] = []
  const dry = Boolean(options.dryRun)
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  if (options.userData.length > EC2_USER_DATA_LIMIT)
    throw new Error(`User data is ${options.userData.length} bytes; EC2 allows ${EC2_USER_DATA_LIMIT}`)

  const account = await api.accountId()
  report.push(`account ${account}, region ${api.region}`)

  const { vpcId, subnets } = await resolveNetwork(api, config, dry, report)

  let securityGroup = vpcId
    ? String(queryList((await api.query('ec2', 'DescribeSecurityGroups', { Filter: [{ Name: 'group-name', Value: [config.name] }, { Name: 'vpc-id', Value: [vpcId] }] }))?.securityGroupInfo)[0]?.groupId ?? '')
    : ''
  if (securityGroup) {
    report.push(`security group ${securityGroup}`)
  }
  else {
    report.push(`${dry ? 'would create' : 'created'} security group ${config.name}`)
    if (!dry)
      securityGroup = String((await api.query('ec2', 'CreateSecurityGroup', { GroupName: config.name, GroupDescription: 'ts-cloud worker group: outbound only', VpcId: vpcId }))?.groupId ?? '')
  }

  const role = `${config.name}-instance`
  const groupArn = `arn:aws:autoscaling:${api.region}:${account}:autoScalingGroup:*:autoScalingGroupName/${config.name}`
  try {
    await api.query('iam', 'GetRole', { RoleName: role })
    report.push(`role ${role}`)
  }
  catch (error) {
    if (!missing(error, 'NoSuchEntity'))
      throw error
    report.push(`${dry ? 'would create' : 'created'} role ${role}`)
    if (!dry) {
      await api.query('iam', 'CreateRole', {
        RoleName: role,
        Description: `Instances of the ${config.name} worker group`,
        AssumeRolePolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] }),
      })
    }
  }
  if (!dry) {
    await api.query('iam', 'PutRolePolicy', {
      RoleName: role,
      PolicyName: 'terminate-self',
      PolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'autoscaling:TerminateInstanceInAutoScalingGroup', Resource: groupArn }] }),
    })
  }
  let createdProfile = false
  try {
    const profile = await api.query('iam', 'GetInstanceProfile', { InstanceProfileName: role })
    if (queryList(profile?.InstanceProfile?.Roles).length === 0 && !dry)
      await api.query('iam', 'AddRoleToInstanceProfile', { InstanceProfileName: role, RoleName: role })
  }
  catch (error) {
    if (!missing(error, 'NoSuchEntity'))
      throw error
    report.push(`${dry ? 'would create' : 'created'} instance profile ${role}`)
    if (!dry) {
      await api.query('iam', 'CreateInstanceProfile', { InstanceProfileName: role })
      await api.query('iam', 'AddRoleToInstanceProfile', { InstanceProfileName: role, RoleName: role })
      createdProfile = true
    }
  }
  // IAM is eventually consistent: a launch template naming a profile seconds
  // old is accepted, and the first instance it launches is refused.
  if (createdProfile)
    await sleep(15_000)

  const image = await api.image(config.imageParameter)
  const tags = { Name: config.name, 'ts-cloud:worker-group': config.name, ...config.tags }
  const data: Record<string, unknown> = {
    'LaunchTemplateData.ImageId': image,
    'LaunchTemplateData.UserData': Buffer.from(options.userData).toString('base64'),
    'LaunchTemplateData.IamInstanceProfile.Name': role,
    'LaunchTemplateData.SecurityGroupId.1': securityGroup,
    'LaunchTemplateData.BlockDeviceMapping.1.DeviceName': '/dev/sda1',
    'LaunchTemplateData.BlockDeviceMapping.1.Ebs.VolumeSize': config.diskGb,
    'LaunchTemplateData.BlockDeviceMapping.1.Ebs.VolumeType': 'gp3',
    'LaunchTemplateData.BlockDeviceMapping.1.Ebs.DeleteOnTermination': true,
    'LaunchTemplateData.MetadataOptions.HttpTokens': 'required',
    'LaunchTemplateData.MetadataOptions.HttpPutResponseHopLimit': 1,
    'LaunchTemplateData.TagSpecification.1.ResourceType': 'instance',
  }
  Object.entries(tags).forEach(([key, value], index) => {
    data[`LaunchTemplateData.TagSpecification.1.Tag.${index + 1}.Key`] = key
    data[`LaunchTemplateData.TagSpecification.1.Tag.${index + 1}.Value`] = value
  })

  let template: any = null
  try {
    template = queryList((await api.query('ec2', 'DescribeLaunchTemplates', { LaunchTemplateName: [config.name] }))?.launchTemplates)[0] ?? null
  }
  catch (error) {
    if (!missing(error, 'NotFound', 'InvalidLaunchTemplateName'))
      throw error
  }
  if (template) {
    report.push(`launch template ${config.name}: new version on ${image}`)
    if (!dry)
      await api.query('ec2', 'CreateLaunchTemplateVersion', { LaunchTemplateName: config.name, VersionDescription: 'ts-cloud worker group', ...data })
  }
  else {
    report.push(`${dry ? 'would create' : 'created'} launch template ${config.name} on ${image}`)
    if (!dry)
      await api.query('ec2', 'CreateLaunchTemplate', { LaunchTemplateName: config.name, VersionDescription: 'ts-cloud worker group', ...data })
  }

  const sizes = {
    AutoScalingGroupName: config.name,
    MinSize: config.min,
    MaxSize: config.max,
    VPCZoneIdentifier: subnets.join(','),
    NewInstancesProtectedFromScaleIn: true,
    MixedInstancesPolicy: {
      LaunchTemplate: {
        LaunchTemplateSpecification: { LaunchTemplateName: config.name, Version: '$Latest' },
        Overrides: config.instanceTypes.map(type => ({ InstanceType: type })),
      },
      InstancesDistribution: {
        OnDemandAllocationStrategy: 'prioritized',
        OnDemandBaseCapacity: config.market.onDemandBaseCapacity,
        OnDemandPercentageAboveBaseCapacity: config.market.spot ? config.market.onDemandPercentageAboveBase : 100,
        SpotAllocationStrategy: 'price-capacity-optimized',
      },
    },
  }
  const existing = await api.describeGroup(config.name)
  if (existing) {
    report.push(`group ${config.name}: min ${config.min}, max ${config.max}, desired stays ${existing.desired}`)
    if (!dry)
      await api.query('autoscaling', 'UpdateAutoScalingGroup', sizes)
  }
  else {
    report.push(`${dry ? 'would create' : 'created'} group ${config.name}: ${config.instanceTypes.join(', ')}, ${config.market.spot ? 'spot' : 'on-demand'}, min ${config.min}, max ${config.max}`)
    if (!dry)
      await api.query('autoscaling', 'CreateAutoScalingGroup', { ...sizes, DesiredCapacity: 0, Tags: [{ Key: 'ts-cloud:worker-group', Value: config.name, PropagateAtLaunch: true }] })
  }

  return report
}
