import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import { SESClient } from '../../src/aws/ses'
import { loadValidatedConfig } from './shared'

export function registerEmailCommands(app: CLI): void {
  app
    .command('email:identities', 'List verified email identities')
    .option('--region <region>', 'AWS region')
    .action(async (options: { region?: string }) => {
      cli.header('Email Identities')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const ses = new SESClient(region)

        const spinner = new cli.Spinner('Fetching identities...')
        spinner.start()

        const result = await ses.listEmailIdentities()
        const identities = result.EmailIdentities || []

        spinner.succeed(`Found ${identities.length} identity(s)`)

        if (identities.length === 0) {
          cli.info('No email identities found')
          cli.info('Use `cloud email:verify` to verify an email or domain')
          return
        }

        // Get verification status for each identity
        const rows: string[][] = []
        for (const identity of identities) {
          const name = identity.IdentityName || 'Unknown'
          let verificationStatus = 'Unknown'
          try {
            const detail = await ses.getEmailIdentity(name)
            verificationStatus = detail.VerificationStatus || 'Unknown'
          }
          catch {
            // If we can't fetch details, just show what we have
          }
          const type = identity.IdentityType === 'EMAIL_ADDRESS' ? 'Email' : identity.IdentityType === 'DOMAIN' ? 'Domain' : (identity.IdentityType || 'Unknown')
          rows.push([name, type, verificationStatus])
        }

        cli.table(
          ['Identity', 'Type', 'Verification Status'],
          rows,
        )
      }
      catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        cli.error(`Failed to list identities: ${message}`)
        process.exit(1)
      }
    })

  app
    .command('email:verify <identity>', 'Verify an email address or domain')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .action(async (identity: string, options: { region: string }) => {
      cli.header('Verify Email Identity')

      try {
        const ses = new SESClient(options.region)

        const isEmail = identity.includes('@')

        cli.info(`Identity: ${identity}`)
        cli.info(`Type: ${isEmail ? 'Email Address' : 'Domain'}`)

        const confirmed = await cli.confirm('\nSend verification?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Initiating verification...')
        spinner.start()

        if (isEmail) {
          await ses.createEmailIdentity({ EmailIdentity: identity })
          spinner.succeed('Verification email sent')

          cli.info(`\nA verification email has been sent to ${identity}`)
          cli.info('Click the link in the email to complete verification.')
        }
        else {
          const result = await ses.verifyDomain(identity)
          spinner.succeed('Domain verification initiated')

          const dkimTokens = result.dkimTokens || []

          if (dkimTokens.length > 0) {
            cli.info('\nDKIM Records (for email authentication):')
            for (const token of dkimTokens) {
              cli.info(`\n  Name:  ${token}._domainkey.${identity}`)
              cli.info(`  Type:  CNAME`)
              cli.info(`  Value: ${token}.dkim.amazonses.com`)
            }
          }

          cli.info(`\nVerification Status: ${result.verificationStatus || 'PENDING'}`)
        }
      }
      catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        cli.error(`Failed to verify identity: ${message}`)
        process.exit(1)
      }
    })

  app
    .command('email:delete <identity>', 'Delete a verified email identity')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .action(async (identity: string, options: { region: string }) => {
      cli.header('Delete Email Identity')

      try {
        const ses = new SESClient(options.region)

        cli.warn(`This will remove identity: ${identity}`)

        const confirmed = await cli.confirm('\nDelete this identity?', false)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Deleting identity...')
        spinner.start()

        await ses.deleteEmailIdentity(identity)

        spinner.succeed('Identity deleted')
      }
      catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        cli.error(`Failed to delete identity: ${message}`)
        process.exit(1)
      }
    })

  app
    .command('email:send', 'Send a test email')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--from <email>', 'From email address (must be verified)')
    .option('--to <email>', 'To email address')
    .option('--subject <text>', 'Email subject')
    .option('--body <text>', 'Email body (text)')
    .option('--html <html>', 'Email body (HTML)')
    .action(async (options: {
      region: string
      from?: string
      to?: string
      subject?: string
      body?: string
      html?: string
    }) => {
      cli.header('Send Email')

      try {
        const ses = new SESClient(options.region)

        const from = options.from || await cli.prompt('From (verified email)')
        const to = options.to || await cli.prompt('To')
        const subject = options.subject || await cli.prompt('Subject', 'Test Email from ts-cloud')
        const body = options.body || await cli.prompt('Body', 'This is a test email sent from ts-cloud CLI.')

        cli.info(`\nFrom: ${from}`)
        cli.info(`To: ${to}`)
        cli.info(`Subject: ${subject}`)

        const confirmed = await cli.confirm('\nSend this email?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Sending email...')
        spinner.start()

        const result = await ses.sendEmail({
          FromEmailAddress: from,
          Destination: {
            ToAddresses: [to],
          },
          Content: {
            Simple: {
              Subject: {
                Data: subject,
              },
              Body: {
                Text: {
                  Data: body,
                },
                ...(options.html && {
                  Html: {
                    Data: options.html,
                  },
                }),
              },
            },
          },
        })

        spinner.succeed('Email sent')

        cli.success(`\nMessage ID: ${result.MessageId}`)
      }
      catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        cli.error(`Failed to send email: ${message}`)
        process.exit(1)
      }
    })

  app
    .command('email:templates', 'List email templates')
    .option('--region <region>', 'AWS region')
    .action(async (options: { region?: string }) => {
      cli.header('Email Templates')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const ses = new SESClient(region)

        const spinner = new cli.Spinner('Fetching templates...')
        spinner.start()

        const result = await ses.listEmailTemplates()
        const templates = result.TemplatesMetadata || []

        spinner.succeed(`Found ${templates.length} template(s)`)

        if (templates.length === 0) {
          cli.info('No email templates found')
          cli.info('Use `cloud email:template:create` to create a template')
          return
        }

        cli.table(
          ['Name', 'Created'],
          templates.map((t: { TemplateName?: string, CreatedTimestamp?: string }) => [
            t.TemplateName || 'N/A',
            t.CreatedTimestamp ? new Date(t.CreatedTimestamp).toLocaleString() : 'N/A',
          ]),
        )
      }
      catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        cli.error(`Failed to list templates: ${message}`)
        process.exit(1)
      }
    })

  app
    .command('email:template:create <name>', 'Create an email template')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--subject <text>', 'Email subject (supports {{variable}} placeholders)')
    .option('--text <text>', 'Text body')
    .option('--html <html>', 'HTML body')
    .option('--html-file <path>', 'HTML body from file')
    .action(async (name: string, options: {
      region: string
      subject?: string
      text?: string
      html?: string
      htmlFile?: string
    }) => {
      cli.header('Create Email Template')

      try {
        const ses = new SESClient(options.region)

        const subject = options.subject || await cli.prompt('Subject template', 'Hello {{name}}')
        const textBody = options.text || await cli.prompt('Text body', 'Hello {{name}}, this is a test.')

        let htmlBody = options.html
        if (options.htmlFile) {
          const file = Bun.file(options.htmlFile)
          htmlBody = await file.text()
        }

        cli.info(`\nTemplate Name: ${name}`)
        cli.info(`Subject: ${subject}`)

        const confirmed = await cli.confirm('\nCreate this template?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Creating template...')
        spinner.start()

        await ses.createEmailTemplate({
          TemplateName: name,
          TemplateContent: {
            Subject: subject,
            Text: textBody,
            Html: htmlBody,
          },
        })

        spinner.succeed('Template created')

        cli.info('\nTo send using this template:')
        cli.info(`  cloud email:send:template --template ${name} --to user@example.com --data '{"name":"John"}'`)
      }
      catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        cli.error(`Failed to create template: ${message}`)
        process.exit(1)
      }
    })

  app
    .command('email:template:delete <name>', 'Delete an email template')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .action(async (name: string, options: { region: string }) => {
      cli.header('Delete Email Template')

      try {
        const ses = new SESClient(options.region)

        cli.warn(`This will delete template: ${name}`)

        const confirmed = await cli.confirm('\nDelete this template?', false)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Deleting template...')
        spinner.start()

        await ses.deleteEmailTemplate(name)

        spinner.succeed('Template deleted')
      }
      catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        cli.error(`Failed to delete template: ${message}`)
        process.exit(1)
      }
    })

  app
    .command('email:stats', 'Show SES sending statistics')
    .option('--region <region>', 'AWS region')
    .action(async (options: { region?: string }) => {
      cli.header('Email Statistics')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const ses = new SESClient(region)

        const spinner = new cli.Spinner('Fetching statistics...')
        spinner.start()

        const [quota, stats] = await Promise.all([
          ses.getSendQuota(),
          ses.getSendStatistics(),
        ])

        spinner.succeed('Statistics loaded')

        cli.info('\nSending Quota:')
        cli.info(`  Max 24-hour Send: ${quota.Max24HourSend || 0}`)
        cli.info(`  Max Send Rate: ${quota.MaxSendRate || 0} emails/second`)
        cli.info(`  Sent Last 24h: ${quota.SentLast24Hours || 0}`)

        const remaining = (quota.Max24HourSend || 0) - (quota.SentLast24Hours || 0)
        cli.info(`  Remaining: ${remaining}`)

        if (stats.SendDataPoints && stats.SendDataPoints.length > 0) {
          cli.info('\nRecent Statistics:')

          // Aggregate stats
          let totalDelivered = 0
          let totalBounces = 0
          let totalComplaints = 0
          let totalRejects = 0

          for (const point of stats.SendDataPoints) {
            totalDelivered += point.DeliveryAttempts || 0
            totalBounces += point.Bounces || 0
            totalComplaints += point.Complaints || 0
            totalRejects += point.Rejects || 0
          }

          cli.info(`  Total Attempts: ${totalDelivered}`)
          cli.info(`  Bounces: ${totalBounces}`)
          cli.info(`  Complaints: ${totalComplaints}`)
          cli.info(`  Rejects: ${totalRejects}`)

          if (totalDelivered > 0) {
            const bounceRate = ((totalBounces / totalDelivered) * 100).toFixed(2)
            const complaintRate = ((totalComplaints / totalDelivered) * 100).toFixed(2)
            cli.info(`\n  Bounce Rate: ${bounceRate}%`)
            cli.info(`  Complaint Rate: ${complaintRate}%`)

            if (Number.parseFloat(bounceRate) > 5) {
              cli.warn('\n  Warning: Bounce rate is high (>5%). This may affect your sender reputation.')
            }
            if (Number.parseFloat(complaintRate) > 0.1) {
              cli.warn('\n  Warning: Complaint rate is high (>0.1%). This may affect your sender reputation.')
            }
          }
        }
      }
      catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        cli.error(`Failed to get statistics: ${message}`)
        process.exit(1)
      }
    })
}
