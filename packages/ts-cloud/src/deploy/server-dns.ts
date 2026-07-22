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
 * remove only duplicate A records for that exact hostname, preserving one copy
 * of the desired address and leaving every unrelated record untouched.
 */
export async function removeStaleServerAddressRecords(
  provider: DnsProvider,
  zone: string,
  hostname: string,
  desiredAddress: string,
): Promise<string[]> {
  // Retrieve the whole zone. Porkbun's retrieveByNameType endpoint treats a
  // missing record name as an apex-only lookup, so listRecords(zone, 'A')
  // silently hides duplicate subdomain records such as www.
  const listed = await provider.listRecords(zone)
  if (!listed.success) return [`could not list A records: ${listed.message || 'unknown provider error'}`]

  const matching = listed.records.filter((record) => record.type === 'A' && matchesHostname(record, zone, hostname))
  const desiredIndex = matching.findIndex((record) => record.content === desiredAddress)
  if (matching.length <= 1 || desiredIndex === -1) return []

  const warnings: string[] = []
  for (const [index, record] of matching.entries()) {
    if (index === desiredIndex) continue

    const result = await provider.deleteRecord(zone, record)
    if (!result.success)
      warnings.push(
        `could not remove stale ${record.name} A ${record.content}: ${result.message || 'unknown provider error'}`,
      )
  }
  return warnings
}
