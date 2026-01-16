/**
 * Let's Encrypt Integration for Stacks
 *
 * Provides utilities for obtaining and managing Let's Encrypt certificates.
 * Supports both HTTP-01 and DNS-01 challenges.
 */

import { Route53Client } from '../aws/route53'

export interface LetsEncryptConfig {
  /**
   * Domain names to obtain certificate for
   */
  domains: string[]

  /**
   * Email for Let's Encrypt notifications
   */
  email: string

  /**
   * Use staging server for testing
   * @default false
   */
  staging?: boolean

  /**
   * Challenge type
   * - 'http-01': Serve challenge file via HTTP (requires port 80)
   * - 'dns-01': Add TXT record to DNS (works behind load balancers)
   * @default 'http-01'
   */
  challengeType?: 'http-01' | 'dns-01'

  /**
   * Route53 hosted zone ID (required for dns-01 challenge)
   */
  hostedZoneId?: string

  /**
   * Certificate storage path
   * @default '/etc/letsencrypt/live'
   */
  certPath?: string

  /**
   * Auto-renew certificates
   * @default true
   */
  autoRenew?: boolean
}

/**
 * Generate UserData script for Let's Encrypt certificate setup on EC2
 * This creates a complete setup that handles certificate acquisition and renewal
 */
export function generateLetsEncryptUserData(config: LetsEncryptConfig): string {
  const {
    domains,
    email,
    staging = false,
    challengeType = 'http-01',
    certPath = '/etc/letsencrypt/live',
    autoRenew = true,
  } = config

  const primaryDomain = domains[0]
  const domainFlags = domains.map(d => `-d ${d}`).join(' ')
  const stagingFlag = staging ? '--staging' : ''

  if (challengeType === 'http-01') {
    return generateHttp01UserData({
      domains,
      email,
      staging,
      certPath,
      autoRenew,
      domainFlags,
      stagingFlag,
      primaryDomain,
    })
  } else {
    return generateDns01UserData({
      domains,
      email,
      staging,
      certPath,
      autoRenew,
      domainFlags,
      stagingFlag,
      primaryDomain,
      hostedZoneId: config.hostedZoneId,
    })
  }
}

interface UserDataParams {
  domains: string[]
  email: string
  staging: boolean
  certPath: string
  autoRenew: boolean
  domainFlags: string
  stagingFlag: string
  primaryDomain: string
  hostedZoneId?: string
}

/**
 * Generate UserData for HTTP-01 challenge
 */
function generateHttp01UserData(params: UserDataParams): string {
  const { email, certPath, autoRenew, domainFlags, stagingFlag, primaryDomain } = params

  return `
# ==========================================
# Let's Encrypt Certificate Setup (HTTP-01)
# ==========================================

# Install certbot
dnf install -y certbot

# Stop any service using port 80 temporarily
systemctl stop stacks 2>/dev/null || true

# Obtain certificate using standalone mode
certbot certonly \\
  --standalone \\
  --non-interactive \\
  --agree-tos \\
  --email ${email} \\
  ${stagingFlag} \\
  ${domainFlags}

# Check if certificate was obtained
if [ -f "${certPath}/${primaryDomain}/fullchain.pem" ]; then
  echo "Certificate obtained successfully!"

  # Create symlinks for easier access
  mkdir -p /etc/ssl/stacks
  ln -sf ${certPath}/${primaryDomain}/fullchain.pem /etc/ssl/stacks/fullchain.pem
  ln -sf ${certPath}/${primaryDomain}/privkey.pem /etc/ssl/stacks/privkey.pem
  ln -sf ${certPath}/${primaryDomain}/cert.pem /etc/ssl/stacks/cert.pem
  ln -sf ${certPath}/${primaryDomain}/chain.pem /etc/ssl/stacks/chain.pem
else
  echo "Failed to obtain certificate!"
fi

${autoRenew ? generateRenewalSetup(primaryDomain) : '# Auto-renewal disabled'}

# Restart the application
systemctl start stacks
`
}

/**
 * Generate UserData for DNS-01 challenge using Route53
 */
function generateDns01UserData(params: UserDataParams): string {
  const { email, certPath, autoRenew, domainFlags, stagingFlag, primaryDomain, hostedZoneId } = params

  if (!hostedZoneId) {
    throw new Error('hostedZoneId is required for DNS-01 challenge')
  }

  return `
# ==========================================
# Let's Encrypt Certificate Setup (DNS-01)
# ==========================================

# Install certbot with Route53 plugin
dnf install -y certbot python3-certbot-dns-route53

# Obtain certificate using DNS-01 challenge with Route53
certbot certonly \\
  --dns-route53 \\
  --non-interactive \\
  --agree-tos \\
  --email ${email} \\
  ${stagingFlag} \\
  ${domainFlags}

# Check if certificate was obtained
if [ -f "${certPath}/${primaryDomain}/fullchain.pem" ]; then
  echo "Certificate obtained successfully!"

  # Create symlinks for easier access
  mkdir -p /etc/ssl/stacks
  ln -sf ${certPath}/${primaryDomain}/fullchain.pem /etc/ssl/stacks/fullchain.pem
  ln -sf ${certPath}/${primaryDomain}/privkey.pem /etc/ssl/stacks/privkey.pem
  ln -sf ${certPath}/${primaryDomain}/cert.pem /etc/ssl/stacks/cert.pem
  ln -sf ${certPath}/${primaryDomain}/chain.pem /etc/ssl/stacks/chain.pem
else
  echo "Failed to obtain certificate!"
fi

${autoRenew ? generateRenewalSetup(primaryDomain) : '# Auto-renewal disabled'}
`
}

/**
 * Generate certificate renewal setup
 */
function generateRenewalSetup(primaryDomain: string): string {
  return `
# ==========================================
# Certificate Auto-Renewal Setup
# ==========================================

# Create renewal hook to restart the application
cat > /etc/letsencrypt/renewal-hooks/deploy/restart-stacks.sh << 'RENEWHOOK'
#!/bin/bash
# Restart the Stacks application after certificate renewal
systemctl restart stacks
echo "Certificate renewed and application restarted at $(date)"
RENEWHOOK

chmod +x /etc/letsencrypt/renewal-hooks/deploy/restart-stacks.sh

# Create systemd timer for automatic renewal
cat > /etc/systemd/system/certbot-renewal.service << 'RENEWSERVICE'
[Unit]
Description=Certbot Renewal
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/certbot renew --quiet
RENEWSERVICE

cat > /etc/systemd/system/certbot-renewal.timer << 'RENEWTIMER'
[Unit]
Description=Run certbot renewal twice daily

[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=3600
Persistent=true

[Install]
WantedBy=timers.target
RENEWTIMER

# Enable and start the renewal timer
systemctl daemon-reload
systemctl enable certbot-renewal.timer
systemctl start certbot-renewal.timer

echo "Certificate auto-renewal configured"
`
}

/**
 * Generate server configuration for HTTPS with Let's Encrypt
 */
export function generateHttpsServerCode(options: {
  httpPort?: number
  httpsPort?: number
  certPath?: string
  redirectHttp?: boolean
}): string {
  const {
    httpPort = 80,
    httpsPort = 443,
    certPath = '/etc/ssl/stacks',
    redirectHttp = true,
  } = options

  return `
// HTTPS Server with Let's Encrypt certificates
import { readFileSync, existsSync } from 'node:fs'

const CERT_PATH = '${certPath}'
const HTTP_PORT = ${httpPort}
const HTTPS_PORT = ${httpsPort}

// Check if certificates exist
const hasCerts = existsSync(\`\${CERT_PATH}/fullchain.pem\`) && existsSync(\`\${CERT_PATH}/privkey.pem\`)

if (hasCerts) {
  // Start HTTPS server
  const httpsServer = Bun.serve({
    port: HTTPS_PORT,
    tls: {
      cert: Bun.file(\`\${CERT_PATH}/fullchain.pem\`),
      key: Bun.file(\`\${CERT_PATH}/privkey.pem\`),
    },
    async fetch(request: Request): Promise<Response> {
      // Your application handler here
      return handleRequest(request)
    },
  })
  console.log(\`HTTPS server running on port \${HTTPS_PORT}\`)

  ${redirectHttp ? `
  // Start HTTP server for redirect
  const httpServer = Bun.serve({
    port: HTTP_PORT,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)

      // Allow ACME challenges through
      if (url.pathname.startsWith('/.well-known/acme-challenge/')) {
        return handleAcmeChallenge(request)
      }

      // Redirect to HTTPS
      return Response.redirect(
        \`https://\${url.host}\${url.pathname}\${url.search}\`,
        301
      )
    },
  })
  console.log(\`HTTP redirect server running on port \${HTTP_PORT}\`)
  ` : ''}
} else {
  // No certificates yet, run HTTP only
  console.log('No SSL certificates found, running HTTP only')
  const httpServer = Bun.serve({
    port: HTTP_PORT,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)

      // Allow ACME challenges
      if (url.pathname.startsWith('/.well-known/acme-challenge/')) {
        return handleAcmeChallenge(request)
      }

      return handleRequest(request)
    },
  })
  console.log(\`HTTP server running on port \${HTTP_PORT}\`)
}

// ACME challenge handler for HTTP-01 validation
async function handleAcmeChallenge(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const token = url.pathname.split('/').pop()

  // Check for challenge file
  const challengePath = \`/var/www/.well-known/acme-challenge/\${token}\`
  if (existsSync(challengePath)) {
    return new Response(Bun.file(challengePath))
  }

  return new Response('Not Found', { status: 404 })
}

// Your application request handler
async function handleRequest(request: Request): Promise<Response> {
  // Implement your request handling here
  return new Response('Hello from Stacks!')
}
`
}

/**
 * Generate DNS-01 challenge setup using Route53
 * Can be used programmatically to set up challenges
 */
export async function setupDns01Challenge(options: {
  domain: string
  hostedZoneId: string
  challengeValue: string
  region?: string
}): Promise<void> {
  const { domain, hostedZoneId, challengeValue, region = 'us-east-1' } = options

  const r53 = new Route53Client(region)

  await r53.changeResourceRecordSets({
    HostedZoneId: hostedZoneId,
    ChangeBatch: {
      Comment: 'ACME DNS-01 challenge',
      Changes: [{
        Action: 'UPSERT',
        ResourceRecordSet: {
          Name: `_acme-challenge.${domain}`,
          Type: 'TXT',
          TTL: 60,
          ResourceRecords: [{ Value: `"${challengeValue}"` }],
        },
      }],
    },
  })
}

/**
 * Clean up DNS-01 challenge record
 */
export async function cleanupDns01Challenge(options: {
  domain: string
  hostedZoneId: string
  challengeValue: string
  region?: string
}): Promise<void> {
  const { domain, hostedZoneId, challengeValue, region = 'us-east-1' } = options

  const r53 = new Route53Client(region)

  await r53.changeResourceRecordSets({
    HostedZoneId: hostedZoneId,
    ChangeBatch: {
      Comment: 'Remove ACME DNS-01 challenge',
      Changes: [{
        Action: 'DELETE',
        ResourceRecordSet: {
          Name: `_acme-challenge.${domain}`,
          Type: 'TXT',
          TTL: 60,
          ResourceRecords: [{ Value: `"${challengeValue}"` }],
        },
      }],
    },
  })
}

/**
 * Check if certificates need renewal (< 30 days until expiry)
 */
export function needsRenewal(certPath: string): boolean {
  try {
    const { execSync } = require('node:child_process')
    const result = execSync(
      `openssl x509 -checkend 2592000 -noout -in ${certPath}/cert.pem`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    )
    return false // Certificate is still valid for > 30 days
  } catch {
    return true // Certificate expires within 30 days or doesn't exist
  }
}
