/**
 * Let's Encrypt Integration for Stacks
 *
 * Provides utilities for obtaining and managing Let's Encrypt certificates.
 * Supports both HTTP-01 and DNS-01 challenges with multiple DNS providers.
*/

import type { DnsProvider, DnsProviderConfig } from '../dns/types'
import { createDnsProvider } from '../dns'
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
   * Route53 hosted zone ID (required for dns-01 challenge with Route53)
   * @deprecated Use dnsProvider config instead
  */
  hostedZoneId?: string

  /**
   * DNS provider configuration for dns-01 challenge
   * Supports: route53, porkbun, godaddy
  */
  dnsProvider?: DnsProviderConfig

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
 * DNS-01 challenge configuration for programmatic use
*/
export interface Dns01ChallengeConfig {
  domain: string
  challengeValue: string
  /**
   * Route53 hosted zone ID (legacy, use dnsProvider instead)
   * @deprecated Use dnsProvider config instead
  */
  hostedZoneId?: string
  /**
   * DNS provider configuration
  */
  dnsProvider?: DnsProviderConfig
  /**
   * AWS region (only for Route53)
  */
  region?: string
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
  }
  else {
    // Determine DNS provider type
    const dnsProviderType = config.dnsProvider?.provider || (config.hostedZoneId ? 'route53' : undefined)

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
      dnsProvider: config.dnsProvider,
      dnsProviderType,
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
  dnsProvider?: DnsProviderConfig
  dnsProviderType?: string
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
 * Generate UserData for DNS-01 challenge
 * Supports Route53 (via certbot plugin) and manual mode for external DNS providers
*/
function generateDns01UserData(params: UserDataParams): string {
  const {
    email,
    certPath,
    autoRenew,
    domainFlags,
    stagingFlag,
    primaryDomain,
    hostedZoneId,
    dnsProvider,
    dnsProviderType,
  } = params

  // Route53 uses certbot's native plugin
  if (dnsProviderType === 'route53' || hostedZoneId) {
    if (!hostedZoneId) {
      throw new Error('hostedZoneId is required for DNS-01 challenge with Route53')
    }

    return `
# ==========================================
# Let's Encrypt Certificate Setup (DNS-01 via Route53)
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

  // For external DNS providers (Porkbun, GoDaddy), use manual mode with hooks
  // The DNS records need to be managed via the API
  if (!dnsProvider) {
    throw new Error('dnsProvider configuration is required for DNS-01 challenge with external DNS providers')
  }

  const providerName = dnsProvider.provider.toUpperCase()
  const envVars = generateDnsProviderEnvVars(dnsProvider)

  return `
# ==========================================
# Let's Encrypt Certificate Setup (DNS-01 via ${providerName})
# ==========================================

# Install certbot
dnf install -y certbot jq curl

${envVars}

# Create DNS challenge hook scripts directory
mkdir -p /etc/letsencrypt/hooks

# Create authenticator hook for ${providerName}
cat > /etc/letsencrypt/hooks/auth-hook.sh << 'AUTHHOOK'
#!/bin/bash
# DNS-01 authenticator hook for ${providerName}
# This creates the TXT record for ACME challenge

DOMAIN="\$CERTBOT_DOMAIN"
VALIDATION="\$CERTBOT_VALIDATION"
RECORD_NAME="_acme-challenge.\$DOMAIN"

${generateDnsCreateRecordScript(dnsProvider)}

# Wait for DNS propagation
echo "Waiting 60 seconds for DNS propagation..."
sleep 60
AUTHHOOK

chmod +x /etc/letsencrypt/hooks/auth-hook.sh

# Create cleanup hook for ${providerName}
cat > /etc/letsencrypt/hooks/cleanup-hook.sh << 'CLEANUPHOOK'
#!/bin/bash
# DNS-01 cleanup hook for ${providerName}
# This removes the TXT record after validation

DOMAIN="\$CERTBOT_DOMAIN"
VALIDATION="\$CERTBOT_VALIDATION"
RECORD_NAME="_acme-challenge.\$DOMAIN"

${generateDnsDeleteRecordScript(dnsProvider)}
CLEANUPHOOK

chmod +x /etc/letsencrypt/hooks/cleanup-hook.sh

# Obtain certificate using manual DNS-01 challenge with hooks
certbot certonly \\
  --manual \\
  --preferred-challenges dns \\
  --manual-auth-hook /etc/letsencrypt/hooks/auth-hook.sh \\
  --manual-cleanup-hook /etc/letsencrypt/hooks/cleanup-hook.sh \\
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
 * Generate environment variables for DNS provider
*/
function generateDnsProviderEnvVars(config: DnsProviderConfig): string {
  switch (config.provider) {
    case 'porkbun':
      return `
# Porkbun API credentials
export PORKBUN_API_KEY="${config.apiKey}"
export PORKBUN_SECRET_KEY="${config.secretKey}"
`
    case 'godaddy':
      return `
# GoDaddy API credentials
export GODADDY_API_KEY="${config.apiKey}"
export GODADDY_API_SECRET="${config.apiSecret}"
export GODADDY_ENV="${config.environment || 'production'}"
`
    case 'route53':
      return `
# Route53 uses IAM role credentials
`
    default:
      return ''
  }
}

/**
 * Generate DNS record creation script for the provider
*/
function generateDnsCreateRecordScript(config: DnsProviderConfig): string {
  switch (config.provider) {
    case 'porkbun':
      return `
# Extract root domain (last two parts)
ROOT_DOMAIN=$(echo "$DOMAIN" | awk -F. '{print $(NF-1)"."$NF}')
SUBDOMAIN="_acme-challenge"
if [ "$DOMAIN" != "$ROOT_DOMAIN" ]; then
  SUBDOMAIN="_acme-challenge.$(echo "$DOMAIN" | sed "s/\\.$ROOT_DOMAIN$//")"
fi

echo "Creating TXT record via Porkbun: $SUBDOMAIN.$ROOT_DOMAIN -> $VALIDATION"

curl -s -X POST "https://api.porkbun.com/api/json/v3/dns/create/$ROOT_DOMAIN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "apikey": "'"$PORKBUN_API_KEY"'",
    "secretapikey": "'"$PORKBUN_SECRET_KEY"'",
    "type": "TXT",
    "name": "'"$SUBDOMAIN"'",
    "content": "'"$VALIDATION"'",
    "ttl": "600"
  }'
`
    case 'godaddy':
      return `
# Extract root domain
ROOT_DOMAIN=$(echo "$DOMAIN" | awk -F. '{print $(NF-1)"."$NF}')
RECORD_NAME="_acme-challenge"
if [ "$DOMAIN" != "$ROOT_DOMAIN" ]; then
  RECORD_NAME="_acme-challenge.$(echo "$DOMAIN" | sed "s/\\.$ROOT_DOMAIN$//")"
fi

echo "Creating TXT record via GoDaddy: $RECORD_NAME.$ROOT_DOMAIN -> $VALIDATION"

API_URL="https://api.godaddy.com"
if [ "$GODADDY_ENV" = "ote" ]; then
  API_URL="https://api.ote-godaddy.com"
fi

curl -s -X PATCH "$API_URL/v1/domains/$ROOT_DOMAIN/records" \\
  -H "Authorization: sso-key $GODADDY_API_KEY:$GODADDY_API_SECRET" \\
  -H "Content-Type: application/json" \\
  -d '[{
    "type": "TXT",
    "name": "'"$RECORD_NAME"'",
    "data": "'"$VALIDATION"'",
    "ttl": 600
  }]'
`
    default:
      return 'echo "Unsupported DNS provider"'
  }
}

/**
 * Generate DNS record deletion script for the provider
*/
function generateDnsDeleteRecordScript(config: DnsProviderConfig): string {
  switch (config.provider) {
    case 'porkbun':
      return `
# Extract root domain
ROOT_DOMAIN=$(echo "$DOMAIN" | awk -F. '{print $(NF-1)"."$NF}')

echo "Deleting TXT record via Porkbun for _acme-challenge.$DOMAIN"

# First, get all TXT records to find the ID
RECORDS=$(curl -s -X POST "https://api.porkbun.com/api/json/v3/dns/retrieveByNameType/$ROOT_DOMAIN/TXT" \\
  -H "Content-Type: application/json" \\
  -d '{
    "apikey": "'"$PORKBUN_API_KEY"'",
    "secretapikey": "'"$PORKBUN_SECRET_KEY"'"
  }')

# Extract record ID for _acme-challenge and delete it
RECORD_ID=$(echo "$RECORDS" | jq -r '.records[] | select(.name | contains("_acme-challenge")) | .id' | head -1)

if [ -n "$RECORD_ID" ] && [ "$RECORD_ID" != "null" ]; then
  curl -s -X POST "https://api.porkbun.com/api/json/v3/dns/delete/$ROOT_DOMAIN/$RECORD_ID" \\
    -H "Content-Type: application/json" \\
    -d '{
      "apikey": "'"$PORKBUN_API_KEY"'",
      "secretapikey": "'"$PORKBUN_SECRET_KEY"'"
    }'
  echo "Deleted record ID: $RECORD_ID"
fi
`
    case 'godaddy':
      return `
# Extract root domain
ROOT_DOMAIN=$(echo "$DOMAIN" | awk -F. '{print $(NF-1)"."$NF}')
RECORD_NAME="_acme-challenge"
if [ "$DOMAIN" != "$ROOT_DOMAIN" ]; then
  RECORD_NAME="_acme-challenge.$(echo "$DOMAIN" | sed "s/\\.$ROOT_DOMAIN$//")"
fi

echo "Deleting TXT record via GoDaddy: $RECORD_NAME.$ROOT_DOMAIN"

API_URL="https://api.godaddy.com"
if [ "$GODADDY_ENV" = "ote" ]; then
  API_URL="https://api.ote-godaddy.com"
fi

curl -s -X DELETE "$API_URL/v1/domains/$ROOT_DOMAIN/records/TXT/$RECORD_NAME" \\
  -H "Authorization: sso-key $GODADDY_API_KEY:$GODADDY_API_SECRET"
`
    default:
      return 'echo "Unsupported DNS provider"'
  }
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

  ${redirectHttp
? `
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
  `
: ''}
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
 * Setup DNS-01 challenge programmatically using any DNS provider
 * This is the unified API that works with Route53, Porkbun, GoDaddy, etc.
*/
export async function setupDns01Challenge(options: Dns01ChallengeConfig): Promise<void> {
  const { domain, challengeValue, hostedZoneId, dnsProvider, region = 'us-east-1' } = options

  // Use the unified DNS provider abstraction if available
  if (dnsProvider) {
    const provider: DnsProvider = createDnsProvider(dnsProvider)
    const result = await provider.upsertRecord(domain, {
      name: `_acme-challenge.${domain}`,
      type: 'TXT',
      content: challengeValue,
      ttl: 60,
    })

    if (!result.success) {
      throw new Error(`Failed to create DNS challenge record: ${result.message}`)
    }
    return
  }

  // Legacy: Use Route53 directly if hostedZoneId is provided
  if (hostedZoneId) {
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
    return
  }

  throw new Error('Either dnsProvider or hostedZoneId must be provided')
}

/**
 * Clean up DNS-01 challenge record using any DNS provider
*/
export async function cleanupDns01Challenge(options: Dns01ChallengeConfig): Promise<void> {
  const { domain, challengeValue, hostedZoneId, dnsProvider, region = 'us-east-1' } = options

  // Use the unified DNS provider abstraction if available
  if (dnsProvider) {
    const provider: DnsProvider = createDnsProvider(dnsProvider)
    const result = await provider.deleteRecord(domain, {
      name: `_acme-challenge.${domain}`,
      type: 'TXT',
      content: challengeValue,
    })

    if (!result.success) {
      console.warn(`Failed to delete DNS challenge record: ${result.message}`)
    }
    return
  }

  // Legacy: Use Route53 directly if hostedZoneId is provided
  if (hostedZoneId) {
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
    return
  }

  throw new Error('Either dnsProvider or hostedZoneId must be provided')
}

/**
 * Check if certificates need renewal (< 30 days until expiry)
*/
export function needsRenewal(certPath: string): boolean {
  try {
    const { execSync } = require('node:child_process')
    const result = execSync(
      `openssl x509 -checkend 2592000 -noout -in ${certPath}/cert.pem`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    )
    return false // Certificate is still valid for > 30 days
  }
  catch {
    return true // Certificate expires within 30 days or doesn't exist
  }
}
