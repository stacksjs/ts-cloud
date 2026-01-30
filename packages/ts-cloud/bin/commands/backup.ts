import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import { loadValidatedConfig } from './shared'

// AWS Backup client
async function getBackupClient(region: string) {
  const { AWSClient } = await import('../../src/aws/client')

  class BackupClient {
    private client: InstanceType<typeof AWSClient>
    private region: string

    constructor(region: string) {
      this.region = region
      this.client = new AWSClient()
    }

    private async jsonRpcRequest(action: string, params: Record<string, any>): Promise<any> {
      return this.client.request({
        service: 'backup',
        region: this.region,
        method: 'POST',
        path: '/',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': `CryoControllerFrontendService.${action}`,
        },
        body: JSON.stringify(params),
      })
    }

    async listBackupVaults() {
      return this.jsonRpcRequest('ListBackupVaults', {})
    }

    async listBackupPlans() {
      return this.jsonRpcRequest('ListBackupPlans', {})
    }

    async listRecoveryPointsByBackupVault(vaultName: string, params?: { MaxResults?: number }) {
      return this.jsonRpcRequest('ListRecoveryPointsByBackupVault', {
        BackupVaultName: vaultName,
        ...params,
      })
    }

    async describeBackupVault(vaultName: string) {
      return this.jsonRpcRequest('DescribeBackupVault', { BackupVaultName: vaultName })
    }

    async getBackupPlan(planId: string) {
      return this.jsonRpcRequest('GetBackupPlan', { BackupPlanId: planId })
    }

    async createBackupVault(vaultName: string, params?: { EncryptionKeyArn?: string }) {
      return this.jsonRpcRequest('CreateBackupVault', {
        BackupVaultName: vaultName,
        ...params,
      })
    }

    async deleteBackupVault(vaultName: string) {
      return this.jsonRpcRequest('DeleteBackupVault', { BackupVaultName: vaultName })
    }

    async createBackupPlan(plan: any) {
      return this.jsonRpcRequest('CreateBackupPlan', { BackupPlan: plan })
    }

    async deleteBackupPlan(planId: string) {
      return this.jsonRpcRequest('DeleteBackupPlan', { BackupPlanId: planId })
    }

    async startBackupJob(params: {
      BackupVaultName: string
      ResourceArn: string
      IamRoleArn: string
      IdempotencyToken?: string
    }) {
      return this.jsonRpcRequest('StartBackupJob', params)
    }

    async startRestoreJob(params: {
      RecoveryPointArn: string
      IamRoleArn: string
      Metadata: Record<string, string>
      IdempotencyToken?: string
    }) {
      return this.jsonRpcRequest('StartRestoreJob', params)
    }

    async describeBackupJob(jobId: string) {
      return this.jsonRpcRequest('DescribeBackupJob', { BackupJobId: jobId })
    }

    async describeRestoreJob(jobId: string) {
      return this.jsonRpcRequest('DescribeRestoreJob', { RestoreJobId: jobId })
    }

    async listBackupJobs(params?: { ByState?: string; MaxResults?: number }) {
      return this.jsonRpcRequest('ListBackupJobs', params || {})
    }

    async listRestoreJobs(params?: { ByStatus?: string; MaxResults?: number }) {
      return this.jsonRpcRequest('ListRestoreJobs', params || {})
    }

    async createBackupSelection(planId: string, selection: any) {
      return this.jsonRpcRequest('CreateBackupSelection', {
        BackupPlanId: planId,
        BackupSelection: selection,
      })
    }

    async listBackupSelections(planId: string) {
      return this.jsonRpcRequest('ListBackupSelections', { BackupPlanId: planId })
    }
  }

  return new BackupClient(region)
}

export function registerBackupCommands(app: CLI): void {
  app
    .command('backup:vaults', 'List backup vaults')
    .option('--region <region>', 'AWS region')
    .action(async (options: { region?: string }) => {
      cli.header('Backup Vaults')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const backup = await getBackupClient(region)

        const spinner = new cli.Spinner('Fetching vaults...')
        spinner.start()

        const result = await backup.listBackupVaults()
        const vaults = result.BackupVaultList || []

        spinner.succeed(`Found ${vaults.length} vault(s)`)

        if (vaults.length === 0) {
          cli.info('No backup vaults found')
          cli.info('Use `cloud backup:create-vault` to create a new vault')
          return
        }

        cli.table(
          ['Vault Name', 'Recovery Points', 'Created', 'Encrypted'],
          vaults.map((vault: any) => [
            vault.BackupVaultName || 'N/A',
            (vault.NumberOfRecoveryPoints || 0).toString(),
            vault.CreationDate ? new Date(vault.CreationDate).toLocaleDateString() : 'N/A',
            vault.EncryptionKeyArn ? 'Yes' : 'Default',
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list vaults: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('backup:list', 'List backup plans')
    .option('--region <region>', 'AWS region')
    .action(async (options: { region?: string }) => {
      cli.header('Backup Plans')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const backup = await getBackupClient(region)

        const spinner = new cli.Spinner('Fetching backup plans...')
        spinner.start()

        const result = await backup.listBackupPlans()
        const plans = result.BackupPlansList || []

        spinner.succeed(`Found ${plans.length} backup plan(s)`)

        if (plans.length === 0) {
          cli.info('No backup plans found')
          cli.info('Use `cloud backup:create` to create a backup plan')
          return
        }

        cli.table(
          ['Plan Name', 'Plan ID', 'Version', 'Created'],
          plans.map((plan: any) => [
            plan.BackupPlanName || 'N/A',
            plan.BackupPlanId || 'N/A',
            plan.VersionId?.substring(0, 8) || 'N/A',
            plan.CreationDate ? new Date(plan.CreationDate).toLocaleDateString() : 'N/A',
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list backup plans: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('backup:recovery-points <vaultName>', 'List recovery points in a vault')
    .option('--region <region>', 'AWS region')
    .option('--limit <number>', 'Maximum results', { default: '50' })
    .action(async (vaultName: string, options: { region?: string; limit: string }) => {
      cli.header(`Recovery Points: ${vaultName}`)

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const backup = await getBackupClient(region)

        const spinner = new cli.Spinner('Fetching recovery points...')
        spinner.start()

        const result = await backup.listRecoveryPointsByBackupVault(vaultName, {
          MaxResults: Number.parseInt(options.limit),
        })

        const points = result.RecoveryPoints || []

        spinner.succeed(`Found ${points.length} recovery point(s)`)

        if (points.length === 0) {
          cli.info('No recovery points found')
          return
        }

        cli.table(
          ['Resource', 'Status', 'Created', 'Size', 'Lifecycle'],
          points.map((point: any) => [
            point.ResourceArn?.split(':').pop() || 'N/A',
            point.Status || 'N/A',
            point.CreationDate ? new Date(point.CreationDate).toLocaleString() : 'N/A',
            point.BackupSizeInBytes ? formatBytes(point.BackupSizeInBytes) : 'N/A',
            point.Lifecycle?.DeleteAfterDays ? `${point.Lifecycle.DeleteAfterDays} days` : 'Indefinite',
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list recovery points: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('backup:create-vault <vaultName>', 'Create a backup vault')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--kms-key <arn>', 'KMS key ARN for encryption')
    .action(async (vaultName: string, options: { region: string; kmsKey?: string }) => {
      cli.header('Create Backup Vault')

      try {
        const backup = await getBackupClient(options.region)

        cli.info(`Vault Name: ${vaultName}`)
        cli.info(`Region: ${options.region}`)
        cli.info(`Encryption: ${options.kmsKey ? 'Custom KMS' : 'AWS Managed'}`)

        const confirmed = await cli.confirm('\nCreate this vault?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Creating vault...')
        spinner.start()

        await backup.createBackupVault(vaultName, {
          EncryptionKeyArn: options.kmsKey,
        })

        spinner.succeed('Vault created')

        cli.success(`\nVault: ${vaultName}`)
      }
      catch (error: any) {
        cli.error(`Failed to create vault: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('backup:create <planName>', 'Create a backup plan')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--vault <name>', 'Target backup vault', { default: 'Default' })
    .option('--schedule <cron>', 'Backup schedule (cron expression)', { default: 'cron(0 5 ? * * *)' })
    .option('--retention <days>', 'Retention period in days', { default: '30' })
    .option('--lifecycle-cold <days>', 'Move to cold storage after days')
    .action(async (planName: string, options: {
      region: string
      vault: string
      schedule: string
      retention: string
      lifecycleCold?: string
    }) => {
      cli.header('Create Backup Plan')

      try {
        const backup = await getBackupClient(options.region)

        cli.info(`Plan Name: ${planName}`)
        cli.info(`Vault: ${options.vault}`)
        cli.info(`Schedule: ${options.schedule}`)
        cli.info(`Retention: ${options.retention} days`)

        const confirmed = await cli.confirm('\nCreate this backup plan?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Creating backup plan...')
        spinner.start()

        const lifecycle: any = {
          DeleteAfterDays: Number.parseInt(options.retention),
        }

        if (options.lifecycleCold) {
          lifecycle.MoveToColdStorageAfterDays = Number.parseInt(options.lifecycleCold)
        }

        const result = await backup.createBackupPlan({
          BackupPlanName: planName,
          Rules: [
            {
              RuleName: `${planName}-daily`,
              TargetBackupVaultName: options.vault,
              ScheduleExpression: options.schedule,
              StartWindowMinutes: 60,
              CompletionWindowMinutes: 180,
              Lifecycle: lifecycle,
            },
          ],
        })

        spinner.succeed('Backup plan created')

        cli.success(`\nPlan ID: ${result.BackupPlanId}`)
        cli.info('\nNote: Add resource selections with `cloud backup:add-selection`')
      }
      catch (error: any) {
        cli.error(`Failed to create backup plan: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('backup:add-selection <planId>', 'Add resources to a backup plan')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--name <name>', 'Selection name')
    .option('--role <arn>', 'IAM role ARN for backup')
    .option('--resource <arn>', 'Resource ARN to backup')
    .option('--tag-key <key>', 'Tag key for resource selection')
    .option('--tag-value <value>', 'Tag value for resource selection')
    .action(async (planId: string, options: {
      region: string
      name?: string
      role?: string
      resource?: string
      tagKey?: string
      tagValue?: string
    }) => {
      cli.header('Add Backup Selection')

      try {
        if (!options.role) {
          cli.error('--role is required (IAM role ARN for AWS Backup)')
          return
        }

        if (!options.resource && !options.tagKey) {
          cli.error('Specify --resource or --tag-key/--tag-value')
          return
        }

        const backup = await getBackupClient(options.region)

        const selectionName = options.name || `selection-${Date.now()}`

        const selection: any = {
          SelectionName: selectionName,
          IamRoleArn: options.role,
        }

        if (options.resource) {
          selection.Resources = [options.resource]
          cli.info(`Resource: ${options.resource}`)
        }

        if (options.tagKey && options.tagValue) {
          selection.ListOfTags = [{
            ConditionType: 'STRINGEQUALS',
            ConditionKey: options.tagKey,
            ConditionValue: options.tagValue,
          }]
          cli.info(`Tag: ${options.tagKey}=${options.tagValue}`)
        }

        const confirmed = await cli.confirm('\nAdd this selection?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Adding selection...')
        spinner.start()

        const result = await backup.createBackupSelection(planId, selection)

        spinner.succeed('Selection added')

        cli.success(`\nSelection ID: ${result.SelectionId}`)
      }
      catch (error: any) {
        cli.error(`Failed to add selection: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('backup:start <resourceArn>', 'Start an on-demand backup')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--vault <name>', 'Backup vault name', { default: 'Default' })
    .option('--role <arn>', 'IAM role ARN for backup')
    .action(async (resourceArn: string, options: { region: string; vault: string; role?: string }) => {
      cli.header('Start Backup Job')

      try {
        if (!options.role) {
          cli.error('--role is required (IAM role ARN for AWS Backup)')
          return
        }

        const backup = await getBackupClient(options.region)

        cli.info(`Resource: ${resourceArn}`)
        cli.info(`Vault: ${options.vault}`)

        const confirmed = await cli.confirm('\nStart backup?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Starting backup job...')
        spinner.start()

        const result = await backup.startBackupJob({
          BackupVaultName: options.vault,
          ResourceArn: resourceArn,
          IamRoleArn: options.role,
          IdempotencyToken: `cli-${Date.now()}`,
        })

        spinner.succeed('Backup job started')

        cli.success(`\nJob ID: ${result.BackupJobId}`)
        cli.info('Use `cloud backup:jobs` to check status')
      }
      catch (error: any) {
        cli.error(`Failed to start backup: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('backup:restore <recoveryPointArn>', 'Start a restore job')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--role <arn>', 'IAM role ARN for restore')
    .option('--metadata <json>', 'Restore metadata JSON')
    .action(async (recoveryPointArn: string, options: { region: string; role?: string; metadata?: string }) => {
      cli.header('Start Restore Job')

      try {
        if (!options.role) {
          cli.error('--role is required (IAM role ARN for AWS Backup)')
          return
        }

        const backup = await getBackupClient(options.region)

        cli.info(`Recovery Point: ${recoveryPointArn}`)

        let metadata: Record<string, string> = {}
        if (options.metadata) {
          metadata = JSON.parse(options.metadata)
        }

        cli.warn('\nRestore will create new resources. Review carefully.')

        const confirmed = await cli.confirm('\nStart restore?', false)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Starting restore job...')
        spinner.start()

        const result = await backup.startRestoreJob({
          RecoveryPointArn: recoveryPointArn,
          IamRoleArn: options.role,
          Metadata: metadata,
          IdempotencyToken: `cli-${Date.now()}`,
        })

        spinner.succeed('Restore job started')

        cli.success(`\nJob ID: ${result.RestoreJobId}`)
        cli.info('Use `cloud backup:restore-jobs` to check status')
      }
      catch (error: any) {
        cli.error(`Failed to start restore: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('backup:jobs', 'List recent backup jobs')
    .option('--region <region>', 'AWS region')
    .option('--state <state>', 'Filter by state (CREATED, PENDING, RUNNING, COMPLETED, FAILED)')
    .action(async (options: { region?: string; state?: string }) => {
      cli.header('Backup Jobs')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const backup = await getBackupClient(region)

        const spinner = new cli.Spinner('Fetching backup jobs...')
        spinner.start()

        const result = await backup.listBackupJobs({
          ByState: options.state,
          MaxResults: 50,
        })

        const jobs = result.BackupJobs || []

        spinner.succeed(`Found ${jobs.length} job(s)`)

        if (jobs.length === 0) {
          cli.info('No backup jobs found')
          return
        }

        cli.table(
          ['Job ID', 'Resource', 'State', 'Started', 'Size'],
          jobs.map((job: any) => [
            job.BackupJobId?.substring(0, 16) || 'N/A',
            job.ResourceArn?.split(':').pop() || 'N/A',
            job.State || 'N/A',
            job.CreationDate ? new Date(job.CreationDate).toLocaleString() : 'N/A',
            job.BackupSizeInBytes ? formatBytes(job.BackupSizeInBytes) : 'N/A',
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list backup jobs: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('backup:restore-jobs', 'List recent restore jobs')
    .option('--region <region>', 'AWS region')
    .option('--status <status>', 'Filter by status')
    .action(async (options: { region?: string; status?: string }) => {
      cli.header('Restore Jobs')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const backup = await getBackupClient(region)

        const spinner = new cli.Spinner('Fetching restore jobs...')
        spinner.start()

        const result = await backup.listRestoreJobs({
          ByStatus: options.status,
          MaxResults: 50,
        })

        const jobs = result.RestoreJobs || []

        spinner.succeed(`Found ${jobs.length} job(s)`)

        if (jobs.length === 0) {
          cli.info('No restore jobs found')
          return
        }

        cli.table(
          ['Job ID', 'Resource', 'Status', 'Started', 'Completed'],
          jobs.map((job: any) => [
            job.RestoreJobId?.substring(0, 16) || 'N/A',
            job.CreatedResourceArn?.split(':').pop() || 'Pending',
            job.Status || 'N/A',
            job.CreationDate ? new Date(job.CreationDate).toLocaleString() : 'N/A',
            job.CompletionDate ? new Date(job.CompletionDate).toLocaleString() : '-',
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list restore jobs: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('backup:schedule', 'Show backup schedule overview')
    .option('--region <region>', 'AWS region')
    .action(async (options: { region?: string }) => {
      cli.header('Backup Schedule Overview')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const backup = await getBackupClient(region)

        const spinner = new cli.Spinner('Fetching backup plans...')
        spinner.start()

        const plansResult = await backup.listBackupPlans()
        const plans = plansResult.BackupPlansList || []

        spinner.succeed(`Found ${plans.length} backup plan(s)`)

        if (plans.length === 0) {
          cli.info('No backup plans configured')
          return
        }

        for (const planSummary of plans) {
          cli.info(`\n${planSummary.BackupPlanName}`)
          cli.info('='.repeat(40))

          try {
            const plan = await backup.getBackupPlan(planSummary.BackupPlanId)
            const rules = plan.BackupPlan?.Rules || []

            for (const rule of rules) {
              cli.info(`  Rule: ${rule.RuleName}`)
              cli.info(`    Schedule: ${rule.ScheduleExpression}`)
              cli.info(`    Vault: ${rule.TargetBackupVaultName}`)
              if (rule.Lifecycle?.DeleteAfterDays) {
                cli.info(`    Retention: ${rule.Lifecycle.DeleteAfterDays} days`)
              }
            }

            // Get selections
            const selections = await backup.listBackupSelections(planSummary.BackupPlanId)
            if (selections.BackupSelectionsList && selections.BackupSelectionsList.length > 0) {
              cli.info(`  Selections: ${selections.BackupSelectionsList.length}`)
            }
          }
          catch {
            cli.info('  (Unable to load plan details)')
          }
        }
      }
      catch (error: any) {
        cli.error(`Failed to get schedule: ${error.message}`)
        process.exit(1)
      }
    })
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`
}
