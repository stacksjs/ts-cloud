import type { JsonValue } from '../control-plane'
import type { QueueExecutionContext } from '../queue'
import type { BackupPolicy, RecoveryPoint } from './model'
import type { BackupSourceAdapter, BackupSourceResult } from './service'
import { createHash } from 'node:crypto'
import { AwsBackupClient } from '../aws/backup'

export interface InfrastructureBackupClient {
  startBackupJob(input: {
    BackupVaultName: string
    ResourceArn: string
    IamRoleArn: string
    IdempotencyToken: string
  }): Promise<{ BackupJobId: string }>
  describeBackupJob(id: string): Promise<{
    State?: string
    StatusMessage?: string
    RecoveryPointArn?: string
    BackupSizeInBytes?: number
  }>
  startRestoreJob(input: {
    RecoveryPointArn: string
    IamRoleArn: string
    Metadata: Record<string, string>
    IdempotencyToken: string
  }): Promise<{ RestoreJobId: string }>
  describeRestoreJob(id: string): Promise<{
    Status?: string
    StatusMessage?: string
    CreatedResourceArn?: string
  }>
  deleteRecoveryPoint(vault: string, recoveryPointArn: string): Promise<void>
}

function setting(patterns: string[], name: string): string | undefined {
  return patterns.find((item) => item.startsWith(`${name}:`))?.slice(name.length + 1)
}

function policySettings(policy: BackupPolicy): {
  resourceArn: string
  roleArn: string
  vaultName: string
} {
  const resourceArn =
      setting(policy.includePatterns, 'resource') ?? policy.includePatterns.find((item) => item.startsWith('arn:')),
    roleArn = setting(policy.includePatterns, 'role'),
    vaultName = setting(policy.includePatterns, 'vault') ?? 'Default'
  if (!resourceArn?.startsWith('arn:'))
    throw new Error('Infrastructure backups require resource:<arn> in include patterns.')
  if (!roleArn?.startsWith('arn:'))
    throw new Error('Infrastructure backups require role:<iam-role-arn> in include patterns.')
  if (!/^[A-Za-z0-9_.-]{2,50}$/.test(vaultName)) throw new Error('Infrastructure backup vault name is invalid.')
  return { resourceArn, roleArn, vaultName }
}

async function waitForBackup(
  client: InfrastructureBackupClient,
  id: string,
  context: QueueExecutionContext,
): Promise<{ recoveryPointArn: string; sizeBytes: number }> {
  for (;; ) {
    context.throwIfCancellationRequested()
    context.heartbeat()
    const job = await client.describeBackupJob(id),
      state = String(job.State ?? '')
    context.checkpoint('provider_backup', `AWS Backup job ${id} is ${state || 'pending'}.`)
    if (state === 'COMPLETED' && job.RecoveryPointArn)
      return { recoveryPointArn: job.RecoveryPointArn, sizeBytes: Number(job.BackupSizeInBytes ?? 0) }
    if (['ABORTED', 'EXPIRED', 'FAILED'].includes(state))
      throw new Error(`AWS Backup job ${id} failed: ${job.StatusMessage ?? state}.`)
    await Bun.sleep(5_000)
  }
}

async function waitForRestore(
  client: InfrastructureBackupClient,
  id: string,
  context: QueueExecutionContext,
): Promise<string> {
  for (;; ) {
    context.throwIfCancellationRequested()
    context.heartbeat()
    const job = await client.describeRestoreJob(id),
      status = String(job.Status ?? '')
    context.checkpoint('provider_restore', `AWS Backup restore ${id} is ${status || 'pending'}.`)
    if (status === 'COMPLETED' && job.CreatedResourceArn) return job.CreatedResourceArn
    if (['ABORTED', 'FAILED'].includes(status))
      throw new Error(`AWS Backup restore ${id} failed: ${job.StatusMessage ?? status}.`)
    await Bun.sleep(5_000)
  }
}

export class AwsInfrastructureBackupSource implements BackupSourceAdapter {
  constructor(private readonly client: InfrastructureBackupClient = new AwsBackupClient()) {}

  async create(policy: BackupPolicy, context: QueueExecutionContext): Promise<BackupSourceResult> {
    const settings = policySettings(policy),
      token = String(context.operation.id)
        .replace(/[^A-Za-z0-9-]/g, '')
        .slice(0, 64),
      started = await this.client.startBackupJob({
        BackupVaultName: settings.vaultName,
        ResourceArn: settings.resourceArn,
        IamRoleArn: settings.roleArn,
        IdempotencyToken: token,
      }),
      completed = await waitForBackup(this.client, started.BackupJobId, context),
      checksum = `sha256:${createHash('sha256').update(completed.recoveryPointArn).digest('hex')}`
    return {
      mode: 'external',
      uri: completed.recoveryPointArn,
      checksum,
      sizeBytes: completed.sizeBytes,
      toolVersion: 'aws-backup-api',
      manifest: {
        provider: 'aws_backup',
        resourceArn: settings.resourceArn,
        roleArn: settings.roleArn,
        vaultName: settings.vaultName,
        providerBackupJobId: started.BackupJobId,
        recoveryPointArn: completed.recoveryPointArn,
      },
    }
  }

  async verifyExternal(point: RecoveryPoint, _context: QueueExecutionContext): Promise<Record<string, JsonValue>> {
    const id = String(point.manifest.providerBackupJobId ?? ''),
      job = await this.client.describeBackupJob(id)
    if (job.State !== 'COMPLETED' || job.RecoveryPointArn !== point.uri)
      throw new Error(`AWS Backup recovery point verification failed: ${job.StatusMessage ?? job.State ?? 'unknown'}.`)
    return {
      state: job.State,
      recoveryPointArn: job.RecoveryPointArn,
      sizeBytes: Number(job.BackupSizeInBytes ?? point.sizeBytes),
    }
  }

  async restore(
    point: RecoveryPoint,
    _body: Uint8Array | undefined,
    target: Record<string, JsonValue>,
    context: QueueExecutionContext,
  ): Promise<Record<string, JsonValue>> {
    if (target.inPlace === true) throw new Error('AWS Backup infrastructure restores must create isolated resources.')
    const roleArn = String(target.roleArn ?? point.manifest.roleArn ?? ''),
      metadata =
        target.metadata && typeof target.metadata === 'object' && !Array.isArray(target.metadata)
          ? Object.fromEntries(Object.entries(target.metadata).map(([key, value]) => [key, String(value)]))
          : {}
    if (!roleArn.startsWith('arn:')) throw new Error('AWS Backup restore requires an IAM role ARN.')
    if (!Object.keys(metadata).length) throw new Error('AWS Backup restore requires provider restore metadata.')
    const started = await this.client.startRestoreJob({
        RecoveryPointArn: point.uri,
        IamRoleArn: roleArn,
        Metadata: metadata,
        IdempotencyToken: String(context.operation.id)
          .replace(/[^A-Za-z0-9-]/g, '')
          .slice(0, 64),
      }),
      createdResourceArn = await waitForRestore(this.client, started.RestoreJobId, context)
    return { providerRestoreJobId: started.RestoreJobId, createdResourceArn, isolated: true, healthy: true }
  }

  async validateHealth(
    target: Record<string, JsonValue>,
    _context: QueueExecutionContext,
  ): Promise<Record<string, JsonValue>> {
    const createdResourceArn = String(target.createdResourceArn ?? '')
    return { healthy: createdResourceArn.startsWith('arn:'), createdResourceArn }
  }

  async deleteExternal(point: RecoveryPoint, _context: QueueExecutionContext): Promise<void> {
    await this.client.deleteRecoveryPoint(String(point.manifest.vaultName ?? ''), point.uri)
  }
}
