/**
 * Cloudflare zone settings: the friendly config shape ts-cloud exposes, and its
 * translation into the `{ setting_id: value }` pairs the API takes.
 *
 * Cloudflare's own ids are terse and inconsistently shaped (`ssl` is an enum
 * string, `brotli` is `'on'|'off'`, HSTS is a nested object under
 * `security_header`), so the config speaks in booleans and plain names and this
 * module owns every mapping. Keeping the translation in one small, pure function
 * is also what makes it testable without touching the network.
 */

/** HSTS (`Strict-Transport-Security`) configuration. */
export interface CloudflareHstsSettings {
  enabled: boolean
  /** Lifetime in seconds. Cloudflare requires one when enabled. @default 31536000 (1 year) */
  maxAge?: number
  /** Apply to every subdomain. @default false */
  includeSubdomains?: boolean
  /**
   * Add the zone to the browser preload lists.
   *
   * Left off by default on purpose: preloading is effectively irreversible on a
   * human timescale, so it should be a deliberate choice rather than something a
   * deploy turns on.
   * @default false
   */
  preload?: boolean
  /** Send `X-Content-Type-Options: nosniff`. @default true */
  noSniff?: boolean
}

/**
 * Zone-level settings ts-cloud can reconcile.
 *
 * Every field is optional and anything left undefined is NOT touched — the zone
 * may hold settings that have nothing to do with this deploy, and a reconcile
 * has no business resetting them to a default it invented.
 */
export interface CloudflareZoneSettings {
  /**
   * How Cloudflare talks to the origin.
   *
   * - `strict` — Full (strict): HTTPS to the origin, certificate verified. The
   *   only mode that actually protects the Cloudflare→origin hop, and the right
   *   answer whenever the origin holds a real certificate.
   * - `full` — HTTPS to the origin, certificate NOT verified. Accepts a
   *   self-signed cert; use only while an origin is still getting its first one.
   * - `flexible` — plaintext to the origin. Cloudflare serves HTTPS to visitors
   *   while the origin hop travels unencrypted, and on an origin that redirects
   *   HTTP to HTTPS it also produces a redirect loop.
   * - `off` — no HTTPS at all.
   */
  ssl?: 'off' | 'flexible' | 'full' | 'strict'
  /** Redirect every HTTP request to HTTPS at the edge. */
  alwaysUseHttps?: boolean
  /** Rewrite http:// references in HTML to https://. */
  automaticHttpsRewrites?: boolean
  /** Minimum TLS version accepted from visitors. */
  minTlsVersion?: '1.0' | '1.1' | '1.2' | '1.3'
  /** Offer TLS 1.3 to visitors. */
  tls13?: boolean
  /** Brotli-compress responses to visitors that accept it. */
  brotli?: boolean
  /** Offer HTTP/3 (QUIC). */
  http3?: boolean
  /** TLS 1.3 0-RTT resumption. */
  zeroRtt?: boolean
  /** Send 103 Early Hints for `Link` headers. */
  earlyHints?: boolean
  /** HSTS. */
  hsts?: CloudflareHstsSettings
  /** Default browser cache TTL in seconds. `0` means "respect the origin". */
  browserCacheTtl?: number
  /** Serve a cached copy when the origin is unreachable. */
  alwaysOnline?: boolean
  /** Proxy WebSocket upgrades. */
  websockets?: boolean
  /**
   * Cloudflare's email-address obfuscation, which REWRITES the HTML the origin
   * sent: `mailto:` links become encoded spans that a script decodes in the
   * browser.
   *
   * Cloudflare enables it on new zones, and it is the one edge setting that
   * changes what a page *is* rather than how it is delivered. A contact link
   * that used to be a plain `mailto:` stops working wherever the script does
   * not run, and the page still looks correct in every check that does not
   * execute JavaScript.
   *
   * ts-cloud turns it OFF by default for that reason. Set it to `true` on a
   * zone that genuinely wants scraper protection more than it wants links that
   * work without JavaScript.
   */
  emailObfuscation?: boolean
  /**
   * Raw escape hatch: setting ids passed straight through, merged last.
   *
   * The mapped fields above cover what a static site needs; this exists so a
   * zone-specific toggle doesn't require a ts-cloud release to reach.
   */
  raw?: Record<string, unknown>
}

const onOff = (value: boolean | undefined): 'on' | 'off' | undefined =>
  value === undefined ? undefined : value ? 'on' : 'off'

/**
 * Translate {@link CloudflareZoneSettings} into Cloudflare setting ids.
 *
 * Undefined inputs produce no entry at all, which is what keeps a reconcile
 * additive: the caller only ever writes settings the config actually names.
 */
export function toCloudflareZoneSettings(settings: CloudflareZoneSettings): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    ssl: settings.ssl,
    always_use_https: onOff(settings.alwaysUseHttps),
    automatic_https_rewrites: onOff(settings.automaticHttpsRewrites),
    min_tls_version: settings.minTlsVersion,
    tls_1_3: onOff(settings.tls13),
    brotli: onOff(settings.brotli),
    http3: onOff(settings.http3),
    '0rtt': onOff(settings.zeroRtt),
    early_hints: onOff(settings.earlyHints),
    browser_cache_ttl: settings.browserCacheTtl,
    always_online: onOff(settings.alwaysOnline),
    websockets: onOff(settings.websockets),
    email_obfuscation: onOff(settings.emailObfuscation),
  }

  if (settings.hsts) {
    mapped.security_header = {
      strict_transport_security: {
        enabled: settings.hsts.enabled,
        max_age: settings.hsts.maxAge ?? 31_536_000,
        include_subdomains: settings.hsts.includeSubdomains ?? false,
        preload: settings.hsts.preload ?? false,
        nosniff: settings.hsts.noSniff ?? true,
      },
    }
  }

  for (const key of Object.keys(mapped)) {
    if (mapped[key] === undefined) delete mapped[key]
  }

  return { ...mapped, ...(settings.raw ?? {}) }
}

/**
 * Sensible zone settings for a static site served from a ts-cloud box behind
 * Cloudflare's proxy.
 *
 * `ssl: 'strict'` is deliberate: the box terminates TLS with a real Let's
 * Encrypt certificate (rpx + tlsx), so there is no reason to accept an
 * unverified origin — and `flexible` would additionally loop, because the
 * gateway redirects plain HTTP to HTTPS.
 */
export const STATIC_SITE_ZONE_SETTINGS: CloudflareZoneSettings = {
  ssl: 'strict',
  alwaysUseHttps: true,
  automaticHttpsRewrites: true,
  minTlsVersion: '1.2',
  tls13: true,
  brotli: true,
  http3: true,
  earlyHints: true,
  alwaysOnline: true,
  // Off: it rewrites `mailto:` links into script-decoded spans, so a contact
  // link silently stops working without JavaScript. Delivery is the CDN's job;
  // altering the document is not.
  emailObfuscation: false,
  // Browser TTL is left to the cache rules, which can distinguish a
  // fingerprinted asset from an HTML document. A blanket zone-level TTL cannot.
  browserCacheTtl: 0,
}
