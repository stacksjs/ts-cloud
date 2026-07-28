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
 * Hetzner hands a cloud server a routed /64 and configures `::1` inside it on
 * the interface, but the API reports the block (`2a01:4f8:c014:6186::/64`), not
 * the address. Publishing the block verbatim as an AAAA record yields a host
 * nothing answers on, so turn it into the address the box actually holds.
 *
 * A plain address (no prefix) is returned unchanged, so this is safe to apply
 * to whatever the driver surfaced.
 */
export function hetznerBoxIpv6(reported: string | undefined | null): string | undefined {
  if (!reported) return undefined

  const trimmed = reported.trim()
  if (!trimmed) return undefined
  if (!trimmed.includes('/')) return trimmed

  const [block] = trimmed.split('/')
  if (!block.endsWith('::')) return block || undefined
  return `${block}1`
}
