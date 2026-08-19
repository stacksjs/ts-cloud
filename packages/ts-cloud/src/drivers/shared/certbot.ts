/**
 * Let's Encrypt TLS for nginx vhosts via certbot — issuance + automatic
 * renewal, mirroring Forge's SSL handling.
 *
 * `certbot --nginx` reads the site's :80 server block, obtains a certificate
 * for its `server_name`s, and rewrites the vhost to serve :443 + redirect
 * :80 → :443. The apt `certbot` package installs a `certbot.timer` that renews
 * twice daily; we add a deploy-hook so nginx reloads after a renewal.
 *
 * For the `custom` provider the vhost is rendered with the operator's cert
 * directly (see nginx-vhost's `ssl` option), so certbot is not involved.
 */
import type { SiteConfig, SslDnsConfig } from '@ts-cloud/core'
import { NGINX_WRAPPER } from './nginx-vhost'

/** Resolve the effective SSL provider for a site (Let's Encrypt by default when it has a domain). */
export function resolveSslProvider(site: SiteConfig): 'letsencrypt' | 'custom' | 'none' {
  if (site.ssl?.provider) return site.ssl.provider
  return site.domain ? 'letsencrypt' : 'none'
}

/** apt package + certbot plugin name for a DNS provider. */
const DNS_PLUGINS: Record<SslDnsConfig['provider'], { pkg: string; plugin: string }> = {
  cloudflare: { pkg: 'python3-certbot-dns-cloudflare', plugin: 'dns-cloudflare' },
  route53: { pkg: 'python3-certbot-dns-route53', plugin: 'dns-route53' },
  digitalocean: { pkg: 'python3-certbot-dns-digitalocean', plugin: 'dns-digitalocean' },
  google: { pkg: 'python3-certbot-dns-google', plugin: 'dns-google' },
}

/** Path of the certbot credentials INI for a DNS provider. */
export function dnsCredentialsPath(provider: SslDnsConfig['provider']): string {
  return `/etc/letsencrypt/ts-cloud-${provider}.ini`
}

/** Install certbot (+ optional DNS plugin) and ensure the auto-renew timer is enabled. */
export function buildCertbotInstallScript(dns?: SslDnsConfig): string[] {
  const plugin = dns ? DNS_PLUGINS[dns.provider] : undefined
  const pkgs = ['certbot', 'python3-certbot-nginx', ...(plugin ? [plugin.pkg] : [])].join(' ')
  // A DNS site always (re)installs to ensure its plugin pkg is present; a plain
  // site skips the apt round-trip when certbot is already there. Refresh lists
  // first — a baked/cleaned image has empty /var/lib/apt/lists.
  const installLine = plugin
    ? `apt-get update -y && apt-get install -y ${pkgs}`
    : `command -v certbot >/dev/null 2>&1 || { apt-get update -y && apt-get install -y ${pkgs}; }`
  return [
    'export DEBIAN_FRONTEND=noninteractive',
    installLine,
    // Reload nginx after each successful renewal so the new cert is served. The
    // managed unit is ts-cloud-nginx (pantry nginx) — there is no nginx.service
    // on these boxes, so reloading 'nginx' silently did nothing and the old
    // cert kept being served until a manual restart. Fall back for apt-nginx
    // boxes.
    'mkdir -p /etc/letsencrypt/renewal-hooks/deploy',
    "cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'TS_CLOUD_HOOK_EOF'",
    '#!/bin/sh',
    'systemctl reload ts-cloud-nginx 2>/dev/null || systemctl reload nginx 2>/dev/null || true',
    'TS_CLOUD_HOOK_EOF',
    'chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh',
    // The apt package ships certbot.timer; make sure it's active.
    'systemctl enable certbot.timer 2>/dev/null || true',
    'systemctl start certbot.timer 2>/dev/null || true',
  ]
}

export interface CertbotIssueOptions {
  /** Primary domain. */
  domain: string
  /** Additional SANs (site aliases). */
  aliases?: string[]
  /** Contact email for registration / expiry notices. */
  email?: string
  /** Redirect HTTP → HTTPS (Forge default). @default true */
  redirect?: boolean
  /** Issue `*.<domain>` + `<domain>` (requires `dns`). */
  wildcard?: boolean
  /** DNS-01 validation via a certbot DNS plugin (required for wildcard). */
  dns?: SslDnsConfig
}

/**
 * Build the commands that write a DNS provider's certbot credentials INI
 * (root-only) so certbot can create the `_acme-challenge` records. Returns `[]`
 * when there are no credentials (e.g. route53 using instance-role creds).
 */
export function buildDnsCredentialsScript(dns: SslDnsConfig): string[] {
  if (!dns.credentials || Object.keys(dns.credentials).length === 0) return []
  const file = dnsCredentialsPath(dns.provider)
  const lines = Object.entries(dns.credentials)
    .map(([k, v]) => `${k} = ${v}`)
    .join('\n')
  return [`cat > ${file} <<'TS_CLOUD_DNSCREDS_EOF'`, lines, 'TS_CLOUD_DNSCREDS_EOF', `chmod 600 ${file}`]
}

/**
 * Issue (or expand) a Let's Encrypt cert. Uses the nginx (HTTP-01) plugin by
 * default; with `dns` set, uses DNS-01 via the provider plugin (the only way to
 * get a wildcard). Idempotent: `--keep-until-expiring` reuses a valid cert.
 */
export function buildCertbotIssueScript(options: CertbotIssueOptions): string[] {
  const dns = options.dns
  // Wildcard covers all subdomains; pair it with the apex. Otherwise the
  // primary domain + each alias as SANs.
  const domains = options.wildcard
    ? [`*.${options.domain}`, options.domain]
    : [options.domain, ...(options.aliases || [])].filter(Boolean)

  const args = ['certbot', '--non-interactive', '--agree-tos', '--keep-until-expiring']
  if (dns) {
    const plugin = DNS_PLUGINS[dns.provider].plugin
    args.push(`--${plugin}`)
    // route53 reads AWS creds from env/role; the others read the INI we wrote.
    if (dns.provider !== 'route53' && dns.credentials)
      args.push(`--${plugin}-credentials ${dnsCredentialsPath(dns.provider)}`)
    if (typeof dns.propagationSeconds === 'number' && dns.provider !== 'route53')
      args.push(`--${plugin}-propagation-seconds ${dns.propagationSeconds}`)
    // DNS-01 only obtains the cert; nginx is reloaded by the renewal/deploy hook.
    args.push('certonly')
  } else {
    // certbot's nginx plugin shells out to an `nginx` binary on PATH (nginx -V,
    // -t, reload). These boxes only carry the ts-cloud wrapper around the
    // pantry-installed binary, so point certbot at it explicitly — otherwise
    // issuance aborts with "Could not find a usable 'nginx' binary".
    args.push('--nginx', `--nginx-ctl ${NGINX_WRAPPER}`, options.redirect === false ? '--no-redirect' : '--redirect')
  }
  if (options.email) args.push(`-m ${options.email}`)
  else args.push('--register-unsafely-without-email')
  for (const d of domains) args.push(`-d ${d}`)

  return [args.join(' ')]
}

/**
 * Full SSL script for a site, dispatched on its provider. Returns `[]` for
 * `custom`/`none` (custom certs are baked into the vhost already). A wildcard
 * request without a DNS config is impossible (HTTP-01 can't do wildcards), so
 * it's skipped.
 */
export function buildSslScript(site: SiteConfig): string[] {
  if (resolveSslProvider(site) !== 'letsencrypt' || !site.domain) return []
  const ssl = site.ssl
  const dns = ssl?.dns
  const wildcard = ssl?.wildcard === true
  if (wildcard && !dns) return [] // wildcard needs DNS-01; nothing to do without it
  return [
    ...buildCertbotInstallScript(dns),
    ...(dns ? buildDnsCredentialsScript(dns) : []),
    ...buildCertbotIssueScript({
      domain: site.domain,
      aliases: site.aliases,
      email: ssl?.email,
      wildcard,
      dns,
    }),
  ]
}
