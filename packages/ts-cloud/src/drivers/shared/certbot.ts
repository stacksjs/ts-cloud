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
import type { SiteConfig } from '@ts-cloud/core'

/** Resolve the effective SSL provider for a site (Let's Encrypt by default when it has a domain). */
export function resolveSslProvider(site: SiteConfig): 'letsencrypt' | 'custom' | 'none' {
  if (site.ssl?.provider)
    return site.ssl.provider
  return site.domain ? 'letsencrypt' : 'none'
}

/** Install certbot + the nginx plugin and ensure the auto-renew timer is enabled. */
export function buildCertbotInstallScript(): string[] {
  return [
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get install -y certbot python3-certbot-nginx',
    // Reload nginx after each successful renewal so the new cert is served.
    'mkdir -p /etc/letsencrypt/renewal-hooks/deploy',
    'cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<\'TS_CLOUD_HOOK_EOF\'',
    '#!/bin/sh',
    'systemctl reload nginx',
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
}

/**
 * Issue (or expand) a Let's Encrypt cert for the domain via the nginx plugin.
 * Idempotent: `--keep-until-expiring` reuses a valid cert, so re-running on
 * every deploy is safe.
 */
export function buildCertbotIssueScript(options: CertbotIssueOptions): string[] {
  const domains = [options.domain, ...(options.aliases || [])].filter(Boolean)
  const args = [
    'certbot --nginx',
    '--non-interactive',
    '--agree-tos',
    '--keep-until-expiring',
    options.redirect === false ? '--no-redirect' : '--redirect',
  ]
  if (options.email)
    args.push(`-m ${options.email}`)
  else
    args.push('--register-unsafely-without-email')
  for (const d of domains)
    args.push(`-d ${d}`)

  return [args.join(' ')]
}

/**
 * Full SSL script for a site, dispatched on its provider. Returns `[]` for
 * `custom`/`none` (custom certs are baked into the vhost already).
 */
export function buildSslScript(site: SiteConfig): string[] {
  if (resolveSslProvider(site) !== 'letsencrypt' || !site.domain)
    return []
  return [
    ...buildCertbotInstallScript(),
    ...buildCertbotIssueScript({
      domain: site.domain,
      aliases: site.aliases,
      email: site.ssl?.email,
    }),
  ]
}
