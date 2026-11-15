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
  /**
   * Skip the edge-certificate check and proxy regardless.
   *
   * Only safe when you know the zone holds a certificate covering every fronted
   * host — a custom uploaded certificate, for instance, which this check cannot
   * see. Skipping it on a zone whose Universal SSL is still validating takes the
   * site down over HTTPS.
   * @default false
   */
  skipEdgeCertificateCheck?: boolean
  /**
   * Wait for the zone's edge certificate instead of deferring the proxy to the
   * next deploy.
   *
   * A zone that has just been delegated has no certificate: Cloudflare first
   * has to see the registrar pointing at it, then issue Universal SSL. Both
   * finish on their own, usually within minutes, so a deploy that waits can
   * turn the proxy on in the same run. Omit it, or give a `timeoutMs` of 0, to
   * publish DNS-only and leave the proxy to a later deploy.
   */
  edgeWait?: EdgeWaitOptions
}

export interface EdgeWaitOptions {
  /** The longest to wait, in milliseconds. */
  timeoutMs: number
  /** Time between looks. @default 20000 */
  intervalMs?: number
  /**
   * Also wait while the zone is still `pending`, that is, while Cloudflare has
   * not yet seen the registrar pointing at it. @default false
   *
   * Only a caller that knows the nameservers were moved should say so: a
   * pending zone whose nameservers are still elsewhere never activates, and
   * waiting on it spends the whole timeout to learn nothing.
   */
  whilePending?: boolean
  /** Told what is being waited for, each time it changes. */
  onProgress?: (message: string) => void
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
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
/**
 * Does any of these certificate hostnames cover `host`?
 *
 * A wildcard matches exactly ONE label, which is the rule that catches people
 * out: `*.example.com` covers `www.example.com` and does not cover
 * `www.app.example.com`. Universal SSL only ever issues the apex plus a single
 * wildcard, so a three-label host inside a zone is not covered by it at all and
 * never will be without a dedicated certificate.
 */
export function edgeCertificateCovers(certificateHosts: string[], host: string): boolean {
  const target = host.replace(/\.$/, '').toLowerCase()

  return certificateHosts.some((raw) => {
    const pattern = raw.replace(/\.$/, '').toLowerCase()
    if (pattern === target) return true
    if (!pattern.startsWith('*.')) return false

    const suffix = pattern.slice(2)
    if (!target.endsWith(`.${suffix}`)) return false

    // One label only: what precedes the suffix must not itself contain a dot.
    return !target.slice(0, target.length - suffix.length - 1).includes('.')
  })
}

/**
 * Can Universal SSL ever cover `host` in `zone`? The apex and names one label
 * below it, and nothing deeper: waiting for a certificate that will never be
 * issued would hold a deploy for its whole timeout to learn nothing.
 */
export function universalSslCovers(zone: string, host: string): boolean {
  return edgeCertificateCovers([zone, `*.${zone}`], host)
}

/**
 * Wait until the zone's active edge certificates cover every host Universal
 * SSL can cover, or the time runs out.
 *
 * Returns what the certificates cover when it stops: `null` if that could not
 * be read, which the caller treats as "no idea", exactly as it does without a
 * wait. A zone still `pending` is waited on only with `whilePending`, and then
 * Cloudflare is asked, once a minute at most, to check the nameservers again.
 */
export async function waitForEdgeCertificate(options: {
  provider: Pick<CloudflareProvider, 'listEdgeCertificateHosts' | 'getZoneDetails' | 'requestActivationCheck'>
  zone: string
  hosts: string[]
  wait: EdgeWaitOptions
}): Promise<string[] | null> {
  const { provider, zone, wait } = options
  const sleep = wait.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = wait.now ?? Date.now
  const interval = wait.intervalMs ?? 20_000
  const awaited = options.hosts.filter(host => universalSslCovers(zone, host))
  const deadline = now() + wait.timeoutMs

  let said = ''
  const say = (message: string): void => {
    if (message !== said) wait.onProgress?.(message)
    said = message
  }
  let askedAt = Number.NEGATIVE_INFINITY

  while (true) {
    const covered = await provider.listEdgeCertificateHosts(zone)
    if (covered === null || awaited.every(host => edgeCertificateCovers(covered, host))) return covered
    if (now() >= deadline) return covered

    const details = await provider.getZoneDetails(zone)
    if (details && details.status !== 'active') {
      if (!wait.whilePending) {
        say(`${zone} is ${details.status} at Cloudflare, which has not seen its nameservers point there: not waiting for a certificate`)
        return covered
      }
      say(`${zone} is ${details.status} at Cloudflare: waiting for it to see the nameservers (${details.nameServers.join(', ')})`)
      if (now() - askedAt >= 60_000) {
        askedAt = now()
        await provider.requestActivationCheck(zone)
      }
    }
    else {
      say(`${zone} is active: waiting for its edge certificate to be issued`)
    }

    await sleep(Math.min(interval, Math.max(0, deadline - now())))
  }
}

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
    skipEdgeCertificateCheck = false,
    edgeWait,
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

  // What the EDGE can terminate TLS for. Fetched once: it is a zone-level fact,
  // and the answer is the same for every host in this run.
  //
  // `null` means coverage could not be read at all, which is deliberately NOT
  // treated as "nothing is covered" — a token missing SSL read would otherwise
  // silently stop proxying every site on every deploy. An empty array is a
  // definitive answer and is acted on.
  let edgeHosts = proxied && !skipEdgeCertificateCheck
    ? await provider.listEdgeCertificateHosts(zone)
    : null

  // A certificate that is on its way is waited for, so one deploy takes a zone
  // from delegated to proxied. Only for names it will actually cover.
  const waitable = (covered: string[]): boolean =>
    hosts.some(host => universalSslCovers(zone, host) && !edgeCertificateCovers(covered, host))
  if (edgeHosts && edgeWait && edgeWait.timeoutMs > 0 && waitable(edgeHosts))
    edgeHosts = await waitForEdgeCertificate({ provider, zone, hosts, wait: edgeWait })
  const waited = !!edgeWait && edgeWait.timeoutMs > 0

  for (const host of hosts) {
    let hostProxied = proxied

    // Checked BEFORE the origin probe, because it is the cheaper failure to
    // reason about and the more destructive one to get wrong: an origin without
    // a certificate yet merely delays proxying, while proxying a host the edge
    // cannot terminate TLS for takes the name down for every visitor.
    if (hostProxied && edgeHosts && !edgeCertificateCovers(edgeHosts, host)) {
      hostProxied = false
      const reason = edgeHosts.length === 0
        ? 'the zone has no active edge certificate yet'
        : `no active edge certificate covers it (${edgeHosts.join(', ')})`
      report.deferredProxy.push({ host, reason })
      report.warnings.push(
        `${host}: publishing DNS-only — ${reason}. Proxying it would make Cloudflare terminate TLS with no certificate for the name, ` +
          `which fails the handshake outright rather than degrading. Universal SSL covers the apex and ONE level of subdomain, so a deeper ` +
          `name needs its own certificate; otherwise ${waited ? 'the certificate was not issued within the time this deploy waits, and the next deploy proxies it' : 're-run the deploy once the certificate is active'}.`,
      )
    }

    if (hostProxied && !skipOriginProbe) {
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
