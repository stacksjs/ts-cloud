import type { CLI } from '@stacksjs/clapp'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as cli from '../../src/utils/cli'
import { InfrastructureGenerator } from '../../src/generators/infrastructure'
import { CloudFormationClient } from '../../src/aws/cloudformation'
import { validateTemplate, validateTemplateSize, validateResourceLimits } from '../../src/validation/template'
import { loadValidatedConfig } from './shared'

export function registerGenerateCommands(app: CLI): void {
  app
    .command('generate', 'Generate CloudFormation templates')
    .alias('gen')
    .option('--output <path>', 'Output directory for templates', { default: 'cloudformation' })
    .option('--format <format>', 'Output format: json or yaml', { default: 'json' })
    .option('--module <module>', 'Generate specific module only')
    .action(async (options?: { output?: string, format?: string, module?: string }) => {
      cli.header('Generating CloudFormation Templates')

      const spinner = new cli.Spinner('Loading configuration...')
      spinner.start()

      try {
        const config = await loadValidatedConfig()
        spinner.succeed('Configuration loaded')

        const outputDir = options?.output || 'cloudformation'
        const format = options?.format || 'json'
        const environment = (options as any)?.env || 'production'

        // Create output directory
        if (!existsSync(outputDir)) {
          await mkdir(outputDir, { recursive: true })
        }

        // Generate infrastructure using all Phase 2 modules
        cli.step('Generating infrastructure...')
        const generator = new InfrastructureGenerator({
          config,
          environment,
          modules: options?.module ? [options.module] : undefined,
        })

        const generationSpinner = new cli.Spinner('Generating CloudFormation template...')
        generationSpinner.start()

        // Generate the template
        generator.generate()
        const output = format === 'yaml' ? generator.toYAML() : generator.toJSON()
        generationSpinner.succeed('Template generated')

        // Validate template
        cli.step('Validating template...')
        const template = JSON.parse(generator.toJSON())
        const validation = validateTemplate(template)
        const sizeValidation = validateTemplateSize(output)
        const limitsValidation = validateResourceLimits(template)

        // Show errors
        const allErrors = [
          ...validation.errors,
          ...sizeValidation.errors,
          ...limitsValidation.errors,
        ]

        if (allErrors.length > 0) {
          cli.error('Template validation failed:')
          for (const error of allErrors) {
            cli.error(`  - ${error.path}: ${error.message}`)
          }
        }
        else {
          cli.success('Template validated successfully')
        }

        // Show warnings
        const allWarnings = [
          ...validation.warnings,
          ...sizeValidation.warnings,
          ...limitsValidation.warnings,
        ]

        if (allWarnings.length > 0) {
          for (const warning of allWarnings) {
            cli.warn(`  - ${warning.path}: ${warning.message}`)
          }
        }

        // Write to file
        const filename = join(outputDir, `${environment}.${format}`)
        await writeFile(filename, output)
        cli.success(`Generated ${filename}`)

        // Show summary
        const builder = generator.getBuilder()
        const resourceCount = Object.keys(builder.getResources()).length
        cli.info(`\nGenerated ${resourceCount} resources:`)

        // Count resource types
        const resources = builder.getResources()
        const typeCounts: Record<string, number> = {}
        for (const resource of Object.values(resources)) {
          const type = (resource as any).Type
          typeCounts[type] = (typeCounts[type] || 0) + 1
        }

        // Display resource types
        const types = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])
        for (const [type, count] of types) {
          cli.info(`  - ${type}: ${count}`)
        }

        cli.info(`\nNext steps:
  1. Review the generated templates in ${outputDir}/
  2. Run 'cloud deploy' to deploy your infrastructure`)
      }
      catch (error) {
        spinner.fail('Failed to generate templates')
        cli.error(error instanceof Error ? error.message : 'Unknown error')
      }
    })

  app
    .command('generate:preview', 'Preview what will be generated')
    .action(async () => {
      cli.header('Template Preview')
      cli.info('This command will show a preview of generated templates')
      // TODO: Implement preview logic
    })

  app
    .command('diff', 'Show diff between local config and deployed stack')
    .alias('generate:diff')
    .option('--stack <name>', 'Stack name to compare against')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .action(async (options?: { stack?: string, env?: string }) => {
      cli.header('Infrastructure Diff')

      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
        const stackName = options?.stack || `${config.project.slug}-${environment}`
        const region = config.project.region || 'us-east-1'

        cli.info(`Stack: ${stackName}`)
        cli.info(`Region: ${region}`)
        cli.info(`Environment: ${environment}`)

        // Generate new template from config
        cli.step('Generating template from configuration...')
        const generator = new InfrastructureGenerator({
          config,
          environment,
        })
        generator.generate()
        const newTemplateBody = generator.toJSON()
        const newTemplate = JSON.parse(newTemplateBody)

        // Get existing template from CloudFormation
        cli.step('Fetching deployed template...')
        const cfn = new CloudFormationClient(region)

        let existingTemplate: any = null
        try {
          const result = await cfn.getTemplate(stackName)
          if (result.TemplateBody) {
            existingTemplate = JSON.parse(result.TemplateBody)
          }
        }
        catch (error: any) {
          if (error.message?.includes('does not exist')) {
            cli.warn(`Stack "${stackName}" does not exist yet`)
            cli.info('\nThis will be a new deployment with the following resources:')

            const resourceCount = Object.keys(newTemplate.Resources || {}).length
            cli.info(`\nResources to create: ${resourceCount}`)

            // Count and display resource types
            const typeCounts: Record<string, number> = {}
            for (const resource of Object.values(newTemplate.Resources || {})) {
              const type = (resource as any).Type
              typeCounts[type] = (typeCounts[type] || 0) + 1
            }

            for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
              cli.info(`  + ${type}: ${count}`)
            }

            cli.info('\nRun `cloud deploy` to create this stack')
            return
          }
          throw error
        }

        // Compare templates
        cli.step('Comparing templates...')

        const existingResources = existingTemplate.Resources || {}
        const newResources = newTemplate.Resources || {}

        const existingKeys = new Set(Object.keys(existingResources))
        const newKeys = new Set(Object.keys(newResources))

        // Find added resources
        const added: string[] = []
        for (const key of newKeys) {
          if (!existingKeys.has(key)) {
            added.push(key)
          }
        }

        // Find removed resources
        const removed: string[] = []
        for (const key of existingKeys) {
          if (!newKeys.has(key)) {
            removed.push(key)
          }
        }

        // Find modified resources
        const modified: string[] = []
        for (const key of newKeys) {
          if (existingKeys.has(key)) {
            const existingJson = JSON.stringify(existingResources[key])
            const newJson = JSON.stringify(newResources[key])
            if (existingJson !== newJson) {
              modified.push(key)
            }
          }
        }

        // Display results
        if (added.length === 0 && removed.length === 0 && modified.length === 0) {
          cli.success('\nNo changes detected - infrastructure is up to date')
          return
        }

        cli.info('\nChanges detected:\n')

        if (added.length > 0) {
          cli.success(`Resources to add (${added.length}):`)
          for (const key of added) {
            const type = newResources[key].Type
            cli.info(`  + ${key} (${type})`)
          }
          console.log()
        }

        if (removed.length > 0) {
          cli.error(`Resources to remove (${removed.length}):`)
          for (const key of removed) {
            const type = existingResources[key].Type
            cli.info(`  - ${key} (${type})`)
          }
          console.log()
        }

        if (modified.length > 0) {
          cli.warn(`Resources to modify (${modified.length}):`)
          for (const key of modified) {
            const type = newResources[key].Type
            cli.info(`  ~ ${key} (${type})`)
          }
          console.log()
        }

        // Summary
        cli.info('Summary:')
        cli.info(`  - Add: ${added.length}`)
        cli.info(`  - Remove: ${removed.length}`)
        cli.info(`  - Modify: ${modified.length}`)

        cli.info('\nRun `cloud deploy` to apply these changes')
      }
      catch (error: any) {
        cli.error(`Diff failed: ${error.message}`)
      }
    })
}
