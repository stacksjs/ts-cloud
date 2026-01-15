#!/usr/bin/env bun
/**
 * Deploy IMAP-to-S3 bridge server to EC2 via SSM
 * Embeds all code directly in SSM commands to avoid S3 permission issues
 *
 * Security:
 * - Uses EC2 instance IAM role for AWS credentials (no hardcoded keys)
 * - Fetches IMAP passwords from AWS Secrets Manager at startup
 * - Secret name: stacks/mail-server/credentials
 * - Credentials are read from email config and synced to Secrets Manager
 */

import { SSMClient } from './ssm'
import { AWSClient } from './client'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface MailboxConfig {
  email: string
  password?: string
}

export interface MailServerDeployConfig {
  instanceId: string
  region: string
  secretName: string
  domain: string
  bucket: string
  prefix: string
  /** Mailboxes can be simple strings or objects with optional passwords */
  mailboxes: Array<string | MailboxConfig>
}

/**
 * Normalize mailbox config to object format with password lookup
 * Supports:
 *   - Simple usernames: 'chris' -> 'chris@{domain}', looks up MAIL_PASSWORD_CHRIS
 *   - Full email strings: 'chris@stacksjs.com' -> looks up MAIL_PASSWORD_CHRIS
 *   - Objects with email: { email: 'chris@stacksjs.com', password: '...' }
 *   - Objects with address (deprecated): { address: 'chris@stacksjs.com' }
 */
function normalizeMailbox(mailbox: string | MailboxConfig | { address: string, password?: string }, domain: string): MailboxConfig {
  if (typeof mailbox === 'string') {
    // If it's just a username (no @), append the domain
    const email = mailbox.includes('@') ? mailbox : `${mailbox}@${domain}`
    const username = email.split('@')[0].toUpperCase()
    const envKey = `MAIL_PASSWORD_${username}`
    const password = process.env[envKey]
    return { email, password }
  }

  // Handle both 'email' and 'address' fields (address is deprecated)
  let email = 'email' in mailbox ? mailbox.email : (mailbox as { address: string }).address
  if (!email) {
    throw new Error('Mailbox must have either "email" or "address" field')
  }

  // If it's just a username (no @), append the domain
  if (!email.includes('@')) {
    email = `${email}@${domain}`
  }

  // If object format but no password, try env lookup
  if (!mailbox.password) {
    const username = email.split('@')[0].toUpperCase()
    const envKey = `MAIL_PASSWORD_${username}`
    const password = process.env[envKey]
    return { email, password }
  }
  return { email, password: mailbox.password }
}

const defaultConfig: MailServerDeployConfig = {
  instanceId: 'i-032233d3e9839b78b',
  region: 'us-east-1',
  secretName: 'stacks/mail-server/credentials',
  domain: 'stacksjs.com',
  bucket: 'stacks-production-email',
  prefix: 'incoming/',
  mailboxes: [],
}

export async function deployImapServer(config: MailServerDeployConfig = defaultConfig) {
  console.log('Deploying IMAP-to-S3 bridge server to EC2...')
  console.log('')

  const ssm = new SSMClient(config.region)
  const awsClient = new AWSClient()

  // Normalize all mailboxes to object format with password lookup
  const normalizedMailboxes = config.mailboxes.map((m) => normalizeMailbox(m, config.domain))

  // Build credentials from normalized mailboxes
  const credentials: Record<string, string> = {}
  for (const mailbox of normalizedMailboxes) {
    // Extract username from email (chris@stacksjs.com -> chris)
    const username = mailbox.email.split('@')[0]
    if (mailbox.password) {
      credentials[username] = mailbox.password
    }
  }

  // Ensure the secret exists with IMAP credentials from config
  console.log('0. Ensuring credentials secret exists in Secrets Manager...')
  try {
    const existingSecretResult = await awsClient.request({
      service: 'secretsmanager',
      region: config.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'secretsmanager.GetSecretValue',
      },
      body: JSON.stringify({ SecretId: config.secretName }),
    })
    const existingSecret = existingSecretResult.SecretString || '{}'
    console.log('   Secret already exists')

    // Update if we have new credentials from config
    if (Object.keys(credentials).length > 0) {
      const existingCreds = JSON.parse(existingSecret)
      const mergedCreds = { ...existingCreds, ...credentials }
      await awsClient.request({
        service: 'secretsmanager',
        region: config.region,
        method: 'POST',
        path: '/',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': 'secretsmanager.PutSecretValue',
        },
        body: JSON.stringify({
          SecretId: config.secretName,
          SecretString: JSON.stringify(mergedCreds),
        }),
      })
      console.log('   Secret updated with config credentials')
    }
  }
  catch {
    // Create the secret with credentials from config
    console.log('   Creating secret...')
    if (Object.keys(credentials).length === 0) {
      console.warn('   WARNING: No passwords configured in mailboxes - logins will fail')
      console.warn('   Set MAIL_PASSWORD_<USER> environment variables in your config')
    }
    await awsClient.request({
      service: 'secretsmanager',
      region: config.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'secretsmanager.CreateSecret',
      },
      body: JSON.stringify({
        Name: config.secretName,
        Description: `IMAP mail server credentials for ${config.domain}`,
        SecretString: JSON.stringify(credentials),
        ClientRequestToken: crypto.randomUUID(),
      }),
    })
    console.log('   Secret created')
  }

  // Read the source files
  const imapServerCode = fs.readFileSync(path.join(__dirname, 'imap-server.ts'), 'utf-8')
  const s3ClientCode = fs.readFileSync(path.join(__dirname, 's3.ts'), 'utf-8')
  const clientCode = fs.readFileSync(path.join(__dirname, 'client.ts'), 'utf-8')

  // Build users config for server script from normalized mailboxes
  const usersConfig = normalizedMailboxes.map((m) => {
    const username = m.email.split('@')[0]
    return `      ${username}: {
        password: passwords.${username} || 'changeme',
        email: '${m.email}',
      },`
  }).join('\n')

  // Create the server startup script - fetches credentials from Secrets Manager using AWSClient directly
  const serverScript = `#!/usr/bin/env bun
import * as fs from 'node:fs'
import { startImapServer } from './imap-server'
import { AWSClient } from './client'

const SECRET_NAME = '${config.secretName}'
const REGION = '${config.region}'

async function main() {
  console.log('Starting IMAP-to-S3 bridge server...')

  // Fetch credentials from Secrets Manager using AWSClient directly (uses EC2 instance IAM role)
  console.log('Fetching credentials from Secrets Manager...')
  const client = new AWSClient()
  let passwords: Record<string, string> = {}

  try {
    const result = await client.request({
      service: 'secretsmanager',
      region: REGION,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'secretsmanager.GetSecretValue'
      },
      body: JSON.stringify({ SecretId: SECRET_NAME })
    })
    passwords = JSON.parse(result.SecretString || '{}')
    console.log('Credentials loaded for:', Object.keys(passwords).join(', '))
  }
  catch (error) {
    console.error('Failed to fetch credentials from Secrets Manager:', error)
    console.error('Using fallback empty passwords - logins will fail')
  }

  const hasTlsCerts = fs.existsSync('/etc/letsencrypt/live/mail.${config.domain}/privkey.pem')
  console.log('TLS certificates available:', hasTlsCerts)

  const server = await startImapServer({
    port: 143,
    sslPort: 993,
    host: '0.0.0.0',
    region: REGION,
    bucket: '${config.bucket}',
    prefix: '${config.prefix}',
    domain: '${config.domain}',
    users: {
${usersConfig}
    },
    tls: hasTlsCerts ? {
      key: '/etc/letsencrypt/live/mail.${config.domain}/privkey.pem',
      cert: '/etc/letsencrypt/live/mail.${config.domain}/fullchain.pem',
    } : undefined,
  })

  console.log('IMAP server running on port 143' + (hasTlsCerts ? ' and 993 (TLS)' : ''))

  process.on('SIGINT', async () => {
    console.log('Shutting down...')
    await server.stop()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    console.log('Shutting down...')
    await server.stop()
    process.exit(0)
  })
}

main().catch(console.error)
`

  // Create systemd service file - NO hardcoded credentials, uses IAM role
  const systemdService = `[Unit]
Description=IMAP-to-S3 Bridge Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/imap-server
# AWS credentials come from EC2 instance IAM role - no hardcoded keys needed
Environment="AWS_REGION=${config.region}"
ExecStart=/root/.bun/bin/bun run /opt/imap-server/server.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
`

  // Step 1: Create directory structure
  console.log('1. Creating directory structure on EC2...')
  let result = await ssm.runShellCommand(config.instanceId, [
    'mkdir -p /opt/imap-server',
    'ls -la /opt/imap-server',
  ], { maxWaitMs: 60000 })

  if (!result.success) {
    console.error('Failed to create directory:', result.error)
    process.exit(1)
  }
  console.log('   Directory created')

  // Step 2: Write client.ts (base64 encode to handle special chars)
  console.log('2. Writing client.ts...')
  const clientBase64 = Buffer.from(clientCode).toString('base64')
  result = await ssm.runShellCommand(config.instanceId, [
    `echo '${clientBase64}' | base64 -d > /opt/imap-server/client.ts`,
    'wc -l /opt/imap-server/client.ts',
  ], { maxWaitMs: 60000 })

  if (!result.success) {
    console.error('Failed to write client.ts:', result.error)
    process.exit(1)
  }
  console.log('   client.ts written')

  // Step 3: Write s3.ts
  console.log('3. Writing s3.ts...')
  const s3Base64 = Buffer.from(s3ClientCode).toString('base64')
  result = await ssm.runShellCommand(config.instanceId, [
    `echo '${s3Base64}' | base64 -d > /opt/imap-server/s3.ts`,
    'wc -l /opt/imap-server/s3.ts',
  ], { maxWaitMs: 60000 })

  if (!result.success) {
    console.error('Failed to write s3.ts:', result.error)
    process.exit(1)
  }
  console.log('   s3.ts written')

  // Step 4: Write imap-server.ts
  console.log('4. Writing imap-server.ts...')
  const imapBase64 = Buffer.from(imapServerCode).toString('base64')
  result = await ssm.runShellCommand(config.instanceId, [
    `echo '${imapBase64}' | base64 -d > /opt/imap-server/imap-server.ts`,
    'wc -l /opt/imap-server/imap-server.ts',
  ], { maxWaitMs: 60000 })

  if (!result.success) {
    console.error('Failed to write imap-server.ts:', result.error)
    process.exit(1)
  }
  console.log('   imap-server.ts written')

  // Step 5: Write server.ts
  console.log('5. Writing server.ts...')
  const serverBase64 = Buffer.from(serverScript).toString('base64')
  result = await ssm.runShellCommand(config.instanceId, [
    `echo '${serverBase64}' | base64 -d > /opt/imap-server/server.ts`,
    'wc -l /opt/imap-server/server.ts',
  ], { maxWaitMs: 60000 })

  if (!result.success) {
    console.error('Failed to write server.ts:', result.error)
    process.exit(1)
  }
  console.log('   server.ts written')

  // Step 6: Write systemd service and start
  console.log('6. Setting up systemd service...')
  const serviceBase64 = Buffer.from(systemdService).toString('base64')
  result = await ssm.runShellCommand(config.instanceId, [
    `echo '${serviceBase64}' | base64 -d > /etc/systemd/system/imap-server.service`,
    'systemctl daemon-reload',
    'systemctl stop imap-server 2>/dev/null || true',
    'systemctl enable imap-server',
    'systemctl start imap-server',
    'sleep 3',
    'systemctl status imap-server --no-pager || true',
    'ss -tlnp | grep -E ":143|:993" || netstat -tlnp | grep -E ":143|:993" || echo "Ports not yet listening"',
  ], { maxWaitMs: 120000 })

  console.log('')
  console.log('Service status:')
  console.log(result.output || result.error)

  console.log('')
  console.log('='.repeat(60))
  console.log('IMAP Server Deployment Complete!')
  console.log('='.repeat(60))
  console.log('')
  console.log('Mail.app Settings:')
  console.log('  Account Type:    IMAP')
  console.log(`  Incoming Server: mail.${config.domain}`)
  console.log('  Port:            143 (or 993 with SSL)')
  console.log('  Username:        <email username>')
  console.log('  Password:        <from Secrets Manager>')
  console.log('')
  console.log('Credentials are stored in AWS Secrets Manager:')
  console.log(`  Secret: ${config.secretName}`)
  console.log('')
}

// Main entry point for standalone execution
async function main() {
  await deployImapServer(defaultConfig)
}

main().catch(console.error)
