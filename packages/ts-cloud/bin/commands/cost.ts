import type { CLI } from '@stacksjs/clapp'
import { CostExplorerClient } from '../../src/aws/cost-explorer'
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
    .action(async (options?: { profile?: string, output?: boolean }) => {
      const profile = options?.profile
      const { start, end, label } = lastFullMonthRange()
      cli.header(`Cost Analysis — ${label}${profile ? ` (profile: ${profile})` : ''}`)

      const spinner = new cli.Spinner('Querying AWS Cost Explorer...')
      spinner.start()

      let services: Awaited<ReturnType<CostExplorerClient['getCostByService']>>
      try {
        services = await new CostExplorerClient(profile).getCostByService({ start, end })
      }
      catch (err: any) {
        spinner.stop()
        cli.error(`Cost Explorer request failed: ${err?.message ?? err}`)
        cli.info('\nThis command needs the ce:GetCostAndUsage IAM permission.')
        return
      }

      let s3Buckets: number | null = null
      if (services.some(s => s.service === S3_SERVICE_NAME)) {
        try {
          const result = await new S3Client('us-east-1', profile).listBuckets()
          s3Buckets = result.Buckets?.length ?? 0
        }
        catch {
          // listBuckets needs s3:ListAllMyBuckets — silently fall back to '-'
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
        if (s.service === S3_SERVICE_NAME && s3Buckets !== null) {
          resources = `${s3Buckets} bucket${s3Buckets === 1 ? '' : 's'}`
        }
        const pct = total > 0 ? `${((s.amount / total) * 100).toFixed(1)}%` : '—'
        return [s.service, resources, formatUSD(s.amount), pct]
      })

      cli.table(['Service', 'Resources', 'Cost', '% of Total'], rows)
      cli.info(`\nTotal: ${formatUSD(total)} across ${services.length} service${services.length === 1 ? '' : 's'}`)

      if (options?.output) {
        const path = `${process.cwd()}/aws.md`
        await Bun.write(path, renderMarkdownReport({ label, profile, rows, total, count: services.length }))
        cli.success(`\nWrote ${path}`)
      }
    })


  app
    .command('cost', 'Show estimated monthly cost')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .action(async (options?: { env?: string }) => {
      const environment = options?.env || 'production'

      cli.header(`Cost Estimate - ${environment}`)

      const spinner = new cli.Spinner('Fetching cost data from AWS Cost Explorer...')
      spinner.start()

      // TODO: Fetch from AWS Cost Explorer API
      await new Promise(resolve => setTimeout(resolve, 2000))

      spinner.stop()

      cli.info('\nCurrent Month (Estimated):')
      cli.info(`  Total: $247.89`)
      cli.info(`  Projected: $325.00\n`)

      cli.table(
        ['Service', 'Current', 'Projected', 'Change'],
        [
          ['EC2', '$89.23', '$120.00', '+12%'],
          ['S3', '$12.45', '$15.00', '+8%'],
          ['CloudFront', '$45.67', '$60.00', '+15%'],
          ['RDS', '$67.89', '$90.00', '+10%'],
          ['Lambda', '$8.23', '$10.00', '+5%'],
          ['ElastiCache', '$24.42', '$30.00', '+12%'],
        ],
      )

      cli.info('\nTip: Use `cloud cost:breakdown` for detailed analysis')
      cli.info('Tip: Use `cloud optimize` for cost-saving recommendations')
    })

  app
    .command('cost:breakdown', 'Cost breakdown by service')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .option('--days <days>', 'Number of days to analyze', { default: '30' })
    .action(async (options?: { env?: string, days?: string }) => {
      const environment = options?.env || 'production'
      const days = options?.days || '30'

      cli.header(`Cost Breakdown - ${environment} (Last ${days} days)`)

      const spinner = new cli.Spinner('Analyzing cost data...')
      spinner.start()

      // TODO: Fetch from AWS Cost Explorer API
      await new Promise(resolve => setTimeout(resolve, 2000))

      spinner.stop()

      cli.info('\nTop Services by Cost:\n')

      cli.table(
        ['Service', 'Cost', '% of Total', 'Trend'],
        [
          ['EC2 Instances', '$89.23', '36%', '^ +12%'],
          ['RDS Databases', '$67.89', '27%', '^ +10%'],
          ['CloudFront', '$45.67', '18%', '^ +15%'],
          ['ElastiCache', '$24.42', '10%', '^ +12%'],
          ['S3 Storage', '$12.45', '5%', '^ +8%'],
          ['Lambda', '$8.23', '3%', '^ +5%'],
        ],
      )

      cli.info('\nCost Trends:')
      cli.info('  - Overall trend: +10.5% vs last month')
      cli.info('  - Highest growth: CloudFront (+15%)')
      cli.info('  - Most stable: Lambda (+5%)')

      cli.info('\nRecommendations:')
      cli.info('  - Consider Reserved Instances for EC2 (save up to 40%)')
      cli.info('  - Review CloudFront cache settings to reduce origin requests')
      cli.info('  - Use S3 Intelligent Tiering for automatic cost optimization')
    })

  app
    .command('resources', 'List all resources')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .option('--type <type>', 'Resource type (ec2, rds, s3, lambda, etc.)')
    .action(async (options?: { env?: string, type?: string }) => {
      const environment = options?.env || 'production'
      const type = options?.type

      cli.header(`Resources - ${environment}`)

      if (type) {
        cli.info(`Filtering by type: ${type}\n`)
      }

      const spinner = new cli.Spinner('Scanning resources...')
      spinner.start()

      // TODO: Fetch resources from AWS Resource Groups or CloudFormation
      await new Promise(resolve => setTimeout(resolve, 2000))

      spinner.stop()

      cli.info('\nResource Summary:\n')

      cli.table(
        ['Type', 'Count', 'Running', 'Stopped', 'Total Cost/mo'],
        [
          ['EC2 Instances', '5', '4', '1', '$89.23'],
          ['RDS Databases', '2', '2', '0', '$67.89'],
          ['S3 Buckets', '12', '-', '-', '$12.45'],
          ['Lambda Functions', '23', '-', '-', '$8.23'],
          ['CloudFront Distributions', '3', '-', '-', '$45.67'],
          ['ElastiCache Clusters', '1', '1', '0', '$24.42'],
        ],
      )

      cli.info('\nTip: Use `cloud resources:unused` to find resources you can delete')
      cli.info('Tip: Use --type to filter by specific resource type')
    })

  app
    .command('resources:unused', 'Find unused resources')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .action(async (options?: { env?: string }) => {
      const environment = options?.env || 'production'

      cli.header(`Unused Resources - ${environment}`)

      const spinner = new cli.Spinner('Scanning for unused resources...')
      spinner.start()

      // TODO: Analyze CloudWatch metrics, CloudFormation stacks, etc.
      await new Promise(resolve => setTimeout(resolve, 3000))

      spinner.stop()

      cli.info('\nPotentially Unused Resources:\n')

      cli.table(
        ['Resource', 'Type', 'Last Used', 'Monthly Cost', 'Recommendation'],
        [
          ['staging-server-old', 'EC2', '45 days ago', '$28.50', 'Terminate'],
          ['test-db-snapshot', 'RDS Snapshot', '90 days ago', '$5.20', 'Delete'],
          ['old-assets-bucket', 'S3', 'Never', '$2.30', 'Delete'],
          ['dev-redis', 'ElastiCache', '30 days ago', '$18.00', 'Review'],
          ['legacy-function', 'Lambda', '60 days ago', '$0.00', 'Delete'],
        ],
      )

      cli.info('\nPotential Monthly Savings: $54.00')

      cli.warn('\nPlease review before deleting any resources')
      cli.info('Tip: Create snapshots/backups before deleting databases or instances')
    })

  app
    .command('optimize', 'Suggest cost optimizations')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .action(async (options?: { env?: string }) => {
      const environment = options?.env || 'production'

      cli.header(`Cost Optimization Recommendations - ${environment}`)

      const spinner = new cli.Spinner('Analyzing infrastructure...')
      spinner.start()

      // TODO: Analyze resource usage, CloudWatch metrics, Cost Explorer data
      await new Promise(resolve => setTimeout(resolve, 3000))

      spinner.stop()

      cli.info('\nTop Recommendations:\n')

      cli.info('1. Use EC2 Reserved Instances')
      cli.info('   Current: On-Demand instances ($89/mo)')
      cli.info('   Potential: Reserved Instances ($54/mo)')
      cli.info('   Savings: $35/month (39%)')

      cli.info('\n2. Enable S3 Intelligent Tiering')
      cli.info('   Current: Standard storage ($12.45/mo)')
      cli.info('   Potential: Intelligent Tiering ($7.50/mo)')
      cli.info('   Savings: $4.95/month (40%)')

      cli.info('\n3. Right-size EC2 Instances')
      cli.info('   2 instances are under-utilized (<20% CPU)')
      cli.info('   Recommended: Downgrade from t3.medium to t3.small')
      cli.info('   Savings: $18/month (20%)')

      cli.info('\n4. Delete Unused Resources')
      cli.info('   Found 5 unused resources')
      cli.info('   Savings: $54/month')
      cli.info('   Run: `cloud resources:unused` for details')

      cli.info('\n5. Use CloudFront Compression')
      cli.info('   Enable automatic compression for text files')
      cli.info('   Savings: ~$8/month (18% reduction in data transfer)')

      cli.success('\nTotal Potential Savings: $119.95/month (37%)')

      cli.info('\nNext Steps:')
      cli.info('  - Run `cloud resources:unused` to review unused resources')
      cli.info('  - Run `cloud cost:breakdown` for detailed cost analysis')
      cli.info('  - Contact AWS support for Reserved Instance recommendations')
    })
}
