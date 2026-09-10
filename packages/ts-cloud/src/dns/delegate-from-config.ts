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
  zone?: ZoneSettingsConfig
}

/** Zone settings a deploy keeps true. Mirrors `DnsZoneConfig` in core. */
export interface ZoneSettingsConfig {
  ssl?: 'off' | 'flexible' | 'full' | 'strict'
  alwaysUseHttps?: boolean
  minTlsVersion?: '1.0' | '1.1' | '1.2' | '1.3'
  visitorLocationHeaders?: boolean
}

/**
 * Managed request-header transforms, by config name.
 *
 * Separate from the settings map because Cloudflare keeps these behind a
 * different endpoint entirely — `/managed_headers`, not `/settings` — so they
 * cannot be reconciled by the same call even though a project declares them in
 * the same `zone` block.
 */
const MANAGED_REQUEST_HEADERS: Record<string, keyof ZoneSettingsConfig> = {
  add_visitor_location_headers: 'visitorLocationHeaders',
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

/**
 * Translate the config's names into Cloudflare's setting ids.
 *
 * Kept as an explicit map rather than a snake_case transform, because the two
 * vocabularies genuinely differ — `alwaysUseHttps` is `always_use_https`, but
 * `ssl` is `ssl` — and a transform that is right four times out of five fails
 * silently on the fifth: Cloudflare 404s an unknown setting id, which
 * `applyZoneSettings` collects as a failure nobody reads.
 *
 * Cloudflare spells booleans 'on' / 'off'.
 */
function toCloudflareSettings(zone: ZoneSettingsConfig): Record<string, unknown> {
  const desired: Record<string, unknown> = {}

  if (zone.ssl !== undefined)
    desired.ssl = zone.ssl
  if (zone.alwaysUseHttps !== undefined)
    desired.always_use_https = zone.alwaysUseHttps ? 'on' : 'off'
  if (zone.minTlsVersion !== undefined)
    desired.min_tls_version = zone.minTlsVersion

  return desired
}

/**
 * The managed header transforms the config asks for, by Cloudflare's id.
 *
 * Same reasoning as {@link toCloudflareSettings}: an explicit map, because the
 * id (`add_visitor_location_headers`) and the config name
 * (`visitorLocationHeaders`) are not mechanically related.
 */
function toManagedRequestHeaders(zone: ZoneSettingsConfig): Record<string, boolean> {
  const desired: Record<string, boolean> = {}

  for (const [id, key] of Object.entries(MANAGED_REQUEST_HEADERS)) {
    const value = zone[key]
    if (typeof value === 'boolean')
      desired[id] = value
  }

  return desired
}

export interface ZoneSettingsReport {
  status: 'applied' | 'unchanged'
  domain: string
  changed: Array<{ id: string, from: unknown, to: unknown }>
  failed: Array<{ id: string, error: string }>
}

/**
 * Reconcile `dns.zone` against the provider, on every deploy.
 *
 * Separate from the delegation on purpose: delegating happens once, but a zone
 * setting is something a person can change in a dashboard at any time, and the
 * point of declaring it is that the next deploy puts it back. Running only at
 * delegation would make `ssl: 'strict'` true exactly once and then let it
 * drift for the life of the zone.
 *
 * A setting the plan does not allow is reported, never thrown — `applyZoneSettings`
 * collects those, and one unavailable toggle must not fail a deploy that has
 * already shipped code.
 */
export async function applyDeclaredZoneSettings(
  config: DelegationConfig,
  options: { credentials?: DelegationCredentials, env?: Record<string, string | undefined> } = {},
): Promise<ZoneSettingsReport | DelegationSkipped> {
  if (!config.zone)
    return { status: 'skipped', reason: 'no dns.zone configured' }

  if (!config.domain)
    return { status: 'skipped', reason: 'no dns.domain configured' }

  if (config.provider !== 'cloudflare')
    return { status: 'skipped', reason: `zone settings are not supported for ${config.provider ?? 'this provider'}` }

  const desired = toCloudflareSettings(config.zone)
  const desiredHeaders = toManagedRequestHeaders(config.zone)

  if (Object.keys(desired).length === 0 && Object.keys(desiredHeaders).length === 0)
    return { status: 'skipped', reason: 'dns.zone declares no settings' }

  const credentials = options.credentials ?? credentialsFromEnv(options.env ?? process.env)
  if (!credentials.cloudflareApiToken)
    return { status: 'skipped', reason: 'CLOUDFLARE_API_TOKEN is not set' }

  const provider = new CloudflareProvider(credentials.cloudflareApiToken, {
    accountId: credentials.cloudflareAccountId,
  })

  const settings = await provider.applyZoneSettings(config.domain, desired)

  // Header transforms go through their own endpoint, but they are declared in
  // the same block and read the same way in a log, so the two sets of outcomes
  // are reported as one.
  const headers = Object.keys(desiredHeaders).length > 0
    ? await provider.applyManagedRequestHeaders(config.domain, desiredHeaders)
    : { changed: [], failed: [] }

  const changed = [...settings.changed, ...headers.changed]
  const failed = [...settings.failed, ...headers.failed]

  return {
    status: changed.length > 0 ? 'applied' : 'unchanged',
    domain: config.domain,
    changed,
    failed,
  }
}

/** One line per outcome, for a deploy log. */
export function describeZoneSettings(result: ZoneSettingsReport | DelegationSkipped): string[] {
  if (result.status === 'skipped')
    return [`dns: zone settings skipped — ${result.reason}`]

  const lines: string[] = []

  for (const change of result.changed)
    lines.push(`dns: ${result.domain} ${change.id}: ${String(change.from)} → ${String(change.to)}`)

  if (result.status === 'unchanged' && result.failed.length === 0)
    lines.push(`dns: ${result.domain} zone settings already as declared`)

  for (const failure of result.failed)
    lines.push(`dns: ${result.domain} could not set ${failure.id} — ${failure.error}`)

  return lines
}
