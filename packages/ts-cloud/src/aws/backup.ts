import { AWSClient } from './client'

export interface AwsBackupJob {
  BackupJobId?: string
  State?: string
  StatusMessage?: string
  RecoveryPointArn?: string
  BackupSizeInBytes?: number
  ResourceArn?: string
  BackupVaultName?: string
}

export interface AwsRestoreJob {
  RestoreJobId?: string
  Status?: string
  StatusMessage?: string
  CreatedResourceArn?: string
  RecoveryPointArn?: string
}

export class AwsBackupClient {
  constructor(
    private readonly region = 'us-east-1',
    private readonly client: AWSClient = new AWSClient(),
  ) {}

  private request<T>(action: string, input: Record<string, unknown>): Promise<T> {
    return this.client.request({
      service: 'backup',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `CryoControllerFrontendService.${action}`,
      },
      body: JSON.stringify(input),
    }) as Promise<T>
  }

  startBackupJob(input: {
    BackupVaultName: string
    ResourceArn: string
    IamRoleArn: string
    IdempotencyToken: string
  }): Promise<{ BackupJobId: string }> {
    return this.request('StartBackupJob', input)
  }

  describeBackupJob(BackupJobId: string): Promise<AwsBackupJob> {
    return this.request('DescribeBackupJob', { BackupJobId })
  }

  startRestoreJob(input: {
    RecoveryPointArn: string
    IamRoleArn: string
    Metadata: Record<string, string>
    IdempotencyToken: string
  }): Promise<{ RestoreJobId: string }> {
    return this.request('StartRestoreJob', input)
  }

  describeRestoreJob(RestoreJobId: string): Promise<AwsRestoreJob> {
    return this.request('DescribeRestoreJob', { RestoreJobId })
  }

  deleteRecoveryPoint(BackupVaultName: string, RecoveryPointArn: string): Promise<void> {
    return this.request('DeleteRecoveryPoint', { BackupVaultName, RecoveryPointArn })
  }
}
