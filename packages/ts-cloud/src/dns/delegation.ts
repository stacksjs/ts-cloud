/**
 * Delegate a zone to the provider that serves it.
 *
 * A domain has two homes that people conflate: the REGISTRAR it is bought
 * from, and the DNS provider whose nameservers actually answer for it. Moving
 * the second is a two-sided operation — create the zone, populate it, then
 * point the registrar at it — and every manual account of it goes wrong in the
 * same place: the nameservers get switched before the new zone is complete,
 * and the records that nothing derives (mail, verification tokens, DKIM) are
 * simply gone until somebody reports that mail stopped.
 *
 * So the order here is fixed and the last step is conditional:
 *
 *   1. ensure the zone exists at the destination and learn its nameservers
 *   2. copy the registrar's records across
 *   3. verify, record for record, that they arrived
 *   4. ONLY THEN point the registrar's nameservers at the destination
 *
 * Step 4 does not run if step 3 found anything missing. A delegation into a
 * half-populated zone is the one outcome worth failing the deploy over, and it
 * is the one an operator cannot easily undo — the old zone keeps answering
 * only until caches expire.
 *
 * Re-running after delegation is a no-op by design. Once the registrar points
 * here, the destination is the source of truth and the registrar's own records
 * are a stale copy; re-importing them would resurrect anything deleted since.
 */

import type { CreateRecordResult, DnsProvider, DnsRecord, DnsRecordResult, DnsRecordType } from './types'
import { PROXIABLE_RECORD_TYPES } from './types'

/**
 * A provider that can also change where a domain's nameservers point.
 *
 * Separate from {@link DnsProvider} because the two capabilities are genuinely
 * different: serving a zone's records and controlling the domain's delegation
 * are usually the same company but never the same permission, and plenty of
 * providers do one without the other.
 */
export interface NameserverRegistrar {
  readonly name: string
  getNameServers: (domain: string) => Promise<string[]>
  updateNameServers: (domain: string, nameservers: string[]) => Promise<boolean>
}

/** A provider that can host a zone and report the nameservers it assigns. */
export interface ZoneHost {
  createZone: (
    domain: string,
    options?: { accountId?: string, jumpStart?: boolean },
  ) => Promise<{ id: string, name: string, status: string, nameServers: string[], created: boolean }>
}

export function isNameserverRegistrar(value: unknown): value is NameserverRegistrar {
  if (!value || typeof value !== 'object')
    return false
  const candidate = value as Partial<NameserverRegistrar>
  return typeof candidate.getNameServers === 'function' && typeof candidate.updateNameServers === 'function'
}

export function isZoneHost(value: unknown): value is ZoneHost {
  return Boolean(value && typeof (value as Partial<ZoneHost>).createZone === 'function')
}

/**
 * Records a zone's new host must never be handed.
 *
 * `NS` at the apex is the delegation itself — copying the registrar's would
 * assert the very thing being changed. `SOA` is generated per zone.
 */
const NEVER_COPIED: ReadonlySet<DnsRecordType> = new Set<DnsRecordType>(['NS'])

export interface DelegationOptions {
  domain: string
  /** Where the domain is registered, and where its records live today. */
  registrar: DnsProvider & NameserverRegistrar
  /** Where the zone is moving to. */
  host: DnsProvider & ZoneHost
  /**
   * Hostnames to serve through the destination's edge proxy, where it has one.
   *
   * Deliberately opt-in per host rather than "proxy every address record".
   * Proxying a mail host is the classic way to break a domain quietly:
   * Cloudflare does not proxy SMTP, and the proxy hides the origin address that
   * the domain's own SPF record authorises, so delivery degrades hours later
   * with nothing visibly wrong.
   */
  proxiedHosts?: Iterable<string>
  /** Account to create the zone under, when the destination needs one. */
  accountId?: string
  /** Report what would happen and change nothing. */
  dryRun?: boolean
}

export interface DelegationRecordOutcome {
  record: DnsRecord
  status: 'copied' | 'present' | 'failed' | 'skipped'
  reason?: string
}

export type DelegationStatus =
  /** The registrar already points at the destination; nothing to do. */
  | 'already-delegated'
  /** Records copied and verified, nameservers updated. */
  | 'delegated'
  /** Records copied and verified; nameservers left alone (dry run). */
  | 'ready'
  /** Something is missing at the destination — nameservers deliberately untouched. */
  | 'blocked'

export interface DelegationReport {
  status: DelegationStatus
  domain: string
  zoneId?: string
  /** Nameservers the destination assigned. */
  targetNameservers: string[]
  /** Nameservers the registrar had when this ran. */
  currentNameservers: string[]
  records: DelegationRecordOutcome[]
  /** Planned records that are absent or wrong at the destination. */
  missing: DnsRecord[]
  warnings: string[]
}

function normalizeHost(value: string): string {
  return value.replace(/\.$/, '').toLowerCase()
}

/** Nameserver sets, compared as sets — order and trailing dots are noise. */
export function sameNameservers(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0)
    return false
  const left = new Set(a.map(normalizeHost))
  const right = new Set(b.map(normalizeHost))
  if (left.size !== right.size)
    return false
  for (const value of left) {
    if (!right.has(value))
      return false
  }
  return true
}

/** TXT content arrives quoted from some providers and bare from others. */
function normalizeContent(record: { type: DnsRecordType, content: string }): string {
  const raw = record.content.trim()
  const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
  return record.type === 'TXT' ? unquoted : normalizeHost(unquoted)
}

/** Types whose priority is part of what the record says. */
const PRIORITIZED: ReadonlySet<DnsRecordType> = new Set<DnsRecordType>(['MX', 'SRV'])

/**
 * Types a deploy may correct in place: one value per name, so an upsert keyed
 * on name + type updates the address instead of adding a second one.
 */
const SINGLE_VALUED: ReadonlySet<DnsRecordType> = new Set<DnsRecordType>(['A', 'AAAA', 'CNAME'])

/**
 * What makes a record this record and not another one at the same name.
 *
 * Name and type alone are not enough: an apex routinely holds an SPF policy
 * and a verification token as two TXT records, a domain has a primary and a
 * backup MX, a name can round-robin over several A records. Keying on
 * name + type collapses each of those to whichever value was written last.
 * Priority counts only where it means something; some registrars report
 * `prio=0` on every record type.
 */
export function recordIdentity(record: { type: DnsRecordType, name: string, content: string, priority?: number | string }): string {
  const priority = PRIORITIZED.has(record.type) && record.priority !== undefined && record.priority !== null
    ? String(Number(record.priority))
    : ''
  return `${record.type}|${normalizeHost(record.name)}|${normalizeContent(record)}|${priority}`
}

function sameRecord(a: DnsRecord, b: DnsRecordResult): boolean {
  return recordIdentity(a) === recordIdentity(b)
}

/**
 * Move `domain` onto `host`, and point `registrar` at it once that is safe.
 */
export async function delegateZone(options: DelegationOptions): Promise<DelegationReport> {
  const { domain, registrar, host, dryRun = false } = options
  const proxied = new Set([...(options.proxiedHosts ?? [])].map(normalizeHost))
  const warnings: string[] = []

  const zone = await host.createZone(domain, { accountId: options.accountId, jumpStart: false })
  const currentNameservers = await registrar.getNameServers(domain)

  const report: DelegationReport = {
    status: 'ready',
    domain,
    zoneId: zone.id,
    targetNameservers: zone.nameServers,
    currentNameservers,
    records: [],
    missing: [],
    warnings,
  }

  // Already pointed here. The destination is authoritative, so its records are
  // the truth and the registrar's are a stale copy — re-importing them would
  // resurrect anything deleted since the move.
  if (sameNameservers(currentNameservers, zone.nameServers)) {
    report.status = 'already-delegated'
    return report
  }

  if (zone.nameServers.length === 0) {
    warnings.push(`${host.name} did not report nameservers for ${domain}; cannot delegate.`)
    report.status = 'blocked'
    return report
  }

  const source = await registrar.listRecords(domain)
  if (!source.success) {
    warnings.push(`Could not read ${domain} from ${registrar.name}: ${source.message ?? 'unknown error'}`)
    report.status = 'blocked'
    return report
  }

  const planned: DnsRecord[] = []

  for (const record of source.records) {
    if (NEVER_COPIED.has(record.type)) {
      report.records.push({
        record,
        status: 'skipped',
        reason: `${record.type} describes the delegation itself; ${host.name} owns it`,
      })
      continue
    }

    const wantsProxy = PROXIABLE_RECORD_TYPES.has(record.type) && proxied.has(normalizeHost(record.name))

    planned.push({
      name: record.name,
      type: record.type,
      content: record.content,
      ttl: record.ttl,
      priority: record.priority,
      ...(PROXIABLE_RECORD_TYPES.has(record.type) ? { proxied: wantsProxy } : {}),
    })
  }

  if (dryRun) {
    for (const record of planned)
      report.records.push({ record, status: 'copied', reason: 'dry run' })
    return report
  }

  // How many values each name + type carries in the source. An upsert is keyed
  // on name + type, so it is only safe where there is exactly one: two TXT
  // values upserted one after the other leave only the second, and the copy
  // reports success for both. Everything else is created, value by value.
  const valuesPerName = new Map<string, number>()
  for (const record of planned) {
    const key = `${record.type}|${normalizeHost(record.name)}`
    valuesPerName.set(key, (valuesPerName.get(key) ?? 0) + 1)
  }

  // What the destination already holds, so a re-run creates only what is
  // missing instead of duplicating every multi-valued record.
  const present = new Set<string>()
  try {
    const before = await host.listRecords(domain)
    for (const record of before.records ?? [])
      present.add(recordIdentity(record))
  }
  catch {
    // A host that cannot list still copies; it just cannot skip duplicates.
  }

  for (const record of planned) {
    const upsert = SINGLE_VALUED.has(record.type)
      && valuesPerName.get(`${record.type}|${normalizeHost(record.name)}`) === 1

    if (!upsert && present.has(recordIdentity(record))) {
      report.records.push({ record, status: 'present' })
      continue
    }

    let result: CreateRecordResult
    try {
      result = upsert
        ? await host.upsertRecord(domain, record)
        : await host.createRecord(domain, record)
    }
    catch (error) {
      result = { success: false, message: error instanceof Error ? error.message : String(error) }
    }

    if (result.success)
      present.add(recordIdentity(record))
    report.records.push(
      result.success
        ? { record, status: 'copied' }
        : { record, status: 'failed', reason: result.message },
    )
  }

  // Verify against what the destination actually holds, not against the
  // upserts' own return values. "Imported 17 records" without a read-back is
  // indistinguishable from having dropped three of them.
  const landed = await host.listRecords(domain)
  if (!landed.success) {
    warnings.push(`Could not read back ${domain} from ${host.name}: ${landed.message ?? 'unknown error'}`)
    report.status = 'blocked'
    return report
  }

  for (const record of planned) {
    if (!landed.records.some(existing => sameRecord(record, existing)))
      report.missing.push(record)
  }

  if (report.missing.length > 0) {
    warnings.push(
      `${report.missing.length} record(s) did not arrive at ${host.name}; `
      + `leaving ${registrar.name}'s nameservers alone. Delegating now would take `
      + `the domain off a complete zone and onto an incomplete one.`,
    )
    report.status = 'blocked'
    return report
  }

  const updated = await registrar.updateNameServers(domain, zone.nameServers)
  if (!updated) {
    warnings.push(`${registrar.name} refused the nameserver update for ${domain}.`)
    report.status = 'blocked'
    return report
  }

  report.status = 'delegated'
  return report
}
