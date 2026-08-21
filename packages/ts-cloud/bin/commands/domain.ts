import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import { ACMClient } from '../../src/aws/acm'
import { UnifiedDnsValidator } from '../../src/dns'
import { CloudflareProvider } from '../../src/dns/cloudflare'
import { GoDaddyProvider } from '../../src/dns/godaddy'
import { PorkbunProvider } from '../../src/dns/porkbun'
import {
  applyZoneMigration,
  exportRoute53Zone,
  planZoneMigration,
  verifyZoneParity,
} from '../../src/dns/zone-migration'
import { Route53Client } from '../../src/aws/route53'
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
        const domainRows = domains.map((d) => [
          d,
          'Active',
          '-',
          providerName.charAt(0).toUpperCase() + providerName.slice(1),
        ])

        cli.table(['Domain', 'Status', 'SSL', 'Provider'], domainRows)
      } catch (error) {
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
        } else {
          spinner.warn(`Domain ${domain} is not available in ${providerName}`)
          cli.info('\nTo add this domain:')
          if (providerName === 'route53') {
            cli.info('  - Create a hosted zone in Route53 for this domain')
            cli.info('  - Update nameservers at your registrar to point to Route53')
          } else {
            cli.info(`  - Ensure the domain is registered with ${providerName}`)
            cli.info('  - Enable API access for the domain in your provider dashboard')
          }
        }
      } catch (error) {
        cli.error(`Failed to check domain: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

  app
    .command('domain:ssl <domain>', 'Generate SSL certificate via ACM with DNS validation')
    .option('--provider <provider>', 'DNS provider for validation: porkbun, godaddy, or route53')
    .option('--region <region>', 'AWS region for ACM (default: us-east-1 for CloudFront compatibility)')
    .option('--wait', 'Wait for certificate validation to complete')
    .action(async (domain: string, options?: { provider?: string; region?: string; wait?: boolean }) => {
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
        } else {
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
        } else if (result.status === 'pending') {
          cli.info('\nDNS validation records have been created.')
          cli.info('Certificate validation may take a few more minutes.')
          cli.info(`\nCheck status with: cloud domain:verify ${domain}`)
        } else {
          cli.error('\nCertificate validation failed. Check ACM console for details.')
        }
      } catch (error) {
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
            (c) => c.DomainName === domain || c.DomainName === `*.${domain}`,
          )
          if (domainCert) {
            certArn = domainCert.CertificateArn || ''
            const details = await acm.describeCertificate({ CertificateArn: certArn })
            sslStatus = details.Status || 'Unknown'
          }
        } catch {
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
      } catch (error) {
        cli.error(`Failed to verify domain: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

  app
    .command('dns:migrate <domain>', 'Migrate a whole zone from Route53 to Cloudflare')
    .option('--account <id>', 'Cloudflare account id (defaults to CLOUDFLARE_ACCOUNT_ID)')
    .option('--hosted-zone <id>', 'Route53 hosted zone id (auto-discovered when omitted)')
    .option('--region <region>', 'AWS region for Route53', { default: 'us-east-1' })
    .option('--apply', 'Write the records. Without it this is a dry run.')
    .action(
      async (
        domain: string,
        options?: { account?: string, hostedZone?: string, region?: string, apply?: boolean },
      ) => {
        cli.header(`Zone migration: ${domain} (Route53 → Cloudflare)`)

        const apiToken = process.env.CLOUDFLARE_API_TOKEN
        if (!apiToken) {
          cli.error('CLOUDFLARE_API_TOKEN is not set.')
          return
        }

        try {
          // 1. Export the source zone, in full.
          const route53 = new Route53Client(options?.region || 'us-east-1')
          let hostedZoneId = options?.hostedZone
          if (!hostedZoneId) {
            const zone = await route53.findHostedZoneForDomain(domain)
            if (!zone) {
              cli.error(`No Route53 hosted zone found for ${domain}`)
              return
            }
            hostedZoneId = zone.Id.replace('/hostedzone/', '')
          }

          const spinner = new cli.Spinner(`Exporting ${domain} from Route53...`)
          spinner.start()
          const sets = await exportRoute53Zone(route53, hostedZoneId)
          spinner.succeed(`Exported ${sets.length} record set(s) from ${hostedZoneId}`)

          // 2. Translate.
          const plan = planZoneMigration(sets, domain)
          cli.info(`Planned ${plan.records.length} record(s), skipped ${plan.skipped.length}`)
          for (const skip of plan.skipped) cli.info(`  - ${skip.type} ${skip.name}: ${skip.reason}`)
          for (const warning of plan.warnings) cli.warn(`  ⚠ ${warning}`)
          for (const record of plan.records.filter(r => r.translatedFrom))
            cli.info(`  ~ ${record.name} ${record.translatedFrom} → CNAME ${record.content}`)

          if (!options?.apply) {
            cli.info('')
            cli.info('Dry run — nothing was written. Re-run with --apply to migrate.')
            return
          }

          // 3. Create the destination zone (idempotent) and import.
          const provider = new CloudflareProvider(apiToken, { accountId: options?.account })
          const zone = await provider.createZone(domain, { accountId: options?.account })
          cli.success(
            zone.created
              ? `Created Cloudflare zone ${zone.name} (${zone.id})`
              : `Using existing Cloudflare zone ${zone.name} (${zone.id})`,
          )

          const importSpinner = new cli.Spinner(`Importing ${plan.records.length} record(s)...`)
          importSpinner.start()
          const report = await applyZoneMigration(provider, plan)
          importSpinner.succeed(`Imported ${report.applied.length} record(s)`)
          for (const failure of report.failed)
            cli.error(`  ✗ ${failure.record.type} ${failure.record.name}: ${failure.message}`)

          // 4. Read the zone back and diff. This is what decides whether the
          //    nameservers are safe to move, so it always runs.
          const parity = await verifyZoneParity(provider, plan)
          if (parity.ok) {
            cli.success(`Parity check passed — all ${parity.matched.length} record(s) present at Cloudflare`)
          } else {
            cli.error(`Parity check FAILED — ${parity.missing.length} record(s) missing or different:`)
            for (const gap of parity.missing)
              cli.error(`  ✗ ${gap.record.type} ${gap.record.name} → ${gap.record.content}${gap.found ? ` (found: ${gap.found})` : ''}`)
            cli.warn('Do NOT move the nameservers until this is clean.')
            return
          }

          cli.info('')
          cli.info('Nameservers to set at the registrar:')
          for (const ns of zone.nameServers) cli.info(`  ${ns}`)
          cli.info('')
          cli.info(`  cloud dns:nameservers ${domain} --set ${zone.nameServers.join(',')}`)
        } catch (error) {
          cli.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    )

  app
    .command('dns:nameservers <domain>', 'Show or set the nameservers a domain is delegated to')
    .option('--registrar <name>', 'Registrar: godaddy or porkbun')
    .option('--set <nameservers>', 'Comma-separated nameservers to delegate to')
    .action(async (domain: string, options?: { registrar?: string, set?: string }) => {
      cli.header(`Nameservers for ${domain}`)

      const registrar = (options?.registrar || detectRegistrarFromEnv())?.toLowerCase()
      if (!registrar) {
        cli.error('No registrar credentials found. Set GODADDY_API_KEY/GODADDY_API_SECRET or PORKBUN_API_KEY/PORKBUN_SECRET_KEY.')
        return
      }

      const client = registrar === 'porkbun'
        ? new PorkbunProvider(process.env.PORKBUN_API_KEY!, process.env.PORKBUN_SECRET_KEY!)
        : new GoDaddyProvider(process.env.GODADDY_API_KEY!, process.env.GODADDY_API_SECRET!)

      try {
        const current = await client.getNameServers(domain)
        cli.info(`Current (${registrar}):`)
        for (const ns of current) cli.info(`  ${ns}`)

        if (!options?.set) return

        const wanted = options.set.split(',').map(n => n.trim()).filter(Boolean)
        if (wanted.length < 2) {
          cli.error('At least two nameservers are required.')
          return
        }

        cli.warn('')
        cli.warn('Changing nameservers moves authority for the ENTIRE zone — every')
        cli.warn('record on it, including mail. Make sure the destination zone is')
        cli.warn('already populated and parity-checked (cloud dns:migrate).')

        const ok = await client.updateNameServers(domain, wanted)
        if (ok) {
          cli.success(`Delegated ${domain} to:`)
          for (const ns of wanted) cli.success(`  ${ns}`)
          cli.info('Propagation typically takes minutes to a few hours.')
        } else {
          cli.error('The registrar rejected the nameserver update.')
        }
      } catch (error) {
        cli.error(`Failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

  app
    .command('dns:records <domain>', 'List DNS records for a domain')
    .option('--provider <provider>', 'DNS provider: porkbun, godaddy, cloudflare, or route53')
    .option('--type <type>', 'Filter by record type (A, AAAA, CNAME, TXT, MX, etc.)')
    .action(async (domain: string, options?: { provider?: string; type?: string }) => {
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
          records = records.filter((r) => r.type.toUpperCase() === filterType)
          cli.info(`Filtered to ${records.length} ${filterType} record(s)`)
        }

        if (records.length === 0) {
          cli.info('No records found')
          return
        }

        // Format records for table display
        const recordRows = records.map((r) => [
          r.type,
          r.name || '@',
          r.content.length > 50 ? `${r.content.substring(0, 47)}...` : r.content,
          String(r.ttl || 300),
        ])

        cli.table(['Type', 'Name', 'Value', 'TTL'], recordRows)
      } catch (error) {
        cli.error(`Failed to list records: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

  app
    .command('dns:add <domain> <type> <value>', 'Add DNS record')
    .option('--provider <provider>', 'DNS provider: porkbun, godaddy, cloudflare, or route53')
    .option('--name <name>', 'Record name (subdomain)', { default: '@' })
    .option('--ttl <seconds>', 'Time to live in seconds', { default: '300' })
    .action(
      async (
        domain: string,
        type: string,
        value: string,
        options?: { provider?: string; name?: string; ttl?: string },
      ) => {
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

          const result = await provider.createRecord(domain, {
            type: recordType,
            name: name === '@' ? '' : name,
            content: value,
            ttl,
          })

          if (!result.success) {
            spinner.fail('Failed to add DNS record')
            cli.error(result.message || 'DNS provider rejected the record')
            return
          }

          spinner.succeed('DNS record added successfully')

          cli.success('\nRecord created!')
          cli.info('\nNote: DNS changes may take a few minutes to propagate')
        } catch (error) {
          cli.error(`Failed to add record: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    )

  app
    .command('dns:delete <domain> <type>', 'Delete DNS record')
    .option('--provider <provider>', 'DNS provider: porkbun, godaddy, cloudflare, or route53')
    .option('--name <name>', 'Record name (subdomain)', { default: '@' })
    .option('--value <value>', 'Record value (required for multi-value records)')
    .action(async (domain: string, type: string, options?: { provider?: string; name?: string; value?: string }) => {
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
        const matchingRecords = allRecords.filter(
          (r) => r.type.toUpperCase() === recordType && (r.name === name || (r.name === '' && name === '@')),
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
          ? matchingRecords.find((r) => r.content === options.value) || matchingRecords[0]
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
      } catch (error) {
        cli.error(`Failed to delete record: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
}

/** Pick a registrar from whichever credentials are present in the environment. */
function detectRegistrarFromEnv(): 'godaddy' | 'porkbun' | null {
  if (process.env.GODADDY_API_KEY && process.env.GODADDY_API_SECRET) return 'godaddy'
  if (process.env.PORKBUN_API_KEY && process.env.PORKBUN_SECRET_KEY) return 'porkbun'
  return null
}
