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
 * The three rules are **mutually exclusive by construction** — each carries the
 * negation of the ones before it — rather than relying on evaluation order.
 * That is deliberate. Cloudflare applies every matching rule in this phase and
 * lets a later one override an earlier one's settings, so a plain catch-all for
 * documents (`http.host eq …`) silently matches `.js` and `.css` too and undoes
 * the asset rule: fingerprinted files come back with the HTML's short browser
 * TTL, which is the opposite of the intent and invisible unless you inspect the
 * response headers.
 *
 * Every rule is also scoped to `hosts`. The zone may serve names that have
 * nothing to do with this site, and a catch-all matching them would quietly
 * start caching someone else's dynamic responses.
 */
export function buildStaticSiteCacheRules(
  hosts: readonly string[],
  settings: CloudflareCacheRuleSettings = {},
): CloudflareRule[] {
  if (settings.enabled === false || hosts.length === 0) return []

  const host = hostCondition(hosts)
  const rules: CloudflareRule[] = []

  const bypassPaths = settings.bypassPaths ?? []
  const bypassClause = bypassPaths.length > 0
    ? `(${bypassPaths.map(path => `starts_with(http.request.uri.path, ${quote(path)})`).join(' or ')})`
    : undefined

  if (bypassClause) {
    rules.push({
      action: 'set_cache_settings',
      description: 'bypass cache',
      expression: `(${host} and ${bypassClause})`,
      enabled: true,
      action_parameters: { cache: false },
    })
  }

  // Shared prefix for the two caching rules: in scope, and not a bypassed path.
  const cacheable = bypassClause ? `${host} and not ${bypassClause}` : host

  const extensions = settings.assetExtensions ?? DEFAULT_STATIC_ASSET_EXTENSIONS
  const assetClause = extensions.length > 0
    ? `lower(http.request.uri.path.extension) in ${set([...extensions])}`
    : undefined

  if (assetClause) {
    rules.push({
      action: 'set_cache_settings',
      description: 'cache fingerprinted assets',
      expression: `(${cacheable} and ${assetClause})`,
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
    expression: assetClause ? `(${cacheable} and not ${assetClause})` : `(${cacheable})`,
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
