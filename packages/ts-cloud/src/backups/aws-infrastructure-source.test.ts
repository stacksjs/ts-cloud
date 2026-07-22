import { describe, expect, it } from 'bun:test'
import type { InfrastructureBackupClient } from './aws-infrastructure-source'
import { AwsInfrastructureBackupSource } from './aws-infrastructure-source'

function context() {
  return {
    operation: { id: 'operation-123' },
    throwIfCancellationRequested: () => {},
    heartbeat: () => {},
    checkpoint: () => {},
  } as any
}

describe('AWS infrastructure backup source', () => {
  it('creates, verifies, restores, and expires provider recovery points', async () => {
    const calls: Array<[string, unknown]> = [], client: InfrastructureBackupClient = {
      startBackupJob: async input => { calls.push(['start-backup', input]); return { BackupJobId: 'backup-job' } },
      describeBackupJob: async id => { calls.push(['describe-backup', id]); return { State: 'COMPLETED', RecoveryPointArn: 'arn:aws:backup:us-east-1:123:recovery-point:one', BackupSizeInBytes: 42 } },
      startRestoreJob: async input => { calls.push(['start-restore', input]); return { RestoreJobId: 'restore-job' } },
      describeRestoreJob: async id => { calls.push(['describe-restore', id]); return { Status: 'COMPLETED', CreatedResourceArn: 'arn:aws:ec2:us-east-1:123:volume/vol-restored' } },
      deleteRecoveryPoint: async (vault, arn) => { calls.push(['delete', { vault, arn }]) },
    }, source = new AwsInfrastructureBackupSource(client), created = await source.create({ projectId: 'project', includePatterns: ['resource:arn:aws:ec2:us-east-1:123:volume/vol-source', 'role:arn:aws:iam::123:role/backup', 'vault:production'] } as any, context())
    expect(created).toMatchObject({ mode: 'external', uri: 'arn:aws:backup:us-east-1:123:recovery-point:one', sizeBytes: 42, manifest: { vaultName: 'production', providerBackupJobId: 'backup-job' } })
    const point = { uri: created.mode === 'external' ? created.uri : '', sizeBytes: 42, manifest: created.manifest } as any
    expect(await source.verifyExternal(point, context())).toMatchObject({ state: 'COMPLETED', sizeBytes: 42 })
    const restored = await source.restore(point, undefined, { metadata: { availabilityZone: 'us-east-1a' } }, context())
    expect(restored).toMatchObject({ createdResourceArn: 'arn:aws:ec2:us-east-1:123:volume/vol-restored', isolated: true })
    expect(await source.validateHealth(restored, context())).toMatchObject({ healthy: true })
    await source.deleteExternal(point, context())
    expect(calls.map(([kind]) => kind)).toEqual(['start-backup', 'describe-backup', 'describe-backup', 'start-restore', 'describe-restore', 'delete'])
  })

  it('requires explicit resource and IAM-role selections', async () => {
    const source = new AwsInfrastructureBackupSource({} as any)
    await expect(source.create({ includePatterns: [] } as any, context())).rejects.toThrow('resource:<arn>')
  })
})
