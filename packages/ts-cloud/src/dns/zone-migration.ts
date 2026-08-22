/**
 * Zone migration — move a whole zone onto another provider, record for record.
 *
 * This exists because the interesting part of a nameserver migration is not the
 * nameserver change, it is everything that silently fails to come with it. A
 * deploy derives the address records for the sites it owns; it knows nothing
 * about mail, domain-verification tokens, certificate-validation CNAMEs or the
 * service records a calendar client autodiscovers with. Those are exactly the
 * records nobody notices are gone until someone reports that mail stopped, and
 * by then the old zone may already have been deleted.
 *
 * So the flow here is deliberately: **export everything → translate → import →
 * diff → only then flip the nameservers.** The diff is the point. A migration
 * that reports "imported 91 records" without comparing against the source is
 * indistinguishable from one that dropped seven of them.
 */
import type { DnsProvider, DnsRecord, DnsRecordType } from './types'
import type { ResourceRecordSet, Route53Client } from '../aws/route53'

/** A record as it will exist at the destination. */
export interface MigratedRecord extends DnsRecord {
  name: string
  type: DnsRecordType
  content: string
  /**
   * Set when this record is not a faithful copy but a translation — an ALIAS
   * flattened to a CNAME, for instance. Carried through to the report so the
   * operator sees which records changed shape rather than having to spot it.
   */
  translatedFrom?: string
}

export interface SkippedRecord {
  name: string
  type: string
  reason: string
}

export interface ZoneMigrationPlan {
  zone: string
  records: MigratedRecord[]
  skipped: SkippedRecord[]
  warnings: string[]
}

export interface ZoneMigrationReport {
  applied: MigratedRecord[]
  failed: Array<{ record: MigratedRecord, message: string }>
}

export interface ZoneParityReport {
  /** Planned records confirmed present at the destination. */
  matched: MigratedRecord[]
  /** Planned records absent, or present with different content. */
  missing: Array<{ record: MigratedRecord, found?: string }>
  ok: boolean
}

/**
 * Read every record set in a Route53 hosted zone.
 *
 * Paginates to exhaustion rather than taking the first page. Route53 returns
 * 100 record sets by default and a zone that has quietly grown past that is
 * precisely the zone whose tail records — added last, so most likely to be the
 * recent mail or verification entries — would be dropped by a single call.
 */
export async function exportRoute53Zone(
  client: Route53Client,
  hostedZoneId: string,
): Promise<ResourceRecordSet[]> {
  const sets: ResourceRecordSet[] = []
  let startName: string | undefined
  let startType: string | undefined

  for (;;) {
    const page = await client.listResourceRecordSets({
      HostedZoneId: hostedZoneId,
      StartRecordName: startName,
      StartRecordType: startType,
      MaxItems: '100',
    })

    sets.push(...page.ResourceRecordSets)

    if (!page.IsTruncated) break
    startName = page.NextRecordName
    startType = page.NextRecordType
    // A truncated page that reports no cursor would loop forever; stop instead
    // and let the parity diff surface whatever was missed.
    if (!startName) break
  }

  return sets
}

/** Route53 renders every name with a trailing dot; nothing else wants one. */
function normalizeName(name: string): string {
  return name.replace(/\.$/, '').toLowerCase()
}

/** Same trailing-dot trim, without folding case — for values, not names. */
function stripTrailingDot(value: string): string {
  return value.replace(/\.$/, '')
}

/**
 * Render a record's value the way the destination reports it back.
 *
 * SRV is the reason this exists. A plan holds the four fields apart
 * (priority/weight/port + target as `content`), while Cloudflare returns
 * `content` as the composite `weight port target` with priority alongside.
 * Comparing the two directly says every SRV record is missing — so a migration
 * that wrote them perfectly reports six failures and refuses to proceed, and
 * re-running tries to create duplicates that the API then rejects.
 */
function comparableValue(record: { type: DnsRecordType, content: string, weight?: number, port?: number }): string {
  if (record.type === 'SRV' && record.weight !== undefined && record.port !== undefined)
    return `${record.weight} ${record.port} ${stripTrailingDot(record.content)}`

  return stripTrailingDot(record.content)
}

/**
 * Reassemble a TXT value.
 *
 * DNS caps a single character-string at 255 bytes, so anything longer — every
 * real DKIM public key — is stored as several quoted strings that must be
 * concatenated back into one value. Route53 hands them over exactly as stored:
 * `"first chunk" "second chunk"`. Treating that as literal text publishes a key
 * containing quote marks and a space, which validates as syntactically fine and
 * then fails every signature check.
 */
function decodeTxtValue(value: string): string {
  const chunks = value.match(/"(?:[^"\\]|\\.)*"/g)
  if (!chunks) return value

  return chunks
    .map(chunk => chunk.slice(1, -1).replace(/\\(.)/g, '$1'))
    .join('')
}

/**
 * Translate a Route53 zone into records another provider can hold.
 *
 * Nothing is written here. The plan is the reviewable artifact — a migration
 * that cannot be read before it runs is one that gets run twice.
 */
export function planZoneMigration(sets: ResourceRecordSet[], zone: string): ZoneMigrationPlan {
  const apex = normalizeName(zone)
  const records: MigratedRecord[] = []
  const skipped: SkippedRecord[] = []
  const warnings: string[] = []

  /** Names that already produced a flattened CNAME, so the A/AAAA pair collapses to one. */
  const flattened = new Set<string>()

  for (const set of sets) {
    const name = normalizeName(set.Name)
    const type = set.Type

    // The destination issues its own SOA and its own delegation. Copying either
    // across is at best ignored and at worst points the new zone back at the
    // old provider.
    if (type === 'SOA' || (type === 'NS' && name === apex)) {
      skipped.push({ name, type, reason: 'owned by the destination provider' })
      continue
    }

    // Weighted / latency / failover / geo record sets are one name with several
    // competing answers, distinguished by SetIdentifier. Cloudflare has no
    // equivalent on a plain DNS record, so importing them would silently
    // collapse a routing policy into whichever copy happened to be written
    // last. Refuse rather than guess.
    if (set.SetIdentifier) {
      skipped.push({
        name,
        type,
        reason: `routing policy record (SetIdentifier=${set.SetIdentifier}) has no equivalent — recreate by hand`,
      })
      warnings.push(`${type} ${name} is part of a Route53 routing policy and was NOT migrated`)
      continue
    }

    if (set.AliasTarget) {
      // ALIAS is a Route53 invention: an A/AAAA that resolves through another
      // hostname. Cloudflare's equivalent is a plain CNAME, which it flattens
      // at the apex, so the address family stops mattering — an A-alias and an
      // AAAA-alias to the same target are ONE CNAME, not two records.
      if (flattened.has(name)) continue
      flattened.add(name)

      const target = normalizeName(set.AliasTarget.DNSName)
      records.push({
        name,
        type: 'CNAME',
        content: target,
        ttl: 300,
        translatedFrom: `${type} ALIAS → ${target}`,
      })

      if (set.AliasTarget.EvaluateTargetHealth) {
        warnings.push(
          `${name} was an ALIAS with health evaluation enabled; the CNAME that replaces it has no health check`,
        )
      }
      continue
    }

    for (const rr of set.ResourceRecords || []) {
      const record = translateResourceRecord(name, type, rr.Value, set.TTL)
      if ('reason' in record) {
        skipped.push({ name, type, reason: record.reason })
        warnings.push(`${type} ${name}: ${record.reason}`)
        continue
      }
      records.push(record)
    }
  }

  return { zone: apex, records, skipped, warnings }
}

/** Split one Route53 RDATA value into the fields the destination expects. */
function translateResourceRecord(
  name: string,
  type: string,
  value: string,
  ttl?: number,
): MigratedRecord | { reason: string } {
  const base = { name, ttl } as const

  switch (type) {
    case 'A':
    case 'AAAA':
    case 'CNAME':
    case 'PTR':
      return { ...base, type: type === 'PTR' ? 'CNAME' : (type as DnsRecordType), content: normalizeName(value) }

    case 'TXT':
      return { ...base, type: 'TXT', content: decodeTxtValue(value) }

    case 'MX': {
      const [priority, ...host] = value.trim().split(/\s+/)
      if (!host.length) return { reason: `malformed MX value "${value}"` }
      return { ...base, type: 'MX', content: normalizeName(host.join(' ')), priority: Number(priority) }
    }

    case 'SRV': {
      const parts = value.trim().split(/\s+/)
      if (parts.length < 4) return { reason: `malformed SRV value "${value}"` }
      const [priority, weight, port] = parts.slice(0, 3).map(Number)
      return {
        ...base,
        type: 'SRV',
        content: normalizeName(parts.slice(3).join(' ')),
        priority,
        weight,
        port,
      }
    }

    case 'NS':
      // A non-apex NS is a real delegation of a subdomain and must come across.
      return { ...base, type: 'NS', content: normalizeName(value) }

    case 'CAA':
      return { ...base, type: 'CAA', content: value.trim() }

    default:
      return { reason: `unsupported record type ${type}` }
  }
}

/**
 * Write a plan to the destination provider.
 *
 * Upserts rather than creates, so a half-finished migration can simply be run
 * again. Failures are collected instead of thrown: one rejected record should
 * not strand the other ninety, and the parity check afterwards is what decides
 * whether the migration is actually complete.
 */
/**
 * Record types that legitimately hold several values at one name.
 *
 * These decide between create and upsert below, and getting the set wrong is
 * silent: an upsert keyed on name+type collapses every value after the first,
 * and the zone still looks populated.
 */
const MULTI_VALUED: ReadonlySet<DnsRecordType> = new Set<DnsRecordType>(['TXT', 'MX', 'SRV', 'NS', 'CAA'])

export async function applyZoneMigration(
  provider: DnsProvider,
  plan: ZoneMigrationPlan,
): Promise<ZoneMigrationReport> {
  const applied: MigratedRecord[] = []
  const failed: Array<{ record: MigratedRecord, message: string }> = []

  // What the destination already holds, read once. Used to decide whether a
  // multi-valued record is a new value or one already present, so re-running a
  // migration does not duplicate every TXT in the zone.
  const existing = new Set<string>()
  try {
    const listed = await provider.listRecords(plan.zone)
    for (const r of listed.records || [])
      existing.add(`${normalizeName(r.name)}|${r.type}|${comparableValue(r as any)}`)
  } catch {
    // A provider that cannot list still migrates; it just cannot dedupe.
  }

  for (const record of plan.records) {
    // Imported DNS-only, always. Proxying is a deploy-time decision that has to
    // wait until the origin can prove it holds a certificate for the hostname —
    // orange-clouding a host before then redirects its ACME challenge to a port
    // where nothing can answer it, and the certificate is never issued.
    const payload = { ...record, proxied: false }
    const key = `${normalizeName(record.name)}|${record.type}|${comparableValue(record)}`

    // A/AAAA/CNAME hold one value per name, so upsert is right: re-running the
    // migration should correct a changed address rather than add a second.
    //
    // TXT/MX/SRV/NS/CAA do not. An apex carrying both an SPF policy and a
    // domain-verification token is two TXT records at one name, and upserting
    // the second over the first deletes the SPF — mail keeps flowing until a
    // receiver checks, and nothing in the import reports a problem.
    if (!MULTI_VALUED.has(record.type)) {
      const result = await provider.upsertRecord(plan.zone, payload)
      if (result.success) applied.push(record)
      else failed.push({ record, message: result.message || 'unknown provider error' })
      continue
    }

    if (existing.has(key)) {
      applied.push(record)
      continue
    }

    const result = await provider.createRecord(plan.zone, payload)
    if (result.success) {
      existing.add(key)
      applied.push(record)
    } else {
      failed.push({ record, message: result.message || 'unknown provider error' })
    }
  }

  return { applied, failed }
}

/**
 * Compare what was planned against what the destination actually holds.
 *
 * This is the step that makes a migration safe to act on. Provider writes
 * report success far more reliably than they take effect — a silently coerced
 * value, a record rejected by a rule, a name written into the wrong zone — and
 * the only way to know the new zone can replace the old one is to read it back.
 */
export async function verifyZoneParity(
  provider: DnsProvider,
  plan: ZoneMigrationPlan,
): Promise<ZoneParityReport> {
  const listed = await provider.listRecords(plan.zone)
  const matched: MigratedRecord[] = []
  const missing: Array<{ record: MigratedRecord, found?: string }> = []

  const index = new Map<string, string[]>()
  for (const record of listed.records || []) {
    const key = `${normalizeName(record.name)}|${record.type}`
    const values = index.get(key) ?? []
    // Names are case-insensitive; VALUES are not. A base64 DKIM key or
    // verification token differs from its lowercased self, and folding case
    // here would report a corrupted record as a match.
    values.push(comparableValue(record as any))
    index.set(key, values)
  }

  for (const record of plan.records) {
    const found = index.get(`${normalizeName(record.name)}|${record.type}`)
    const wanted = comparableValue(record)

    if (found?.some(value => value === wanted))
      matched.push(record)
    else missing.push({ record, found: found?.join(', ') })
  }

  return { matched, missing, ok: missing.length === 0 }
}
