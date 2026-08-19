/**
 * Put Cloudflare's proxy CDN in front of a ts-cloud origin.
 *
 * Cloudflare's CDN is not a separate resource you point at an origin the way
 * CloudFront is — it *is* the DNS record. A proxied ("orange cloud") A/AAAA
 * record makes the public answer a Cloudflare anycast address, and Cloudflare
 * forwards to the address stored in the record. Two consequences shape this
 * module:
 *
 *  - there is no origin hostname to invent. CloudFront needs a dedicated
 *    `origin.example.com` because a distribution whose origin is one of its own
 *    aliases resolves back into itself; Cloudflare reads the origin address out
 *    of the record it is proxying, so the apex fronts itself without looping.
 *  - the CDN and the DNS record cannot drift apart, because they are one object.
 *    That is why proxy state has to be preserved across upserts rather than
 *    re-derived (see `CloudflareProvider.upsertRecord`).
 *
 * The reconcile is ordered so it is safe to run on a zone that has never been
 * touched AND on one already serving traffic: addresses first (so the origin is
 * reachable), then zone settings, then rules, then a purge — never the reverse,
 * which would briefly enforce `Full (strict)` against an origin the deploy has
 * not yet pointed anywhere.
 */
import type { CloudflareProvider, CloudflareRule } from '../dns/cloudflare'
import type { CloudflareCacheRuleSettings } from './cloudflare-rules'
import type { CloudflareZoneSettings } from './cloudflare-settings'
import { hostAcceptsIpv6 } from '../deploy/server-dns'
import { buildOriginGuardRule, buildStaticSiteCacheRules } from './cloudflare-rules'
import { STATIC_SITE_ZONE_SETTINGS, toCloudflareZoneSettings } from './cloudflare-settings'
import { probeOriginTls } from './origin-tls'

export interface CloudflareOriginGuard {
  /** Header Cloudflare stamps on the origin hop. */
  header: string
  /** Shared secret value; rpx rejects fronted hosts that arrive without it. */
  value: string
}

export interface ReconcileCloudflareCdnOptions {
  provider: CloudflareProvider
  /** Zone apex (`example.com`). */
  zone: string
  /** Public hostnames served through the proxy. */
  hosts: string[]
  /** Origin IPv4 the proxied records point at. */
  ipv4: string
  /** Origin IPv6, when the box has one. */
  ipv6?: string
  /**
   * Serve these hosts through Cloudflare's proxy. @default true
   *
   * Set `false` for a DNS-only zone — records still reconcile, the CDN-specific
   * work (settings, cache rules, purge) is skipped.
   */
  proxied?: boolean
  /** Zone settings to apply. Defaults to {@link STATIC_SITE_ZONE_SETTINGS}. */
  settings?: CloudflareZoneSettings
  /** Cache-rule tuning. */
  cache?: CloudflareCacheRuleSettings
  /** Origin lockdown. Omit to leave the origin reachable directly. */
  originGuard?: CloudflareOriginGuard
  /** Purge the edge cache once everything else is in place. @default true */
  purge?: boolean
  /** Record TTL for unproxied records, in seconds. @default 300 */
  ttl?: number
  /**
   * Skip the origin TLS probe and proxy immediately.
   *
   * The probe only exists to avoid stranding a box that has no certificate yet;
   * a caller that knows the origin is ready can skip the round trip.
   * @default false
   */
  skipOriginProbe?: boolean
}

export interface CloudflareCdnReport {
  /** Records confirmed written, with the proxy state each ended up in. */
  records: Array<{ host: string, type: 'A' | 'AAAA', content: string, proxied: boolean }>
  /** Zone settings actually changed. */
  settingsChanged: Array<{ id: string, from: unknown, to: unknown }>
  /** Cache rules written. */
  cacheRules: number
  /** Whether the origin-guard transform rule was written. */
  originGuard: boolean
  /** Whether the edge cache was purged. */
  purged: boolean
  /**
   * Hosts published DNS-only because the origin could not yet serve a trusted
   * certificate for them. Re-run the deploy once the certificate is issued.
   */
  deferredProxy: Array<{ host: string, reason: string }>
  warnings: string[]
}

/**
 * Reconcile a Cloudflare zone so `hosts` are served from the edge and forwarded
 * to a ts-cloud origin.
 *
 * Warnings are collected rather than thrown throughout. This runs at the tail of
 * a deploy that has already shipped code to a box: a plan-gated zone setting or
 * a rules permission the token lacks is worth reporting loudly, but it is not
 * worth reporting as "the deploy failed" when the site is up and serving.
 */
export async function reconcileCloudflareCdn(
  options: ReconcileCloudflareCdnOptions,
): Promise<CloudflareCdnReport> {
  const {
    provider,
    zone,
    hosts,
    ipv4,
    ipv6,
    proxied = true,
    settings = STATIC_SITE_ZONE_SETTINGS,
    cache,
    originGuard,
    purge = true,
    ttl = 300,
    skipOriginProbe = false,
  } = options

  const report: CloudflareCdnReport = {
    records: [],
    settingsChanged: [],
    cacheRules: 0,
    originGuard: false,
    purged: false,
    deferredProxy: [],
    warnings: [],
  }

  if (hosts.length === 0) return report

  // ---- 1. Address records ------------------------------------------------
  //
  // Proxy state is decided per host, because the certificate is per host: one
  // name being ready says nothing about a name added later in the same deploy.
  const proxiedHosts: string[] = []

  for (const host of hosts) {
    let hostProxied = proxied

    if (proxied && !skipOriginProbe) {
      const probe = await probeOriginTls({ address: ipv4, serverName: host })
      if (!probe.trusted) {
        hostProxied = false
        const reason = probe.reason || 'origin is not serving a trusted certificate'
        report.deferredProxy.push({ host, reason })
        report.warnings.push(
          `${host}: publishing DNS-only for now — the origin does not yet serve a certificate this proxy can verify (${reason}). ` +
            `The origin issues certificates over HTTP-01, which needs the name to reach it directly; re-run the deploy once it has one and the record will be proxied.`,
        )
      }
    }

    if (hostProxied) proxiedHosts.push(host)

    const families: Array<{ type: 'A' | 'AAAA', content: string }> = [{ type: 'A', content: ipv4 }]
    if (ipv6 && hostAcceptsIpv6(host)) families.push({ type: 'AAAA', content: ipv6 })

    for (const { type, content } of families) {
      const result = await provider.upsertRecord(zone, {
        name: host,
        type,
        content,
        ttl,
        proxied: hostProxied,
      })

      if (result.success) report.records.push({ host, type, content, proxied: hostProxied })
      else report.warnings.push(`${host} ${type} → ${content} failed: ${result.message || 'unknown provider error'}`)
    }
  }

  // Everything below configures the EDGE. With nothing proxied there is no edge
  // in the path, and applying it anyway would enforce `Full (strict)` against an
  // origin Cloudflare isn't talking to yet — the exact state the probe avoids.
  if (proxiedHosts.length === 0) {
    if (proxied) {
      report.warnings.push(
        'No host is proxied yet, so zone settings, cache rules and purge were skipped — they only take effect through the proxy.',
      )
    }
    return report
  }

  // ---- 2. Zone settings --------------------------------------------------
  try {
    const desired = toCloudflareZoneSettings(settings)
    const applied = await provider.applyZoneSettings(zone, desired)
    report.settingsChanged = applied.changed
    for (const failure of applied.failed) {
      report.warnings.push(`zone setting '${failure.id}' could not be applied: ${failure.error}`)
    }
  }
  catch (error) {
    report.warnings.push(`zone settings could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }

  // ---- 3. Cache rules ----------------------------------------------------
  const cacheRules = buildStaticSiteCacheRules(proxiedHosts, cache)
  if (cacheRules.length > 0) {
    const written = await provider.putManagedPhaseRules(zone, 'http_request_cache_settings', cacheRules)
    if (written.success) report.cacheRules = cacheRules.length
    else report.warnings.push(`cache rules could not be written: ${written.message}`)
  }

  // ---- 4. Origin guard ---------------------------------------------------
  if (originGuard) {
    const rules: CloudflareRule[] = buildOriginGuardRule(proxiedHosts, originGuard.header, originGuard.value)
    if (rules.length > 0) {
      const written = await provider.putManagedPhaseRules(zone, 'http_request_late_transform', rules)
      if (written.success) report.originGuard = true
      else {
        report.warnings.push(
          `origin guard header could not be written: ${written.message}. ` +
            `The gateway will reject requests that lack it — disable the guard or grant the token Transform Rules: Edit.`,
        )
      }
    }
  }

  // ---- 5. Purge ----------------------------------------------------------
  //
  // Last, and only for the hosts this deploy actually fronts. A deploy replaces
  // the documents that reference the fingerprinted assets, so leaving the edge
  // holding the previous HTML serves visitors a page pointing at files the new
  // release may no longer have.
  if (purge) {
    report.purged = await provider.purgeCache(zone, { hosts: proxiedHosts })
    if (!report.purged) report.warnings.push('edge cache purge failed — new content may take until TTL expiry to appear.')
  }

  return report
}
