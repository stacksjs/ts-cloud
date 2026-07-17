/**
 * Provider-agnostic single-box provisioning.
 *
 * `createBoxProvisioner` gives deploy scripts one interface — ensure a named
 * box exists (running, reachable, firewall open, SSH key authorized, bootstrap
 * script run) and tear it down again — regardless of whether the box lives on
 * Hetzner Cloud or AWS EC2. Idempotent like the underlying `ensure*` helpers:
 * re-running converges instead of duplicating resources.
 *
 * SSH access is normalized to `root@<publicIp>`: the public key is injected
 * via cloud-init (`disable_root: false` plus an authorized_keys append) so the
 * same `sshExec(host, cmd)` calls work on both providers, even though AWS
 * Ubuntu images default to the `ubuntu` user.
 */
import type { EC2Client, Instance, IpPermission } from '../../aws/ec2'
import type { SSMClient } from '../../aws/ssm'
import type { HetznerClient, HetznerFirewallRule } from '../hetzner/client'
import { ensureFirewall, ensureServer, ensureSshKey, serverPublicIpv4 } from '../hetzner/provision'

export type BoxProviderName = 'hetzner' | 'aws'

export interface BoxPort {
  protocol: 'tcp' | 'udp' | 'icmp'
  /** Port number; omit for icmp. */
  port?: number
}

export interface BoxSpec {
  /** Resource name; also names the firewall/security group (`<name>-fw`/`<name>-sg`). */
  name: string
  /** Provider-native size (Hetzner server type like `cx23`, EC2 instance type like `t3.micro`). */
  size: string
  /** Hetzner image name or an `ami-...` id. Defaults to Ubuntu 24.04 on both providers. */
  image?: string
  /** Hetzner location (e.g. `fsn1`). AWS placement follows the provisioner's region. */
  location?: string
  /** Ingress to open in addition to tcp/22. */
  ports?: BoxPort[]
  /** OpenSSH public key authorized for root. */
  sshPublicKey: string
  /** Plain bash bootstrap script, run once at first boot via cloud-init. */
  bootstrapScript?: string
  labels?: Record<string, string>
}

export interface ProvisionedBox {
  provider: BoxProviderName
  id: string
  name: string
  publicIp: string
  created: boolean
}

export interface BoxProvisioner {
  readonly provider: BoxProviderName
  ensureBox(spec: BoxSpec): Promise<ProvisionedBox>
  /** Tear down the box and its firewall/security group. */
  destroyBox(name: string): Promise<{ destroyed: string[] }>
}

/** SSM parameter for the current Ubuntu 24.04 amd64 gp3 AMI (Canonical-published). */
export const UBUNTU_2404_AMI_PARAM = '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id'

/**
 * Cloud-config shared by both providers: root SSH access with the given key
 * (AWS Ubuntu images otherwise lock root and point at the `ubuntu` user) and
 * the optional bootstrap script.
 */
export function buildBoxUserData(spec: Pick<BoxSpec, 'sshPublicKey' | 'bootstrapScript'>): string {
  const key = spec.sshPublicKey.trim()
  const lines = [
    '#cloud-config',
    'disable_root: false',
    'ssh_authorized_keys:',
    `  - ${key}`,
  ]
  if (spec.bootstrapScript) {
    const path = '/var/lib/cloud/box-bootstrap.sh'
    const indented = spec.bootstrapScript.split('\n').map(l => `      ${l}`).join('\n')
    lines.push(
      'write_files:',
      `  - path: ${path}`,
      `    permissions: '0755'`,
      '    owner: root:root',
      '    content: |',
      indented,
    )
  }
  lines.push(
    'runcmd:',
    // Root key injection must survive cloud-init's default-user rewrite on AWS.
    `  - mkdir -p /root/.ssh && grep -qF "${key}" /root/.ssh/authorized_keys 2>/dev/null || echo "${key}" >> /root/.ssh/authorized_keys`,
  )
  if (spec.bootstrapScript)
    lines.push('  - [ bash, /var/lib/cloud/box-bootstrap.sh ]')
  return `${lines.join('\n')}\n`
}

// ── Hetzner ────────────────────────────────────────────────────────────────

function toHetznerRules(ports: BoxPort[] = []): HetznerFirewallRule[] {
  const rules: HetznerFirewallRule[] = [
    { direction: 'in', protocol: 'tcp', port: '22', source_ips: ['0.0.0.0/0', '::/0'], description: 'SSH' },
  ]
  for (const p of ports) {
    rules.push({
      direction: 'in',
      protocol: p.protocol,
      ...(p.protocol === 'icmp' ? {} : { port: String(p.port) }),
      source_ips: ['0.0.0.0/0', '::/0'],
    })
  }
  return rules
}

export class HetznerBoxProvisioner implements BoxProvisioner {
  readonly provider = 'hetzner' as const

  constructor(private client: HetznerClient) {}

  async ensureBox(spec: BoxSpec): Promise<ProvisionedBox> {
    const key = await ensureSshKey(this.client, { name: `${spec.name}-key`, publicKey: spec.sshPublicKey })
    const firewall = await ensureFirewall(this.client, { name: `${spec.name}-fw`, rules: toHetznerRules(spec.ports) })
    const { server, created } = await ensureServer(this.client, {
      name: spec.name,
      serverType: spec.size,
      image: spec.image ?? 'ubuntu-24.04',
      location: spec.location,
      sshKeys: [key.id],
      firewalls: [{ firewall: firewall.id }],
      userData: buildBoxUserData(spec),
      labels: spec.labels,
    })
    return { provider: 'hetzner', id: String(server.id), name: server.name, publicIp: serverPublicIpv4(server), created }
  }

  async destroyBox(name: string): Promise<{ destroyed: string[] }> {
    const destroyed: string[] = []

    const server = (await this.client.listServers()).find(s => s.name === name)
    if (server) {
      const action = await this.client.deleteServer(server.id)
      await this.client.waitForAction(action.id).catch(() => {})
      destroyed.push(`server ${name} (#${server.id})`)
    }

    // A firewall can only be deleted once the provider detaches it from the
    // deleted server, which happens asynchronously — retry briefly.
    const firewall = (await this.client.listFirewalls()).find(f => f.name === `${name}-fw`)
    if (firewall) {
      for (let i = 0; i < 10; i++) {
        try {
          await this.client.deleteFirewall(firewall.id)
          destroyed.push(`firewall ${name}-fw (#${firewall.id})`)
          break
        }
        catch {
          if (i === 9)
            break
          await new Promise(resolve => setTimeout(resolve, 3000))
        }
      }
    }

    return { destroyed }
  }
}

// ── AWS ────────────────────────────────────────────────────────────────────

/** The EC2 surface the AWS provisioner uses (injectable for tests). */
export type BoxEc2Client = Pick<
  EC2Client,
  'describeInstances' | 'describeSecurityGroups' | 'createSecurityGroup'
  | 'authorizeSecurityGroupIngress' | 'runInstances' | 'terminateInstances'
  | 'deleteSecurityGroup' | 'getInstance'
>

/** The SSM surface the AWS provisioner uses (injectable for tests). */
export type BoxSsmClient = Pick<SSMClient, 'getParameter'>

export interface AwsBoxProvisionerOptions {
  ec2: BoxEc2Client
  ssm: BoxSsmClient
}

function toIpPermissions(ports: BoxPort[] = []): IpPermission[] {
  const permissions: IpPermission[] = [
    { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'SSH' }] },
  ]
  for (const p of ports) {
    permissions.push(p.protocol === 'icmp'
      ? { IpProtocol: 'icmp', FromPort: -1, ToPort: -1, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }
      : { IpProtocol: p.protocol, FromPort: p.port, ToPort: p.port, IpRanges: [{ CidrIp: '0.0.0.0/0' }] })
  }
  return permissions
}

export class AwsBoxProvisioner implements BoxProvisioner {
  readonly provider = 'aws' as const
  private ec2: BoxEc2Client
  private ssm: BoxSsmClient

  constructor(options: AwsBoxProvisionerOptions) {
    this.ec2 = options.ec2
    this.ssm = options.ssm
  }

  private async findInstance(name: string, states: string[]): Promise<Instance | undefined> {
    const result = await this.ec2.describeInstances({
      Filters: [
        { Name: 'tag:Name', Values: [name] },
        { Name: 'instance-state-name', Values: states },
      ],
    })
    return result.Reservations?.flatMap(r => r.Instances ?? [])[0]
  }

  private async waitForPublicIp(instanceId: string, timeoutMs = 300_000): Promise<Instance> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const instance = await this.ec2.getInstance(instanceId)
      if (instance?.State?.Name === 'running' && instance.PublicIpAddress)
        return instance
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
    throw new Error(`EC2 instance ${instanceId} did not reach running with a public IP within ${timeoutMs}ms`)
  }

  private async ensureSecurityGroup(spec: BoxSpec): Promise<string> {
    const groupName = `${spec.name}-sg`
    const existing = await this.ec2.describeSecurityGroups({
      Filters: [{ Name: 'group-name', Values: [groupName] }],
    })
    const found = existing.SecurityGroups?.[0]?.GroupId
    if (found)
      return found

    const created = await this.ec2.createSecurityGroup({
      GroupName: groupName,
      Description: `box ${spec.name} (managed by ts-cloud box-provision)`,
    })
    if (!created.GroupId)
      throw new Error(`could not create security group ${groupName}`)
    await this.ec2.authorizeSecurityGroupIngress({
      GroupId: created.GroupId,
      IpPermissions: toIpPermissions(spec.ports),
    })
    return created.GroupId
  }

  private async resolveImage(spec: BoxSpec): Promise<string> {
    if (spec.image?.startsWith('ami-'))
      return spec.image
    const result = await this.ssm.getParameter({ Name: UBUNTU_2404_AMI_PARAM })
    const ami = result.Parameter?.Value
    if (!ami)
      throw new Error(`could not resolve the Ubuntu 24.04 AMI via SSM (${UBUNTU_2404_AMI_PARAM})`)
    return ami
  }

  async ensureBox(spec: BoxSpec): Promise<ProvisionedBox> {
    const existing = await this.findInstance(spec.name, ['pending', 'running'])
    if (existing?.InstanceId) {
      const instance = await this.waitForPublicIp(existing.InstanceId)
      return { provider: 'aws', id: instance.InstanceId!, name: spec.name, publicIp: instance.PublicIpAddress!, created: false }
    }

    const [groupId, imageId] = await Promise.all([
      this.ensureSecurityGroup(spec),
      this.resolveImage(spec),
    ])

    const tags = [
      { Key: 'Name', Value: spec.name },
      ...Object.entries(spec.labels ?? {}).map(([Key, Value]) => ({ Key, Value })),
    ]
    const result = await this.ec2.runInstances({
      ImageId: imageId,
      InstanceType: spec.size,
      MinCount: 1,
      MaxCount: 1,
      SecurityGroupIds: [groupId],
      // btoa() only accepts Latin-1 — a bootstrap script with any non-Latin-1
      // char (an emoji in an echo line) would kill provisioning with an
      // InvalidCharacterError. Encode as UTF-8 first.
      UserData: Buffer.from(buildBoxUserData(spec), 'utf8').toString('base64'),
      TagSpecifications: [{ ResourceType: 'instance', Tags: tags }],
    })
    const instanceId = result.Instances?.[0]?.InstanceId
    if (!instanceId)
      throw new Error(`RunInstances returned no instance for box ${spec.name}`)

    const instance = await this.waitForPublicIp(instanceId)
    return { provider: 'aws', id: instanceId, name: spec.name, publicIp: instance.PublicIpAddress!, created: true }
  }

  async destroyBox(name: string): Promise<{ destroyed: string[] }> {
    const destroyed: string[] = []

    const instance = await this.findInstance(name, ['pending', 'running', 'stopping', 'stopped'])
    if (instance?.InstanceId) {
      await this.ec2.terminateInstances([instance.InstanceId])
      destroyed.push(`instance ${name} (${instance.InstanceId})`)
      // The security group can only be deleted after the instance releases it.
      const start = Date.now()
      while (Date.now() - start < 300_000) {
        const current = await this.ec2.getInstance(instance.InstanceId)
        if (!current || current.State?.Name === 'terminated')
          break
        await new Promise(resolve => setTimeout(resolve, 5000))
      }
    }

    const groups = await this.ec2.describeSecurityGroups({
      Filters: [{ Name: 'group-name', Values: [`${name}-sg`] }],
    })
    const groupId = groups.SecurityGroups?.[0]?.GroupId
    if (groupId) {
      for (let i = 0; i < 10; i++) {
        try {
          await this.ec2.deleteSecurityGroup(groupId)
          destroyed.push(`security group ${name}-sg (${groupId})`)
          break
        }
        catch {
          if (i === 9)
            break
          await new Promise(resolve => setTimeout(resolve, 3000))
        }
      }
    }

    return { destroyed }
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

export interface CreateBoxProvisionerOptions {
  provider: BoxProviderName
  /** Required for provider 'hetzner'. */
  hetzner?: HetznerClient
  /** Required for provider 'aws'. */
  aws?: AwsBoxProvisionerOptions
}

export function createBoxProvisioner(options: CreateBoxProvisionerOptions): BoxProvisioner {
  if (options.provider === 'hetzner') {
    if (!options.hetzner)
      throw new Error('createBoxProvisioner: options.hetzner (a HetznerClient) is required for provider "hetzner"')
    return new HetznerBoxProvisioner(options.hetzner)
  }
  if (!options.aws)
    throw new Error('createBoxProvisioner: options.aws ({ ec2, ssm }) is required for provider "aws"')
  return new AwsBoxProvisioner(options.aws)
}
