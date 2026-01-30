import type { CLI } from '@stacksjs/clapp'
import { writeFileSync, statSync } from 'node:fs'
import * as cli from '../../src/utils/cli'
import { CloudFormationClient } from '../../src/aws/cloudformation'
import { loadValidatedConfig } from './shared'

export function registerStackCommands(app: CLI): void {
  app
    .command('stack:list', 'List all CloudFormation stacks')
    .action(async () => {
      cli.header('CloudFormation Stacks')

      try {
        const config = await loadValidatedConfig()
        const region = config.project.region || 'us-east-1'

        const cfn = new CloudFormationClient(region)

        const spinner = new cli.Spinner('Loading stacks...')
        spinner.start()

        const result = await cfn.listStacks([
          'CREATE_COMPLETE',
          'UPDATE_COMPLETE',
          'ROLLBACK_COMPLETE',
          'UPDATE_ROLLBACK_COMPLETE',
          'CREATE_IN_PROGRESS',
          'UPDATE_IN_PROGRESS',
        ])

        spinner.succeed(`Found ${result.StackSummaries.length} stacks`)

        if (result.StackSummaries.length === 0) {
          cli.info('No stacks found')
          return
        }

        // Display stacks in a table
        const headers = ['Stack Name', 'Status', 'Created', 'Updated']
        const rows = result.StackSummaries.map(stack => [
          stack.StackName,
          stack.StackStatus,
          new Date(stack.CreationTime).toLocaleString(),
          stack.LastUpdatedTime ? new Date(stack.LastUpdatedTime).toLocaleString() : 'Never',
        ])

        cli.table(headers, rows)
      }
      catch (error: any) {
        cli.error(`Failed to list stacks: ${error.message}`)
      }
    })

  app
    .command('stack:describe STACK_NAME', 'Describe a CloudFormation stack')
    .action(async (stackName: string) => {
      cli.header(`Stack: ${stackName}`)

      try {
        const config = await loadValidatedConfig()
        const region = config.project.region || 'us-east-1'

        const cfn = new CloudFormationClient(region)

        const spinner = new cli.Spinner('Loading stack details...')
        spinner.start()

        const result = await cfn.describeStacks({ stackName })

        if (!result.Stacks || result.Stacks.length === 0) {
          spinner.fail('Stack not found')
          return
        }

        const stack = result.Stacks[0]
        spinner.succeed('Stack details loaded')

        // Display stack info
        cli.info(`\nStack Information:`)
        cli.info(`  - Name: ${stack.StackName}`)
        cli.info(`  - Status: ${stack.StackStatus}`)
        cli.info(`  - Created: ${new Date(stack.CreationTime).toLocaleString()}`)
        if (stack.LastUpdatedTime) {
          cli.info(`  - Updated: ${new Date(stack.LastUpdatedTime).toLocaleString()}`)
        }

        // Display parameters
        if (stack.Parameters && stack.Parameters.length > 0) {
          cli.info('\nParameters:')
          for (const param of stack.Parameters) {
            cli.info(`  - ${param.ParameterKey}: ${param.ParameterValue}`)
          }
        }

        // Display outputs
        if (stack.Outputs && stack.Outputs.length > 0) {
          cli.info('\nOutputs:')
          for (const output of stack.Outputs) {
            cli.info(`  - ${output.OutputKey}: ${output.OutputValue}`)
            if (output.Description) {
              cli.info(`    ${output.Description}`)
            }
          }
        }

        // Display tags
        if (stack.Tags && stack.Tags.length > 0) {
          cli.info('\nTags:')
          for (const tag of stack.Tags) {
            cli.info(`  - ${tag.Key}: ${tag.Value}`)
          }
        }

        // List resources
        cli.step('\nLoading stack resources...')
        const resources = await cfn.listStackResources(stackName)

        if (resources.StackResourceSummaries.length > 0) {
          cli.info(`\nResources (${resources.StackResourceSummaries.length}):`)
          const resourceHeaders = ['Logical ID', 'Type', 'Status']
          const resourceRows = resources.StackResourceSummaries.slice(0, 10).map(resource => [
            resource.LogicalResourceId,
            resource.ResourceType,
            resource.ResourceStatus,
          ])

          cli.table(resourceHeaders, resourceRows)

          if (resources.StackResourceSummaries.length > 10) {
            cli.info(`\n... and ${resources.StackResourceSummaries.length - 10} more resources`)
          }
        }
      }
      catch (error: any) {
        cli.error(`Failed to describe stack: ${error.message}`)
      }
    })

  app
    .command('stack:delete STACK_NAME', 'Delete a CloudFormation stack')
    .action(async (stackName: string) => {
      cli.header(`Delete Stack: ${stackName}`)

      try {
        const config = await loadValidatedConfig()
        const region = config.project.region || 'us-east-1'

        cli.warn('This will permanently delete the stack and all its resources!')

        const confirmed = await cli.confirm('\nAre you sure you want to delete this stack?', false)
        if (!confirmed) {
          cli.info('Deletion cancelled')
          return
        }

        const cfn = new CloudFormationClient(region)

        const spinner = new cli.Spinner('Deleting stack...')
        spinner.start()

        await cfn.deleteStack(stackName)

        spinner.succeed('Stack deletion initiated')

        // Wait for deletion
        cli.step('Waiting for stack deletion...')
        await cfn.waitForStack(stackName, 'stack-delete-complete')

        cli.success('Stack deleted successfully!')
      }
      catch (error: any) {
        cli.error(`Failed to delete stack: ${error.message}`)
      }
    })

  app
    .command('stack:events STACK_NAME', 'Show stack events')
    .option('--limit <number>', 'Limit number of events', { default: '20' })
    .action(async (stackName: string, options?: { limit?: string }) => {
      cli.header(`Stack Events: ${stackName}`)

      try {
        const config = await loadValidatedConfig()
        const region = config.project.region || 'us-east-1'

        const cfn = new CloudFormationClient(region)

        const spinner = new cli.Spinner('Loading events...')
        spinner.start()

        const result = await cfn.describeStackEvents(stackName)

        spinner.succeed(`Found ${result.StackEvents.length} events`)

        const limit = options?.limit ? Number.parseInt(options.limit) : 20
        const events = result.StackEvents.slice(0, limit)

        if (events.length === 0) {
          cli.info('No events found')
          return
        }

        // Display events
        const headers = ['Time', 'Resource', 'Status', 'Reason']
        const rows = events.map(event => [
          new Date(event.Timestamp).toLocaleString(),
          event.LogicalResourceId,
          event.ResourceStatus,
          event.ResourceStatusReason || '',
        ])

        cli.table(headers, rows)
      }
      catch (error: any) {
        cli.error(`Failed to load events: ${error.message}`)
      }
    })

  app
    .command('stack:outputs STACK_NAME', 'Show stack outputs')
    .action(async (stackName: string) => {
      cli.header(`Stack Outputs: ${stackName}`)

      try {
        const config = await loadValidatedConfig()
        const region = config.project.region || 'us-east-1'

        const cfn = new CloudFormationClient(region)

        const spinner = new cli.Spinner('Loading stack outputs...')
        spinner.start()

        const result = await cfn.describeStacks({ stackName })

        if (!result.Stacks || result.Stacks.length === 0) {
          spinner.fail('Stack not found')
          return
        }

        const stack = result.Stacks[0]
        spinner.succeed('Stack outputs loaded')

        if (!stack.Outputs || stack.Outputs.length === 0) {
          cli.info('No outputs found for this stack')
          return
        }

        // Display outputs in a table
        const headers = ['Key', 'Value', 'Description', 'Export Name']
        const rows = stack.Outputs.map(output => [
          output.OutputKey || '',
          output.OutputValue || '',
          output.Description || '',
          output.ExportName || '',
        ])

        cli.table(headers, rows)

        // Also display in key=value format for easy copying
        cli.info('\nCopy-friendly format:')
        for (const output of stack.Outputs) {
          cli.info(`${output.OutputKey}=${output.OutputValue}`)
        }
      }
      catch (error: any) {
        cli.error(`Failed to load outputs: ${error.message}`)
      }
    })

  app
    .command('stack:export STACK_NAME', 'Export stack template')
    .option('--output <file>', 'Output file path')
    .option('--format <format>', 'Output format (json or yaml)', { default: 'json' })
    .action(async (stackName: string, options?: { output?: string, format?: string }) => {
      cli.header(`Export Stack: ${stackName}`)

      try {
        const config = await loadValidatedConfig()
        const region = config.project.region || 'us-east-1'

        const cfn = new CloudFormationClient(region)

        const spinner = new cli.Spinner('Fetching stack template...')
        spinner.start()

        const result = await cfn.getTemplate(stackName)

        if (!result.TemplateBody) {
          spinner.fail('Template not found')
          return
        }

        spinner.succeed('Template fetched')

        const format = options?.format || 'json'
        let templateContent = result.TemplateBody

        // Parse and re-format if needed
        if (format === 'json') {
          const template = JSON.parse(templateContent)
          templateContent = JSON.stringify(template, null, 2)
        }

        // Save to file or display
        if (options?.output) {
          const outputPath = options.output
          writeFileSync(outputPath, templateContent, 'utf-8')
          cli.success(`Template exported to: ${outputPath}`)

          // Show file size
          const stats = statSync(outputPath)
          const sizeInKB = (stats.size / 1024).toFixed(2)
          cli.info(`File size: ${sizeInKB} KB`)
        }
        else {
          // Display template
          cli.info('\nTemplate:')
          console.log(templateContent)
        }
      }
      catch (error: any) {
        cli.error(`Failed to export template: ${error.message}`)
      }
    })
}
