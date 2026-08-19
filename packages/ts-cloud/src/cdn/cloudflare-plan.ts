/**
 * Turn a `CloudConfig` into a concrete Cloudflare CDN reconcile plan.
 *
 * Kept separate from {@link import('./cloudflare').reconcileCloudflareCdn} so
 * the "what did the operator ask for" question is answerable — and testable —
 * without a zone, a token, or a network. The reconciler takes explicit values;
 * this is the only place that reads config and environment.
 */
import type { CdnFrontConfig, CloudConfig, SiteConfig } from '@ts-cloud/core'
import type { CloudflareCacheRuleSettings } from './cloudflare-rules'
import type { CloudflareZoneSettings } from './cloudflare-settings'
import type { CloudflareOriginGuard } from './cloudflare'
import { gatewayHostnames } from '../drivers/shared/rpx-gateway'
import { STATIC_SITE_ZONE_SETTINGS } from './cloudflare-settings'

export interface CloudflareCdnPlan {
  /** Zone apex the records live in. */
  zone: string
  /** Hostnames to front. */
  hosts: string[]
  /** API token. */
  apiToken: string
  zoneId?: string
  accountId?: string
  proxied: boolean
  settings: CloudflareZoneSettings
  cache?: CloudflareCacheRuleSettings
  originGuard?: CloudflareOriginGuard
  purge: boolean
  skipOriginProbe: boolean
}

export interface ResolveCloudflareCdnPlanResult {
  /** The plan, or `null` when this config does not ask for a Cloudflare CDN. */
  plan: CloudflareCdnPlan | null
  /**
   * Reasons a requested CDN could not be planned. Non-empty with a `null` plan
   * means "you asked for this and it is misconfigured", which is worth surfacing
   * — as distinct from "you never asked", which yields no plan and no errors.
   */
  errors: string[]
}

/** Environment lookup, injectable so tests never touch `process.env`. */
export type EnvLookup = (key: string) => string | undefined

const defaultEnv: EnvLookup = key => process.env[key]

/**
 * Derive the zone apex for a hostname.
 *
 * A configured `infrastructure.dns.domain` wins whenever the host sits inside
 * it, because that is the only input that knows about multi-label suffixes; the
 * last-two-labels fallback is a guess that is right for `example.com` and wrong
 * for `example.co.uk`. The provider corrects the guess anyway once it resolves
 * the zone by id, so this only has to be good enough to route the lookup.
 */
export function resolveZoneApex(host: string, configuredDomain?: string): string {
  const hostname = host.replace(/\.$/, '').toLowerCase()
  if (configuredDomain) {
    const domain = configuredDomain.replace(/\.$/, '').toLowerCase()
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return domain
  }
  return hostname.split('.').slice(-2).join('.')
}

/**
 * Resolve the Cloudflare CDN plan for a config, or `null` when none applies.
 *
 * A plan is produced only when `infrastructure.compute.proxy.cdn.provider` is
 * `'cloudflare'`. Everything else — hosts, zone, credentials — is filled in from
 * the config with environment fallbacks, so the common case is a two-line CDN
 * block plus a token in the environment.
 */
export function resolveCloudflareCdnPlan(
  config: CloudConfig,
  options: { env?: EnvLookup } = {},
): ResolveCloudflareCdnPlanResult {
  const env = options.env ?? defaultEnv
  const cdn: CdnFrontConfig | undefined = config.infrastructure?.compute?.proxy?.cdn
  const errors: string[] = []

  if (!cdn || cdn.provider !== 'cloudflare') return { plan: null, errors }

  if (cdn.originDomain) {
    errors.push(
      `compute.proxy.cdn.originDomain (${cdn.originDomain}) is ignored for Cloudflare: the proxy forwards to the address in the record it fronts, ` +
        `so no separate origin hostname is needed — and publishing one gives clients a documented way around the edge.`,
    )
  }

  const apiToken = env('CLOUDFLARE_API_TOKEN')
  if (!apiToken) {
    errors.push('CLOUDFLARE_API_TOKEN is not set — the Cloudflare CDN cannot be reconciled.')
    return { plan: null, errors }
  }

  // Fronted hosts default to every hostname the gateway answers for, which is
  // the same set DNS publishes. Listing them explicitly is for the case where
  // only some of a box's names should go through the edge.
  const sites = (config.sites ?? {}) as Record<string, SiteConfig | undefined>
  const hosts = cdn.frontedHosts?.length
    ? [...new Set(cdn.frontedHosts.map(host => host.toLowerCase()))]
    : gatewayHostnames(sites, { autoWww: config.infrastructure?.compute?.proxy?.autoWww !== false })

  if (hosts.length === 0) {
    errors.push('No hostnames to front — set compute.proxy.cdn.frontedHosts, or give a site a domain.')
    return { plan: null, errors }
  }

  const configuredDomain = config.infrastructure?.dns?.domain
  const zones = new Set(hosts.map(host => resolveZoneApex(host, configuredDomain)))
  if (zones.size > 1) {
    errors.push(
      `Fronted hosts span more than one zone (${[...zones].join(', ')}). ` +
        `A Cloudflare zone is configured as a unit, so run one CDN config per zone.`,
    )
    return { plan: null, errors }
  }

  const cf = cdn.cloudflare ?? {}
  const guard: CloudflareOriginGuard | undefined = cdn.secret
    ? { header: cdn.secretHeader ?? 'X-Origin-Verify', value: cdn.secret }
    : undefined

  return {
    plan: {
      zone: [...zones][0],
      hosts,
      apiToken,
      zoneId: cf.zoneId ?? env('CLOUDFLARE_ZONE_ID'),
      accountId: cf.accountId ?? env('CLOUDFLARE_ACCOUNT_ID'),
      proxied: cf.proxied !== false,
      settings: (cf.settings as CloudflareZoneSettings | undefined) ?? STATIC_SITE_ZONE_SETTINGS,
      cache: cf.cache as CloudflareCacheRuleSettings | undefined,
      originGuard: guard,
      purge: cf.purgeOnDeploy !== false,
      skipOriginProbe: cf.skipOriginProbe === true,
    },
    errors,
  }
}
