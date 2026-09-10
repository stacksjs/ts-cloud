/**
 * Turn `infrastructure.dns.registrar` into an actual delegation.
 *
 * The deploy already knows where a zone should live — `dns.provider` — and now
 * also where the domain is registered. Everything needed to move the first onto
 * the second is therefore in the config, and the only reason it was ever a
 * manual job at two dashboards is that nothing joined the two halves up.
 *
 * Safe to call on every deploy: once the registrar points at the provider this
 * returns `already-delegated` without reading or writing a record.
 */

import type { DnsProvider } from './types'
import type { DelegationReport } from './delegation'
import { CloudflareProvider } from './cloudflare'
import { GoDaddyProvider } from './godaddy'
import { PorkbunProvider } from './porkbun'
import { delegateZone, isNameserverRegistrar, isZoneHost } from './delegation'

/** The slice of `infrastructure.dns` this needs. */
export interface DelegationConfig {
  domain?: string
  provider?: 'route53' | 'cloudflare' | 'porkbun' | 'godaddy'
  registrar?: {
    provider: 'porkbun' | 'godaddy'
    proxied?: string[]
    dryRun?: boolean
    delegate?: boolean
  }
}

export interface DelegationCredentials {
  porkbunApiKey?: string
  porkbunSecretKey?: string
  godaddyApiKey?: string
  godaddyApiSecret?: string
  cloudflareApiToken?: string
  cloudflareAccountId?: string
}

/** Why a delegation was not attempted. Never a failure — just not applicable. */
export interface DelegationSkipped {
  status: 'skipped'
  reason: string
}

function credentialsFromEnv(env: Record<string, string | undefined>): DelegationCredentials {
  return {
    porkbunApiKey: env.PORKBUN_API_KEY,
    porkbunSecretKey: env.PORKBUN_SECRET_KEY,
    godaddyApiKey: env.GODADDY_API_KEY,
    godaddyApiSecret: env.GODADDY_API_SECRET,
    cloudflareApiToken: env.CLOUDFLARE_API_TOKEN,
    cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
  }
}

function buildRegistrar(
  provider: 'porkbun' | 'godaddy',
  credentials: DelegationCredentials,
): (DnsProvider & { getNameServers: (d: string) => Promise<string[]>, updateNameServers: (d: string, ns: string[]) => Promise<boolean> }) | string {
  if (provider === 'porkbun') {
    if (!credentials.porkbunApiKey || !credentials.porkbunSecretKey)
      return 'PORKBUN_API_KEY / PORKBUN_SECRET_KEY are not set'
    return new PorkbunProvider(credentials.porkbunApiKey, credentials.porkbunSecretKey)
  }

  if (!credentials.godaddyApiKey || !credentials.godaddyApiSecret)
    return 'GODADDY_API_KEY / GODADDY_API_SECRET are not set'

  const godaddy = new GoDaddyProvider(credentials.godaddyApiKey, credentials.godaddyApiSecret)
  if (!isNameserverRegistrar(godaddy))
    return 'the GoDaddy provider cannot change nameservers'
  return godaddy as any
}

/**
 * Delegate `dns.domain` from its registrar to `dns.provider`, if the config
 * asks for it and the credentials are there.
 *
 * Returns a `skipped` result rather than throwing when the delegation does not
 * apply — a project with no registrar declared, or one whose zone is already
 * where it belongs, is not an error and must not fail a deploy.
 */
export async function delegateZoneFromConfig(
  config: DelegationConfig,
  options: { credentials?: DelegationCredentials, env?: Record<string, string | undefined> } = {},
): Promise<DelegationReport | DelegationSkipped> {
  const registrarConfig = config.registrar
  if (!registrarConfig)
    return { status: 'skipped', reason: 'no dns.registrar configured' }

  if (registrarConfig.delegate === false)
    return { status: 'skipped', reason: 'dns.registrar.delegate is false' }

  if (!config.domain)
    return { status: 'skipped', reason: 'no dns.domain configured' }

  // Delegating to the registrar itself is what every un-migrated project looks
  // like, and it is a no-op rather than a mistake.
  if (!config.provider || config.provider === registrarConfig.provider)
    return { status: 'skipped', reason: `dns.provider is already ${registrarConfig.provider}` }

  if (config.provider !== 'cloudflare')
    return { status: 'skipped', reason: `delegation to ${config.provider} is not supported yet` }

  const credentials = options.credentials ?? credentialsFromEnv(options.env ?? process.env)

  if (!credentials.cloudflareApiToken)
    return { status: 'skipped', reason: 'CLOUDFLARE_API_TOKEN is not set' }

  const registrar = buildRegistrar(registrarConfig.provider, credentials)
  if (typeof registrar === 'string')
    return { status: 'skipped', reason: registrar }

  const host = new CloudflareProvider(credentials.cloudflareApiToken, {
    accountId: credentials.cloudflareAccountId,
  })

  if (!isZoneHost(host))
    return { status: 'skipped', reason: 'the Cloudflare provider cannot create zones' }

  return delegateZone({
    domain: config.domain,
    registrar,
    host: host as any,
    proxiedHosts: registrarConfig.proxied,
    accountId: credentials.cloudflareAccountId,
    dryRun: registrarConfig.dryRun,
  })
}

/** One line per outcome, for a deploy log. */
export function describeDelegation(result: DelegationReport | DelegationSkipped): string[] {
  if (result.status === 'skipped')
    return [`dns: delegation skipped — ${result.reason}`]

  const lines: string[] = []

  switch (result.status) {
    case 'already-delegated':
      lines.push(`dns: ${result.domain} already delegated to ${result.targetNameservers.join(', ')}`)
      break
    case 'delegated':
      lines.push(
        `dns: ${result.domain} delegated to ${result.targetNameservers.join(', ')} `
        + `(${result.records.filter(r => r.status === 'copied').length} record(s) copied)`,
      )
      lines.push('dns: nameserver changes take up to 24h to propagate; the old zone answers until then')
      break
    case 'ready':
      lines.push(`dns: ${result.domain} would delegate to ${result.targetNameservers.join(', ')} (dry run)`)
      break
    case 'blocked':
      lines.push(`dns: ${result.domain} NOT delegated — nameservers left at ${result.currentNameservers.join(', ')}`)
      for (const record of result.missing)
        lines.push(`  missing at destination: ${record.type} ${record.name}`)
      break
  }

  for (const warning of result.warnings)
    lines.push(`  ${warning}`)

  return lines
}
