import type { CLI } from '@stacksjs/clapp'
import { existsSync, statSync, writeFileSync, copyFileSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as cli from '../../src/utils/cli'
import { InfrastructureGenerator } from '../../src/generators/infrastructure'
import { CloudFormationClient } from '../../src/aws/cloudformation'
import { S3Client } from '../../src/aws/s3'
import { CloudFrontClient } from '../../src/aws/cloudfront'
import { ECRClient } from '../../src/aws/ecr'
import { ECSClient } from '../../src/aws/ecs'
import { STSClient } from '../../src/aws/sts'
import { detectCredentialSource } from '../../src/aws/client'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { validateTemplate, validateTemplateSize, validateResourceLimits } from '../../src/validation/template'
import { loadValidatedConfig, resolveDnsProviderConfig, getDnsProvider } from './shared'
import { collectServerDnsDomains, removeStaleServerAddressRecords } from '../../src/deploy/server-dns'
import { deployStaticSiteWithExternalDnsFull } from '../../src/deploy/static-site-external-dns'
import { createDnsProvider } from '../../src/dns'
import type { DnsProviderConfig } from '../../src/dns/types'
import { PreDeployScanner, type ScanResult, type SecurityFinding } from '../../src/security/pre-deploy-scanner'
import { ensureDynamicMethodsForDomains } from '../../src/deploy/ensure-dynamic-cloudfront'
import { deploymentCoexistenceError, resolveAppDatabase, resolveDeploymentMode, resolveProjectStackName, resolveSiteBucketName, resolveSiteResourceName, resolveSiteStackName, resolveCloudProvider } from '@ts-cloud/core'
import { createCloudDriver } from '../../src/drivers'
import { deployAllComputeSites, renewRpxCertificates } from '../../src/drivers/shared/compute-deploy'
import { runConfigHook } from '../../src/deploy/hooks'
import { resolveSiteKind, validateDeploymentConfig } from '../../src/deploy/site-target'

/**
 * Detect AWS credential source, warn on misconfiguration, and print the
 * resolved IAM identity. Surfaces "who am I deploying as" before any
 * AWS calls happen — saves a lot of debugging time when env vars and
 * profiles disagree.
 */
async function reportAwsIdentity(region: string): Promise<void> {
  const credSource = detectCredentialSource()

  // Warn on set-but-empty env vars (almost always a misconfigured .env file)
  if (credSource.emptyEnvKey || credSource.emptyEnvSecret) {
    cli.warn('Empty AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY env var detected — likely a misconfigured .env file. Remove the empty lines or fill them in.')
  }

  cli.info(`AWS credentials: ${credSource.description}`)

  try {
    const sts = new STSClient(region)
    const identity = await sts.getCallerIdentity()
    if (identity.Arn) {
      cli.info(`AWS identity: ${identity.Arn}`)
    }
  }
  catch (err: any) {
    cli.warn(`Could not verify AWS identity: ${err.message}`)
  }
}

/**
 * Resolve a release SHA used across all sites in this deploy.
 */
function resolveReleaseSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  }
  catch {
    return Date.now().toString(36)
  }
}

/**
 * Forge-style compute app deploy via the active cloud driver.
 *
 * `onlySite` narrows what is BUILT and SHIPPED, not what is routed: the proxy
 * config is still regenerated from the full site list (via `rpxConfig`), so a
 * single-site deploy can never drop the other sites' routes.
 */
async function deployAppToCompute(
  config: any,
  environment: 'production' | 'staging' | 'development',
  _region: string,
  onlySite?: string,
): Promise<boolean> {
  // Auto-deploy the management dashboard (the stx cockpit) alongside the app on
  // every server box.
  const { ensureManagementDashboard } = await import('../../src/deploy/management-dashboard')
  ensureManagementDashboard(config, { logger: { info: cli.info, warn: cli.warn } })

  const sites = config.sites || {}
  const allSites = Object.entries<any>(sites)

  if (allSites.length === 0) {
    cli.warn('infrastructure.compute is set but no sites are configured — nothing to deploy. Add sites to `cloud.config.ts`.')
    return true
  }

  if (onlySite && !sites[onlySite]) {
    // Name the sites that exist — the dashboard is auto-injected, so a caller
    // cannot know its key without being told.
    cli.error(`Site '${onlySite}' was not found. Configured sites: ${allSites.map(([n]) => n).join(', ')}`)
    return false
  }

  const deployable = allSites.filter(([name, s]) => {
    if (!s)
      return false
    if (onlySite && name !== onlySite)
      return false
    const kind = resolveSiteKind(s)
    if (kind === 'bucket') {
      cli.warn(`Site '${name}' targets a bucket — skipping compute deploy (handled by the static-site path).`)
      return false
    }
    return true
  })
  if (deployable.length === 0) return true

  if (onlySite)
    cli.info(`Deploying only '${onlySite}'. Other sites keep their current release; proxy routes are still regenerated in full.`)

  const slug = config.project.slug
  const compute = config.infrastructure?.compute || {}
  const runtime: 'bun' | 'node' | 'deno' = compute.runtime || 'bun'
  const driver = createCloudDriver({ config })
  const sha = resolveReleaseSha()
  const tarballs = new Map<string, string>()
  const hookLogger = { step: (m: string) => cli.step(m), error: (m: string) => cli.error(m) }

  // beforeDeploy / beforeBuild lifecycle hooks (run locally).
  if (!await runConfigHook(config, 'beforeDeploy', hookLogger)) return true
  if (!await runConfigHook(config, 'beforeBuild', hookLogger)) return true

  for (const [siteName, site] of deployable) {
    const kind = resolveSiteKind(site)
    cli.header(`Preparing site: ${siteName}`)
    cli.info(`Domain: ${site.domain || '(none)'}`)
    cli.info(`Source: ${site.root}`)
    cli.info(`Kind: ${kind === 'server-static' ? 'static (shipped to /var/www)' : 'app (systemd service)'}`)
    if (kind === 'server-app') {
      cli.info(`Start: ${site.start}`)
      cli.info(`Port: ${site.port ?? '(unset)'}`)
    }

    if (site.build) {
      cli.step(`Running build: ${site.build}`)
      try {
        execSync(site.build, { stdio: 'inherit', cwd: process.cwd() })
      }
      catch (err: any) {
        cli.error(`Build failed for site '${siteName}': ${err.message}`)
        return true
      }
    }

    if (!existsSync(site.root)) {
      cli.error(`Build output not found at ${site.root} for site '${siteName}'`)
      return true
    }

    const tarballPath = pathJoin(tmpdir(), `${slug}-${siteName}-${sha}.tar.gz`)
    cli.step(`Packaging ${site.root} → ${tarballPath}`)
    try {
      // Honor `site.exclude` so heavy/host-specific paths (node_modules with
      // native binaries, .git, dev caches) stay out of the release tarball.
      const excludeFlags = (site.exclude || [])
        .map((pattern: string) => `--exclude='${pattern}'`)
        .join(' ')
      execSync(`tar czf "${tarballPath}" -C "${site.root}" ${excludeFlags} .`, { stdio: 'inherit' })
    }
    catch (err: any) {
      cli.error(`Failed to package '${siteName}': ${err.message}`)
      return true
    }

    tarballs.set(siteName, tarballPath)
  }

  // afterBuild hook (run locally once all sites are built/packaged).
  if (!await runConfigHook(config, 'afterBuild', hookLogger)) return true

  const ok = await deployAllComputeSites({
    // Only the selected site is shipped...
    config: onlySite ? { ...config, sites: Object.fromEntries(deployable) } : config,
    // ...but the proxy still sees every site, so a single-site deploy can never
    // drop the other sites' routes from the regenerated gateway config.
    rpxConfig: onlySite ? config : undefined,
    environment,
    driver,
    sha,
    runtime,
    tarballForSite: siteName => {
      const path = tarballs.get(siteName)
      if (!path) throw new Error(`Missing tarball for site '${siteName}'`)
      return path
    },
    logger: {
      info: message => cli.info(message),
      warn: message => cli.warn(message),
      error: message => cli.error(message),
      step: message => cli.step(message),
      success: message => cli.success(message),
    },
  })

  // afterDeploy hook (run locally once the deploy succeeded).
  if (ok)
    await runConfigHook(config, 'afterDeploy', hookLogger)

  return ok
}

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
    .option('--site <name>', 'Deploy specific site only (routes are still regenerated in full)')
    .option('--skip-security-scan', 'Skip pre-deployment security scan')
    .option('--skip-dns-verification', 'Skip DNS provider verification and record creation (use when DNS is already configured)')
    .option('--security-fail-on <severity>', 'Security scan fail threshold (critical, high, medium, low)', { default: 'critical' })
    .option('--dry-run', 'Show the deployment plan without making changes')
    .option('--yes', 'Skip confirmation prompts (non-interactive / CI)')
    .action(async (options?: {
      stack?: string
      env?: string
      site?: string
      skipSecurityScan?: boolean
      skipDnsVerification?: boolean
      securityFailOn?: 'critical' | 'high' | 'medium' | 'low'
      dryRun?: boolean
      yes?: boolean
    }) => {
      cli.header('Deploying Infrastructure')

      const autoConfirm = options?.yes === true || process.env.CI === 'true'
      const environment = (options?.env || 'staging') as 'production' | 'staging' | 'development'

      // Load environment-specific .env file BEFORE anything else.
      // Bun auto-loads .env.local at process startup, so we must purge
      // those values before config loading or any other env reads.
      let restoreEnv: (() => Promise<void>) | null = null
      restoreEnv = await loadEnvironmentFile(environment)

      try {
        // Load configuration after env is set up correctly
        const config = await loadValidatedConfig()

        // Validate the per-site deployment model up front — turns silent runtime
        // failures (e.g. a server-app site with no compute server) into an
        // explicit, actionable contract. Errors abort; warnings continue.
        const { errors: deployErrors, warnings: deployWarnings } = validateDeploymentConfig(config)
        for (const w of deployWarnings)
          cli.warn(w)
        if (deployErrors.length > 0) {
          cli.error('\n✗ Deployment configuration is invalid:')
          for (const e of deployErrors)
            cli.error(`  • ${e}`)
          return
        }

        if (options?.dryRun) {
          if (options.site && !config.sites?.[options.site]) {
            cli.error(`Site '${options.site}' was not found. Configured sites: ${Object.keys(config.sites || {}).join(', ') || 'none'}`)
            return
          }
          const deploymentMode = resolveDeploymentMode(config)
          const stackName = options.stack || resolveProjectStackName(config, environment)
          const cloudProvider = resolveCloudProvider(config)
          const region = config.project.region || 'us-east-1'
          const sites = options.site ? [options.site] : Object.keys(config.sites || {})
          cli.header('Deployment Plan')
          cli.info(`Cloud provider: ${cloudProvider}`)
          cli.info(`Mode: ${deploymentMode}`)
          cli.info(`Stack: ${stackName}`)
          cli.info(`Region: ${region}`)
          cli.info(`Environment: ${environment}`)
          cli.info(`Sites: ${sites.length > 0 ? sites.join(', ') : 'none'}`)
          cli.success('Dry run complete. No infrastructure, DNS, certificates, or application files were changed.')
          return
        }

        // Surface which AWS credentials and identity are about to be used
        // (helps catch wrong-profile / wrong-account mistakes before any AWS calls)
        const awsRegion = config.project?.region || 'us-east-1'
        await reportAwsIdentity(awsRegion)

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

        // Server and serverless are mutually exclusive. When the project is a
        // serverless app (`environments.<env>.app`), `cloud deploy` routes to the
        // Lambda pipeline automatically (the same work as `cloud deploy:serverless`)
        // instead of the compute/infrastructure path below.
        if (resolveDeploymentMode(config) === 'serverless') {
          cli.step('Serverless project detected: deploying the Lambda application')
          const { deployServerlessApp } = await import('../../src/deploy/serverless-app')
          await deployServerlessApp(config, environment, {})
          cli.success('Serverless deployment complete')
          return
        }

        const stackName = options?.stack || resolveProjectStackName(config, environment)
        const region = config.project.region || 'us-east-1'
        const deployInfrastructureStack = config.infrastructure?.deployStack !== false
        const hasSites = config.sites && Object.keys(config.sites).length > 0
        const dnsProvider = config.infrastructure?.dns?.provider

        // Site stacks (S3 + CloudFront) — run whenever sites + DNS are configured,
        // including alongside compute (registry EC2 + pantry.dev CDN are separate concerns).
        if (hasSites && dnsProvider) {
          await deployStaticSitesWithExternalDns(
            config,
            options?.site,
            dnsProvider,
            region,
            options?.skipDnsVerification,
            environment,
            autoConfirm,
          )

          if (!deployInfrastructureStack) {
            if (config.infrastructure?.compute) {
              const siteDomains = Object.values(config.sites!)
                .map(site => site.domain)
                .filter((domain): domain is string => !!domain)
              if (siteDomains.length > 0) {
                cli.step('Syncing CloudFront dynamic HTTP methods for app domains...')
                await ensureDynamicMethodsForDomains(siteDomains)
              }
            }
            return
          }
        }

        if (!deployInfrastructureStack) {
          cli.info('Infrastructure stack deployment disabled (infrastructure.deployStack: false)')
          return
        }

        const cloudProvider = resolveCloudProvider(config)
        cli.info(`Cloud provider: ${cloudProvider}`)
        cli.info(`Stack: ${stackName}`)
        cli.info(`Region: ${region}`)
        cli.info(`Environment: ${environment}`)

        // Lightweight single-server (Forge-style) path: provision one box via
        // the driver and deploy onto it — no CloudFormation. Used for Hetzner,
        // and for AWS when `compute.mode === 'server'` (boots an Ubuntu EC2).
        const serverCompute = cloudProvider === 'hetzner'
          || config.infrastructure?.compute?.mode === 'server'
        if (serverCompute && config.infrastructure?.compute) {
          cli.step(`Provisioning ${cloudProvider} compute infrastructure...`)
          const driver = createCloudDriver({ config, provider: cloudProvider })
          if (!driver.provisionComputeInfrastructure) {
            cli.error(`${cloudProvider} driver does not support compute provisioning`)
            return
          }

          const outputs = await driver.provisionComputeInfrastructure({ config, environment })
          cli.success(`${cloudProvider} compute infrastructure ready`)
          if (outputs.appPublicIp) cli.info(`App server: ${outputs.appPublicIp}`)
          if (outputs.appInstanceId) cli.info(`Server ID: ${outputs.appInstanceId}`)

          // Provision-then-deploy (no separate CloudFormation stack step). Always
          // run the deploy step — even with no user sites — so the management
          // dashboard is auto-deployed on every freshly started server.
          const ok = await deployAppToCompute(config, environment, region, options?.site)
          if (!ok) {
            cli.error(`App deploy to ${cloudProvider} compute reported a failure`)
          }
          else {
            cli.success(`App deployed to ${cloudProvider} compute`)
            // Point each server-served site domain at the box. The S3 site path
            // (deployStaticSitesWithExternalDns) skips deploy:'server' sites, so
            // for a compute deploy DNS is reconciled here instead — additive
            // UPSERTs only, opt-in via `infrastructure.dns.provider`.
            await reconcileServerDns(config, outputs.appPublicIp, dnsProvider)
            const tlsOk = await renewRpxCertificates({
              config,
              environment,
              driver,
              logger: { info: cli.info, warn: cli.warn, error: cli.error, step: cli.step, success: cli.success },
            })
            if (!tlsOk)
              cli.error('App deployed, but rpx TLS certificate reconciliation failed')
          }
          return
        }

        // Generate CloudFormation template
        cli.step('Generating CloudFormation template...')
        const generator = new InfrastructureGenerator({
          config,
          environment,
        })

        generator.generate()
        const templateBody = generator.toJSON()
        const template = JSON.parse(templateBody)

        // A site-only project (sites + DNS, no compute/database/VPC/etc.) produces an
        // environment stack with no resources. The sites were already deployed above, so
        // there is genuinely nothing left to provision here. CloudFormation rejects empty
        // stacks ("At least one resource is required") — skip gracefully instead of
        // surfacing that as a deployment failure.
        const envResourceCount = Object.keys(template.Resources || {}).length
        if (envResourceCount === 0) {
          cli.info(`No infrastructure resources to deploy for environment '${environment}' — skipping stack ${stackName}.`)
          return
        }

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
        const confirmed = autoConfirm || await cli.confirm('\nDeploy now?', true)
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
              cli.info('Stack is already up to date — continuing to app deploy')
              // Do NOT return here: an unchanged stack still needs the code
              // (sites) deployed/redeployed below. Returning early made code
              // deploys impossible once the infra existed.
            }
            else {
              throw error
            }
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

        // Auto-upload files for website storage buckets that have a `root` configured
        if (config.infrastructure?.storage) {
          for (const [name, storageConfig] of Object.entries(config.infrastructure.storage)) {
            if (!storageConfig.website || !storageConfig.root) continue

            const bucketName = outputs[`${name}BucketName`] || outputs.FrontendBucketName
            const distributionId = outputs[`${name}CloudFrontDistributionId`]

            if (!bucketName) {
              cli.warn(`Could not find bucket name for storage '${name}' — skipping file upload`)
              continue
            }

            if (!existsSync(storageConfig.root)) {
              cli.warn(`Source directory not found: ${storageConfig.root} — skipping file upload for '${name}'`)
              continue
            }

            cli.step(`Uploading files from ${storageConfig.root} to s3://${bucketName}...`)
            const { uploadStaticFiles, invalidateCache } = await import('../../src/deploy/static-site')
            const uploadResult = await uploadStaticFiles({
              sourceDir: storageConfig.root,
              bucket: bucketName,
              region,
              onProgress: (uploaded, total, file) => {
                if (uploaded % 10 === 0 || uploaded === total) {
                  cli.info(`  ${uploaded}/${total}: ${file}`)
                }
              },
            })

            if (uploadResult.errors.length > 0) {
              cli.warn(`Upload completed with errors: ${uploadResult.errors.join(', ')}`)
            }
            else {
              const msg = uploadResult.skipped > 0
                ? `Uploaded ${uploadResult.uploaded} files (${uploadResult.skipped} unchanged)`
                : `Uploaded ${uploadResult.uploaded} files`
              cli.success(msg)
            }

            // Invalidate CloudFront cache
            if (distributionId && uploadResult.uploaded > 0) {
              cli.step('Invalidating CloudFront cache...')
              const { invalidationId } = await invalidateCache(distributionId)
              cli.success(`Cache invalidation created: ${invalidationId}`)
            }
          }
        }

        // EC2 app deploy via SSM (Forge-style) — when `infrastructure.compute` is set,
        // deploy every configured site as a systemd service on the EC2 instance.
        if (config.infrastructure?.compute) {
          await deployAppToCompute(config, environment, region, options?.site)
        }

        // When compute serves site domains via CloudFront, ensure POST/auth routes work
        if (config.infrastructure?.compute && config.sites) {
          const siteDomains = Object.values(config.sites)
            .map((site: { domain?: string }) => site.domain)
            .filter((domain): domain is string => !!domain)
          if (siteDomains.length > 0) {
            cli.step('Syncing CloudFront dynamic HTTP methods for app domains...')
            await ensureDynamicMethodsForDomains(siteDomains)
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
      finally {
        if (restoreEnv) await restoreEnv()
      }
    })

  app
    .command('deploy:server', 'Deploy EC2 infrastructure')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .option('--site <name>', 'Deploy specific site only (routes are still regenerated in full)')
    .action(async (options?: { env?: string, site?: string }) => {
      cli.header('Deploying Server Infrastructure')

      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
        const region = config.project.region || 'us-east-1'

        const serverCoexistence = deploymentCoexistenceError(config)
        if (serverCoexistence) {
          cli.error(serverCoexistence)
          process.exitCode = 1
          return
        }

        if (!config.infrastructure?.compute) {
          cli.error('No `infrastructure.compute` configured — nothing to deploy as a server.')
          cli.info('Add an EC2 compute block to cloud.config, or use `cloud deploy:serverless` for Lambda apps.')
          process.exitCode = 1
          return
        }

        cli.info(`Region: ${region}`)
        cli.info(`Environment: ${environment}`)

        // Forge-style EC2 deploy via SSM — the same real path used by `cloud deploy`.
        const ok = await deployAppToCompute(config, environment, region, options?.site)
        if (!ok) {
          process.exitCode = 1
          return
        }

        if (config.sites) {
          const siteDomains = Object.values(config.sites)
            .map((site: { domain?: string }) => site.domain)
            .filter((domain): domain is string => !!domain)
          if (siteDomains.length > 0) {
            cli.step('Syncing CloudFront dynamic HTTP methods for app domains...')
            await ensureDynamicMethodsForDomains(siteDomains)
          }
        }
        cli.success('\nServer deployment complete!')
      }
      catch (error: any) {
        cli.error(`Deployment failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('deploy:serverless', 'Deploy a serverless application (http/queue/cli Lambda functions)')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .option('--skip-build', 'Skip local build hooks')
    .option('--skip-hooks', 'Skip remote deploy hooks (e.g. migrations)')
    .option('--redeploy', 'Re-activate the last build without rebuilding')
    .action(async (options?: { env?: string, skipBuild?: boolean, skipHooks?: boolean, redeploy?: boolean }) => {
      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
        const serverlessCoexistence = deploymentCoexistenceError(config)
        if (serverlessCoexistence) {
          cli.error(serverlessCoexistence)
          process.exitCode = 1
          return
        }
        const { deployServerlessApp, redeployServerlessApp } = await import('../../src/deploy/serverless-app')

        if (options?.redeploy) {
          await redeployServerlessApp(config, environment)
          return
        }
        await deployServerlessApp(config, environment, {
          skipBuild: options?.skipBuild,
          skipDeployHooks: options?.skipHooks,
        })
      }
      catch (error: any) {
        cli.error(`Deployment failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('serverless:rollback', 'Roll back a serverless app to the previous build')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .action(async (options?: { env?: string }) => {
      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
        const { rollbackServerlessApp } = await import('../../src/deploy/serverless-app')
        await rollbackServerlessApp(config, environment)
      }
      catch (error: any) {
        cli.error(`Rollback failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('deploy:rollback [site]', 'Roll a compute site back to a previous release')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .option('--to <release>', 'Release id to roll back to (default: the previous release)')
    .action(async (site?: string, options?: { env?: string, to?: string }) => {
      cli.header('Rolling Back Release')
      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
        const siteName = site || Object.keys(config.sites || {})[0]
        if (!siteName) {
          cli.error('No site configured to roll back.')
          process.exitCode = 1
          return
        }
        const { rollbackComputeSite } = await import('../../src/drivers/shared/compute-ops')
        const result = await rollbackComputeSite(
          { driver: createCloudDriver({ config }), slug: config.project.slug, environment, logger: cli },
          { siteName, to: options?.to },
        )
        if (!result.success) {
          cli.error(`Rollback failed: ${result.error || 'unknown error'}`)
          process.exitCode = 1
          return
        }
        for (const inst of result.perInstance || [])
          cli.info(`  ${inst.instanceId}: ${inst.output?.trim() || inst.status}`)
      }
      catch (error: any) {
        cli.error(`Rollback failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('deploy:history [site]', 'Show a compute site\'s deployment history')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .option('--limit <n>', 'Number of entries to show', { default: '20' })
    .action(async (site?: string, options?: { env?: string, limit?: string }) => {
      cli.header('Deployment History')
      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
        const siteName = site || Object.keys(config.sites || {})[0]
        if (!siteName) {
          cli.error('No site configured.')
          process.exitCode = 1
          return
        }
        const { getComputeDeployHistory } = await import('../../src/drivers/shared/compute-ops')
        const result = await getComputeDeployHistory(
          { driver: createCloudDriver({ config }), slug: config.project.slug, environment, logger: cli },
          { siteName, limit: Number.parseInt(options?.limit || '20', 10) || 20 },
        )
        if (!result.success) {
          cli.error(`Could not read history: ${result.error || 'unknown error'}`)
          process.exitCode = 1
          return
        }
        for (const inst of result.perInstance || []) {
          cli.info(`\n${inst.instanceId}:`)
          cli.info(inst.output?.trimEnd() || '(no output)')
        }
      }
      catch (error: any) {
        cli.error(`History lookup failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('deploy:recipe <name> <script>', 'Run a reusable server recipe (a local bash file) across servers')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .option('--user <user>', 'User to run the recipe as', { default: 'root' })
    .action(async (name: string, script: string, options?: { env?: string, user?: string }) => {
      cli.header(`Running Recipe: ${name}`)
      try {
        if (!existsSync(script)) {
          cli.error(`Recipe script not found: ${script}`)
          process.exitCode = 1
          return
        }
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
        const lines = readFileSync(script, 'utf8').split('\n')
        const { runComputeRecipe } = await import('../../src/drivers/shared/compute-ops')
        const result = await runComputeRecipe(
          { driver: createCloudDriver({ config }), slug: config.project.slug, environment, logger: cli },
          { name, script: lines, user: options?.user },
        )
        for (const inst of result.perInstance || []) {
          cli.info(`\n${inst.instanceId}:`)
          cli.info(inst.output?.trimEnd() || '(no output)')
        }
        if (!result.success)
          process.exitCode = 1
      }
      catch (error: any) {
        cli.error(`Recipe failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('db:restore-backup [from]', 'Restore the app database from an on-box ts-backups dump (latest, or a given file)')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .action(async (from?: string, options?: { env?: string }) => {
      cli.header('Database Restore')
      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
        const { restoreDatabaseBackup } = await import('../../src/drivers/shared/compute-ops')
        const result = await restoreDatabaseBackup(
          { driver: createCloudDriver({ config }), slug: config.project.slug, environment, logger: cli },
          { database: resolveAppDatabase(config), from },
        )
        for (const inst of result.perInstance || [])
          cli.info(`  ${inst.instanceId}: ${inst.output?.trim() || inst.status}`)
        if (!result.success) {
          cli.error(`Restore failed: ${result.error || 'unknown error'}`)
          process.exitCode = 1
        }
      }
      catch (error: any) {
        cli.error(`Restore failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('quick-deploy', 'Generate a push-to-deploy CI pipeline for your git provider (Forge Quick Deploy)')
    .option('--env <environment>', 'Environment to deploy on push', { default: 'production' })
    .option('--provider <provider>', 'CI provider (github, gitlab, bitbucket); defaults to the origin remote')
    .option('--site <site>', 'Deploy only this configured site')
    .option('--skip-dns-verification', 'Generate a deploy that skips DNS verification and record creation')
    .option('--force', 'Overwrite an existing pipeline file')
    .action(async (options?: { env?: string, provider?: string, site?: string, skipDnsVerification?: boolean, force?: boolean }) => {
      cli.header('Quick Deploy (push-to-deploy)')
      try {
        const config = await loadValidatedConfig()
        const { buildQuickDeployCi, inferQuickDeployProvider } = await import('../../src/deploy/quick-deploy')
        const requestedProvider = options?.provider?.toLowerCase()
        if (requestedProvider && !['github', 'gitlab', 'bitbucket'].includes(requestedProvider))
          throw new Error(`Unsupported CI provider '${options?.provider}'. Use github, gitlab, or bitbucket.`)
        let provider = requestedProvider as 'github' | 'gitlab' | 'bitbucket' | undefined
        if (!provider) {
          try {
            const origin = execSync('git remote get-url origin', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
            provider = inferQuickDeployProvider(origin)
          }
          catch {}
        }
        const ci = buildQuickDeployCi(config, options?.env || 'production', {
          provider,
          site: options?.site,
          skipDnsVerification: options?.skipDnsVerification,
          setup: existsSync('pantry.lock') ? 'pantry' : 'bun',
        })
        if (!ci) {
          cli.warn('Could not resolve a GitHub, GitLab, or Bitbucket provider from --provider, the origin remote, or a configured site repository.')
          process.exitCode = 1
          return
        }
        if (existsSync(ci.path) && !options?.force) {
          cli.warn(`${ci.path} already exists — re-run with --force to overwrite.`)
          return
        }
        mkdirSync(dirname(ci.path), { recursive: true })
        writeFileSync(ci.path, ci.content)
        cli.success(`Wrote ${ci.path} (${ci.provider}, deploys on push to '${ci.branch}').`)
        cli.info('Next: commit it and add your provider credentials as CI secrets/variables.')
      }
      catch (error: any) {
        cli.error(`Quick deploy setup failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('down', 'Put the serverless app into maintenance mode (503)')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .option('--secret <secret>', 'Bypass secret (send as x-maintenance-bypass header)')
    .action(async (options?: { env?: string, secret?: string }) => {
      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
        const { setMaintenance } = await import('../../src/deploy/serverless-app')
        await setMaintenance(config, environment, true, options?.secret)
      }
      catch (error: any) {
        cli.error(`Failed to enable maintenance mode: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('up', 'Bring the serverless app out of maintenance mode')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .action(async (options?: { env?: string }) => {
      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
        const { setMaintenance } = await import('../../src/deploy/serverless-app')
        await setMaintenance(config, environment, false)
      }
      catch (error: any) {
        cli.error(`Failed to disable maintenance mode: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('command <cmd>', 'Run a command on the serverless CLI function (e.g. migrations)')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .action(async (cmd: string, options?: { env?: string }) => {
      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
        const { runAndRecordCommand } = await import('../../src/deploy/serverless-app')
        const { id, output } = await runAndRecordCommand(config, environment, cmd)
        cli.info(output)
        if (id > 0) cli.info(`\n(recorded as #${id} — re-run with \`cloud command:again ${id}\`)`)
      }
      catch (error: any) {
        cli.error(`Command failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('command:history', 'List recorded CLI-function command invocations')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .option('--limit <n>', 'Show at most this many (most recent)', { default: '20' })
    .action(async (options?: { env?: string, limit?: string }) => {
      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
        const { listCommandHistory } = await import('../../src/deploy/serverless-app')
        const records = await listCommandHistory(config, environment)
        if (!records.length) {
          cli.info('No command history yet.')
          return
        }
        const limit = Number(options?.limit ?? 20)
        cli.header(`Command history — ${config.project.slug} (${environment})`)
        cli.table(
          ['#', 'When', 'Status', 'Command'],
          records.slice(-limit).reverse().map(r => [String(r.id), r.timestamp, r.status, r.command]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to read history: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('command:again [id]', 'Re-run a recorded command (defaults to the most recent)')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .action(async (id?: string, options?: { env?: string }) => {
      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
        const { getCommandRecord, runAndRecordCommand } = await import('../../src/deploy/serverless-app')
        const record = await getCommandRecord(config, environment, id ? Number(id) : undefined)
        if (!record) {
          cli.error(id ? `No command #${id} in history.` : 'No command history to re-run.')
          process.exitCode = 1
          return
        }
        cli.info(`Re-running #${record.id}: ${record.command}`)
        const res = await runAndRecordCommand(config, environment, record.command)
        cli.info(res.output)
        if (res.id > 0) cli.info(`\n(recorded as #${res.id})`)
      }
      catch (error: any) {
        cli.error(`Command failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('serverless:db-shell <sql>', 'Run a SQL statement against a private serverless database (via the CLI function)')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .action(async (sql: string, options?: { env?: string }) => {
      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
        const { runDbQuery } = await import('../../src/deploy/serverless-app')
        const output = await runDbQuery(config, environment, sql)
        cli.info(output)
      }
      catch (error: any) {
        cli.error(`Query failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('serverless:db-scale <min> <max>', 'Rescale the serverless Aurora cluster (min/max ACUs)')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .action(async (min: string, max: string, options?: { env?: string }) => {
      cli.header('Scaling serverless database')
      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
        const minCapacity = Number(min)
        const maxCapacity = Number(max)
        if (!(minCapacity > 0) || !(maxCapacity >= minCapacity)) {
          cli.error('Provide valid capacities: min > 0 and max >= min (e.g. `serverless:db-scale 0.5 8`).')
          process.exitCode = 1
          return
        }
        const { scaleServerlessDatabase } = await import('../../src/deploy/serverless-app')
        await scaleServerlessDatabase(config, environment, minCapacity, maxCapacity)
      }
      catch (error: any) {
        cli.error(`Scale failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('serverless:db-restore', 'Restore the serverless Aurora cluster to a point in time (as a new cluster)')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .option('--to <timestamp>', 'Restore to this ISO-8601 time (UTC)')
    .option('--latest', 'Restore to the latest restorable time')
    .option('--target <id>', 'New cluster identifier (defaults to <cluster>-restore-<stamp>)')
    .action(async (options?: { env?: string, to?: string, latest?: boolean, target?: string }) => {
      cli.header('Restoring serverless database')
      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
        let toTime: Date | undefined
        if (options?.to) {
          toTime = new Date(options.to)
          if (Number.isNaN(toTime.getTime())) {
            cli.error(`Invalid --to timestamp: ${options.to} (use ISO-8601, e.g. 2026-06-18T10:00:00Z).`)
            process.exitCode = 1
            return
          }
        }
        const { restoreServerlessDatabase } = await import('../../src/deploy/serverless-app')
        await restoreServerlessDatabase(config, environment, { toTime, latest: options?.latest, target: options?.target })
      }
      catch (error: any) {
        cli.error(`Restore failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('serverless:info', 'Show an operational summary of a deployed serverless app')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .action(async (options?: { env?: string }) => {
      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
        const { serverlessInfo } = await import('../../src/deploy/serverless-app')
        const info = await serverlessInfo(config, environment)
        cli.header(`${info.slug} (${info.environment})`)
        cli.info(`Stack:    ${info.stackStatus}`)
        cli.info(`Region:   ${info.region}`)
        if (info.endpoint) cli.info(`URL:      ${info.endpoint}`)
        if (info.assetUrl) cli.info(`Assets:   ${info.assetUrl}`)
        cli.info(`Scheduler:${info.scheduler === 'off' ? ' off' : ` ${info.scheduler}`}`)
        cli.info(`Queues:   ${info.queues.length ? info.queues.join(', ') : 'none'}`)
        cli.info(`Warming:  ${info.provisionedConcurrency > 0 ? `provisioned concurrency ×${info.provisionedConcurrency}` : 'none / ping-warm'}`)
        if (info.lastRelease) cli.info(`Release:  ${info.lastRelease.sha.slice(0, 12)} @ ${info.lastRelease.timestamp}`)
        cli.table(
          ['Function', 'Version', 'Provisioned'],
          info.functions.map(f => [
            f.name,
            f.version,
            f.provisioned ? `${f.provisioned.status} ${f.provisioned.allocated}/${f.provisioned.requested}` : '—',
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to read info: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('dashboard:build', 'Build the management dashboard with live data baked in')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .option('--ui <dir>', 'UI directory (default ./ui)', { default: 'ui' })
    .action(async (options?: { env?: string, ui?: string }) => {
      cli.header('Building management dashboard (live data)')
      try {
        const { existsSync } = await import('node:fs')
        const uiDir = options?.ui || 'ui'
        if (!existsSync(`${uiDir}/package.json`)) {
          cli.error(`No UI project at ${uiDir}/ (expected ${uiDir}/package.json). Pass --ui <dir>.`)
          process.exitCode = 1
          return
        }
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
        cli.step('Gathering live data from AWS')

        // Gather both halves the dashboard shows — serverless app (Lambda) and the
        // server box (EC2) — and merge into one injected payload. Each is
        // best-effort: a failure leaves that half on representative sample data.
        let data: Record<string, any> | null = null
        if (config.environments?.[environment]?.app) {
          const { resolveDashboardData } = await import('../../src/deploy/dashboard-data')
          const sl = await resolveDashboardData(config, environment).catch((e) => {
            cli.warn(`Serverless data unavailable (${e.message}) — that view uses sample data.`)
            return null
          })
          if (sl) data = { ...(data ?? {}), ...sl }
        }
        if (config.infrastructure?.compute) {
          const { resolveServerDashboardData } = await import('../../src/deploy/dashboard-data-server')
          const sv = await resolveServerDashboardData(config, environment).catch(() => null)
          if (sv) {
            if (sv._serverReachable === false)
              cli.warn('Server box not reachable over SSM — server view uses config + sample data.')
            data = { ...(data ?? {}), ...sv }
          }
        }
        cli.step('Building dashboard')
        const { execSync } = await import('node:child_process')
        const { rmSync } = await import('node:fs')
        // stx caches built pages by source-content hash and is blind to env, so a
        // prior sample build would be served stale — bust the SSG cache first.
        for (const c of ['.stx/ssg-cache', '.stx/cache'])
          rmSync(`${uiDir}/${c}`, { recursive: true, force: true })
        // Build only (no `bun install`): the dashboard's deps are already present
        // (hoisted at the repo root, or shipped prebuilt), and re-resolving can
        // fail on registry version drift. Run `bun install` in the ui dir yourself
        // first if you're building it standalone for the first time.
        execSync('bun run build', {
          cwd: uiDir,
          stdio: 'inherit',
          env: { ...process.env, ...(data ? { TSCLOUD_DASHBOARD_DATA: JSON.stringify(data) } : {}) },
        })
        cli.success(`Dashboard built → ${uiDir}/dist${data ? ' (live data)' : ' (sample data)'}`)
      }
      catch (error: any) {
        cli.error(`Dashboard build failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('serverless:build-php-layer', 'Build + publish the ts-cloud PHP runtime layer (requires Docker)')
    .option('--arch <architecture>', 'x86_64 or arm64', { default: 'x86_64' })
    .option('--php <version>', 'PHP version', { default: '8.3' })
    .option('--name <name>', 'Layer name', { default: 'tscloud-php' })
    .option('--bucket <bucket>', 'S3 bucket to stage the layer zip (defaults to {slug}-layers)')
    .option('--region <region>', 'AWS region')
    .action(async (options?: { arch?: 'x86_64' | 'arm64', php?: string, name?: string, bucket?: string, region?: string }) => {
      cli.header('Building PHP runtime layer')
      try {
        const config = await loadValidatedConfig().catch(() => null)
        const region = options?.region || config?.project.region || 'us-east-1'
        const arch = options?.arch || 'x86_64'
        const phpVersion = options?.php || '8.3'
        const layerName = `${options?.name || 'tscloud-php'}-${phpVersion.replace('.', '')}-${arch}`
        const bucket = options?.bucket || `${config?.project.slug || 'tscloud'}-layers`

        const { buildPhpRuntimeLayerZip } = await import('@ts-cloud/core')
        const { S3Client } = await import('../../src/aws/s3')
        const { LambdaClient } = await import('../../src/aws/lambda')

        const artifact = buildPhpRuntimeLayerZip({ architecture: arch, phpVersion, onStep: m => cli.step(m) })
        cli.info(`Layer: ${artifact.fileCount} files, ${(artifact.zip.length / 1024 / 1024).toFixed(1)} MB`)

        const s3 = new S3Client(region)
        if (!(await s3.bucketExists(bucket))) {
          cli.step(`Creating layer bucket ${bucket}`)
          await s3.createBucket(bucket)
        }
        const key = `layers/${layerName}.zip`
        cli.step('Uploading layer zip')
        await s3.putObject({ bucket, key, body: artifact.zip, contentType: 'application/zip' })

        cli.step('Publishing layer version')
        const lambda = new LambdaClient(region)
        const published = await lambda.publishLayerVersion({
          LayerName: layerName,
          Description: `ts-cloud PHP ${phpVersion} runtime (${arch})`,
          Content: { S3Bucket: bucket, S3Key: key },
          CompatibleRuntimes: ['provided.al2023'],
          CompatibleArchitectures: [arch],
        })

        cli.box([
          'PHP runtime layer published',
          '',
          `ARN: ${published.LayerVersionArn}`,
          '',
          'Reference it in your config:',
          `  app: { kind: 'php', layers: ['${published.LayerVersionArn}'] }`,
          'or set TSCLOUD_PHP_LAYER_ARN before deploying.',
        ].join('\n'), 'green')
      }
      catch (error: any) {
        cli.error(`Layer build failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('serverless:build-node-layer', 'Build + publish a ts-cloud Node custom runtime layer (any version, incl. 24)')
    .option('--arch <architecture>', 'x86_64 or arm64', { default: 'x86_64' })
    .option('--node <version>', 'Node version (e.g. 24)', { default: '24' })
    .option('--name <name>', 'Layer name', { default: 'tscloud-node' })
    .option('--bucket <bucket>', 'S3 bucket to stage the layer zip (defaults to {slug}-layers)')
    .option('--region <region>', 'AWS region')
    .action(async (options?: { arch?: 'x86_64' | 'arm64', node?: string, name?: string, bucket?: string, region?: string }) => {
      cli.header('Building Node runtime layer')
      try {
        const config = await loadValidatedConfig().catch(() => null)
        const region = options?.region || config?.project.region || 'us-east-1'
        const arch = options?.arch || 'x86_64'
        const version = options?.node || '24'
        const { buildNodeRuntimeLayerZip } = await import('@ts-cloud/core')
        const { S3Client } = await import('../../src/aws/s3')
        const { LambdaClient } = await import('../../src/aws/lambda')

        const artifact = buildNodeRuntimeLayerZip({ architecture: arch, version, onStep: m => cli.step(m) })
        const layerName = `${options?.name || 'tscloud-node'}-${artifact.version.split('.')[0]}-${arch}`
        const bucket = options?.bucket || `${config?.project.slug || 'tscloud'}-layers`
        cli.info(`Layer: Node ${artifact.version}, ${(artifact.zip.length / 1024 / 1024).toFixed(1)} MB`)

        const s3 = new S3Client(region)
        if (!(await s3.bucketExists(bucket))) {
          cli.step(`Creating layer bucket ${bucket}`)
          await s3.createBucket(bucket)
        }
        const key = `layers/${layerName}.zip`
        cli.step('Uploading layer zip')
        await s3.putObject({ bucket, key, body: artifact.zip, contentType: 'application/zip' })

        cli.step('Publishing layer version')
        const lambda = new LambdaClient(region)
        const published = await lambda.publishLayerVersion({
          LayerName: layerName,
          Description: `ts-cloud Node ${artifact.version} runtime (${arch})`,
          Content: { S3Bucket: bucket, S3Key: key },
          CompatibleRuntimes: ['provided.al2023'],
          CompatibleArchitectures: [arch],
        })

        cli.box([
          'Node runtime layer published',
          '',
          `ARN: ${published.LayerVersionArn}`,
          '',
          'Reference it in your config:',
          `  app: { kind: 'node', runtimeVersion: '${artifact.version.split('.')[0]}', layers: ['${published.LayerVersionArn}'] }`,
          'or set TSCLOUD_NODE_LAYER_ARN before deploying.',
        ].join('\n'), 'green')
      }
      catch (error: any) {
        cli.error(`Layer build failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('serverless:build-bun-layer', 'Build + publish a ts-cloud Bun custom runtime layer')
    .option('--arch <architecture>', 'x86_64 or arm64', { default: 'x86_64' })
    .option('--bun <version>', 'Bun version (e.g. 1.3.13, or "latest")', { default: 'latest' })
    .option('--name <name>', 'Layer name', { default: 'tscloud-bun' })
    .option('--bucket <bucket>', 'S3 bucket to stage the layer zip (defaults to {slug}-layers)')
    .option('--region <region>', 'AWS region')
    .action(async (options?: { arch?: 'x86_64' | 'arm64', bun?: string, name?: string, bucket?: string, region?: string }) => {
      cli.header('Building Bun runtime layer')
      try {
        const config = await loadValidatedConfig().catch(() => null)
        const region = options?.region || config?.project.region || 'us-east-1'
        const arch = options?.arch || 'x86_64'
        const version = options?.bun || 'latest'
        const { buildBunRuntimeLayerZip } = await import('@ts-cloud/core')
        const { S3Client } = await import('../../src/aws/s3')
        const { LambdaClient } = await import('../../src/aws/lambda')

        const artifact = buildBunRuntimeLayerZip({ architecture: arch, version, onStep: m => cli.step(m) })
        const layerName = `${options?.name || 'tscloud-bun'}-${artifact.version.replace(/\./g, '')}-${arch}`
        const bucket = options?.bucket || `${config?.project.slug || 'tscloud'}-layers`
        cli.info(`Layer: Bun ${artifact.version}, ${(artifact.zip.length / 1024 / 1024).toFixed(1)} MB`)

        const s3 = new S3Client(region)
        if (!(await s3.bucketExists(bucket))) {
          cli.step(`Creating layer bucket ${bucket}`)
          await s3.createBucket(bucket)
        }
        const key = `layers/${layerName}.zip`
        cli.step('Uploading layer zip')
        await s3.putObject({ bucket, key, body: artifact.zip, contentType: 'application/zip' })

        cli.step('Publishing layer version')
        const lambda = new LambdaClient(region)
        const published = await lambda.publishLayerVersion({
          LayerName: layerName,
          Description: `ts-cloud Bun ${artifact.version} runtime (${arch})`,
          Content: { S3Bucket: bucket, S3Key: key },
          CompatibleRuntimes: ['provided.al2023'],
          CompatibleArchitectures: [arch],
        })

        cli.box([
          'Bun runtime layer published',
          '',
          `ARN: ${published.LayerVersionArn}`,
          '',
          'Reference it in your config:',
          `  app: { kind: 'bun', layers: ['${published.LayerVersionArn}'] }`,
          'or set TSCLOUD_BUN_LAYER_ARN before deploying.',
        ].join('\n'), 'green')
      }
      catch (error: any) {
        cli.error(`Layer build failed: ${error.message}`)
        process.exitCode = 1
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
        const stackName = options?.stack || resolveProjectStackName(config, environment as 'production' | 'staging' | 'development')
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
        const stackName = options?.stack || resolveProjectStackName(config, environment as 'production' | 'staging' | 'development')
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
 * Load environment-specific .env file and handle Bun's .env.local auto-loading.
 *
 * Bun automatically loads .env.local at process startup before any user code runs,
 * which means its values always leak into process.env regardless of --env flag.
 * This function:
 *  1. Backs up and removes .env.local so child processes (builds) don't re-read it
 *  2. Purges .env.local keys from process.env to clear the auto-loaded values
 *  3. Loads the target .env.<environment> file into process.env
 *  4. Returns a restore function to put .env.local back after deployment
 */
async function loadEnvironmentFile(environment: string): Promise<(() => Promise<void>) | null> {
  const cwd = process.cwd()
  const targetEnv = `${cwd}/.env`
  const envLocal = `${cwd}/.env.local`

  // Build list of env file candidates with aliases
  const envAliases: Record<string, string[]> = {
    stage: ['stage', 'staging'],
    staging: ['staging', 'stage'],
  }
  const candidates = (envAliases[environment] || [environment]).map(e => `${cwd}/.env.${e}`)
  const envFile = candidates.find(f => existsSync(f))

  if (!envFile) {
    if (existsSync(targetEnv)) {
      cli.warn(`No .env.${environment} found, falling back to .env`)
    }
    else {
      cli.info(`No .env.${environment} or .env file found; using the existing process environment`)
    }
    return null
  }

  const envFileName = envFile.split('/').pop()
  cli.step(`Loading environment file: ${envFileName}`)

  let envLocalBackup: string | null = null
  let envBackup: string | null = null

  // Back up .env.local if it exists and purge its keys from process.env
  // since Bun auto-loads .env.local at startup before our code runs
  if (existsSync(envLocal)) {
    envLocalBackup = `${envLocal}.bak`
    copyFileSync(envLocal, envLocalBackup)

    const localContent = readFileSync(envLocal, 'utf-8')
    for (const line of localContent.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIndex = trimmed.indexOf('=')
      if (eqIndex === -1) continue
      const key = trimmed.slice(0, eqIndex).trim()
      delete process.env[key]
    }

    const { unlinkSync } = await import('node:fs')
    unlinkSync(envLocal)
    cli.info('Temporarily moved .env.local out of the way and purged its values from process.env')
  }

  // Back up .env before overwriting
  if (existsSync(targetEnv)) {
    envBackup = `${targetEnv}.bak`
    copyFileSync(targetEnv, envBackup)
  }

  copyFileSync(envFile, targetEnv)

  // Parse and load env vars into process.env
  const envContent = readFileSync(envFile, 'utf-8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex).trim()
    const value = trimmed.slice(eqIndex + 1).trim()
    process.env[key] = value
  }

  cli.success(`Loaded ${envFileName}`)

  // Return restore function
  return async () => {
    const { unlinkSync } = await import('node:fs')
    if (envBackup) {
      copyFileSync(envBackup, `${cwd}/.env`)
      unlinkSync(envBackup)
      cli.info('Restored .env')
    }
    if (envLocalBackup) {
      copyFileSync(envLocalBackup, `${cwd}/.env.local`)
      unlinkSync(envLocalBackup)
      cli.info('Restored .env.local')
    }
  }
}

/**
 * Reconcile DNS A records for the sites served by a compute box (Hetzner or
 * AWS server mode) so `everything.example.com → <box IP>` is created/updated as
 * part of `cloud deploy` — no manual dashboard step.
 *
 * Opt-in: runs only when `infrastructure.dns.provider` is set. The S3/CloudFront
 * site path already handles bucket-backed sites (and skips `deploy:'server'`
 * sites), so this covers the complementary case — server-app and server-static
 * sites shipped to the box. UPSERT-only; never deletes other records, so it is
 * safe on a shared, multi-tenant zone.
 */
async function reconcileServerDns(
  config: any,
  appPublicIp: string | undefined,
  dnsProviderName: string | undefined,
): Promise<void> {
  if (!dnsProviderName)
    return // opt-in — no DNS provider configured, nothing to do

  // Bucket sites (S3/CloudFront) are handled by deployStaticSitesWithExternalDns.
  // Redirect-only sites still terminate on this box and therefore need DNS.
  const domains = collectServerDnsDomains(config.sites || {})
  if (domains.size === 0)
    return
  if (!appPublicIp) {
    cli.warn('DNS: no app server IP resolved — skipping A-record reconciliation.')
    return
  }

  let dnsConfig
  try {
    dnsConfig = resolveDnsProviderConfig(dnsProviderName)
  }
  catch (error) {
    cli.warn(`DNS: ${error instanceof Error ? error.message : String(error)}`)
    cli.info(`Point each site domain at ${appPublicIp} manually.`)
    return
  }
  if (!dnsConfig) {
    cli.warn(`DNS provider '${dnsProviderName}' is not configured — skipping A-record reconciliation.`)
    cli.info(`Point each site domain at ${appPublicIp} manually.`)
    return
  }
  // Let the zone id from cloud.config.ts stand in for AWS_HOSTED_ZONE_ID.
  if (dnsConfig.provider === 'route53') {
    const configHostedZoneId = config.infrastructure?.dns?.hostedZoneId
    if (configHostedZoneId && !dnsConfig.hostedZoneId)
      dnsConfig.hostedZoneId = configHostedZoneId
  }

  const dnsProvider = createDnsProvider(dnsConfig)
  const configuredZone = config.infrastructure?.dns?.domain as string | undefined
  cli.step(`Reconciling DNS: ${domains.size} A record(s) → ${appPublicIp} via ${dnsProviderName}...`)
  for (const domain of domains) {
    // The zone is the registrable apex (config `dns.domain` wins; otherwise the
    // last two labels — good enough for `sub.example.com`).
    const zone = configuredZone && domain.endsWith(configuredZone)
      ? configuredZone
      : domain.split('.').slice(-2).join('.')
    try {
      const res = await dnsProvider.upsertRecord(zone, { name: domain, type: 'A', content: appPublicIp, ttl: 300 })
      if (res.success)
        cli.success(`  ✓ ${domain} A → ${appPublicIp}`)
      else
        cli.warn(`  ⚠ ${domain}: ${res.message} — set the A record manually.`)

      if (res.success) {
        const cleanupWarnings = await removeStaleServerAddressRecords(dnsProvider, zone, domain, appPublicIp)
        for (const warning of cleanupWarnings)
          cli.warn(`  ⚠ ${domain}: ${warning}`)
        if (cleanupWarnings.length === 0)
          cli.info(`  ✓ ${domain}: stale duplicate A records reconciled`)
      }
    }
    catch (error) {
      cli.warn(`  ⚠ ${domain}: ${error instanceof Error ? error.message : String(error)} — set the A record manually.`)
    }
  }
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
  environment?: string,
  autoConfirm = false,
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

  // Merge config-level DNS settings (e.g., hostedZoneId from cloud.config.ts)
  // so users don't have to set AWS_HOSTED_ZONE_ID just to point at an existing zone.
  if (dnsConfig.provider === 'route53') {
    const configHostedZoneId = config.infrastructure?.dns?.hostedZoneId
    if (configHostedZoneId && !dnsConfig.hostedZoneId) {
      dnsConfig.hostedZoneId = configHostedZoneId
    }
  }

  const dnsProvider = createDnsProvider(dnsConfig)

  for (const siteName of siteNames) {
    const siteConfig = sites[siteName]
    if (!siteConfig) {
      cli.error(`Site '${siteName}' not found in configuration`)
      continue
    }

    // Skip sites the user EXPLICITLY targeted at the server (deploy:'server') —
    // those are handled by the compute path (systemd app or static site shipped
    // to /var/www), not S3+CloudFront. Backward-compat: a legacy site with `start` and NO
    // explicit `deploy` still gets its static front here (unchanged behavior);
    // only an explicit deploy:'server' opts out of the bucket path.
    if (siteConfig.deploy === 'server') {
      cli.info(`Site '${siteName}' is deploy:'server' — handled by the compute path, skipping static (bucket) deploy.`)
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

    // Environment file is already loaded by the caller via loadEnvironmentFile()

    // Run build command if configured
    if (siteConfig.build) {
      cli.step(`Running build command: ${siteConfig.build}`)
      try {
        const { execSync } = await import('node:child_process')
        execSync(siteConfig.build, {
          stdio: 'inherit',
          cwd: process.cwd(),
        })
        cli.success('Build completed successfully')
      }
      catch (err: any) {
        cli.error(`Build failed: ${err.message}`)
        continue
      }
    }

    // Check if source directory exists
    if (!existsSync(siteConfig.root)) {
      cli.error(`Source directory not found: ${siteConfig.root}`)
      if (!siteConfig.build) {
        cli.info('Run your build command first (e.g., bun run generate) or add a "build" option to your site config')
      }
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
        }
else {
          const providerName = isNetlify ? 'Netlify' : isVercel ? 'Vercel' : 'another provider'

          cli.warn(`\nExisting CNAME record detected:`)
          cli.info(`  ${existingCname.name} -> ${existingCname.content}`)

          if (isNetlify || isVercel) {
            cli.info(`\nThis domain is currently pointing to ${providerName}.`)
            cli.info('Deploying will update this record to point to AWS CloudFront.')
          }

          const proceed = autoConfirm || await cli.confirm(`\nUpdate DNS record to point to AWS CloudFront?`, true)
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
          }
else {
            cli.warn(`Could not remove old record: ${deleteResult.message}`)
            cli.info('The deployment will attempt to update it instead.')
          }
        }
      }
    }

    // Handle install script: prepare a temp directory with the script as index.html
    let deploySourceDir = siteConfig.root
    let tempInstallDir: string | undefined
    const hasInstallScript = !!siteConfig.installScript

    if (hasInstallScript) {
      const { mkdtempSync, copyFileSync, readdirSync, statSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join, resolve } = await import('node:path')

      tempInstallDir = mkdtempSync(join(tmpdir(), 'cloud-install-'))
      const scriptPath = resolve(siteConfig.installScript!)

      // Copy the script as index.html (served at root for curl domain | bash)
      copyFileSync(scriptPath, join(tempInstallDir, 'index.html'))

      // Also keep the original filename for direct access
      const scriptName = scriptPath.split('/').pop()!
      if (scriptName !== 'index.html') {
        copyFileSync(scriptPath, join(tempInstallDir, scriptName))
      }

      // Copy any other files from root dir if it exists
      if (existsSync(siteConfig.root)) {
        const rootFiles = readdirSync(siteConfig.root)
        for (const file of rootFiles) {
          const src = join(siteConfig.root, file)
          if (statSync(src).isFile() && file !== 'index.html') {
            copyFileSync(src, join(tempInstallDir, file))
          }
        }
      }

      deploySourceDir = tempInstallDir
      cli.info(`Install script: ${siteConfig.installScript}`)
      cli.info(`Serving at: curl -fsSL https://${domain} | bash`)
    }

    // Deploy the static site
    cli.step('Deploying to AWS (S3 + CloudFront)...')

    const siteStackName = resolveSiteStackName(config, siteName, siteConfig, environment as 'production' | 'staging' | 'development')
    const siteResourceName = resolveSiteResourceName(config, siteName)

    cli.info(`Stack: ${siteStackName}`)

    const result = await deployStaticSiteWithExternalDnsFull({
      siteName: siteResourceName,
      stackName: siteStackName,
      domain,
      region,
      bucket: resolveSiteBucketName(config.project.slug, environment as 'production' | 'staging' | 'development', siteName, siteConfig.bucket),
      sourceDir: deploySourceDir,
      certificateArn: siteConfig.certificateArn,
      dnsProvider: dnsConfig,
      skipDnsVerification,
      passthroughUrls: hasInstallScript,
      dynamicApp: !!config.infrastructure?.compute?.cloudFrontOriginDomain,
      computeOriginDomain: config.infrastructure?.compute?.cloudFrontOriginDomain,
      computeOriginPort: config.infrastructure?.compute?.cloudFrontOriginPort
        ?? (config.infrastructure as { api?: { port?: number } })?.api?.port
        ?? 3008,
      computeOriginId: config.infrastructure?.compute?.cloudFrontOriginId ?? `${config.project.slug}-site-ec2`,
      onProgress: (stage, detail) => {
        if (stage === 'infrastructure') {
          cli.step(detail || 'Setting up infrastructure...')
        }
else if (stage === 'upload') {
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
        }
else if (stage === 'invalidate') {
          cli.step('Invalidating CDN cache...')
        }
else if (stage === 'complete') {
          // Handled below
        }
      },
    })

    // Clean up temp install script directory
    if (tempInstallDir) {
      const { rmSync } = await import('node:fs')
      rmSync(tempInstallDir, { recursive: true, force: true })
    }

    if (result.success) {
      cli.success('\nDeployment successful!')
      const filesInfo = (result as any).filesSkipped > 0
        ? `${result.filesUploaded} uploaded, ${(result as any).filesSkipped} unchanged`
        : `${result.filesUploaded}`

      const installInfo = hasInstallScript
        ? `\nInstall: curl -fsSL https://${result.domain} | bash`
        : ''

      cli.box(`Site Deployed!

Domain: https://${result.domain}
CloudFront: ${result.distributionDomain}
Bucket: ${result.bucket}
Files: ${filesInfo}${installInfo}

Your site is now live at https://${result.domain}`, 'green')
    }
else {
      cli.error(`\nDeployment failed: ${result.message}`)
    }
  }
}
