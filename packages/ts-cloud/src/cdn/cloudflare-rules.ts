/**
 * Cloudflare Ruleset rules ts-cloud generates: cache rules for a static site and
 * the request-header transform that carries the origin-lockdown secret.
 *
 * Everything here is pure — rules in, rules out — so the expression syntax can
 * be tested without a zone. Writing them is {@link
 * import('../dns/cloudflare').CloudflareProvider.putManagedPhaseRules}'s job.
 */
import type { CloudflareRule } from '../dns/cloudflare'

/**
 * File extensions treated as immutable build output.
 *
 * These are the extensions a bundler fingerprints (`app.4f2a9c.js`), so a given
 * URL's bytes never change and the edge can hold them effectively forever. HTML
 * is deliberately absent: it carries the references to the fingerprinted files,
 * so caching it as long would pin visitors to a stale deploy.
 */
export const DEFAULT_STATIC_ASSET_EXTENSIONS: readonly string[] = [
  'js', 'mjs', 'cjs', 'css', 'map',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico',
  'mp4', 'webm', 'ogg', 'mp3', 'wav',
  'pdf', 'wasm',
]

export interface CloudflareCacheRuleSettings {
  /** Generate cache rules at all. @default true */
  enabled?: boolean
  /** Extensions treated as immutable, fingerprinted assets. */
  assetExtensions?: readonly string[]
  /** Edge TTL for those assets, in seconds. @default 2592000 (30 days) */
  assetEdgeTtl?: number
  /** Browser TTL for those assets, in seconds. @default 31536000 (1 year) */
  assetBrowserTtl?: number
  /** Edge TTL for HTML documents, in seconds. @default 3600 (1 hour) */
  documentEdgeTtl?: number
  /**
   * Browser TTL for HTML documents, in seconds. @default 0
   *
   * Zero means the browser revalidates every navigation while the edge still
   * absorbs the traffic — a deploy then reaches visitors as soon as the edge
   * cache is purged, without a stale copy pinned in their local cache.
   */
  documentBrowserTtl?: number
  /**
   * Path prefixes that must never be cached (`/api`, `/admin`, …). Matched with
   * `starts_with`, so `/api` also covers `/api/anything`.
   */
  bypassPaths?: readonly string[]
}

/** Quote a string for a Cloudflare Ruleset expression literal. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Render a Ruleset `in {…}` set literal (space-separated, not comma). */
function set(values: readonly string[]): string {
  return `{${values.map(quote).join(' ')}}`
}

/** `http.host in {…}` for the hosts a rule applies to. */
export function hostCondition(hosts: readonly string[]): string {
  if (hosts.length === 1) return `http.host eq ${quote(hosts[0])}`
  return `http.host in ${set(hosts)}`
}

/**
 * Cache rules for a static site fronted by Cloudflare.
 *
 * Order matters: Cloudflare evaluates cache rules top-down, so bypasses come
 * first, then the immutable-asset rule, then the catch-all for documents. Every
 * rule is scoped to `hosts` — the zone may serve other names that have nothing
 * to do with this site, and a catch-all that matched them would quietly start
 * caching someone else's dynamic responses.
 */
export function buildStaticSiteCacheRules(
  hosts: readonly string[],
  settings: CloudflareCacheRuleSettings = {},
): CloudflareRule[] {
  if (settings.enabled === false || hosts.length === 0) return []

  const host = hostCondition(hosts)
  const rules: CloudflareRule[] = []

  const bypassPaths = settings.bypassPaths ?? []
  if (bypassPaths.length > 0) {
    const paths = bypassPaths
      .map(path => `starts_with(http.request.uri.path, ${quote(path)})`)
      .join(' or ')
    rules.push({
      action: 'set_cache_settings',
      description: 'bypass cache',
      expression: `(${host} and (${paths}))`,
      enabled: true,
      action_parameters: { cache: false },
    })
  }

  const extensions = settings.assetExtensions ?? DEFAULT_STATIC_ASSET_EXTENSIONS
  if (extensions.length > 0) {
    rules.push({
      action: 'set_cache_settings',
      description: 'cache fingerprinted assets',
      expression: `(${host} and lower(http.request.uri.path.extension) in ${set([...extensions])})`,
      enabled: true,
      action_parameters: {
        cache: true,
        edge_ttl: { mode: 'override_origin', default: settings.assetEdgeTtl ?? 2_592_000 },
        browser_ttl: { mode: 'override_origin', default: settings.assetBrowserTtl ?? 31_536_000 },
      },
    })
  }

  rules.push({
    action: 'set_cache_settings',
    description: 'cache documents',
    expression: `(${host})`,
    enabled: true,
    action_parameters: {
      cache: true,
      edge_ttl: { mode: 'override_origin', default: settings.documentEdgeTtl ?? 3_600 },
      browser_ttl: { mode: 'override_origin', default: settings.documentBrowserTtl ?? 0 },
    },
  })

  return rules
}

/**
 * A request-header transform that stamps the origin-lockdown secret onto every
 * request Cloudflare forwards to the box.
 *
 * This is the Cloudflare half of ts-cloud's origin guard: rpx rejects any
 * request to these hosts that arrives without the header
 * (`RpxGatewayConfig.originGuard`), so a client that discovers the origin IP
 * and connects to it directly cannot bypass the edge. Without the pair, the
 * origin stays openly reachable and the CDN is advisory.
 *
 * It goes in the LATE transform phase so the header survives any earlier
 * rewrite and is not visible to rules the zone owner writes in the normal
 * transform phase.
 */
export function buildOriginGuardRule(
  hosts: readonly string[],
  header: string,
  value: string,
): CloudflareRule[] {
  if (hosts.length === 0 || !header || !value) return []

  return [
    {
      action: 'rewrite',
      description: 'origin guard header',
      expression: `(${hostCondition(hosts)})`,
      enabled: true,
      action_parameters: {
        headers: {
          [header]: { operation: 'set', value },
        },
      },
    },
  ]
}
