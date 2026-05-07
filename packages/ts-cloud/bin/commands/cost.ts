import type { CLI } from '@stacksjs/clapp'
import { CostExplorerClient } from '../../src/aws/cost-explorer'
import { cacheLocation, clearCache } from '../../src/aws/cost-explorer-cache'
import { S3Client } from '../../src/aws/s3'
import * as cli from '../../src/utils/cli'

const S3_SERVICE_NAME = 'Amazon Simple Storage Service'

function lastFullMonthRange(): { start: string, end: string, label: string } {
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
    .action(async (options?: { profile?: string, output?: boolean, cache?: boolean }) => {
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
      }
      catch (err: any) {
        spinner.stop()
        cli.error(`Cost Explorer request failed: ${err?.message ?? err}`)
        cli.info('\nThis command needs the ce:GetCostAndUsage IAM permission.')
        return
      }

      // Track s3:ListAllMyBuckets outcome separately so we can distinguish
      // "0 buckets visible to this identity" from "couldn't enumerate at all".
      let s3Buckets: number | null = null
      let s3ListBlocked = false
      if (services.some(s => s.service === S3_SERVICE_NAME)) {
        try {
          const result = await new S3Client('us-east-1', profile).listBuckets()
          s3Buckets = result.Buckets?.length ?? 0
        }
        catch {
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
      const s3Cost = services.find(s => s.service === S3_SERVICE_NAME)?.amount ?? 0
      if (s3Cost > 1 && s3Buckets === 0) {
        cli.warn('\nS3 has spend but listBuckets returned 0. The buckets are likely owned by a different account in your AWS Organization (consolidated billing rolls up to the payer account, but ListBuckets only shows buckets owned by the calling account).')
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
    .action(async (options?: { profile?: string, all?: boolean }) => {
      const scope = options?.all ? undefined : options?.profile
      const before = cacheLocation(scope)
      const result = clearCache(scope)
      cli.info(`Cleared ${result.deletedFiles} cached response${result.deletedFiles === 1 ? '' : 's'} for ${result.scope}`)
      cli.info(`(${before})`)
    })

  // The five commands below are stubs — they used to return hardcoded
  // mock data, which is dangerous next to a real `cost:analyze`. Until
  // each is implemented against real AWS APIs (tracked issues below),
  // they refuse to run with a clear pointer rather than print fake
  // numbers users could act on.
  app
    .command('cost', 'Show estimated monthly cost')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .action(() => {
      cli.warn('`cost` is not yet implemented against real AWS data. Use `cost:analyze` for real numbers.')
      cli.info('Tracking: https://github.com/stacksjs/ts-cloud/issues/108')
    })

  app
    .command('cost:breakdown', 'Cost breakdown by service')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .option('--days <days>', 'Number of days to analyze', { default: '30' })
    .action(() => {
      cli.warn('`cost:breakdown` is not yet implemented against real AWS data. Use `cost:analyze` for the latest full month.')
      cli.info('Tracking: https://github.com/stacksjs/ts-cloud/issues/109')
    })

  app
    .command('resources', 'List all resources')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .option('--type <type>', 'Resource type (ec2, rds, s3, lambda, etc.)')
    .action(() => {
      cli.warn('`resources` is not yet implemented against real AWS data.')
      cli.info('Tracking: https://github.com/stacksjs/ts-cloud/issues/110')
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
