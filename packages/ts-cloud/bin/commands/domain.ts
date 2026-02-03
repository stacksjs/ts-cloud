import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import { ACMClient } from '../../src/aws/acm'
import { UnifiedDnsValidator } from '../../src/dns'
import { getDnsProvider, resolveDnsProviderConfig } from './shared'

export function registerDomainCommands(app: CLI): void {
  app
    .command('domain:list', 'List all domains')
    .option('--provider <provider>', 'DNS provider: porkbun, godaddy, cloudflare, or route53')
    .action(async (options?: { provider?: string }) => {
      cli.header('Domains')

      try {
        const provider = getDnsProvider(options?.provider)
        const providerName = resolveDnsProviderConfig(options?.provider)?.provider || 'unknown'

        const spinner = new cli.Spinner(`Fetching domains from ${providerName}...`)
        spinner.start()

        const domains = await provider.listDomains()
        spinner.succeed(`Found ${domains.length} domain(s)`)

        if (domains.length === 0) {
          cli.info('No domains found in this provider')
          return
        }

        // Format domains for table display
        const domainRows = domains.map(d => [
          d,
          'Active',
          '-',
          providerName.charAt(0).toUpperCase() + providerName.slice(1),
        ])

        cli.table(
          ['Domain', 'Status', 'SSL', 'Provider'],
          domainRows,
        )
      }
      catch (error) {
        cli.error(`Failed to list domains: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

  app
    .command('domain:add <domain>', 'Add a new domain')
    .option('--provider <provider>', 'DNS provider: porkbun, godaddy, cloudflare, or route53')
    .action(async (domain: string, options?: { provider?: string }) => {
      cli.header(`Adding Domain: ${domain}`)

      try {
        const provider = getDnsProvider(options?.provider)
        const providerName = resolveDnsProviderConfig(options?.provider)?.provider || 'unknown'

        // Check if provider can manage the domain
        const spinner = new cli.Spinner(`Checking if ${providerName} can manage ${domain}...`)
        spinner.start()

        const canManage = await provider.canManageDomain(domain)

        if (canManage) {
          spinner.succeed(`Domain ${domain} is already available in ${providerName}`)
          cli.info('\nThe domain is ready to use. You can now:')
          cli.info(`  - Add DNS records: cloud dns:add ${domain} A 192.168.1.1`)
          cli.info(`  - Generate SSL: cloud domain:ssl ${domain}`)
        }
        else {
          spinner.warn(`Domain ${domain} is not available in ${providerName}`)
          cli.info('\nTo add this domain:')
          if (providerName === 'route53') {
            cli.info('  - Create a hosted zone in Route53 for this domain')
            cli.info('  - Update nameservers at your registrar to point to Route53')
          }
          else {
            cli.info(`  - Ensure the domain is registered with ${providerName}`)
            cli.info('  - Enable API access for the domain in your provider dashboard')
          }
        }
      }
      catch (error) {
        cli.error(`Failed to check domain: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

  app
    .command('domain:ssl <domain>', 'Generate SSL certificate via ACM with DNS validation')
    .option('--provider <provider>', 'DNS provider for validation: porkbun, godaddy, or route53')
    .option('--region <region>', 'AWS region for ACM (default: us-east-1 for CloudFront compatibility)')
    .option('--wait', 'Wait for certificate validation to complete')
    .action(async (domain: string, options?: { provider?: string, region?: string, wait?: boolean }) => {
      cli.header(`Generating SSL Certificate for ${domain}`)

      try {
        const dnsConfig = resolveDnsProviderConfig(options?.provider)
        if (!dnsConfig) {
          throw new Error('No DNS provider configured')
        }

        const region = options?.region || 'us-east-1'
        const providerName = dnsConfig.provider

        cli.info(`DNS Provider: ${providerName}`)
        cli.info(`ACM Region: ${region}`)

        // Use UnifiedDnsValidator for complete certificate workflow
        const validator = new UnifiedDnsValidator(dnsConfig, region)
        const spinner = new cli.Spinner('Requesting certificate and creating validation records...')
        spinner.start()

        const result = await validator.findOrCreateCertificate({
          domainName: domain,
          subjectAlternativeNames: [`*.${domain}`],
          waitForValidation: options?.wait ?? true,
          maxWaitMinutes: 10,
        })

        if (result.isNew) {
          spinner.succeed('Certificate requested and validation records created')
        }
        else {
          spinner.succeed('Found existing valid certificate')
        }

        cli.info(`Certificate ARN: ${result.certificateArn}`)
        cli.info(`Status: ${result.status}`)

        if (result.status === 'issued') {
          cli.success('\nSSL Certificate is ready!')
          cli.info('\nYou can now use this certificate with:')
          cli.info('  - CloudFront distributions')
          cli.info('  - Application Load Balancers')
          cli.info('  - API Gateway custom domains')
        }
        else if (result.status === 'pending') {
          cli.info('\nDNS validation records have been created.')
          cli.info('Certificate validation may take a few more minutes.')
          cli.info(`\nCheck status with: cloud domain:verify ${domain}`)
        }
        else {
          cli.error('\nCertificate validation failed. Check ACM console for details.')
        }
      }
      catch (error) {
        cli.error(`Failed to generate SSL: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

  app
    .command('domain:verify <domain>', 'Verify domain ownership and SSL status')
    .option('--provider <provider>', 'DNS provider: porkbun, godaddy, cloudflare, or route53')
    .action(async (domain: string, options?: { provider?: string }) => {
      cli.header(`Verifying Domain: ${domain}`)

      try {
        const provider = getDnsProvider(options?.provider)
        const providerName = resolveDnsProviderConfig(options?.provider)?.provider || 'unknown'

        // Check domain ownership
        const spinner = new cli.Spinner('Checking domain ownership...')
        spinner.start()

        const canManage = await provider.canManageDomain(domain)

        if (!canManage) {
          spinner.fail('Domain not found in provider')
          cli.error(`Domain ${domain} is not available in ${providerName}`)
          return
        }

        spinner.succeed('Domain ownership verified')

        // Get DNS records
        spinner.text = 'Fetching DNS records...'
        spinner.start()

        const recordsResult = await provider.listRecords(domain)
        const records = recordsResult.records || []
        spinner.succeed(`Found ${records.length} DNS record(s)`)

        // Check for SSL certificate in ACM
        spinner.text = 'Checking SSL certificate status...'
        spinner.start()

        const acm = new ACMClient('us-east-1')
        let sslStatus = 'Not found'
        let certArn = ''

        try {
          const certsResult = await acm.listCertificates()
          const domainCert = certsResult.CertificateSummaryList.find(
            c => c.DomainName === domain || c.DomainName === `*.${domain}`,
          )
          if (domainCert) {
            certArn = domainCert.CertificateArn || ''
            const details = await acm.describeCertificate({ CertificateArn: certArn })
            sslStatus = details.Status || 'Unknown'
          }
        }
        catch {
          // ACM not accessible or no certs
        }

        spinner.succeed('SSL check complete')

        cli.info('\nVerification details:')
        cli.info(`  - Provider: ${providerName}`)
        cli.info(`  - DNS records found: ${records.length}`)
        cli.info(`  - Domain managed: Yes`)
        cli.info(`  - SSL certificate: ${sslStatus}`)
        if (certArn) {
          cli.info(`  - Certificate ARN: ${certArn}`)
        }

        // Show record summary by type
        const recordTypes = new Map<string, number>()
        for (const record of records) {
          const count = recordTypes.get(record.type) || 0
          recordTypes.set(record.type, count + 1)
        }

        if (recordTypes.size > 0) {
          cli.info('\nRecord summary:')
          for (const [type, count] of recordTypes) {
            cli.info(`  - ${type}: ${count}`)
          }
        }
      }
      catch (error) {
        cli.error(`Failed to verify domain: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

  app
    .command('dns:records <domain>', 'List DNS records for a domain')
    .option('--provider <provider>', 'DNS provider: porkbun, godaddy, cloudflare, or route53')
    .option('--type <type>', 'Filter by record type (A, AAAA, CNAME, TXT, MX, etc.)')
    .action(async (domain: string, options?: { provider?: string, type?: string }) => {
      cli.header(`DNS Records for ${domain}`)

      try {
        const provider = getDnsProvider(options?.provider)
        const providerName = resolveDnsProviderConfig(options?.provider)?.provider || 'unknown'

        const spinner = new cli.Spinner(`Fetching records from ${providerName}...`)
        spinner.start()

        const result = await provider.listRecords(domain)
        let records = result.records || []
        spinner.succeed(`Found ${records.length} record(s)`)

        // Filter by type if specified
        if (options?.type) {
          const filterType = options.type.toUpperCase()
          records = records.filter(r => r.type.toUpperCase() === filterType)
          cli.info(`Filtered to ${records.length} ${filterType} record(s)`)
        }

        if (records.length === 0) {
          cli.info('No records found')
          return
        }

        // Format records for table display
        const recordRows = records.map(r => [
          r.type,
          r.name || '@',
          r.content.length > 50 ? `${r.content.substring(0, 47)}...` : r.content,
          String(r.ttl || 300),
        ])

        cli.table(
          ['Type', 'Name', 'Value', 'TTL'],
          recordRows,
        )
      }
      catch (error) {
        cli.error(`Failed to list records: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

  app
    .command('dns:add <domain> <type> <value>', 'Add DNS record')
    .option('--provider <provider>', 'DNS provider: porkbun, godaddy, cloudflare, or route53')
    .option('--name <name>', 'Record name (subdomain)', { default: '@' })
    .option('--ttl <seconds>', 'Time to live in seconds', { default: '300' })
    .action(async (domain: string, type: string, value: string, options?: { provider?: string, name?: string, ttl?: string }) => {
      cli.header(`Adding DNS Record`)

      try {
        const provider = getDnsProvider(options?.provider)
        const providerName = resolveDnsProviderConfig(options?.provider)?.provider || 'unknown'

        const name = options?.name || '@'
        const ttl = Number.parseInt(options?.ttl || '300', 10)
        const recordType = type.toUpperCase() as 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'NS' | 'SRV' | 'CAA'

        cli.info(`Provider: ${providerName}`)
        cli.info(`Domain: ${domain}`)
        cli.info(`Type: ${recordType}`)
        cli.info(`Name: ${name}`)
        cli.info(`Value: ${value}`)
        cli.info(`TTL: ${ttl}`)

        const spinner = new cli.Spinner(`Adding record via ${providerName}...`)
        spinner.start()

        await provider.createRecord(domain, {
          type: recordType,
          name: name === '@' ? '' : name,
          content: value,
          ttl,
        })

        spinner.succeed('DNS record added successfully')

        cli.success('\nRecord created!')
        cli.info('\nNote: DNS changes may take a few minutes to propagate')
      }
      catch (error) {
        cli.error(`Failed to add record: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

  app
    .command('dns:delete <domain> <type>', 'Delete DNS record')
    .option('--provider <provider>', 'DNS provider: porkbun, godaddy, cloudflare, or route53')
    .option('--name <name>', 'Record name (subdomain)', { default: '@' })
    .option('--value <value>', 'Record value (required for multi-value records)')
    .action(async (domain: string, type: string, options?: { provider?: string, name?: string, value?: string }) => {
      cli.header(`Deleting DNS Record`)

      try {
        const provider = getDnsProvider(options?.provider)
        const providerName = resolveDnsProviderConfig(options?.provider)?.provider || 'unknown'

        const name = options?.name || '@'
        const recordType = type.toUpperCase()

        cli.info(`Provider: ${providerName}`)
        cli.info(`Domain: ${domain}`)
        cli.info(`Type: ${recordType}`)
        cli.info(`Name: ${name}`)

        // Get existing records to find the one to delete
        const spinner = new cli.Spinner('Finding record...')
        spinner.start()

        const result = await provider.listRecords(domain)
        const allRecords = result.records || []
        const matchingRecords = allRecords.filter(r =>
          r.type.toUpperCase() === recordType
          && (r.name === name || r.name === '' && name === '@'),
        )

        if (matchingRecords.length === 0) {
          spinner.fail('No matching record found')
          return
        }

        // If multiple records and no value specified, show them
        if (matchingRecords.length > 1 && !options?.value) {
          spinner.warn('Multiple records found')
          cli.info('\nPlease specify --value to identify which record to delete:')
          for (const r of matchingRecords) {
            cli.info(`  - ${r.content}`)
          }
          return
        }

        const recordToDelete = options?.value
          ? matchingRecords.find(r => r.content === options.value) || matchingRecords[0]
          : matchingRecords[0]

        cli.info(`Value: ${recordToDelete.content}`)

        // Confirm deletion
        const confirm = await cli.confirm('Delete this record?', false)
        if (!confirm) {
          cli.info('Deletion cancelled')
          return
        }

        spinner.text = `Deleting record via ${providerName}...`
        spinner.start()

        await provider.deleteRecord(domain, recordToDelete)

        spinner.succeed('DNS record deleted successfully')
        cli.success('\nRecord deleted!')
      }
      catch (error) {
        cli.error(`Failed to delete record: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
}
