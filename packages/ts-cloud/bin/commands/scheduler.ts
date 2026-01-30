import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import { SchedulerClient, type Schedule, type ScheduleGroup } from '../../src/aws/scheduler'
import { loadValidatedConfig } from './shared'

export function registerSchedulerCommands(app: CLI): void {
  app
    .command('scheduler:list', 'List all EventBridge schedules')
    .option('--region <region>', 'AWS region')
    .option('--group <name>', 'Schedule group name', { default: 'default' })
    .action(async (options: { region?: string; group: string }) => {
      cli.header('EventBridge Schedules')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const scheduler = new SchedulerClient(region)

        const spinner = new cli.Spinner('Fetching schedules...')
        spinner.start()

        const result = await scheduler.listSchedules({ GroupName: options.group })
        const schedules = result.Schedules || []

        spinner.succeed(`Found ${schedules.length} schedule(s)`)

        if (schedules.length === 0) {
          cli.info('No schedules found')
          cli.info('Use `cloud scheduler:create` to create a new schedule')
          return
        }

        cli.table(
          ['Name', 'State', 'Schedule Expression', 'Group'],
          schedules.map((s: Schedule) => [
            s.Name || 'N/A',
            s.State || 'N/A',
            s.ScheduleExpression || 'N/A',
            s.GroupName || 'default',
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list schedules: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('scheduler:create <name>', 'Create a new EventBridge schedule')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--schedule <expression>', 'Schedule expression (rate or cron)')
    .option('--target-arn <arn>', 'Target ARN (Lambda, SQS, SNS, etc.)')
    .option('--role-arn <arn>', 'IAM role ARN for scheduler')
    .option('--input <json>', 'JSON input to pass to target')
    .option('--group <name>', 'Schedule group name', { default: 'default' })
    .option('--timezone <tz>', 'Timezone for cron expressions', { default: 'UTC' })
    .option('--description <text>', 'Schedule description')
    .option('--start <datetime>', 'Start date/time (ISO 8601)')
    .option('--end <datetime>', 'End date/time (ISO 8601)')
    .action(async (name: string, options: {
      region: string
      schedule?: string
      targetArn?: string
      roleArn?: string
      input?: string
      group: string
      timezone: string
      description?: string
      start?: string
      end?: string
    }) => {
      cli.header('Create EventBridge Schedule')

      try {
        if (!options.schedule) {
          cli.error('--schedule is required')
          cli.info('Examples:')
          cli.info('  Rate: rate(5 minutes), rate(1 hour), rate(1 day)')
          cli.info('  Cron: cron(0 12 * * ? *) - every day at 12:00 UTC')
          return
        }

        if (!options.targetArn) {
          cli.error('--target-arn is required')
          return
        }

        if (!options.roleArn) {
          cli.error('--role-arn is required')
          cli.info('The role must have permissions to invoke the target.')
          return
        }

        const scheduler = new SchedulerClient(options.region)

        cli.info(`Name: ${name}`)
        cli.info(`Schedule: ${options.schedule}`)
        cli.info(`Target: ${options.targetArn}`)
        cli.info(`Group: ${options.group}`)
        cli.info(`Timezone: ${options.timezone}`)

        const confirmed = await cli.confirm('\nCreate this schedule?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Creating schedule...')
        spinner.start()

        await scheduler.createSchedule({
          Name: name,
          GroupName: options.group,
          ScheduleExpression: options.schedule,
          ScheduleExpressionTimezone: options.timezone,
          Description: options.description,
          State: 'ENABLED',
          FlexibleTimeWindow: {
            Mode: 'OFF',
          },
          Target: {
            Arn: options.targetArn,
            RoleArn: options.roleArn,
            Input: options.input,
          },
          StartDate: options.start ? new Date(options.start) : undefined,
          EndDate: options.end ? new Date(options.end) : undefined,
        })

        spinner.succeed('Schedule created')

        cli.success(`\nSchedule: ${name}`)
        cli.info(`Expression: ${options.schedule}`)
      }
      catch (error: any) {
        cli.error(`Failed to create schedule: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('scheduler:delete <name>', 'Delete an EventBridge schedule')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--group <name>', 'Schedule group name', { default: 'default' })
    .action(async (name: string, options: { region: string; group: string }) => {
      cli.header('Delete EventBridge Schedule')

      try {
        const scheduler = new SchedulerClient(options.region)

        cli.warn(`This will delete schedule: ${name}`)

        const confirmed = await cli.confirm('\nDelete this schedule?', false)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Deleting schedule...')
        spinner.start()

        await scheduler.deleteSchedule({
          Name: name,
          GroupName: options.group,
        })

        spinner.succeed('Schedule deleted')
      }
      catch (error: any) {
        cli.error(`Failed to delete schedule: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('scheduler:enable <name>', 'Enable an EventBridge schedule')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--group <name>', 'Schedule group name', { default: 'default' })
    .action(async (name: string, options: { region: string; group: string }) => {
      cli.header('Enable EventBridge Schedule')

      try {
        const scheduler = new SchedulerClient(options.region)

        const spinner = new cli.Spinner('Getting schedule...')
        spinner.start()

        // Get current schedule
        const current = await scheduler.getSchedule({
          Name: name,
          GroupName: options.group,
        })

        if (!current) {
          spinner.fail('Schedule not found')
          return
        }

        spinner.text = 'Enabling schedule...'

        await scheduler.updateSchedule({
          Name: name,
          GroupName: options.group,
          ScheduleExpression: current.ScheduleExpression,
          ScheduleExpressionTimezone: current.ScheduleExpressionTimezone,
          FlexibleTimeWindow: current.FlexibleTimeWindow,
          Target: current.Target,
          State: 'ENABLED',
        })

        spinner.succeed('Schedule enabled')
      }
      catch (error: any) {
        cli.error(`Failed to enable schedule: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('scheduler:disable <name>', 'Disable an EventBridge schedule')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--group <name>', 'Schedule group name', { default: 'default' })
    .action(async (name: string, options: { region: string; group: string }) => {
      cli.header('Disable EventBridge Schedule')

      try {
        const scheduler = new SchedulerClient(options.region)

        const spinner = new cli.Spinner('Getting schedule...')
        spinner.start()

        // Get current schedule
        const current = await scheduler.getSchedule({
          Name: name,
          GroupName: options.group,
        })

        if (!current) {
          spinner.fail('Schedule not found')
          return
        }

        spinner.text = 'Disabling schedule...'

        await scheduler.updateSchedule({
          Name: name,
          GroupName: options.group,
          ScheduleExpression: current.ScheduleExpression,
          ScheduleExpressionTimezone: current.ScheduleExpressionTimezone,
          FlexibleTimeWindow: current.FlexibleTimeWindow,
          Target: current.Target,
          State: 'DISABLED',
        })

        spinner.succeed('Schedule disabled')
      }
      catch (error: any) {
        cli.error(`Failed to disable schedule: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('scheduler:describe <name>', 'Show EventBridge schedule details')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--group <name>', 'Schedule group name', { default: 'default' })
    .action(async (name: string, options: { region: string; group: string }) => {
      cli.header(`Schedule: ${name}`)

      try {
        const scheduler = new SchedulerClient(options.region)

        const spinner = new cli.Spinner('Fetching schedule...')
        spinner.start()

        const schedule = await scheduler.getSchedule({
          Name: name,
          GroupName: options.group,
        })

        if (!schedule) {
          spinner.fail('Schedule not found')
          return
        }

        spinner.succeed('Schedule loaded')

        cli.info('\nSchedule Information:')
        cli.info(`  Name: ${schedule.Name}`)
        cli.info(`  ARN: ${schedule.Arn}`)
        cli.info(`  Group: ${schedule.GroupName}`)
        cli.info(`  State: ${schedule.State}`)
        cli.info(`  Expression: ${schedule.ScheduleExpression}`)
        cli.info(`  Timezone: ${schedule.ScheduleExpressionTimezone}`)

        if (schedule.Description) {
          cli.info(`  Description: ${schedule.Description}`)
        }

        if (schedule.Target) {
          cli.info('\nTarget:')
          cli.info(`  ARN: ${schedule.Target.Arn}`)
          cli.info(`  Role ARN: ${schedule.Target.RoleArn}`)
          if (schedule.Target.Input) {
            cli.info(`  Input: ${schedule.Target.Input}`)
          }
        }

        cli.info('\nFlexible Time Window:')
        cli.info(`  Mode: ${schedule.FlexibleTimeWindow?.Mode}`)
        if (schedule.FlexibleTimeWindow?.MaximumWindowInMinutes) {
          cli.info(`  Max Window: ${schedule.FlexibleTimeWindow.MaximumWindowInMinutes} minutes`)
        }

        if (schedule.StartDate) {
          cli.info(`\nStart Date: ${schedule.StartDate}`)
        }
        if (schedule.EndDate) {
          cli.info(`End Date: ${schedule.EndDate}`)
        }

        cli.info(`\nCreated: ${schedule.CreationDate || 'N/A'}`)
        cli.info(`Last Modified: ${schedule.LastModificationDate || 'N/A'}`)
      }
      catch (error: any) {
        cli.error(`Failed to get schedule: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('scheduler:groups', 'List schedule groups')
    .option('--region <region>', 'AWS region')
    .action(async (options: { region?: string }) => {
      cli.header('Schedule Groups')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const scheduler = new SchedulerClient(region)

        const spinner = new cli.Spinner('Fetching groups...')
        spinner.start()

        const result = await scheduler.listScheduleGroups()
        const groups = result.ScheduleGroups || []

        spinner.succeed(`Found ${groups.length} group(s)`)

        if (groups.length === 0) {
          cli.info('No schedule groups found')
          return
        }

        cli.table(
          ['Name', 'State', 'Created'],
          groups.map((g: ScheduleGroup) => [
            g.Name || 'N/A',
            g.State || 'N/A',
            g.CreationDate ? new Date(g.CreationDate).toLocaleString() : 'N/A',
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list groups: ${error.message}`)
        process.exit(1)
      }
    })
}
