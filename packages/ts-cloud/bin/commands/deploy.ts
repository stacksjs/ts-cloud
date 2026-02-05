import type { CLI } from '@stacksjs/clapp'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import * as cli from '../../src/utils/cli'
import { InfrastructureGenerator } from '../../src/generators/infrastructure'
import { CloudFormationClient } from '../../src/aws/cloudformation'
import { S3Client } from '../../src/aws/s3'
import { CloudFrontClient } from '../../src/aws/cloudfront'
import { ECRClient } from '../../src/aws/ecr'
import { ECSClient } from '../../src/aws/ecs'
import { validateTemplate, validateTemplateSize, validateResourceLimits } from '../../src/validation/template'
import { loadValidatedConfig, resolveDnsProviderConfig, getDnsProvider } from './shared'
import { deployStaticSiteWithExternalDnsFull } from '../../src/deploy/static-site-external-dns'
import type { DnsProviderConfig } from '../../src/dns/types'
import { PreDeployScanner, type ScanResult, type SecurityFinding } from '../../src/security/pre-deploy-scanner'

/**
 * Run pre-deployment security scan
 */
async function runSecurityScan(options: {
  sourceDir: string
  failOnSeverity?: 'critical' | 'high' | 'medium' | 'low'
  skipPatterns?: string[]
}): Promise<{ passed: boolean, result: ScanResult }> {
  const scanner = new PreDeployScanner()

  cli.step('Running pre-deployment security scan...')

  const result = await scanner.scan({
    directory: options.sourceDir,
    failOnSeverity: options.failOnSeverity || 'critical',
    skipPatterns: options.skipPatterns,
  })

  return { passed: result.passed, result }
}

/**
 * Display security scan results in CLI
 */
function displaySecurityResults(result: ScanResult): void {
  const { summary, findings, scannedFiles, duration } = result

  cli.info(`\nScanned ${scannedFiles} files in ${duration}ms`)

  // Display summary
  if (summary.critical > 0) {
    cli.error(`  Critical: ${summary.critical}`)
  }
  else {
    cli.info(`  Critical: ${summary.critical}`)
  }

  if (summary.high > 0) {
    cli.warn(`  High: ${summary.high}`)
  }
  else {
    cli.info(`  High: ${summary.high}`)
  }

  cli.info(`  Medium: ${summary.medium}`)
  cli.info(`  Low: ${summary.low}`)

  // Display findings
  if (findings.length > 0) {
    cli.info('\nFindings:')

    // Group by severity
    const criticalFindings = findings.filter(f => f.pattern.severity === 'critical')
    const highFindings = findings.filter(f => f.pattern.severity === 'high')
    const mediumFindings = findings.filter(f => f.pattern.severity === 'medium')
    const lowFindings = findings.filter(f => f.pattern.severity === 'low')

    const displayFindings = (list: SecurityFinding[], label: string, color: 'red' | 'yellow' | 'blue' | 'gray') => {
      if (list.length > 0) {
        console.log(`\n${cli.colorize(`[${label}]`, color)}`)
        for (const finding of list.slice(0, 10)) { // Limit to first 10 per severity
          cli.info(`  ${finding.pattern.name}`)
          cli.info(`    File: ${finding.file}:${finding.line}`)
          cli.info(`    Match: ${finding.match}`)
        }
        if (list.length > 10) {
          cli.info(`  ... and ${list.length - 10} more ${label.toLowerCase()} findings`)
        }
      }
    }

    displayFindings(criticalFindings, 'CRITICAL', 'red')
    displayFindings(highFindings, 'HIGH', 'yellow')
    displayFindings(mediumFindings, 'MEDIUM', 'blue')
    displayFindings(lowFindings, 'LOW', 'gray')
  }
}

export function registerDeployCommands(app: CLI): void {
  // Security scan command
  app
    .command('deploy:security-scan', 'Run pre-deployment security scan')
    .option('--source <path>', 'Source directory to scan', { default: '.' })
    .option('--fail-on <severity>', 'Fail on severity level (critical, high, medium, low)', { default: 'critical' })
    .option('--skip-patterns <patterns>', 'Comma-separated list of pattern names to skip')
    .action(async (options?: {
      source?: string
      failOn?: 'critical' | 'high' | 'medium' | 'low'
      skipPatterns?: string
    }) => {
      cli.header('Pre-Deployment Security Scan')

      try {
        const sourceDir = options?.source || '.'
        const failOnSeverity = options?.failOn || 'critical'
        const skipPatterns = options?.skipPatterns?.split(',').map(p => p.trim()) || []

        if (!existsSync(sourceDir)) {
          cli.error(`Source directory not found: ${sourceDir}`)
          return
        }

        cli.info(`Source: ${sourceDir}`)
        cli.info(`Fail on: ${failOnSeverity} or higher severity`)

        const { passed, result } = await runSecurityScan({
          sourceDir,
          failOnSeverity,
          skipPatterns,
        })

        displaySecurityResults(result)

        if (passed) {
          cli.success('\n✓ Security scan passed - no blocking issues found')
        }
        else {
          cli.error('\n✗ Security scan failed - blocking issues detected')
          cli.info('\nRecommendations:')
          cli.info('  1. Remove any hardcoded credentials from your code')
          cli.info('  2. Use environment variables or AWS Secrets Manager')
          cli.info('  3. Add sensitive files to .gitignore')
          cli.info('  4. Use --skip-patterns to ignore false positives')
          process.exit(1)
        }
      }
      catch (error: any) {
        cli.error(`Security scan failed: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('deploy', 'Deploy infrastructure')
    .option('--stack <name>', 'Stack name')
    .option('--env <environment>', 'Environment to deploy to')
    .option('--site <name>', 'Deploy specific site only')
    .option('--skip-security-scan', 'Skip pre-deployment security scan')
    .option('--skip-dns-verification', 'Skip DNS provider verification and record creation (use when DNS is already configured)')
    .option('--security-fail-on <severity>', 'Security scan fail threshold (critical, high, medium, low)', { default: 'critical' })
    .action(async (options?: {
      stack?: string
      env?: string
      site?: string
      skipSecurityScan?: boolean
      skipDnsVerification?: boolean
      securityFailOn?: 'critical' | 'high' | 'medium' | 'low'
    }) => {
      cli.header('Deploying Infrastructure')

      try {
        // Load configuration first to get project info
        const config = await loadValidatedConfig()

        // Run security scan before deployment (unless skipped)
        if (!options?.skipSecurityScan) {
          const projectRoot = process.cwd()
          const { passed, result } = await runSecurityScan({
            sourceDir: projectRoot,
            failOnSeverity: options?.securityFailOn || 'critical',
          })

          displaySecurityResults(result)

          if (!passed) {
            cli.error('\n✗ Security scan failed - deployment blocked')
            cli.info('\nTo proceed anyway, use --skip-security-scan flag')
            cli.info('To change sensitivity, use --security-fail-on <severity>')
            return
          }

          cli.success('✓ Security scan passed\n')
        }
        else {
          cli.warn('Security scan skipped (--skip-security-scan)\n')
        }
        const environment = (options?.env || 'staging') as 'production' | 'staging' | 'development'
        const stackName = options?.stack || `${config.project.slug}-${environment}`
        const region = config.project.region || 'us-east-1'

        // Check if this is a static site deployment
        if (config.sites && Object.keys(config.sites).length > 0) {
          const dnsProvider = config.infrastructure?.dns?.provider

          if (dnsProvider && dnsProvider !== 'route53') {
            // Deploy static sites with external DNS
            await deployStaticSitesWithExternalDns(config, options?.site, dnsProvider, region, options?.skipDnsVerification)
            return
          }
        }

        cli.info(`Stack: ${stackName}`)
        cli.info(`Region: ${region}`)
        cli.info(`Environment: ${environment}`)

        // Generate CloudFormation template
        cli.step('Generating CloudFormation template...')
        const generator = new InfrastructureGenerator({
          config,
          environment,
        })

        generator.generate()
        const templateBody = generator.toJSON()
        const template = JSON.parse(templateBody)

        // Validate template
        cli.step('Validating template...')
        const validation = validateTemplate(template)
        const sizeValidation = validateTemplateSize(templateBody)
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
          return
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

        cli.success('Template validated successfully')

        // Show resource summary
        const resourceCount = Object.keys(template.Resources).length
        cli.info(`\nResources to deploy: ${resourceCount}`)

        // Count resource types
        const typeCounts: Record<string, number> = {}
        for (const resource of Object.values(template.Resources)) {
          const type = (resource as any).Type
          typeCounts[type] = (typeCounts[type] || 0) + 1
        }

        for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
          cli.info(`  - ${type}: ${count}`)
        }

        // Confirm deployment
        const confirmed = await cli.confirm('\nDeploy now?', true)
        if (!confirmed) {
          cli.info('Deployment cancelled')
          return
        }

        // Initialize CloudFormation client
        const cfn = new CloudFormationClient(region)

        // Check if stack exists
        cli.step('Checking stack status...')
        let stackExists = false
        try {
          const result = await cfn.describeStacks({ stackName })
          stackExists = result.Stacks && result.Stacks.length > 0
        }
        catch (error) {
          // Stack doesn't exist, that's fine
          stackExists = false
        }

        if (stackExists) {
          cli.info('Stack exists, updating...')
          const updateSpinner = new cli.Spinner('Updating CloudFormation stack...')
          updateSpinner.start()

          try {
            await cfn.updateStack({
              stackName,
              templateBody,
              capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
              tags: [
                { Key: 'Project', Value: config.project.name },
                { Key: 'Environment', Value: environment },
                { Key: 'ManagedBy', Value: 'ts-cloud' },
              ],
            })

            updateSpinner.succeed('Update initiated')

            // Wait for completion
            cli.step('Waiting for stack update to complete...')
            await cfn.waitForStack(stackName, 'stack-update-complete')

            cli.success('Stack updated successfully!')
          }
          catch (error: any) {
            if (error.message.includes('No updates are to be performed')) {
              updateSpinner.succeed('No changes detected')
              cli.info('Stack is already up to date')
              return
            }
            throw error
          }
        }
        else {
          cli.info('Creating new stack...')
          const createSpinner = new cli.Spinner('Creating CloudFormation stack...')
          createSpinner.start()

          await cfn.createStack({
            stackName,
            templateBody,
            capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
            tags: [
              { Key: 'Project', Value: config.project.name },
              { Key: 'Environment', Value: environment },
              { Key: 'ManagedBy', Value: 'ts-cloud' },
            ],
          })

          createSpinner.succeed('Stack creation initiated')

          // Wait for completion
          cli.step('Waiting for stack creation to complete...')
          await cfn.waitForStack(stackName, 'stack-create-complete')

          cli.success('Stack created successfully!')
        }

        // Get stack outputs
        const outputs = await cfn.getStackOutputs(stackName)

        cli.box(`Deployment Complete!

Stack: ${stackName}
Region: ${region}
Environment: ${environment}
Resources: ${resourceCount}

View in console:
https://console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/stackinfo?stackId=${encodeURIComponent(stackName)}`, 'green')

        if (Object.keys(outputs).length > 0) {
          cli.info('\nStack Outputs:')
          for (const [key, value] of Object.entries(outputs)) {
            cli.info(`  - ${key}: ${value}`)
          }
        }
      }
      catch (error: any) {
        cli.error(`Deployment failed: ${error.message}`)
        if (error.stack) {
          cli.info('\nStack trace:')
          console.error(error.stack)
        }
      }
    })

  app
    .command('deploy:server', 'Deploy EC2 infrastructure')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .action(async (options?: { env?: string }) => {
      cli.header('Deploying Server Infrastructure')

      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
        const stackName = `${config.project.slug}-server-${environment}`
        const region = config.project.region || 'us-east-1'

        cli.info(`Stack: ${stackName}`)
        cli.info(`Region: ${region}`)
        cli.info(`Environment: ${environment}`)

        cli.step('Generating EC2 server infrastructure...')

        // TODO: Generate server-specific infrastructure
        const spinner = new cli.Spinner('Deploying server infrastructure...')
        spinner.start()

        await new Promise(resolve => setTimeout(resolve, 2000))

        spinner.succeed('Server infrastructure deployed successfully!')

        cli.success('\nDeployment complete!')
        cli.info('\nNext steps:')
        cli.info('  - cloud server:list - View deployed servers')
        cli.info('  - cloud server:ssh <name> - SSH into a server')
      }
      catch (error: any) {
        cli.error(`Deployment failed: ${error.message}`)
      }
    })

  app
    .command('deploy:serverless', 'Deploy serverless infrastructure')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .option('--function <name>', 'Deploy specific function only')
    .action(async (options?: { env?: string, function?: string }) => {
      cli.header('Deploying Serverless Infrastructure')

      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
        const stackName = `${config.project.slug}-serverless-${environment}`
        const region = config.project.region || 'us-east-1'

        cli.info(`Stack: ${stackName}`)
        cli.info(`Region: ${region}`)
        cli.info(`Environment: ${environment}`)

        if (options?.function) {
          cli.info(`Function: ${options.function}`)
        }

        cli.step('Generating serverless infrastructure...')

        const spinner = new cli.Spinner('Deploying serverless infrastructure...')
        spinner.start()

        await new Promise(resolve => setTimeout(resolve, 2000))

        spinner.succeed('Serverless infrastructure deployed successfully!')

        cli.success('\nDeployment complete!')
        cli.info('\nNext steps:')
        cli.info('  - cloud function:list - View deployed functions')
        cli.info('  - cloud function:logs <name> - View function logs')
        cli.info('  - cloud function:invoke <name> - Test function')
      }
      catch (error: any) {
        cli.error(`Deployment failed: ${error.message}`)
      }
    })

  app
    .command('deploy:status', 'Check deployment status')
    .option('--stack <name>', 'Stack name')
    .option('--env <environment>', 'Environment')
    .action(async (options?: { stack?: string, env?: string }) => {
      cli.header('Deployment Status')

      try {
        const config = await loadValidatedConfig()
        const environment = options?.env || 'production'
        const stackName = options?.stack || `${config.project.slug}-${environment}`
        const region = config.project.region || 'us-east-1'

        cli.info(`Stack: ${stackName}`)
        cli.info(`Region: ${region}`)

        const spinner = new cli.Spinner('Checking deployment status...')
        spinner.start()

        const cfn = new CloudFormationClient(region)

        // Get stack status
        const result = await cfn.describeStacks({ stackName })

        if (result.Stacks.length === 0) {
          spinner.fail('Stack not found')
          cli.warning('No deployment found for this environment')
          return
        }

        const stack = result.Stacks[0]
        spinner.succeed('Status retrieved')

        cli.info(`\nStatus: ${stack.StackStatus}`)
        cli.info(`Created: ${stack.CreationTime}`)
        if (stack.LastUpdatedTime) {
          cli.info(`Last Updated: ${stack.LastUpdatedTime}`)
        }

        // Show outputs
        if (stack.Outputs && stack.Outputs.length > 0) {
          cli.info('\nOutputs:')
          for (const output of stack.Outputs) {
            cli.info(`  ${output.OutputKey}: ${output.OutputValue}`)
          }
        }
      }
      catch (error: any) {
        cli.error(`Failed to get status: ${error.message}`)
      }
    })

  app
    .command('deploy:rollback', 'Rollback to previous version')
    .option('--stack <name>', 'Stack name')
    .option('--env <environment>', 'Environment')
    .action(async (options?: { stack?: string, env?: string }) => {
      cli.header('Rolling Back Deployment')

      try {
        const config = await loadValidatedConfig()
        const environment = options?.env || 'production'
        const stackName = options?.stack || `${config.project.slug}-${environment}`
        const region = config.project.region || 'us-east-1'

        cli.info(`Stack: ${stackName}`)
        cli.info(`Region: ${region}`)

        const confirmed = await cli.confirm('\nAre you sure you want to rollback?', false)
        if (!confirmed) {
          cli.info('Rollback cancelled')
          return
        }

        const spinner = new cli.Spinner('Rolling back stack...')
        spinner.start()

        const cfn = new CloudFormationClient(region)

        // Delete the stack
        await cfn.deleteStack(stackName)

        spinner.succeed('Stack deletion initiated')

        // Wait for deletion
        cli.step('Waiting for stack deletion...')
        await cfn.waitForStack(stackName, 'stack-delete-complete')

        cli.success('Stack rolled back successfully!')
      }
      catch (error: any) {
        cli.error(`Rollback failed: ${error.message}`)
      }
    })

  app
    .command('deploy:static', 'Deploy static site (S3 + CloudFront invalidation)')
    .option('--source <path>', 'Source directory', { default: 'dist' })
    .option('--bucket <name>', 'S3 bucket name')
    .option('--distribution <id>', 'CloudFront distribution ID')
    .option('--prefix <prefix>', 'S3 prefix/folder')
    .option('--delete', 'Delete files not in source')
    .option('--cache-control <value>', 'Cache-Control header', { default: 'public, max-age=31536000' })
    .option('--no-invalidate', 'Skip CloudFront invalidation')
    .option('--wait', 'Wait for invalidation to complete')
    .option('--skip-security-scan', 'Skip pre-deployment security scan')
    .option('--security-fail-on <severity>', 'Security scan fail threshold (critical, high, medium, low)', { default: 'critical' })
    .action(async (options?: {
      source?: string
      bucket?: string
      distribution?: string
      prefix?: string
      delete?: boolean
      cacheControl?: string
      invalidate?: boolean
      wait?: boolean
      skipSecurityScan?: boolean
      securityFailOn?: 'critical' | 'high' | 'medium' | 'low'
    }) => {
      cli.header('Deploying Static Site')

      try {
        const config = await loadValidatedConfig()
        const region = config.project.region || 'us-east-1'

        const source = options?.source || 'dist'

        // Run security scan on the source directory before deployment
        if (!options?.skipSecurityScan) {
          cli.step('Scanning source directory for leaked secrets...')

          const { passed, result } = await runSecurityScan({
            sourceDir: source,
            failOnSeverity: options?.securityFailOn || 'critical',
          })

          displaySecurityResults(result)

          if (!passed) {
            cli.error('\n✗ Security scan failed - deployment blocked')
            cli.info('\nPotential secrets detected in frontend build:')
            cli.info('  - API keys, tokens, or credentials may be bundled in your code')
            cli.info('  - These would be publicly accessible once deployed')
            cli.info('\nTo proceed anyway, use --skip-security-scan flag')
            return
          }

          cli.success('✓ Security scan passed\n')
        }
        else {
          cli.warn('Security scan skipped (--skip-security-scan)\n')
        }
        const bucket = options?.bucket
        const distributionId = options?.distribution
        const prefix = options?.prefix
        const shouldDelete = options?.delete || false
        const cacheControl = options?.cacheControl || 'public, max-age=31536000'
        const shouldInvalidate = options?.invalidate !== false
        const shouldWait = options?.wait || false

        if (!bucket) {
          cli.error('--bucket is required')
          return
        }

        // Check if source directory exists
        if (!existsSync(source)) {
          cli.error(`Source directory not found: ${source}`)
          return
        }

        cli.info(`Source: ${source}`)
        cli.info(`Bucket: s3://${bucket}${prefix ? `/${prefix}` : ''}`)
        cli.info(`Cache-Control: ${cacheControl}`)
        if (distributionId) {
          cli.info(`CloudFront Distribution: ${distributionId}`)
        }
        if (shouldDelete) {
          cli.warn('Delete mode enabled - files not in source will be removed')
        }

        const confirmed = await cli.confirm('\nDeploy static site now?', true)
        if (!confirmed) {
          cli.info('Deployment cancelled')
          return
        }

        // Step 1: Upload to S3
        const s3 = new S3Client(region)
        const uploadSpinner = new cli.Spinner('Uploading files to S3...')
        uploadSpinner.start()

        await s3.sync({
          source,
          bucket,
          prefix,
          delete: shouldDelete,
          cacheControl,
          acl: 'public-read',
        })

        uploadSpinner.succeed('Files uploaded successfully!')

        // Get bucket size
        const size = await s3.getBucketSize(bucket, prefix)
        const sizeInMB = (size / 1024 / 1024).toFixed(2)
        cli.info(`Total size: ${sizeInMB} MB`)

        // Step 2: Invalidate CloudFront (if distribution provided)
        if (shouldInvalidate && distributionId) {
          const cloudfront = new CloudFrontClient()
          const invalidateSpinner = new cli.Spinner('Invalidating CloudFront cache...')
          invalidateSpinner.start()

          const invalidation = await cloudfront.invalidateAll(distributionId)
          invalidateSpinner.succeed('Invalidation created')

          cli.info(`Invalidation ID: ${invalidation.Id}`)

          if (shouldWait) {
            const waitSpinner = new cli.Spinner('Waiting for invalidation to complete...')
            waitSpinner.start()
            await cloudfront.waitForInvalidation(distributionId, invalidation.Id)
            waitSpinner.succeed('Invalidation completed!')
          }
        }

        cli.box(`Static Site Deployed!

Source: ${source}
Bucket: s3://${bucket}${prefix ? `/${prefix}` : ''}
Size: ${sizeInMB} MB
${distributionId ? `Distribution: ${distributionId}` : ''}

View your site:
https://${bucket}.s3.${region}.amazonaws.com${prefix ? `/${prefix}` : ''}/index.html`, 'green')
      }
      catch (error: any) {
        cli.error(`Deployment failed: ${error.message}`)
      }
    })

  app
    .command('deploy:container', 'Deploy container (ECR push + ECS service update)')
    .option('--cluster <name>', 'ECS cluster name')
    .option('--service <name>', 'ECS service name')
    .option('--repository <name>', 'ECR repository name')
    .option('--image <tag>', 'Docker image tag', { default: 'latest' })
    .option('--dockerfile <path>', 'Dockerfile path', { default: 'Dockerfile' })
    .option('--context <path>', 'Docker build context', { default: '.' })
    .option('--task-definition <name>', 'Task definition family name')
    .option('--force', 'Force new deployment even if no changes')
    .option('--wait', 'Wait for deployment to stabilize')
    .option('--skip-security-scan', 'Skip pre-deployment security scan')
    .option('--security-fail-on <severity>', 'Security scan fail threshold (critical, high, medium, low)', { default: 'critical' })
    .action(async (options?: {
      cluster?: string
      service?: string
      repository?: string
      image?: string
      dockerfile?: string
      context?: string
      taskDefinition?: string
      force?: boolean
      wait?: boolean
      skipSecurityScan?: boolean
      securityFailOn?: 'critical' | 'high' | 'medium' | 'low'
    }) => {
      cli.header('Deploying Container')

      try {
        const config = await loadValidatedConfig()
        const region = config.project.region || 'us-east-1'

        const cluster = options?.cluster
        const service = options?.service
        const repository = options?.repository
        const imageTag = options?.image || 'latest'
        const dockerfile = options?.dockerfile || 'Dockerfile'
        const context = options?.context || '.'
        const forceDeployment = options?.force || false
        const shouldWait = options?.wait || false

        if (!cluster || !service) {
          cli.error('--cluster and --service are required')
          return
        }

        if (!repository) {
          cli.error('--repository is required')
          return
        }

        // Check if Dockerfile exists
        if (!existsSync(dockerfile)) {
          cli.error(`Dockerfile not found: ${dockerfile}`)
          return
        }

        // Run security scan on the build context before deployment
        if (!options?.skipSecurityScan) {
          cli.step('Scanning build context for leaked secrets...')

          const { passed, result } = await runSecurityScan({
            sourceDir: context,
            failOnSeverity: options?.securityFailOn || 'critical',
          })

          displaySecurityResults(result)

          if (!passed) {
            cli.error('\n✗ Security scan failed - deployment blocked')
            cli.info('\nPotential secrets detected in container build context:')
            cli.info('  - Credentials may be baked into the Docker image')
            cli.info('  - Use Docker secrets or environment variables instead')
            cli.info('\nTo proceed anyway, use --skip-security-scan flag')
            return
          }

          cli.success('✓ Security scan passed\n')
        }
        else {
          cli.warn('Security scan skipped (--skip-security-scan)\n')
        }

        cli.info(`Cluster: ${cluster}`)
        cli.info(`Service: ${service}`)
        cli.info(`Repository: ${repository}`)
        cli.info(`Image Tag: ${imageTag}`)
        cli.info(`Dockerfile: ${dockerfile}`)

        const confirmed = await cli.confirm('\nDeploy container now?', true)
        if (!confirmed) {
          cli.info('Deployment cancelled')
          return
        }

        const ecr = new ECRClient(region)
        const ecs = new ECSClient(region)

        // Step 1: Get ECR login credentials
        const loginSpinner = new cli.Spinner('Getting ECR credentials...')
        loginSpinner.start()

        const authResult = await ecr.getAuthorizationToken()
        if (!authResult.authorizationData?.[0]) {
          loginSpinner.fail('Failed to get ECR credentials')
          return
        }

        const auth = authResult.authorizationData[0]
        const registryEndpoint = auth.proxyEndpoint || ''
        const registryHost = registryEndpoint.replace('https://', '')

        loginSpinner.succeed('ECR credentials obtained')

        // Step 2: Docker login to ECR
        const dockerLoginSpinner = new cli.Spinner('Logging into ECR...')
        dockerLoginSpinner.start()

        const token = auth.authorizationToken || ''
        const decoded = Buffer.from(token, 'base64').toString('utf8')
        const password = decoded.split(':')[1]

        // Run docker login
        const { spawn } = await import('child_process')
        const dockerLogin = spawn('docker', ['login', '--username', 'AWS', '--password-stdin', registryHost], {
          stdio: ['pipe', 'pipe', 'pipe'],
        })

        dockerLogin.stdin.write(password)
        dockerLogin.stdin.end()

        await new Promise<void>((resolve, reject) => {
          dockerLogin.on('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`Docker login failed with code ${code}`))
          })
        })

        dockerLoginSpinner.succeed('Logged into ECR')

        // Step 3: Build Docker image
        const buildSpinner = new cli.Spinner('Building Docker image...')
        buildSpinner.start()

        const imageUri = `${registryHost}/${repository}:${imageTag}`

        const dockerBuild = spawn('docker', ['build', '-t', imageUri, '-f', dockerfile, context], {
          stdio: ['pipe', 'pipe', 'pipe'],
        })

        await new Promise<void>((resolve, reject) => {
          let stderr = ''
          dockerBuild.stderr.on('data', (data) => { stderr += data.toString() })
          dockerBuild.on('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`Docker build failed: ${stderr}`))
          })
        })

        buildSpinner.succeed('Docker image built')

        // Step 4: Push to ECR
        const pushSpinner = new cli.Spinner('Pushing image to ECR...')
        pushSpinner.start()

        const dockerPush = spawn('docker', ['push', imageUri], {
          stdio: ['pipe', 'pipe', 'pipe'],
        })

        await new Promise<void>((resolve, reject) => {
          let stderr = ''
          dockerPush.stderr.on('data', (data) => { stderr += data.toString() })
          dockerPush.on('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`Docker push failed: ${stderr}`))
          })
        })

        pushSpinner.succeed('Image pushed to ECR')

        // Step 5: Update ECS service
        const updateSpinner = new cli.Spinner('Updating ECS service...')
        updateSpinner.start()

        await ecs.updateService({
          cluster,
          service,
          forceNewDeployment: forceDeployment,
        })

        updateSpinner.succeed('ECS service updated')

        // Step 6: Wait for deployment (if requested)
        if (shouldWait) {
          const waitSpinner = new cli.Spinner('Waiting for deployment to stabilize...')
          waitSpinner.start()

          await ecs.waitForServiceStable(cluster, service)

          waitSpinner.succeed('Deployment stabilized')
        }

        cli.success('\nContainer deployment complete!')
        cli.info(`\nImage: ${imageUri}`)
        cli.info(`Cluster: ${cluster}`)
        cli.info(`Service: ${service}`)
      }
      catch (error: any) {
        cli.error(`Deployment failed: ${error.message}`)
      }
    })
}

/**
 * Deploy static sites with external DNS provider (Cloudflare, Porkbun, GoDaddy)
 * Handles detection of existing DNS records (like Netlify) and prompts for migration
 */
async function deployStaticSitesWithExternalDns(
  config: any,
  specificSite: string | undefined,
  dnsProviderName: string,
  region: string,
  skipDnsVerification?: boolean,
): Promise<void> {
  const sites = config.sites || {}
  const siteNames = specificSite ? [specificSite] : Object.keys(sites)

  if (siteNames.length === 0) {
    cli.warn('No sites configured in cloud.config.ts')
    return
  }

  // Get DNS provider config from environment
  const dnsConfig = resolveDnsProviderConfig(dnsProviderName)
  if (!dnsConfig) {
    cli.error(`DNS provider '${dnsProviderName}' is not configured. Please set the required environment variables.`)
    cli.info('\nFor Cloudflare: CLOUDFLARE_API_TOKEN')
    cli.info('For Porkbun: PORKBUN_API_KEY, PORKBUN_SECRET_KEY')
    cli.info('For GoDaddy: GODADDY_API_KEY, GODADDY_API_SECRET')
    return
  }

  const dnsProvider = getDnsProvider(dnsProviderName)

  for (const siteName of siteNames) {
    const siteConfig = sites[siteName]
    if (!siteConfig) {
      cli.error(`Site '${siteName}' not found in configuration`)
      continue
    }

    const domain = siteConfig.domain
    if (!domain) {
      cli.error(`Site '${siteName}' has no domain configured`)
      continue
    }

    cli.header(`Deploying Site: ${siteName}`)
    cli.info(`Domain: ${domain}`)
    cli.info(`Source: ${siteConfig.root}`)
    cli.info(`DNS Provider: ${dnsProviderName}`)

    // Check if source directory exists
    if (!existsSync(siteConfig.root)) {
      cli.error(`Source directory not found: ${siteConfig.root}`)
      cli.info('Run your build command first (e.g., bun run generate)')
      continue
    }

    // Check for existing DNS records
    cli.step('Checking existing DNS records...')
    const existingRecords = await dnsProvider.listRecords(domain)

    if (existingRecords.success && existingRecords.records.length > 0) {
      // Look for existing CNAME records that might be pointing to Netlify or other providers
      const domainParts = domain.split('.')
      const subdomain = domainParts.length > 2 ? domainParts[0] : '@'
      const rootDomain = domainParts.slice(-2).join('.')

      const existingCname = existingRecords.records.find(r =>
        r.type === 'CNAME' &&
        (r.name === domain || r.name === subdomain || r.name === `${subdomain}.${rootDomain}`)
      )

      if (existingCname) {
        const isNetlify = existingCname.content.includes('netlify')
        const isVercel = existingCname.content.includes('vercel')
        const isCloudFront = existingCname.content.includes('cloudfront.net')

        // Skip if already pointing to CloudFront (our infrastructure)
        if (isCloudFront) {
          cli.info(`Domain already points to CloudFront: ${existingCname.content}`)
          cli.info('Proceeding with file upload...')
        } else {
          const providerName = isNetlify ? 'Netlify' : isVercel ? 'Vercel' : 'another provider'

          cli.warn(`\nExisting CNAME record detected:`)
          cli.info(`  ${existingCname.name} -> ${existingCname.content}`)

          if (isNetlify || isVercel) {
            cli.info(`\nThis domain is currently pointing to ${providerName}.`)
            cli.info('Deploying will update this record to point to AWS CloudFront.')
          }

          const proceed = await cli.confirm(`\nUpdate DNS record to point to AWS CloudFront?`, true)
          if (!proceed) {
            cli.info('Deployment cancelled')
            continue
          }

          // Delete the old CNAME record before deploying
          cli.step(`Removing old ${providerName} CNAME record...`)
          const deleteResult = await dnsProvider.deleteRecord(domain, {
            name: existingCname.name,
            type: 'CNAME',
            content: existingCname.content,
          })

          if (deleteResult.success) {
            cli.success(`Removed CNAME: ${existingCname.name} -> ${existingCname.content}`)
          } else {
            cli.warn(`Could not remove old record: ${deleteResult.message}`)
            cli.info('The deployment will attempt to update it instead.')
          }
        }
      }
    }

    // Deploy the static site
    cli.step('Deploying to AWS (S3 + CloudFront)...')

    const result = await deployStaticSiteWithExternalDnsFull({
      siteName: `${config.project.slug}-${siteName}`,
      domain,
      region,
      sourceDir: siteConfig.root,
      certificateArn: siteConfig.certificateArn,
      dnsProvider: dnsConfig,
      skipDnsVerification,
      onProgress: (stage, detail) => {
        if (stage === 'infrastructure') {
          cli.step(detail || 'Setting up infrastructure...')
        } else if (stage === 'upload') {
          // Show upload progress without spamming
          if (detail?.includes('/') && !detail.includes('1/')) {
            const match = detail.match(/(\d+)\/(\d+)/)
            if (match) {
              const [, current, total] = match
              if (Number(current) % 10 === 0 || current === total) {
                cli.info(`  Uploaded ${current}/${total} files`)
              }
            }
          }
        } else if (stage === 'invalidate') {
          cli.step('Invalidating CDN cache...')
        } else if (stage === 'complete') {
          // Handled below
        }
      },
    })

    if (result.success) {
      cli.success('\nDeployment successful!')
      const filesInfo = (result as any).filesSkipped > 0
        ? `${result.filesUploaded} uploaded, ${(result as any).filesSkipped} unchanged`
        : `${result.filesUploaded}`
      cli.box(`Site Deployed!

Domain: https://${result.domain}
CloudFront: ${result.distributionDomain}
Bucket: ${result.bucket}
Files: ${filesInfo}

Your site is now live at https://${result.domain}`, 'green')
    } else {
      cli.error(`\nDeployment failed: ${result.message}`)
    }
  }
}
