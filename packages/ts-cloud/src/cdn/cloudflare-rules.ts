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

/**
 * Request headers that select a DIFFERENT body at the same url.
 *
 * A single-page app's router fetches the url the browser would navigate to and
 * asks for a fragment of it — no `<head>`, no stylesheet link, no nav — with a
 * request header. Two representations therefore share one cache key.
 *
 * Origins are supposed to declare that with `Vary`, and stx now does. Cloudflare
 * does not honour `Vary` on anything but `Accept-Encoding`, so on the edge the
 * declaration changes nothing: whichever representation is fetched first is
 * stored under the bare url and served to everyone until the TTL expires. When
 * that is the fragment — one visitor's prefetch is enough — every subsequent
 * visitor gets an unstyled, headless page. The origin stays healthy throughout,
 * which is why it survives every check that looks at the box.
 *
 * The edge cannot split the key, so it must not hold these at all.
 */
export const DEFAULT_NEGOTIATED_REQUEST_HEADERS: readonly NegotiatedRequestHeader[] = [
  // stx's SPA router (stacksjs/stx#1958).
  { name: 'x-stx-router', value: 'true' },
]

/** A request header, optionally narrowed to one value, that renegotiates the body. */
export interface NegotiatedRequestHeader {
  /** Header name, lowercase — Cloudflare's header map is lowercase-keyed. */
  name: string
  /** Only bypass when the header carries this value. Omit to match its presence. */
  value?: string
}

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
  /**
   * Request headers that select a different body at the same url.
   *
   * Defaults to {@link DEFAULT_NEGOTIATED_REQUEST_HEADERS}. Pass `[]` to cache
   * these too — only correct for a site with no client-side router at all.
   */
  negotiatedRequestHeaders?: readonly NegotiatedRequestHeader[]
}

/** Quote a string for a Cloudflare Ruleset expression literal. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Render a Ruleset `in {…}` set literal (space-separated, not comma). */
function set(values: readonly string[]): string {
  return `{${values.map(quote).join(' ')}}`
}

/**
 * `any(http.request.headers[…][*] == …)` for one renegotiating header.
 *
 * Cloudflare's header map is lowercase-keyed and multi-valued, so the name is
 * lowered and every value is tested rather than only the first.
 */
function negotiatedHeaderCondition(header: NegotiatedRequestHeader): string {
  const name = `http.request.headers[${quote(header.name.toLowerCase())}]`
  return header.value === undefined
    ? `len(${name}) > 0`
    : `any(${name}[*] == ${quote(header.value)})`
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
 *
 * The bypass rule comes first and is now always emitted, because it carries the
 * renegotiating request headers as well as `bypassPaths` — a url that answers
 * two bodies is not cacheable under the url alone, and the edge has no other
 * key. See {@link DEFAULT_NEGOTIATED_REQUEST_HEADERS}.
 */
export function buildStaticSiteCacheRules(
  hosts: readonly string[],
  settings: CloudflareCacheRuleSettings = {},
): CloudflareRule[] {
  if (settings.enabled === false || hosts.length === 0) return []

  const host = hostCondition(hosts)
  const rules: CloudflareRule[] = []

  const bypassPaths = settings.bypassPaths ?? []
  const pathClauses = bypassPaths.map(path => `starts_with(http.request.uri.path, ${quote(path)})`)

  // A url whose body depends on a request header cannot be cached under the url
  // alone, and the edge keys on nothing else. See
  // DEFAULT_NEGOTIATED_REQUEST_HEADERS for what caching one anyway does to a
  // site. Folded into the same bypass as the paths: both mean "not ours to
  // hold", and one rule is one thing to read in the dashboard.
  const negotiated = settings.negotiatedRequestHeaders ?? DEFAULT_NEGOTIATED_REQUEST_HEADERS
  const headerClauses = negotiated.map(negotiatedHeaderCondition)

  const bypassClauses = [...pathClauses, ...headerClauses]
  const bypassClause = bypassClauses.length > 0
    ? `(${bypassClauses.join(' or ')})`
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
