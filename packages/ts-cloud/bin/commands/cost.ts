import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import { CostExplorerClient } from '../../src/aws/cost-explorer'
import { cacheLocation, clearCache } from '../../src/aws/cost-explorer-cache'
import { S3Client } from '../../src/aws/s3'
import { compareServiceCosts, egressUsageCosts, monthToDateRange, percentChange, projectedMonthlyCost, rollingComparisonRange } from '../../src/cost/reporting'
import { ResourceInventoryClient } from '../../src/cost/resource-inventory'

const S3_SERVICE_NAME = 'Amazon Simple Storage Service'

function lastFullMonthRange(): { start: string; end: string; label: string } {
  const now = new Date()
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const start = new Date(end)
  start.setUTCMonth(start.getUTCMonth() - 1)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const label = start.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  return { start: iso(start), end: iso(end), label }
}

function formatUSD(amount: number): string {
  return `$${amount.toFixed(2)}`
}

function formatTrend(change: number | null): string {
  if (change === null) return 'new'
  if (Math.abs(change) < 0.05) return '→ 0.0%'
  return `${change > 0 ? '↑' : '↓'} ${Math.abs(change).toFixed(1)}%`
}

function costError(error: unknown): void {
  cli.error(`Cost Explorer request failed: ${error instanceof Error ? error.message : String(error)}`)
  cli.info('\nThis command needs the ce:GetCostAndUsage IAM permission.')
}

function renderMarkdownReport(params: {
  label: string
  profile: string | undefined
  rows: string[][]
  total: number
  count: number
}): string {
  const { label, profile, rows, total, count } = params
  const header = `# AWS Cost Analysis — ${label}`
  const meta = profile ? `\n_Profile: \`${profile}\`_\n` : '\n'
  const tableHeader = `| Service | Resources | Cost | % of Total |\n|---|---|---|---|`
  const tableBody = rows.map(([s, r, c, p]) => `| ${s} | ${r} | ${c} | ${p} |`).join('\n')
  const totalLine = `\n**Total: ${formatUSD(total)} across ${count} service${count === 1 ? '' : 's'}**`
  return `${header}\n${meta}\n${tableHeader}\n${tableBody}\n${totalLine}\n`
}

export function registerCostCommands(app: CLI): void {
  app
    .command('cost:analyze', 'Rank AWS services by cost for the last full month')
    .option('--output', 'Also write a markdown report to ./aws.md')
    .option('--no-cache', 'Skip the local response cache (always hit AWS — costs $0.01)')
    .action(async (options?: { profile?: string; output?: boolean; cache?: boolean }) => {
      const profile = options?.profile
      // clapp turns --no-cache into `cache: false`; default to true.
      const useCache = options?.cache !== false
      const { start, end, label } = lastFullMonthRange()
      cli.header(`Cost Analysis — ${label}${profile ? ` (profile: ${profile})` : ''}`)

      const spinner = new cli.Spinner('Querying AWS Cost Explorer...')
      spinner.start()

      const ceClient = new CostExplorerClient(profile, { useCache })
      let services: Awaited<ReturnType<CostExplorerClient['getCostByService']>>
      try {
        services = await ceClient.getCostByService({ start, end })
      } catch (err: any) {
        spinner.stop()
        cli.error(`Cost Explorer request failed: ${err?.message ?? err}`)
        cli.info('\nThis command needs the ce:GetCostAndUsage IAM permission.')
        return
      }

      // Track s3:ListAllMyBuckets outcome separately so we can distinguish
      // "0 buckets visible to this identity" from "couldn't enumerate at all".
      let s3Buckets: number | null = null
      let s3ListBlocked = false
      if (services.some((s) => s.service === S3_SERVICE_NAME)) {
        try {
          const result = await new S3Client('us-east-1', profile).listBuckets()
          s3Buckets = result.Buckets?.length ?? 0
        } catch {
          s3ListBlocked = true
        }
      }

      spinner.stop()

      if (services.length === 0) {
        cli.info('No billed services in this period.')
        return
      }

      const total = services.reduce((sum, s) => sum + s.amount, 0)
      const rows = services.map((s) => {
        let resources = '-'
        if (s.service === S3_SERVICE_NAME) {
          if (s3ListBlocked) resources = 'unknown (no s3:ListAllMyBuckets)'
          else if (s3Buckets !== null) resources = `${s3Buckets} bucket${s3Buckets === 1 ? '' : 's'}`
        }
        const pct = total > 0 ? `${((s.amount / total) * 100).toFixed(1)}%` : '—'
        return [s.service, resources, formatUSD(s.amount), pct]
      })

      cli.table(['Service', 'Resources', 'Cost', '% of Total'], rows)
      cli.info(`\nTotal: ${formatUSD(total)} across ${services.length} service${services.length === 1 ? '' : 's'}`)

      if (ceClient.lastCacheAgeSeconds !== null) {
        cli.info(`(cached, ${ceClient.lastCacheAgeSeconds}s old — pass --no-cache to refresh)`)
      }

      // Sanity hint: non-trivial S3 spend with 0 visible buckets usually means
      // the calling identity is in the org's payer/management account — billing
      // rolls up but the workload buckets live in a member account.
      const s3Cost = services.find((s) => s.service === S3_SERVICE_NAME)?.amount ?? 0
      if (s3Cost > 1 && s3Buckets === 0) {
        cli.warn(
          '\nS3 has spend but listBuckets returned 0. The buckets are likely owned by a different account in your AWS Organization (consolidated billing rolls up to the payer account, but ListBuckets only shows buckets owned by the calling account).',
        )
      }

      if (options?.output) {
        const path = `${process.cwd()}/aws.md`
        await Bun.write(path, renderMarkdownReport({ label, profile, rows, total, count: services.length }))
        cli.success(`\nWrote ${path}`)
      }
    })

  app
    .command('cost:cache:clear', 'Wipe the local Cost Explorer response cache')
    .option('--all', 'Wipe entries for every profile (default: just the current profile)')
    .action(async (options?: { profile?: string; all?: boolean }) => {
      const scope = options?.all ? undefined : options?.profile
      const before = cacheLocation(scope)
      const result = clearCache(scope)
      cli.info(
        `Cleared ${result.deletedFiles} cached response${result.deletedFiles === 1 ? '' : 's'} for ${result.scope}`,
      )
      cli.info(`(${before})`)
    })

  app
    .command('cost', 'Show current month-to-date AWS spend and projected total')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .option('--no-cache', 'Skip the local response cache')
    .action(async (options?: { profile?: string; cache?: boolean }) => {
      const range = monthToDateRange()
      const client = new CostExplorerClient(options?.profile, { useCache: options?.cache !== false })
      cli.header(`AWS Cost — ${range.label}${options?.profile ? ` (profile: ${options.profile})` : ''}`)
      const spinner = new cli.Spinner('Querying month-to-date AWS spend...')
      spinner.start()
      try {
        const [current, previous] = await Promise.all([
          client.getCostByService({ start: range.start, end: range.end, granularity: 'DAILY' }),
          client.getCostByService({
            start: range.previous.start,
            end: range.previous.end,
            granularity: 'MONTHLY',
          }),
        ])
        spinner.stop()
        const compared = compareServiceCosts(current, previous)
        const rows = compared.map((cost) => {
          const projected = projectedMonthlyCost(cost.amount, range.daysElapsed, range.daysInMonth)
          return [
            cost.service,
            formatUSD(cost.amount),
            formatUSD(projected),
            formatUSD(cost.previousAmount),
            formatTrend(percentChange(projected, cost.previousAmount)),
          ]
        })
        cli.table(['Service', 'MTD', 'Projected', range.previous.label, 'Change'], rows)
        const total = current.reduce((sum, cost) => sum + cost.amount, 0)
        const previousTotal = previous.reduce((sum, cost) => sum + cost.amount, 0)
        const projected = projectedMonthlyCost(total, range.daysElapsed, range.daysInMonth)
        cli.info(`\nMTD: ${formatUSD(total)} through day ${range.daysElapsed} of ${range.daysInMonth}`)
        cli.info(
          `Projected: ${formatUSD(projected)} (${formatTrend(percentChange(projected, previousTotal))} vs ${range.previous.label})`,
        )
      } catch (error) {
        spinner.stop()
        costError(error)
      }
    })

  app
    .command('cost:breakdown', 'Cost breakdown by service')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .option('--days <days>', 'Number of days to analyze', { default: '30' })
    .option('--no-cache', 'Skip the local response cache')
    .action(async (options?: { profile?: string; days?: string; cache?: boolean }) => {
      const days = Number.parseInt(options?.days ?? '30', 10)
      let ranges: ReturnType<typeof rollingComparisonRange>
      try {
        ranges = rollingComparisonRange(days)
      } catch (error) {
        cli.error(error instanceof Error ? error.message : String(error))
        return
      }
      const client = new CostExplorerClient(options?.profile, { useCache: options?.cache !== false })
      cli.header(
        `AWS Cost Breakdown — ${ranges.current.label}${options?.profile ? ` (profile: ${options.profile})` : ''}`,
      )
      const spinner = new cli.Spinner('Comparing AWS service spend...')
      spinner.start()
      try {
        const [current, previous] = await Promise.all([
          client.getCostByService({ start: ranges.current.start, end: ranges.current.end, granularity: 'DAILY' }),
          client.getCostByService({ start: ranges.previous.start, end: ranges.previous.end, granularity: 'DAILY' }),
        ])
        spinner.stop()
        const compared = compareServiceCosts(current, previous)
        cli.table(
          ['Service', `Last ${days}d`, `Previous ${days}d`, 'Trend'],
          compared.map((cost) => [
            cost.service,
            formatUSD(cost.amount),
            formatUSD(cost.previousAmount),
            formatTrend(cost.changePercent),
          ]),
        )
        const total = current.reduce((sum, cost) => sum + cost.amount, 0)
        const previousTotal = previous.reduce((sum, cost) => sum + cost.amount, 0)
        cli.info(`\nTotal: ${formatUSD(total)} (${formatTrend(percentChange(total, previousTotal))})`)
      } catch (error) {
        spinner.stop()
        costError(error)
      }
    })

  app
    .command('cost:egress', 'Rank AWS data-transfer usage types by cost')
    .option('--days <days>', 'Number of days to analyze', { default: '30' })
    .option('--no-cache', 'Skip the local response cache')
    .action(async (options?: { profile?: string; days?: string; cache?: boolean }) => {
      const days = Number.parseInt(options?.days ?? '30', 10)
      let range: ReturnType<typeof rollingComparisonRange>['current']
      try {
        range = rollingComparisonRange(days).current
      } catch (error) {
        cli.error(error instanceof Error ? error.message : String(error))
        return
      }
      const client = new CostExplorerClient(options?.profile, { useCache: options?.cache !== false })
      cli.header(`AWS Egress Cost — ${range.label}${options?.profile ? ` (profile: ${options.profile})` : ''}`)
      const spinner = new cli.Spinner('Querying data-transfer usage types...')
      spinner.start()
      try {
        const costs = egressUsageCosts(
          await client.getCostByDimension({
            start: range.start,
            end: range.end,
            dimension: 'USAGE_TYPE',
            granularity: 'DAILY',
          }),
        )
        spinner.stop()
        if (costs.length === 0) {
          cli.info('No billed data-transfer usage types were found in this period.')
          return
        }
        cli.table(
          ['Usage type', 'Cost'],
          costs.map((cost) => [cost.key, formatUSD(cost.amount)]),
        )
        cli.info(`\nTotal ranked egress: ${formatUSD(costs.reduce((sum, cost) => sum + cost.amount, 0))}`)
        cli.info(
          'Usage types classify NAT, internet, inter-AZ, and inter-region transfer; destination correlation requires VPC Flow Logs.',
        )
      } catch (error) {
        spinner.stop()
        costError(error)
      }
    })

  app
    .command('resources', 'List all resources')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .option('--type <type>', 'Resource type (ec2, rds, s3, lambda, etc.)')
    .option('--region <region>', 'AWS region for regional resources')
    .action(async (options?: { profile?: string; type?: string; region?: string }) => {
      cli.header(`AWS Resources${options?.profile ? ` (profile: ${options.profile})` : ''}`)
      const spinner = new cli.Spinner('Discovering tagged and untagged resources...')
      spinner.start()
      const inventory = new ResourceInventoryClient(options?.profile, options?.region)
      try {
        const result = await inventory.discover({ type: options?.type })
        spinner.stop()
        if (result.resources.length === 0) cli.info('No matching resources were discovered.')
        else {
          cli.table(
            ['Type', 'Name', 'Region', 'State', 'Monthly cost'],
            result.resources.map((resource) => [
              `${resource.service}:${resource.type}`,
              resource.name,
              resource.region ?? 'global',
              resource.state ?? 'unknown',
              '— (requires CUR resource IDs)',
            ]),
          )
          cli.info(`\n${result.resources.length} resource${result.resources.length === 1 ? '' : 's'} discovered.`)
        }
        for (const warning of result.warnings) cli.warn(warning)
      } catch (error) {
        spinner.stop()
        cli.error(`Resource discovery failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

  app
    .command('resources:unused', 'Find unused resources')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .action(() => {
      cli.warn('`resources:unused` is not yet implemented against real AWS data.')
      cli.info('Tracking: https://github.com/stacksjs/ts-cloud/issues/111')
    })

  app
    .command('optimize', 'Suggest cost optimizations')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .action(() => {
      cli.warn('`optimize` is not yet implemented against real AWS data.')
      cli.info('Tracking: https://github.com/stacksjs/ts-cloud/issues/112')
    })
}
