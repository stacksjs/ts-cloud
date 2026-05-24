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

  async getComputeOutputs(options: ProvisionComputeOptions): Promise<ComputeStackOutputs> {
    const region = this.resolveRegion(options.config)
    const stackName = resolveProjectStackName(options.config, options.environment)
    const cfn = new CloudFormationClient(region)
    const outputs = await cfn.getStackOutputs(stackName)
    return {
      deployBucketName: outputs.deployBucketName,
      appInstanceId: outputs.appInstanceId,
      appPublicIp: outputs.appPublicIp,
      sshUser: 'ec2-user',
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

  async runRemoteDeploy(options: RunRemoteDeployOptions): Promise<RemoteDeployResult> {
    const region = this.region
    const ssm = new SSMClient(region)

    if (options.targets.length > 0) {
      const sendResult = await ssm.sendCommand({
        InstanceIds: options.targets.map(target => target.id),
        DocumentName: 'AWS-RunShellScript',
        Parameters: { commands: options.commands },
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
      commands: options.commands,
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
