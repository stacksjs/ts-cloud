import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import { ACMClient } from '../../src/aws/acm'

export function registerSslCommands(app: CLI): void {
  app
    .command('ssl:list', 'List all SSL certificates')
    .option('--region <region>', 'AWS region (default: us-east-1)')
    .action(async (options?: { region?: string }) => {
      cli.header('SSL Certificates')

      const region = options?.region || 'us-east-1'
      const spinner = new cli.Spinner('Fetching certificates from ACM...')
      spinner.start()

      try {
        const acm = new ACMClient(region)

        // List all certificates
        const result = await acm.listCertificates()

        if (result.CertificateSummaryList.length === 0) {
          spinner.succeed('No certificates found')
          cli.info(`\nNo SSL certificates found in region ${region}`)
          cli.info('Use \'cloud domain:ssl <domain>\' to request a new certificate')
          return
        }

        // Get details for each certificate
        const certDetails = await Promise.all(
          result.CertificateSummaryList.map(async (cert) => {
            const details = await acm.describeCertificate({ CertificateArn: cert.CertificateArn })
            return details
          }),
        )

        spinner.succeed(`Found ${certDetails.length} certificate(s)`)

        // Helper to format AWS timestamp (seconds since epoch)
        const formatDate = (timestamp: string | number | undefined): string => {
          if (!timestamp) return 'N/A'
          // AWS returns seconds since epoch, JS Date expects milliseconds
          const ts = typeof timestamp === 'string' ? Number.parseFloat(timestamp) : timestamp
          const ms = ts < 1e12 ? ts * 1000 : ts // Convert if seconds
          return new Date(ms).toISOString().split('T')[0]
        }

        // Format the table data
        const tableData = certDetails.map((cert) => {
          const expiry = formatDate(cert.NotAfter)
          const typeDisplay = cert.Type === 'AMAZON_ISSUED' ? 'Amazon Issued' : cert.Type || 'Unknown'
          const inUse = cert.Status === 'ISSUED' ? 'Available' : cert.Status || 'Unknown'

          return [
            cert.DomainName,
            cert.Status || 'Unknown',
            expiry,
            typeDisplay,
            inUse,
          ]
        })

        cli.table(
          ['Domain', 'Status', 'Expiry', 'Type', 'State'],
          tableData,
        )

        cli.info('\nACM certificates are automatically renewed by AWS')
        cli.info(`Region: ${region}`)
      }
      catch (error: any) {
        spinner.fail('Failed to fetch certificates')
        cli.error(error.message)
      }
    })

  app
    .command('ssl:renew <domain>', 'Renew SSL certificate')
    .option('--region <region>', 'AWS region (default: us-east-1)')
    .action(async (domain: string, options?: { region?: string }) => {
      cli.header(`Checking SSL Certificate for ${domain}`)

      const region = options?.region || 'us-east-1'
      cli.info(`Domain: ${domain}`)
      cli.info(`Region: ${region}`)

      const spinner = new cli.Spinner('Checking certificate status...')
      spinner.start()

      try {
        const acm = new ACMClient(region)

        // Find certificate by domain
        const cert = await acm.findCertificateByDomain(domain)

        if (!cert) {
          spinner.fail('Certificate not found')
          cli.error(`No certificate found for domain: ${domain}`)
          cli.info('Use \'cloud domain:ssl <domain>\' to request a new certificate')
          return
        }

        spinner.succeed('Certificate found')

        cli.info('\nCertificate is managed by AWS Certificate Manager')
        cli.info('ACM certificates are automatically renewed 60 days before expiry')
        cli.warn('\nNo manual renewal needed for ACM certificates')

        // Helper to format AWS timestamp (seconds since epoch)
        const formatDate = (timestamp: string | number | undefined): string => {
          if (!timestamp) return 'N/A'
          const ts = typeof timestamp === 'string' ? Number.parseFloat(timestamp) : timestamp
          const ms = ts < 1e12 ? ts * 1000 : ts
          return new Date(ms).toISOString().split('T')[0]
        }

        const expiry = formatDate(cert.NotAfter)
        const issued = formatDate(cert.IssuedAt)

        cli.info('\nCertificate details:')
        cli.info(`  - Domain: ${cert.DomainName}`)
        cli.info(`  - Status: ${cert.Status}`)
        cli.info(`  - Issued: ${issued}`)
        cli.info(`  - Expiry: ${expiry}`)
        cli.info(`  - Type: ${cert.Type || 'Unknown'}`)
        cli.info(`  - ARN: ${cert.CertificateArn}`)
        cli.info(`  - Auto-renewal: ${cert.Type === 'AMAZON_ISSUED' ? 'Enabled' : 'N/A (imported)'}`)

        if (cert.SubjectAlternativeNames && cert.SubjectAlternativeNames.length > 1) {
          cli.info(`  - SANs: ${cert.SubjectAlternativeNames.join(', ')}`)
        }
      }
      catch (error: any) {
        spinner.fail('Failed to check certificate')
        cli.error(error.message)
      }
    })
}
