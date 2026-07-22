import type { CLI } from '@stacksjs/clapp'
import type { EnvironmentType } from '@ts-cloud/core'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolveServerlessAppStackName } from '@ts-cloud/core'
import { CloudFormationClient } from '../../src/aws/cloudformation'
import { LambdaClient } from '../../src/aws/lambda'
import { assertEnvWithinLimit, resolveServerlessFunctions } from '../../src/deploy/serverless-app'
import { initializeDashboardControlPlane } from '../../src/deploy/dashboard-control-plane'
import { PreviewEnvironmentService } from '../../src/preview'
import * as cli from '../../src/utils/cli'
import { loadValidatedConfig } from './shared'

/** Commands that would need multi-stack orchestration we haven't built — fail
 * honestly instead of printing fabricated success. */
function notImplemented(name: string, guidance: string): void {
  cli.error(`'${name}' is not implemented yet.`)
  cli.info(guidance)
  process.exitCode = 1
}

/** Parse a dotenv-style file into key/value pairs (ignores comments/blank lines). */
function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\'')))
      val = val.slice(1, -1)
    out[key] = val
  }
  return out
}

/** Serialize key/value pairs to dotenv text, quoting values that need it. */
function toDotenv(vars: Record<string, string>): string {
  const lines = Object.entries(vars)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => {
      if (!/[\s#"']/.test(v)) return `${k}=${v}`
      const quoted = '"' + v.replace(/"/g, '\\"') + '"'
      return `${k}=${quoted}`
    })
  return lines.join('\n') + '\n'
}

export function registerEnvironmentCommands(app: CLI): void {
  app
    .command('env:list', 'List configured environments and their deployed stack status')
    .action(async () => {
      cli.header('Environments')
      try {
        const config = await loadValidatedConfig()
        const envs = Object.keys(config.environments ?? {})
        if (!envs.length) {
          cli.info('No environments configured. Add environments.<env> to your cloud.config.')
          return
        }
        const rows: string[][] = []
        for (const env of envs) {
          const envCfg = (config.environments as any)[env]
          const region = envCfg?.region || config.project.region || 'us-east-1'
          const kind = envCfg?.app ? `serverless (${envCfg.app.kind})` : 'server/static'
          let status = 'not deployed'
          if (envCfg?.app) {
            try {
              const cf = new CloudFormationClient(region)
              const { Stacks } = await cf.describeStacks({ stackName: resolveServerlessAppStackName(config, env as EnvironmentType) })
              status = Stacks?.[0]?.StackStatus ?? 'not deployed'
            }
            catch { status = 'not deployed' }
          }
          rows.push([env, envCfg?.type ?? env, kind, region, status])
        }
        cli.table(['Environment', 'Type', 'Kind', 'Region', 'Stack status'], rows)
      }
      catch (error: any) {
        cli.error(`Failed to list environments: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('env:compare <env1> <env2>', 'Compare two environments\' app configuration')
    .action(async (env1: string, env2: string) => {
      cli.header(`Comparing ${env1} ↔ ${env2}`)
      try {
        const config = await loadValidatedConfig()
        const a = (config.environments as any)?.[env1]
        const b = (config.environments as any)?.[env2]
        if (!a || !b) {
          cli.error(`Both environments must exist in config (have: ${Object.keys(config.environments ?? {}).join(', ') || 'none'}).`)
          process.exitCode = 1
          return
        }
        const flatten = (o: any, prefix = ''): Record<string, string> => {
          const out: Record<string, string> = {}
          for (const [k, v] of Object.entries(o ?? {})) {
            const key = prefix ? `${prefix}.${k}` : k
            if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key))
            else out[key] = Array.isArray(v) ? JSON.stringify(v) : String(v)
          }
          return out
        }
        const fa = flatten(a)
        const fb = flatten(b)
        const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort()
        const rows = keys
          .filter(k => fa[k] !== fb[k])
          .map(k => [k, fa[k] ?? '—', fb[k] ?? '—'])
        if (!rows.length) {
          cli.success('Identical — no configuration differences.')
          return
        }
        cli.table(['Setting', env1, env2], rows)
        cli.info(`\n${rows.length} difference(s)`)
      }
      catch (error: any) {
        cli.error(`Comparison failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('env:pull', 'Download a serverless function\'s environment to a .env file')
    .option('--env <environment>', 'Environment (production, staging, development)', { default: 'production' })
    .option('--function <which>', 'Which function: http | queue | cli', { default: 'http' })
    .option('--file <path>', 'Output file (default .env.<environment>)')
    .action(async (options?: { env?: string, function?: string, file?: string }) => {
      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as EnvironmentType
        const { region, functions } = resolveServerlessFunctions(config, environment)
        const which = (options?.function ?? 'http') as 'http' | 'queue' | 'cli'
        const lambda = new LambdaClient(region)
        const fn = await lambda.getFunction(functions[which])
        const vars = (fn.Configuration?.Environment?.Variables ?? {}) as Record<string, string>
        const file = options?.file ?? `.env.${environment}`
        writeFileSync(file, toDotenv(vars))
        cli.success(`Wrote ${Object.keys(vars).length} variable(s) from ${functions[which]} → ${file}`)
      }
      catch (error: any) {
        cli.error(`env:pull failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('env:push', 'Upload a .env file to a serverless function\'s configuration')
    .option('--env <environment>', 'Environment (production, staging, development)', { default: 'production' })
    .option('--function <which>', 'Function: http | queue | cli | all', { default: 'all' })
    .option('--file <path>', 'Input file (default .env.<environment>)')
    .option('--replace', 'Replace the entire env instead of merging over the live config')
    .action(async (options?: { env?: string, function?: string, file?: string, replace?: boolean }) => {
      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as EnvironmentType
        const { region, functions } = resolveServerlessFunctions(config, environment)
        const file = options?.file ?? `.env.${environment}`
        if (!existsSync(file)) {
          cli.error(`File not found: ${file}`)
          process.exitCode = 1
          return
        }
        const fileVars = parseDotenv(readFileSync(file, 'utf8'))
        const which = (options?.function ?? 'all').toLowerCase()
        if (which !== 'all' && !['http', 'queue', 'cli'].includes(which)) {
          cli.error('--function must be one of: http, queue, cli, all')
          process.exitCode = 1
          return
        }
        const targets = which === 'all' ? (['http', 'queue', 'cli'] as const) : ([which] as Array<'http' | 'queue' | 'cli'>)
        // Under provisioned concurrency, traffic runs a frozen published version,
        // so an env change on $LATEST must be published + the `live` alias flipped
        // to take effect.
        const usesPc = ((config.environments as any)?.[environment]?.app?.provisionedConcurrency ?? 0) > 0
        const lambda = new LambdaClient(region)
        for (const mode of targets) {
          const name = functions[mode]
          // Merge over the live env by default so deploy-injected infra/secret
          // vars (ASSET_URL, DB_*, REDIS_HOST, …) aren't dropped. --replace opts out.
          let next = fileVars
          if (!options?.replace) {
            const fn = await lambda.getFunction(name)
            next = { ...(fn.Configuration?.Environment?.Variables ?? {}), ...fileVars }
          }
          assertEnvWithinLimit(name, next)
          await lambda.updateFunctionConfiguration({ FunctionName: name, Environment: { Variables: next } })
          await lambda.waitForFunctionActive(name, 120)
          if (usesPc) {
            const published = await lambda.publishVersion({ FunctionName: name })
            if (published.Version)
              await lambda.updateAlias({ FunctionName: name, Name: 'live', FunctionVersion: published.Version })
          }
          cli.success(`Pushed ${Object.keys(fileVars).length} var(s) → ${name}${options?.replace ? ' (replaced)' : ' (merged)'}${usesPc ? ' (published + flipped live alias)' : ''}`)
        }
        cli.info('Note: a subsequent `cloud deploy:serverless` re-injects infra/secret env from config.')
      }
      catch (error: any) {
        cli.error(`env:push failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  // The following require multi-stack orchestration that isn't built yet. They
  // fail clearly rather than faking success (was: setTimeout + fabricated data).
  app
    .command('env:create <name>', 'Create new environment')
    .action(async (name: string) => {
      notImplemented(`env:create ${name}`, 'Add an `environments.<name>` block to your cloud.config and run `cloud deploy:serverless --env <name>`.')
    })

  app
    .command('env:switch <name>', 'Switch active environment')
    .action(async (name: string) => {
      notImplemented(`env:switch ${name}`, 'ts-cloud has no persistent "active" environment — pass --env <name> to each command.')
    })

  for (const verb of ['clone', 'promote', 'sync'] as const) {
    app
      .command(`env:${verb} <source> <target>`, `(${verb}) environment configuration`)
      .action(async (source: string, target: string) => {
        notImplemented(`env:${verb} ${source} ${target}`, `Copy the \`environments.${source}\` block to \`environments.${target}\` in cloud.config, then \`cloud deploy:serverless --env ${target}\`.`)
      })
  }

  app
    .command('env:preview <branch>', 'Create, inspect, rebuild, extend, or destroy an immutable preview')
    .option('--sha <commit>', 'Exact 40-64 character source commit')
    .option('--pr <number>', 'Pull request number')
    .option('--site <name>', 'Application site (defaults to the first site)')
    .option('--env <environment>', 'Base environment', { default: 'production' })
    .option('--domain <pattern>', 'HTTPS URL pattern containing {name}')
    .option('--ttl <hours>', 'Preview lifetime in hours')
    .option('--destroy', 'Queue teardown for this preview')
    .option('--rebuild', 'Rebuild the currently recorded commit')
    .option('--extend <hours>', 'Extend expiry from now/current expiry')
    .option('--get-url', 'Print the stable preview URL without mutation')
    .option('--yes', 'Skip destructive confirmation')
    .action(async (branch: string, options: { sha?: string, pr?: string, site?: string, env?: string, domain?: string, ttl?: string, destroy?: boolean, rebuild?: boolean, extend?: string, getUrl?: boolean, yes?: boolean }) => {
      let controlPlane: ReturnType<typeof initializeDashboardControlPlane> | undefined
      try {
        const config = await loadValidatedConfig(); const base = options.env || 'production'; const site = options.site || Object.keys(config.sites ?? {})[0]
        if (!site) throw new Error('No application site is configured; pass --site after adding one')
        controlPlane = initializeDashboardControlPlane(process.cwd(), config)
        const environment = controlPlane.environments.get(base); const resource = environment ? controlPlane.store.listResources(controlPlane.project.id, environment.id).find(item => item.kind === 'application' && item.slug === site) : undefined
        if (!environment || !resource) throw new Error(`Application ${site} was not found in base environment ${base}`)
        const service = new PreviewEnvironmentService(controlPlane.store)
        let policy = service.previews.getDefinitionForResource(resource.id)
        if (!policy) {
          const siteDomain = (config.sites as Record<string, { domain?: string }> | undefined)?.[site]?.domain
          const domainPattern = options.domain || (siteDomain ? `https://{name}.preview.${siteDomain}` : undefined)
          if (!domainPattern) throw new Error('Pass --domain with an HTTPS pattern containing {name} to configure previews')
          policy = service.previews.createDefinition({ projectId: controlPlane.project.id, resourceId: resource.id, baseEnvironmentId: environment.id, domainPattern, ttlHours: Number(options.ttl) || undefined })
        }
        const pr = Number(options.pr) || undefined
        const preview = pr ? service.previews.findForPullRequest(policy.id, 'local', pr) : service.previews.findForBranch(policy.id, 'local', branch)
        if (options.getUrl) { if (!preview) throw new Error('Preview was not found'); cli.info(preview.url ?? 'URL unavailable'); return }
        if (options.extend) { if (!preview) throw new Error('Preview was not found'); const extended = service.previews.extend(preview.id, Number(options.extend)); cli.success(`Extended ${extended.name} until ${extended.expiresAt}`); return }
        if (options.destroy) {
          if (!preview) throw new Error('Preview was not found')
          if (!options.yes && !(await cli.confirm(`Destroy ${preview.name} and only its tagged resources?`, false))) return
          const operation = service.enqueueDestroy(preview, 'manual'); cli.success(`Preview teardown queued: ${operation.id}`); return
        }
        if (options.rebuild) { if (!preview) throw new Error('Preview was not found'); const operation = service.enqueueDeploy(preview, { reason: 'manual_rebuild' }); cli.success(`Preview rebuild queued: ${operation.id}`); return }
        if (!options.sha) throw new Error('Pass --sha with the exact immutable commit to deploy')
        const persisted = service.previews.upsert({ definitionId: policy.id, repository: 'local', branch, pullRequestNumber: pr, commitSha: options.sha })
        const operation = service.enqueueDeploy(persisted.preview, { created: persisted.created })
        cli.success(`${persisted.created ? 'Preview creation' : 'Preview update'} queued: ${operation.id}`)
        cli.info(`${persisted.preview.url} · expires ${persisted.preview.expiresAt}`)
      }
      catch (error) { cli.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
      finally { controlPlane?.store.close() }
    })

  app
    .command('env:cleanup', 'Remove stale preview environments')
    .option('--dry-run', 'List cleanup candidates without queuing teardown')
    .option('--max-age <hours>', 'Also remove previews older than this age')
    .option('--keep <count>', 'Keep this many newest previews per application')
    .action(async (options: { dryRun?: boolean, maxAge?: string, keep?: string }) => {
      let controlPlane: ReturnType<typeof initializeDashboardControlPlane> | undefined
      try {
        const config = await loadValidatedConfig(); controlPlane = initializeDashboardControlPlane(process.cwd(), config); const service = new PreviewEnvironmentService(controlPlane.store)
        const result = service.cleanup({ dryRun: options.dryRun, maxAgeHours: Number(options.maxAge) || undefined, keepCount: Number(options.keep) || undefined })
        cli.table(['Preview', 'Status', 'Expires', 'Reason'], result.candidates.map(item => [item.preview.name, item.preview.status, item.preview.expiresAt, item.reasons.join(', ')]))
        cli.success(options.dryRun ? `${result.candidates.length} cleanup candidate(s)` : `${result.operations.length} teardown job(s) queued`)
      }
      catch (error) { cli.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
      finally { controlPlane?.store.close() }
    })

  app.command('env:previews', 'List persistent preview environments').option('--site <name>', 'Filter application site').action(async (options: { site?: string }) => {
    let controlPlane: ReturnType<typeof initializeDashboardControlPlane> | undefined
    try { const config = await loadValidatedConfig(); controlPlane = initializeDashboardControlPlane(process.cwd(), config); const service = new PreviewEnvironmentService(controlPlane.store); const resourceIds = options.site ? new Set(controlPlane.store.listResources(controlPlane.project.id).filter(item => item.slug === options.site).map(item => item.id)) : undefined; const values = service.previews.listInstances({ projectId: controlPlane.project.id }).filter(item => !resourceIds || resourceIds.has(item.resourceId)); cli.table(['ID', 'Name', 'Status', 'Branch / PR', 'Commit', 'URL', 'Expires', 'Cost'], values.map(item => [item.id, item.name, item.status, item.pullRequestNumber ? `PR #${item.pullRequestNumber}` : item.branch, item.commitSha.slice(0, 12), item.url ?? '—', item.expiresAt, item.costEstimate == null ? '—' : `$${item.costEstimate.toFixed(2)}`])) }
    catch (error) { cli.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
    finally { controlPlane?.store.close() }
  })
}
