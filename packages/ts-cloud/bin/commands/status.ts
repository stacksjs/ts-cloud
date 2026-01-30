import type { CLI } from '@stacksjs/clapp'
import type { Distribution } from '../../src/aws/cloudfront'
import type { CertificateDetail } from '../../src/aws/acm'
import * as cli from '../../src/utils/cli'
import { loadValidatedConfig } from './shared'

export function registerStatusCommands(app: CLI): void {
  app
    .command('status', 'Show overall infrastructure health dashboard')
    .option('--region <region>', 'AWS region')
    .action(async (options: { region?: string }) => {
      cli.header('Infrastructure Status Dashboard')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'

        cli.info(`Region: ${region}`)
        cli.info(`Project: ${config.project.name || 'Unknown'}`)
        cli.info('')

        const checks: { name: string; status: string; details: string }[] = []

        // Check EC2 Instances
        const ec2Spinner = new cli.Spinner('Checking EC2 instances...')
        ec2Spinner.start()
        try {
          const { EC2Client } = await import('../../src/aws/ec2')
          const ec2 = new EC2Client(region)
          const instances = await ec2.describeInstances({
            Filters: [{ Name: 'instance-state-name', Values: ['running', 'pending', 'stopping', 'stopped'] }],
          })

          let running = 0
          let stopped = 0
          let total = 0

          for (const reservation of instances.Reservations || []) {
            for (const instance of reservation.Instances || []) {
              total++
              if (instance.State?.Name === 'running') running++
              else if (instance.State?.Name === 'stopped') stopped++
            }
          }

          ec2Spinner.succeed('EC2 instances checked')
          checks.push({
            name: 'EC2 Instances',
            status: running > 0 ? 'OK' : (total > 0 ? 'WARN' : 'INFO'),
            details: `${running} running, ${stopped} stopped, ${total} total`,
          })
        }
        catch (error: any) {
          ec2Spinner.fail('EC2 check failed')
          checks.push({ name: 'EC2 Instances', status: 'ERROR', details: error.message })
        }

        // Check RDS Instances
        const rdsSpinner = new cli.Spinner('Checking RDS instances...')
        rdsSpinner.start()
        try {
          const { RDSClient } = await import('../../src/aws/rds')
          const rds = new RDSClient(region)
          const result = await rds.describeDBInstances()
          const instances = result.DBInstances || []

          const available = instances.filter(i => i.DBInstanceStatus === 'available').length

          rdsSpinner.succeed('RDS instances checked')
          checks.push({
            name: 'RDS Databases',
            status: instances.length > 0 && available === instances.length ? 'OK' : (instances.length > 0 ? 'WARN' : 'INFO'),
            details: `${available} available, ${instances.length} total`,
          })
        }
        catch (error: any) {
          rdsSpinner.fail('RDS check failed')
          checks.push({ name: 'RDS Databases', status: 'ERROR', details: error.message })
        }

        // Check Lambda Functions
        const lambdaSpinner = new cli.Spinner('Checking Lambda functions...')
        lambdaSpinner.start()
        try {
          const { LambdaClient } = await import('../../src/aws/lambda')
          const lambda = new LambdaClient(region)
          const result = await lambda.listFunctions()
          const functions = result.Functions || []

          lambdaSpinner.succeed('Lambda functions checked')
          checks.push({
            name: 'Lambda Functions',
            status: 'OK',
            details: `${functions.length} function(s)`,
          })
        }
        catch (error: any) {
          lambdaSpinner.fail('Lambda check failed')
          checks.push({ name: 'Lambda Functions', status: 'ERROR', details: error.message })
        }

        // Check S3 Buckets
        const s3Spinner = new cli.Spinner('Checking S3 buckets...')
        s3Spinner.start()
        try {
          const { S3Client } = await import('../../src/aws/s3')
          const s3 = new S3Client(region)
          const result = await s3.listBuckets()
          const buckets = result.Buckets || []

          s3Spinner.succeed('S3 buckets checked')
          checks.push({
            name: 'S3 Buckets',
            status: 'OK',
            details: `${buckets.length} bucket(s)`,
          })
        }
        catch (error: any) {
          s3Spinner.fail('S3 check failed')
          checks.push({ name: 'S3 Buckets', status: 'ERROR', details: error.message })
        }

        // Check CloudFront Distributions
        const cfSpinner = new cli.Spinner('Checking CloudFront distributions...')
        cfSpinner.start()
        try {
          const { CloudFrontClient } = await import('../../src/aws/cloudfront')
          const cloudfront = new CloudFrontClient()
          const distributions = await cloudfront.listDistributions()

          const deployed = distributions.filter((d: Distribution) => d.Status === 'Deployed').length

          cfSpinner.succeed('CloudFront checked')
          checks.push({
            name: 'CloudFront',
            status: distributions.length > 0 && deployed === distributions.length ? 'OK' : (distributions.length > 0 ? 'WARN' : 'INFO'),
            details: `${deployed} deployed, ${distributions.length} total`,
          })
        }
        catch (error: any) {
          cfSpinner.fail('CloudFront check failed')
          checks.push({ name: 'CloudFront', status: 'ERROR', details: error.message })
        }

        // Check SQS Queues
        const sqsSpinner = new cli.Spinner('Checking SQS queues...')
        sqsSpinner.start()
        try {
          const { SQSClient } = await import('../../src/aws/sqs')
          const sqs = new SQSClient(region)
          const result = await sqs.listQueues()
          const queues = result.QueueUrls || []

          sqsSpinner.succeed('SQS queues checked')
          checks.push({
            name: 'SQS Queues',
            status: 'OK',
            details: `${queues.length} queue(s)`,
          })
        }
        catch (error: any) {
          sqsSpinner.fail('SQS check failed')
          checks.push({ name: 'SQS Queues', status: 'ERROR', details: error.message })
        }

        // Check CloudFormation Stacks
        const cfnSpinner = new cli.Spinner('Checking CloudFormation stacks...')
        cfnSpinner.start()
        try {
          const { CloudFormationClient } = await import('../../src/aws/cloudformation')
          const cfn = new CloudFormationClient(region)
          const result = await cfn.listStacks([
            'CREATE_COMPLETE',
            'UPDATE_COMPLETE',
            'CREATE_IN_PROGRESS',
            'UPDATE_IN_PROGRESS',
            'ROLLBACK_COMPLETE',
            'UPDATE_ROLLBACK_COMPLETE',
          ])
          const stacks = result.StackSummaries || []

          const healthy = stacks.filter(s =>
            s.StackStatus === 'CREATE_COMPLETE' || s.StackStatus === 'UPDATE_COMPLETE',
          ).length

          const inProgress = stacks.filter(s =>
            s.StackStatus?.includes('IN_PROGRESS'),
          ).length

          const failed = stacks.filter(s =>
            s.StackStatus?.includes('ROLLBACK'),
          ).length

          cfnSpinner.succeed('CloudFormation checked')
          checks.push({
            name: 'CloudFormation',
            status: failed > 0 ? 'WARN' : (inProgress > 0 ? 'INFO' : 'OK'),
            details: `${healthy} healthy, ${inProgress} in progress, ${failed} rolled back`,
          })
        }
        catch (error: any) {
          cfnSpinner.fail('CloudFormation check failed')
          checks.push({ name: 'CloudFormation', status: 'ERROR', details: error.message })
        }

        // Check ACM Certificates
        const acmSpinner = new cli.Spinner('Checking SSL certificates...')
        acmSpinner.start()
        try {
          const { ACMClient } = await import('../../src/aws/acm')
          const acm = new ACMClient('us-east-1')
          const result = await acm.listCertificates()
          const certSummaries = result.CertificateSummaryList || []

          // Get full details for each certificate to access Status and NotAfter
          const certs: CertificateDetail[] = await Promise.all(
            certSummaries.map(c => acm.describeCertificate({ CertificateArn: c.CertificateArn })),
          )

          const issued = certs.filter(c => c.Status === 'ISSUED').length
          const pending = certs.filter(c => c.Status === 'PENDING_VALIDATION').length
          const expiringSoon = certs.filter((c) => {
            if (c.NotAfter) {
              const daysUntilExpiry = (new Date(c.NotAfter).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
              return daysUntilExpiry < 30
            }
            return false
          }).length

          acmSpinner.succeed('SSL certificates checked')
          checks.push({
            name: 'SSL Certificates',
            status: expiringSoon > 0 ? 'WARN' : (pending > 0 ? 'INFO' : 'OK'),
            details: `${issued} issued, ${pending} pending${expiringSoon > 0 ? `, ${expiringSoon} expiring soon` : ''}`,
          })
        }
        catch (error: any) {
          acmSpinner.fail('ACM check failed')
          checks.push({ name: 'SSL Certificates', status: 'ERROR', details: error.message })
        }

        // Display summary
        cli.info('\n' + '='.repeat(60))
        cli.info('HEALTH SUMMARY')
        cli.info('='.repeat(60) + '\n')

        for (const check of checks) {
          let icon = ''
          if (check.status === 'OK') {
            icon = `${cli.colors.green}[OK]${cli.colors.reset}`
          }
          else if (check.status === 'WARN') {
            icon = `${cli.colors.yellow}[WARN]${cli.colors.reset}`
          }
          else if (check.status === 'ERROR') {
            icon = `${cli.colors.red}[ERROR]${cli.colors.reset}`
          }
          else {
            icon = `${cli.colors.blue}[INFO]${cli.colors.reset}`
          }

          console.log(`${icon} ${check.name.padEnd(20)} ${check.details}`)
        }

        // Overall status
        const hasErrors = checks.some(c => c.status === 'ERROR')
        const hasWarnings = checks.some(c => c.status === 'WARN')

        cli.info('')
        if (hasErrors) {
          cli.error('Some services have errors. Check the details above.')
        }
        else if (hasWarnings) {
          cli.warn('Some services need attention. Check the warnings above.')
        }
        else {
          cli.success('All services are healthy!')
        }
      }
      catch (error: any) {
        cli.error(`Failed to get status: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('status:costs', 'Show current month cost summary')
    .option('--region <region>', 'AWS region')
    .action(async (options: { region?: string }) => {
      cli.header('Cost Summary')

      try {
        cli.info('Fetching cost data from AWS Cost Explorer...')
        cli.info('')

        // Get current month dates
        const now = new Date()
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0)

        cli.info(`Period: ${startOfMonth.toISOString().split('T')[0]} to ${endOfMonth.toISOString().split('T')[0]}`)
        cli.info('')

        // Note: Cost Explorer API requires special permissions
        cli.info('Note: Cost data requires AWS Cost Explorer API access.')
        cli.info('Run `cloud cost` for detailed cost analysis.')
      }
      catch (error: any) {
        cli.error(`Failed to get cost summary: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('status:alarms', 'Show CloudWatch alarm status')
    .option('--region <region>', 'AWS region')
    .action(async (options: { region?: string }) => {
      cli.header('CloudWatch Alarms')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'

        const { AWSClient } = await import('../../src/aws/client')

        class CloudWatchClient {
          private client: InstanceType<typeof AWSClient>
          private region: string

          constructor(region: string) {
            this.region = region
            this.client = new AWSClient()
          }

          async describeAlarms() {
            return this.client.request({
              service: 'monitoring',
              region: this.region,
              method: 'POST',
              path: '/',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: 'Action=DescribeAlarms&Version=2010-08-01',
            })
          }
        }

        const cloudwatch = new CloudWatchClient(region)

        const spinner = new cli.Spinner('Fetching alarms...')
        spinner.start()

        const result = await cloudwatch.describeAlarms()
        const alarms = result.MetricAlarms || []

        spinner.succeed(`Found ${alarms.length} alarm(s)`)

        if (alarms.length === 0) {
          cli.info('No CloudWatch alarms configured')
          return
        }

        const alarming = alarms.filter((a: any) => a.StateValue === 'ALARM')
        const ok = alarms.filter((a: any) => a.StateValue === 'OK')
        const insufficient = alarms.filter((a: any) => a.StateValue === 'INSUFFICIENT_DATA')

        cli.info('')
        cli.info(`Alarming: ${alarming.length}`)
        cli.info(`OK: ${ok.length}`)
        cli.info(`Insufficient Data: ${insufficient.length}`)

        if (alarming.length > 0) {
          cli.info('\nAlarms in ALARM state:')
          for (const alarm of alarming) {
            cli.error(`  - ${alarm.AlarmName}: ${alarm.AlarmDescription || 'No description'}`)
          }
        }
      }
      catch (error: any) {
        cli.error(`Failed to get alarms: ${error.message}`)
        process.exit(1)
      }
    })
}
