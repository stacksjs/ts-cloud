import type { DnsProvider, DnsRecordResult } from '../dns/types'

interface ServerSite {
  domain?: string
  deploy?: string
  redirect?: string
  start?: string
}

/** Domains served by a compute box, including redirect-only virtual hosts. */
export function collectServerDnsDomains(sites: Record<string, ServerSite> = {}): Set<string> {
  const domains = new Set<string>()
  for (const site of Object.values(sites)) {
    if (!site.domain) continue
    if (site.redirect || site.deploy === 'server' || site.start) domains.add(site.domain)
  }
  return domains
}

function normalizeName(name: string): string {
  return name.replace(/\.$/, '').toLowerCase()
}

function matchesHostname(record: DnsRecordResult, zone: string, hostname: string): boolean {
  const recordName = normalizeName(record.name)
  const normalizedZone = normalizeName(zone)
  const normalizedHostname = normalizeName(hostname)
  const relativeName =
    normalizedHostname === normalizedZone
      ? '@'
      : normalizedHostname.endsWith(`.${normalizedZone}`)
        ? normalizedHostname.slice(0, -(normalizedZone.length + 1))
        : normalizedHostname

  return (
    recordName === normalizedHostname ||
    recordName === relativeName ||
    (relativeName === '@' && (recordName === '' || recordName === normalizedZone))
  )
}

/**
 * A compute deployment owns one address per managed hostname. After an upsert,
 * remove only duplicate address records for that exact hostname, preserving one
 * copy of the desired address and leaving every unrelated record untouched.
 *
 * `recordType` selects the family. It used to be hardcoded to 'A', which meant
 * a dual-stack box could clean up its stale IPv4 records but accumulated stale
 * AAAA ones forever — and a stale AAAA is worse than a stale A, because
 * dual-stack clients prefer IPv6 and would keep landing on the dead address.
 */
export async function removeStaleServerAddressRecords(
  provider: DnsProvider,
  zone: string,
  hostname: string,
  desiredAddress: string,
  recordType: 'A' | 'AAAA' = 'A',
): Promise<string[]> {
  // Retrieve the whole zone. Porkbun's retrieveByNameType endpoint treats a
  // missing record name as an apex-only lookup, so listRecords(zone, 'A')
  // silently hides duplicate subdomain records such as www.
  const listed = await provider.listRecords(zone)
  if (!listed.success)
    return [`could not list ${recordType} records: ${listed.message || 'unknown provider error'}`]

  const matching = listed.records.filter(
    (record) => record.type === recordType && matchesHostname(record, zone, hostname),
  )
  const desiredIndex = matching.findIndex((record) => record.content === desiredAddress)
  if (matching.length <= 1 || desiredIndex === -1) return []

  const warnings: string[] = []
  for (const [index, record] of matching.entries()) {
    if (index === desiredIndex) continue

    const result = await provider.deleteRecord(zone, record)
    if (!result.success)
      warnings.push(
        `could not remove stale ${record.name} ${recordType} ${record.content}: ${result.message || 'unknown provider error'}`,
      )
  }
  return warnings
}

/**
 * Turn whatever a provider reports as a box's IPv6 into an address an AAAA
 * record can point at.
 *
 * Providers disagree on what "the server's IPv6" means. Hetzner hands out a
 * routed /64 and reports the block (`2a01:4f8:c014:6186::/64`) while the
 * interface actually holds `::1` inside it; AWS reports a plain address per
 * network interface. Publishing a block verbatim gives an AAAA record nothing
 * answers on, which is the kind of failure that only shows up for the fraction
 * of visitors whose network prefers IPv6 — so every driver runs its value
 * through here rather than reinventing the narrowing.
 *
 * A plain address passes through unchanged.
 */
export function normalizePublicIpv6(reported: string | undefined | null): string | undefined {
  if (!reported) return undefined

  const trimmed = reported.trim()
  if (!trimmed) return undefined
  if (!trimmed.includes('/')) return trimmed

  const [block] = trimmed.split('/')
  if (!block.endsWith('::')) return block || undefined
  return `${block}1`
}

/**
 * Hostname labels that must stay IPv4-only.
 *
 * A box typically runs its mail server on IPv4 alone, and its IPv6 address
 * usually has no PTR — both of which make an AAAA on a mail host actively
 * harmful: senders try the v6 address first, find nothing listening (or get
 * rejected for the missing reverse record) and defer the message. Web traffic
 * has no such constraint, so the exclusion is per-host rather than per-zone.
 */
export const IPV6_EXCLUDED_HOST_LABELS: ReadonlySet<string> = new Set(['mail', 'smtp', 'imap', 'mx'])

/** Whether `fqdn` should get an AAAA record pointing at the box. */
export function hostAcceptsIpv6(fqdn: string): boolean {
  return !IPV6_EXCLUDED_HOST_LABELS.has(fqdn.split('.')[0] ?? '')
}

export interface AddressRecordReport {
  /** Records confirmed present at the provider after the write. */
  published: Array<{ fqdn: string; type: 'A' | 'AAAA'; content: string }>
  /** Anything the caller should surface: failed writes, unverified writes, stale-record cleanup problems. */
  warnings: string[]
}

interface ReconcileAddressRecordsOptions {
  provider: DnsProvider
  zone: string
  fqdn: string
  ipv4: string
  /** Omit when the box has no public IPv6; the AAAA pass is then skipped entirely. */
  ipv6?: string
  ttl?: number
}

/**
 * Point one hostname at a box on every address family the box actually has.
 *
 * Shared by every driver and by the framework's deploy command so the rules
 * live in one place: upsert, then remove the *other* records of that family for
 * the same hostname (a leftover address round-robins traffic to a dead host —
 * and a stale AAAA is the worse of the two, because dual-stack clients prefer
 * IPv6), then verify against the provider rather than trusting the write.
 */
export async function reconcileAddressRecords(
  options: ReconcileAddressRecordsOptions,
): Promise<AddressRecordReport> {
  const { provider, zone, fqdn, ipv4, ipv6, ttl = 600 } = options
  const report: AddressRecordReport = { published: [], warnings: [] }

  const families: Array<{ type: 'A' | 'AAAA'; content: string }> = [{ type: 'A', content: ipv4 }]
  if (ipv6 && hostAcceptsIpv6(fqdn)) families.push({ type: 'AAAA', content: ipv6 })

  for (const { type, content } of families) {
    const result = await provider.upsertRecord(zone, { name: fqdn, type, content, ttl })
    if (result?.success === false) {
      report.warnings.push(
        `${fqdn} → ${content} failed: ${(result as any).error || result.message || 'unknown error'}`,
      )
      continue
    }

    report.warnings.push(
      ...(await removeStaleServerAddressRecords(provider, zone, fqdn, content, type)).map(
        (warning) => `${fqdn} cleanup: ${warning}`,
      ),
    )

    if (await verifyAddressRecord(provider, zone, fqdn, content, type)) report.published.push({ fqdn, type, content })
    else
      report.warnings.push(
        `${fqdn} → ${content} reported success at ${provider.name} but no matching ${type} record exists — create it manually: ${type} ${fqdn} → ${content}`,
      )
  }

  return report
}

/**
 * Best-effort post-write check that the record exists at the provider.
 *
 * Returns true when the provider offers no list API or the listing itself
 * fails: verification must never turn a possibly-good write into a false
 * alarm. It exists to catch phantom successes — an upsert that reported OK
 * while editing the wrong record — at providers that can list their zone.
 *
 * The listing is deliberately untyped. Typed listings map to endpoints like
 * Porkbun's retrieveByNameType, whose subdomain-less form returns apex records
 * only, which made verification blind to every non-apex record.
 */
export async function verifyAddressRecord(
  provider: DnsProvider,
  zone: string,
  fqdn: string,
  content: string,
  recordType: 'A' | 'AAAA',
): Promise<boolean> {
  try {
    if (typeof provider?.listRecords !== 'function') return true

    const listed = await provider.listRecords(zone)
    if (!listed?.success || !Array.isArray(listed.records)) return true

    return listed.records.some((record) => {
      const name = typeof record?.name === 'string' ? record.name.replace(/\.$/, '') : ''
      return record?.type === recordType && name === fqdn && record?.content === content
    })
  }
  catch {
    return true
  }
}
