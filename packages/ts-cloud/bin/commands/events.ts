import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import { EventBridgeClient } from '../../src/aws/eventbridge'
import { loadValidatedConfig } from './shared'

export function registerEventsCommands(app: CLI): void {
  app
    .command('events:list', 'List all EventBridge rules')
    .option('--region <region>', 'AWS region')
    .option('--bus <name>', 'Event bus name', { default: 'default' })
    .action(async (options: { region?: string; bus: string }) => {
      cli.header('EventBridge Rules')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const eventbridge = new EventBridgeClient(region)

        const spinner = new cli.Spinner('Fetching rules...')
        spinner.start()

        const result = await eventbridge.listRules({ EventBusName: options.bus })
        const rules = result.Rules || []

        spinner.succeed(`Found ${rules.length} rule(s)`)

        if (rules.length === 0) {
          cli.info('No EventBridge rules found')
          cli.info('Use `cloud events:create` to create a new rule')
          return
        }

        cli.table(
          ['Name', 'State', 'Schedule/Pattern', 'Description'],
          rules.map(rule => [
            rule.Name || 'N/A',
            rule.State || 'N/A',
            rule.ScheduleExpression || (rule.EventPattern ? 'Event Pattern' : 'N/A'),
            (rule.Description || '').substring(0, 40),
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list rules: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('events:create <name>', 'Create a new EventBridge rule')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--bus <name>', 'Event bus name', { default: 'default' })
    .option('--schedule <expression>', 'Schedule expression (rate or cron)')
    .option('--pattern <json>', 'Event pattern JSON')
    .option('--pattern-file <path>', 'Event pattern from JSON file')
    .option('--description <text>', 'Rule description')
    .option('--disabled', 'Create in disabled state')
    .action(async (name: string, options: {
      region: string
      bus: string
      schedule?: string
      pattern?: string
      patternFile?: string
      description?: string
      disabled?: boolean
    }) => {
      cli.header('Create EventBridge Rule')

      try {
        if (!options.schedule && !options.pattern && !options.patternFile) {
          cli.error('Either --schedule or --pattern/--pattern-file is required')
          cli.info('\nExamples:')
          cli.info('  Schedule: --schedule "rate(5 minutes)"')
          cli.info('  Pattern:  --pattern \'{"source": ["aws.ec2"]}\'')
          return
        }

        const eventbridge = new EventBridgeClient(options.region)

        let eventPattern: string | undefined

        if (options.patternFile) {
          const file = Bun.file(options.patternFile)
          eventPattern = await file.text()
        }
        else if (options.pattern) {
          eventPattern = options.pattern
        }

        cli.info(`Name: ${name}`)
        cli.info(`Event Bus: ${options.bus}`)
        if (options.schedule) {
          cli.info(`Schedule: ${options.schedule}`)
        }
        if (eventPattern) {
          cli.info(`Event Pattern: ${eventPattern}`)
        }
        cli.info(`State: ${options.disabled ? 'DISABLED' : 'ENABLED'}`)

        const confirmed = await cli.confirm('\nCreate this rule?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Creating rule...')
        spinner.start()

        const result = await eventbridge.putRule({
          Name: name,
          EventBusName: options.bus,
          ScheduleExpression: options.schedule,
          EventPattern: eventPattern,
          Description: options.description,
          State: options.disabled ? 'DISABLED' : 'ENABLED',
        })

        spinner.succeed('Rule created')

        cli.success(`\nRule ARN: ${result.RuleArn}`)
        cli.info('\nNote: Add targets to the rule with `cloud events:target`')
      }
      catch (error: any) {
        cli.error(`Failed to create rule: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('events:delete <name>', 'Delete an EventBridge rule')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--bus <name>', 'Event bus name', { default: 'default' })
    .option('--force', 'Remove all targets and delete rule')
    .action(async (name: string, options: { region: string; bus: string; force?: boolean }) => {
      cli.header('Delete EventBridge Rule')

      try {
        const eventbridge = new EventBridgeClient(options.region)

        cli.warn(`This will delete rule: ${name}`)

        const confirmed = await cli.confirm('\nDelete this rule?', false)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Checking targets...')
        spinner.start()

        // Check for targets
        const targets = await eventbridge.listTargetsByRule({
          Rule: name,
          EventBusName: options.bus,
        })

        if (targets.Targets && targets.Targets.length > 0) {
          if (!options.force) {
            spinner.fail('Rule has targets')
            cli.info(`\nThe rule has ${targets.Targets.length} target(s).`)
            cli.info('Use --force to remove targets and delete the rule.')
            return
          }

          spinner.text = 'Removing targets...'

          await eventbridge.removeTargets({
            Rule: name,
            EventBusName: options.bus,
            Ids: targets.Targets.map(t => t.Id!),
          })
        }

        spinner.text = 'Deleting rule...'

        await eventbridge.deleteRule({
          Name: name,
          EventBusName: options.bus,
        })

        spinner.succeed('Rule deleted')
      }
      catch (error: any) {
        cli.error(`Failed to delete rule: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('events:describe <name>', 'Show EventBridge rule details')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--bus <name>', 'Event bus name', { default: 'default' })
    .action(async (name: string, options: { region: string; bus: string }) => {
      cli.header(`Rule: ${name}`)

      try {
        const eventbridge = new EventBridgeClient(options.region)

        const spinner = new cli.Spinner('Fetching rule...')
        spinner.start()

        const rule = await eventbridge.describeRule({
          Name: name,
          EventBusName: options.bus,
        })

        if (!rule) {
          spinner.fail('Rule not found')
          return
        }

        // Get targets
        const targets = await eventbridge.listTargetsByRule({
          Rule: name,
          EventBusName: options.bus,
        })

        spinner.succeed('Rule loaded')

        cli.info('\nRule Information:')
        cli.info(`  Name: ${rule.Name}`)
        cli.info(`  ARN: ${rule.Arn}`)
        cli.info(`  State: ${rule.State}`)
        cli.info(`  Event Bus: ${rule.EventBusName}`)

        if (rule.Description) {
          cli.info(`  Description: ${rule.Description}`)
        }

        if (rule.ScheduleExpression) {
          cli.info(`\nSchedule Expression: ${rule.ScheduleExpression}`)
        }

        if (rule.EventPattern) {
          cli.info('\nEvent Pattern:')
          console.log(JSON.stringify(JSON.parse(rule.EventPattern), null, 2))
        }

        if (targets.Targets && targets.Targets.length > 0) {
          cli.info(`\nTargets (${targets.Targets.length}):`)
          for (const target of targets.Targets) {
            cli.info(`  - ${target.Id}: ${target.Arn}`)
            if (target.Input) {
              cli.info(`    Input: ${target.Input}`)
            }
          }
        }
        else {
          cli.info('\nNo targets configured.')
        }
      }
      catch (error: any) {
        cli.error(`Failed to get rule: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('events:target <ruleName>', 'Add a target to an EventBridge rule')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--bus <name>', 'Event bus name', { default: 'default' })
    .option('--id <id>', 'Target ID')
    .option('--arn <arn>', 'Target ARN (Lambda, SQS, SNS, etc.)')
    .option('--role <arn>', 'IAM role ARN (for some targets)')
    .option('--input <json>', 'Constant JSON input')
    .option('--input-path <path>', 'JSONPath expression for input')
    .action(async (ruleName: string, options: {
      region: string
      bus: string
      id?: string
      arn?: string
      role?: string
      input?: string
      inputPath?: string
    }) => {
      cli.header('Add EventBridge Target')

      try {
        if (!options.arn) {
          cli.error('--arn is required')
          return
        }

        const eventbridge = new EventBridgeClient(options.region)

        const targetId = options.id || `target-${Date.now()}`

        cli.info(`Rule: ${ruleName}`)
        cli.info(`Target ID: ${targetId}`)
        cli.info(`Target ARN: ${options.arn}`)

        const confirmed = await cli.confirm('\nAdd this target?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Adding target...')
        spinner.start()

        const target: any = {
          Id: targetId,
          Arn: options.arn,
        }

        if (options.role) {
          target.RoleArn = options.role
        }

        if (options.input) {
          target.Input = options.input
        }

        if (options.inputPath) {
          target.InputPath = options.inputPath
        }

        await eventbridge.putTargets({
          Rule: ruleName,
          EventBusName: options.bus,
          Targets: [target],
        })

        spinner.succeed('Target added')

        cli.success(`\nTarget ${targetId} added to rule ${ruleName}`)
      }
      catch (error: any) {
        cli.error(`Failed to add target: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('events:buses', 'List event buses')
    .option('--region <region>', 'AWS region')
    .action(async (options: { region?: string }) => {
      cli.header('Event Buses')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const eventbridge = new EventBridgeClient(region)

        const spinner = new cli.Spinner('Fetching event buses...')
        spinner.start()

        const result = await eventbridge.listEventBuses()
        const buses = result.EventBuses || []

        spinner.succeed(`Found ${buses.length} event bus(es)`)

        if (buses.length === 0) {
          cli.info('No event buses found')
          return
        }

        cli.table(
          ['Name', 'ARN', 'Policy'],
          buses.map(bus => [
            bus.Name || 'N/A',
            bus.Arn || 'N/A',
            bus.Policy ? 'Custom' : 'Default',
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list event buses: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('events:enable <name>', 'Enable an EventBridge rule')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--bus <name>', 'Event bus name', { default: 'default' })
    .action(async (name: string, options: { region: string; bus: string }) => {
      cli.header('Enable EventBridge Rule')

      try {
        const eventbridge = new EventBridgeClient(options.region)

        const spinner = new cli.Spinner('Enabling rule...')
        spinner.start()

        await eventbridge.enableRule({
          Name: name,
          EventBusName: options.bus,
        })

        spinner.succeed('Rule enabled')
      }
      catch (error: any) {
        cli.error(`Failed to enable rule: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('events:disable <name>', 'Disable an EventBridge rule')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--bus <name>', 'Event bus name', { default: 'default' })
    .action(async (name: string, options: { region: string; bus: string }) => {
      cli.header('Disable EventBridge Rule')

      try {
        const eventbridge = new EventBridgeClient(options.region)

        const spinner = new cli.Spinner('Disabling rule...')
        spinner.start()

        await eventbridge.disableRule({
          Name: name,
          EventBusName: options.bus,
        })

        spinner.succeed('Rule disabled')
      }
      catch (error: any) {
        cli.error(`Failed to disable rule: ${error.message}`)
        process.exit(1)
      }
    })
}
