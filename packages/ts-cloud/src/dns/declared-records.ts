/**
 * Publish the records a deploy cannot infer: mail, verification tokens,
 * third-party CNAMEs — everything in `infrastructure.dns.records`.
 *
 * The address records for `sites` are derived from the deploy itself and live in
 * {@link import('../deploy/server-dns')}. This module covers the other half of a
 * zone, which is precisely the half that silently disappears in a nameserver
 * migration: nothing in a normal deploy reads or writes MX or SPF, so their
 * absence is invisible until someone reports that mail stopped days later.
 *
 * The whole module is upsert-only. A real zone holds records owned by other
 * tools and other people, so "not declared here" never implies "safe to
 * delete". The single deliberate exception is a policy TXT record — see
 * {@link policyTag}.
 */
import type { DnsProvider, DnsRecord, DnsRecordResult, DnsRecordType } from './types'

/** A record to publish, already resolved to a fully-qualified name. */
export interface DeclaredRecord {
  type: DnsRecordType
  /** Fully-qualified record name. */
  name: string
  content: string
  ttl?: number
  priority?: number
  proxied?: boolean
  comment?: string
}

/** The config shape, before names are qualified against the zone. */
export interface DeclaredRecordInput {
  type: DnsRecordType
  name?: string
  content: string
  ttl?: number
  priority?: number
  proxied?: boolean
  comment?: string
}

/**
 * Record types where one value per name is the norm, so an existing record is
 * updated rather than joined.
 *
 * `A` is multi-valued in principle, but a declared `A` in a deploy config means
 * "this name points here", and treating it as additive would accumulate a new
 * address on every content change while the old one kept taking half the
 * traffic.
 */
const SINGLETON_TYPES: ReadonlySet<DnsRecordType> = new Set<DnsRecordType>(['A', 'AAAA', 'CNAME', 'ALIAS'])

/**
 * The policy tag opening a TXT record whose duplicates are harmful, or
 * `undefined` for an ordinary TXT.
 *
 * This is the one case where publishing a second record is not additive but
 * destructive. Two `v=spf1` records at a name are a permerror: receivers do not
 * merge them, they conclude the domain has no usable SPF, and mail that would
 * have passed starts failing. Two `v=DMARC1` records are discarded wholesale,
 * silently disabling the policy. So a policy record must REPLACE its
 * predecessor, while every other TXT at that name is left alone.
 */
export function policyTag(content: string): string | undefined {
  const normalized = content.trim().replace(/^"|"$/g, '').toLowerCase()
  if (normalized.startsWith('v=spf1')) return 'v=spf1'
  if (normalized.startsWith('v=dmarc1')) return 'v=dmarc1'
  return undefined
}

/** Strip the quoting some providers wrap TXT values in, for comparison. */
function unquote(value: string): string {
  return value.trim().replace(/^"(.*)"$/s, '$1')
}

function normalizeName(name: string): string {
  return name.replace(/\.$/, '').toLowerCase()
}

/**
 * Qualify a configured record name against the zone.
 *
 * `'@'`, `''` and an omitted name all mean the apex; a bare label is joined to
 * the zone; an already-qualified name is left alone.
 */
export function qualifyName(name: string | undefined, zone: string): string {
  const z = normalizeName(zone)
  const raw = (name ?? '@').trim()
  if (!raw || raw === '@') return z
  const n = normalizeName(raw)
  if (n === z || n.endsWith(`.${z}`)) return n
  return `${n}.${z}`
}

/** Resolve config records into fully-qualified {@link DeclaredRecord}s. */
export function resolveDeclaredRecords(records: DeclaredRecordInput[], zone: string): DeclaredRecord[] {
  return records.map(record => ({
    ...record,
    name: qualifyName(record.name, zone),
    // Declared records are DNS-only unless asked otherwise: mail records cannot
    // be proxied, and a proxied autodiscover CNAME points clients at the CDN.
    proxied: record.proxied ?? false,
  }))
}

/** What the reconcile did with one record. */
export interface DeclaredRecordOutcome {
  record: DeclaredRecord
  action: 'created' | 'updated' | 'unchanged' | 'failed'
  message?: string
}

export interface DeclaredRecordsReport {
  outcomes: DeclaredRecordOutcome[]
  /**
   * Undeclared values sitting beside a declared multi-value record — a second
   * MX from a previous provider, say. Reported and never removed: a stray MX
   * splits mail delivery and the operator must see it, but silently deleting a
   * record on a shared zone is the worse failure.
   */
  warnings: string[]
}

/** Does an existing record already satisfy this declaration? */
function matches(existing: DnsRecordResult, record: DeclaredRecord): boolean {
  if (existing.type !== record.type) return false
  if (normalizeName(existing.name) !== normalizeName(record.name)) return false

  if (SINGLETON_TYPES.has(record.type)) return true

  if (record.type === 'TXT') {
    const tag = policyTag(record.content)
    // A policy record supersedes the one carrying the same tag; an ordinary TXT
    // is identified by its exact value so verification tokens coexist.
    if (tag) return policyTag(unquote(existing.content)) === tag
    return unquote(existing.content) === unquote(record.content)
  }

  // MX / SRV / CAA / NS: identified by value, so declaring one never disturbs
  // the others at that name.
  return unquote(existing.content) === unquote(record.content)
}

/** Is the existing record already exactly what was declared? */
function isCurrent(existing: DnsRecordResult, record: DeclaredRecord): boolean {
  if (unquote(existing.content) !== unquote(record.content)) return false
  if (record.priority !== undefined && existing.priority !== record.priority) return false
  if (record.proxied !== undefined && existing.proxied !== undefined && existing.proxied !== record.proxied) return false
  return true
}

/**
 * Publish `records` into `zone`, updating what exists and creating what does
 * not.
 *
 * Never throws: this runs at the tail of a deploy that has already shipped, so a
 * provider rejecting one record is reported per-record rather than failing the
 * whole run — and the outcome list says exactly which ones landed.
 */
export async function reconcileDeclaredRecords(options: {
  provider: DnsProvider
  zone: string
  records: DeclaredRecord[]
}): Promise<DeclaredRecordsReport> {
  const { provider, zone, records } = options
  const report: DeclaredRecordsReport = { outcomes: [], warnings: [] }
  if (records.length === 0) return report

  const listed = await provider.listRecords(zone)
  if (!listed.success) {
    report.warnings.push(`could not list ${zone}: ${listed.message || 'unknown provider error'} — records not reconciled`)
    return report
  }
  const existing = listed.records

  for (const record of records) {
    const current = existing.filter(e => matches(e, record))

    if (current.length > 0 && current.every(e => isCurrent(e, record))) {
      report.outcomes.push({ record, action: 'unchanged' })
      continue
    }

    const wire: DnsRecord = {
      name: record.name,
      type: record.type,
      content: record.content,
      ttl: record.ttl ?? 3600,
      ...(record.priority !== undefined ? { priority: record.priority } : {}),
      ...(record.proxied !== undefined ? { proxied: record.proxied } : {}),
    }

    // A policy TXT whose value changed is replaced by removing the old record
    // first. The alternative — create then delete — briefly publishes two SPF
    // records, and two SPF records is a permerror: strictly worse than the
    // moment of "no SPF" that a delete-then-create leaves, which merely
    // evaluates as neutral.
    const supersedes = record.type === 'TXT' && policyTag(record.content) !== undefined
    if (supersedes) {
      for (const stale of current) {
        const removed = await provider.deleteRecord(zone, {
          name: stale.name,
          type: stale.type,
          content: stale.content,
        })
        if (!removed.success)
          report.warnings.push(`could not remove superseded ${stale.type} at ${stale.name}: ${removed.message || 'unknown error'}`)
      }
    }

    const result = supersedes || current.length === 0
      ? await provider.createRecord(zone, wire)
      : await provider.upsertRecord(zone, wire)

    if (result.success) report.outcomes.push({ record, action: current.length > 0 ? 'updated' : 'created' })
    else report.outcomes.push({ record, action: 'failed', message: result.message })
  }

  // Surface undeclared neighbours for multi-value types, so a leftover MX from a
  // previous provider is visible rather than quietly splitting delivery.
  for (const type of ['MX'] as const) {
    const declaredNames = new Set(records.filter(r => r.type === type).map(r => normalizeName(r.name)))
    for (const name of declaredNames) {
      const declaredValues = new Set(
        records.filter(r => r.type === type && normalizeName(r.name) === name).map(r => unquote(r.content).toLowerCase()),
      )
      const strays = existing.filter(
        e => e.type === type && normalizeName(e.name) === name && !declaredValues.has(unquote(e.content).toLowerCase()),
      )
      for (const stray of strays)
        report.warnings.push(
          `${name} has an undeclared ${type} record (${stray.content}) alongside the declared one — mail will be split between them. Remove it at the provider if it is stale.`,
        )
    }
  }

  return report
}
