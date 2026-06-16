import type {
  CloudConfig,
  CloudDriver,
  ComputeStackOutputs,
  ComputeTarget,
  FindComputeTargetsOptions,
  ProvisionComputeOptions,
  RemoteDeployResult,
  RunRemoteDeployOptions,
  UploadReleaseOptions,
  UploadReleaseResult,
} from '@ts-cloud/core'
import { readFileSync } from 'node:fs'
import { resolveProjectStackName } from '@ts-cloud/core'
import { CloudFormationClient } from '../../aws/cloudformation'
import { EC2Client } from '../../aws/ec2'
import { S3Client } from '../../aws/s3'
import { SSMClient } from '../../aws/ssm'
import {
  awsComputeIngressRules,
  buildAwsUserData,
  encodeUserData,
  resolveAwsImageId,
  UBUNTU_AMI_SSM_PARAM,
} from './provision'

export interface AwsDriverOptions {
  region?: string
}

export class AwsDriver implements CloudDriver {
  readonly name = 'aws' as const
  readonly usesCloudFormation = true

  private region: string

  constructor(options: AwsDriverOptions = {}) {
    this.region = options.region || 'us-east-1'
  }

  private resolveRegion(config: CloudConfig): string {
    return config.project.region || this.region
  }

  /**
   * Provision a single Ubuntu EC2 box for the Forge/PHP path — mirroring the
   * Hetzner driver, bypassing the heavy CloudFormation stack. Boots the shared
   * Ubuntu bootstrap (or a baked golden AMI), fronted by a security group, and
   * tagged so deploys (SSM) find it. Idempotent: reuses a running instance.
   *
   * NOTE: deploys run over SSM, so the instance needs the SSM agent + an IAM
   * instance profile granting AmazonSSMManagedInstanceCore. Provide it via
   * `compute.server.iamInstanceProfile` (live-verified step).
   */
  async provisionComputeInfrastructure(options: ProvisionComputeOptions): Promise<ComputeStackOutputs> {
    const { config, environment } = options
    const region = this.resolveRegion(config)
    const slug = config.project.slug
    const compute = config.infrastructure?.compute
    if (!compute)
      throw new Error('infrastructure.compute is required to provision AWS compute')

    const ec2 = new EC2Client(region)

    // Idempotency — reuse a running/pending box tagged for this project.
    const existing = await this.findComputeTargets({ slug, environment, role: 'app' })
    if (existing.length > 0) {
      const first = existing[0]
      return { appInstanceId: first.id, appPublicIp: first.publicIp, sshUser: 'ubuntu', deployStoragePath: '/var/ts-cloud/staging' }
    }

    // AMI: explicit golden image, else latest Canonical Ubuntu 24.04 via SSM.
    let imageId = resolveAwsImageId(config)
    if (!imageId) {
      const ssm = new SSMClient(region)
      const param = await ssm.getParameter({ Name: UBUNTU_AMI_SSM_PARAM })
      imageId = param.Parameter?.Value ?? null
      if (!imageId)
        throw new Error('Could not resolve the Ubuntu 24.04 AMI from SSM')
    }

    // A VPC + a subnet to launch into. Prefer a subnet that auto-assigns a
    // public IP, else the instance has no public address for deploys/SSL.
    const vpcs = await ec2.describeVpcs()
    const vpc = (vpcs.Vpcs || []).find(v => v.IsDefault) || (vpcs.Vpcs || [])[0]
    if (!vpc?.VpcId)
      throw new Error('No VPC found to launch the instance into')
    const subnets = (await ec2.describeSubnets({ Filters: [{ Name: 'vpc-id', Values: [vpc.VpcId] }] })).Subnets || []
    const subnet = subnets.find(s => s.MapPublicIpOnLaunch) || subnets[0]
    const subnetId = subnet?.SubnetId
    if (!subnet?.MapPublicIpOnLaunch)
      // eslint-disable-next-line no-console
      console.warn('ts-cloud: no public subnet found; the instance may not get a public IP (deploys/SSL need one).')

    // Security group scoped to the VPC (a same-named SG in another VPC must not
    // be reused). Reconcile ingress rules every time so config changes apply.
    const sgName = `${slug}-${environment}-app-sg`
    const found = await ec2.describeSecurityGroups({ Filters: [{ Name: 'group-name', Values: [sgName] }, { Name: 'vpc-id', Values: [vpc.VpcId] }] })
    let groupId = found.SecurityGroups?.[0]?.GroupId
    if (!groupId) {
      const created = await ec2.createSecurityGroup({ GroupName: sgName, Description: `ts-cloud ${slug}/${environment} app`, VpcId: vpc.VpcId })
      groupId = created.GroupId
    }
    // Authorize desired ingress; ignore "already exists" so this is idempotent.
    const rules = awsComputeIngressRules(config)
    await ec2.authorizeSecurityGroupIngress({
      GroupId: groupId!,
      IpPermissions: rules.map(r => ({ IpProtocol: r.protocol, FromPort: r.port, ToPort: r.port, IpRanges: [{ CidrIp: r.cidr }] })),
    }).catch((e: any) => {
      if (!/InvalidPermission\.Duplicate/.test(e?.message || ''))
        throw e
    })

    const userData = encodeUserData(buildAwsUserData(config))
    const instanceType = compute.server?.instanceType || 't3.small'

    const run = await ec2.runInstances({
      ImageId: imageId,
      InstanceType: instanceType,
      MinCount: 1,
      MaxCount: 1,
      SecurityGroupIds: groupId ? [groupId] : undefined,
      SubnetId: subnetId,
      UserData: userData,
      IamInstanceProfile: compute.server?.iamInstanceProfile ? { Name: compute.server.iamInstanceProfile } : undefined,
      TagSpecifications: [{
        ResourceType: 'instance',
        Tags: [
          { Key: 'Name', Value: `${slug}-${environment}-app` },
          { Key: 'Project', Value: slug },
          { Key: 'Environment', Value: environment },
          { Key: 'Role', Value: 'app' },
        ],
      }],
    })

    const instanceId = run.Instances?.[0]?.InstanceId
    if (!instanceId)
      throw new Error('RunInstances did not return an instance id')

    const running = await ec2.waitForInstanceState(instanceId, 'running')
    if (!running)
      throw new Error(`Instance ${instanceId} did not reach 'running' before timeout`)
    return {
      appInstanceId: instanceId,
      appPublicIp: running.PublicIpAddress,
      sshUser: 'ubuntu',
      deployStoragePath: '/var/ts-cloud/staging',
    }
  }

  async getComputeOutputs(options: ProvisionComputeOptions): Promise<ComputeStackOutputs> {
    const region = this.resolveRegion(options.config)
    const stackName = resolveProjectStackName(options.config, options.environment)
    const cfn = new CloudFormationClient(region)
    try {
      const outputs = await cfn.getStackOutputs(stackName)
      return {
        deployBucketName: outputs.deployBucketName,
        appInstanceId: outputs.appInstanceId,
        appPublicIp: outputs.appPublicIp,
        sshUser: 'ec2-user',
      }
    }
    catch (err: any) {
      // Only fall back for "stack does not exist" (the lightweight EC2 boot
      // path creates no CloudFormation stack). Rethrow transient/permission
      // errors so they aren't masked as a missing stack.
      if (!/does not exist|ValidationError/i.test(err?.message || ''))
        throw err
      // Tag-based lookup of the instance booted by provisionComputeInfrastructure.
      const targets = await this.findComputeTargets({
        slug: options.config.project.slug,
        environment: options.environment,
        role: 'app',
      })
      const first = targets[0]
      return {
        appInstanceId: first?.id,
        appPublicIp: first?.publicIp,
        sshUser: 'ubuntu',
        deployStoragePath: '/var/ts-cloud/staging',
      }
    }
  }

  async uploadRelease(options: UploadReleaseOptions): Promise<UploadReleaseResult> {
    const region = this.resolveRegion(options.config)
    const outputs = await this.getComputeOutputs({
      config: options.config,
      environment: options.environment,
    })

    const bucket = outputs.deployBucketName
    if (!bucket) {
      throw new Error('No deployBucketName in stack outputs. Re-deploy infrastructure to add the staging bucket.')
    }

    const s3 = new S3Client(region)
    await s3.putObject({
      bucket,
      key: options.remoteKey,
      body: readFileSync(options.localPath),
      contentType: 'application/gzip',
    })

    return { artifactRef: `s3://${bucket}/${options.remoteKey}` }
  }

  async findComputeTargets(options: FindComputeTargetsOptions): Promise<ComputeTarget[]> {
    const region = this.region
    const ec2 = new EC2Client(region)
    const filters = [
      { Name: 'tag:Project', Values: [options.slug] },
      { Name: 'tag:Environment', Values: [options.environment] },
      { Name: 'tag:Role', Values: [options.role || 'app'] },
      { Name: 'instance-state-name', Values: ['running', 'pending'] },
    ]

    const result = await ec2.describeInstances({ Filters: filters })
    const targets: ComputeTarget[] = []

    for (const reservation of result.Reservations || []) {
      for (const instance of reservation.Instances || []) {
        if (!instance.InstanceId) continue
        const nameTag = instance.Tags?.find(tag => tag.Key === 'Name')?.Value
        targets.push({
          id: instance.InstanceId,
          name: nameTag,
          publicIp: instance.PublicIpAddress,
          privateIp: instance.PrivateIpAddress,
          status: instance.State?.Name,
        })
      }
    }

    return targets
  }

  /**
   * SSM AWS-RunShellScript executes the joined commands with `/bin/sh` (dash on
   * Ubuntu), which rejects bash-only syntax like `set -o pipefail`. Our deploy
   * scripts are bash, so run them through a bash heredoc.
   */
  private bashWrap(commands: string[]): string[] {
    return ['bash <<\'TS_CLOUD_BASH_EOF\'', commands.join('\n'), 'TS_CLOUD_BASH_EOF']
  }

  async runRemoteDeploy(options: RunRemoteDeployOptions): Promise<RemoteDeployResult> {
    const region = this.region
    const ssm = new SSMClient(region)

    if (options.targets.length > 0) {
      const sendResult = await ssm.sendCommand({
        InstanceIds: options.targets.map(target => target.id),
        DocumentName: 'AWS-RunShellScript',
        Parameters: { commands: this.bashWrap(options.commands) },
        TimeoutSeconds: options.timeoutSeconds || 600,
        Comment: options.comment,
      })

      if (!sendResult.CommandId) {
        return { success: false, instanceCount: 0, perInstance: [], error: 'Failed to send SSM command' }
      }

      return this.pollSsmCommand(ssm, sendResult.CommandId, options.targets.length)
    }

    if (!options.tags || Object.keys(options.tags).length === 0) {
      return { success: false, instanceCount: 0, perInstance: [], error: 'No targets or tags provided for AWS deploy' }
    }

    const result = await ssm.sendCommandByTags({
      tags: options.tags,
      commands: this.bashWrap(options.commands),
      timeoutSeconds: options.timeoutSeconds || 600,
      comment: options.comment,
    })

    return {
      success: result.success,
      instanceCount: result.instanceCount,
      perInstance: result.perInstance.map(item => ({
        instanceId: item.instanceId,
        status: item.status,
        output: item.output,
        error: item.error,
      })),
      error: result.error,
    }
  }

  private async pollSsmCommand(ssm: SSMClient, commandId: string, expectedCount: number): Promise<RemoteDeployResult> {
    const pollInterval = 3000
    const maxWait = 600000
    const startTime = Date.now()
    const terminalStatuses = new Set(['Success', 'Failed', 'Cancelled', 'TimedOut'])
    let lastInvocations: Array<{ InstanceId: string, Status?: string, StandardOutputContent?: string, StandardErrorContent?: string }> = []

    while (Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, pollInterval))
      try {
        const invocations = await ssm.listCommandInvocations({ CommandId: commandId, Details: true })
        lastInvocations = invocations
        if (lastInvocations.length >= expectedCount && lastInvocations.every(i => terminalStatuses.has(i.Status || ''))) {
          break
        }
      }
      catch {
        // keep polling
      }
    }

    const perInstance = lastInvocations.map(item => ({
      instanceId: item.InstanceId,
      status: item.Status || 'Unknown',
      output: item.StandardOutputContent,
      error: item.StandardErrorContent,
    }))

    const success = perInstance.length > 0 && perInstance.every(item => item.status === 'Success')
    return {
      success,
      instanceCount: perInstance.length,
      perInstance,
      error: success ? undefined : 'One or more SSM command invocations failed',
    }
  }
}
