/**
 * Mail DNS provisioning.
 *
 * A domain that sends mail needs four records, and getting any one of them
 * wrong is not a visible error: mail simply arrives in spam, or is silently
 * rejected by the receiving side. That failure mode is why this belongs in the
 * deploy rather than in a runbook — a deploy that stands up a mail-sending app
 * and leaves its DNS to be typed by hand has not finished the job.
 *
 * The record set is deliberately a pure function of its inputs, so what a
 * deploy is about to publish can be inspected, diffed and tested without an
 * API call or a live zone.
 *
 * @module ts-cloud/dns/mail-records
 */

import type { DnsProvider, DnsRecord } from './types'

export interface MailDnsOptions {
  /** The domain that sends mail, e.g. `example.com`. */
  domain: string
  /** Hostname of the mail server that receives for it. */
  mailHost: string
  /** Public IPv4 of the sending server, authorised in SPF. */
  ip?: string
  /** Additional SPF mechanisms, e.g. `include:amazonses.com`. */
  spfIncludes?: string[]
  /** DKIM selector. Convention is `default`. */
  dkimSelector?: string
  /**
   * DKIM public key, base64, without PEM armour or newlines. Omit to skip the
   * DKIM record: publishing an empty or malformed key is worse than publishing
   * none, because receivers treat a broken signature as a stronger negative
   * signal than an unsigned message.
   */
  dkimPublicKey?: string
  /** MX preference. */
  mxPriority?: number
  /**
   * DMARC policy. `none` by default: it asks receivers to report rather than
   * to reject, which is the only safe setting to switch on automatically for a
   * domain whose mail history nobody has checked yet.
   */
  dmarcPolicy?: 'none' | 'quarantine' | 'reject'
  /** Where aggregate DMARC reports go. Omitted from the record when absent. */
  dmarcReportTo?: string
  ttl?: number
}

/** SPF is a single TXT record; more than one is a permanent error. */
export function buildSpfValue(options: Pick<MailDnsOptions, 'ip' | 'spfIncludes'>): string {
  const mechanisms = ['v=spf1']
  if (options.ip) mechanisms.push(`ip4:${options.ip}`)
  for (const include of options.spfIncludes || []) {
    // Accept either `include:host` or a bare host, so callers can pass whichever
    // they have without the record silently becoming invalid.
    mechanisms.push(include.startsWith('include:') ? include : `include:${include}`)
  }
  // `~all` (softfail) rather than `-all`: a hard fail on a freshly provisioned
  // domain bounces legitimate mail the moment any sender is forgotten.
  mechanisms.push('~all')

  return mechanisms.join(' ')
}

/** Strip PEM armour and whitespace, which a DKIM TXT record must not contain. */
export function normalizeDkimKey(key: string): string {
  return String(key || '')
    .replace(/-----(?:BEGIN|END)[^-]*-----/g, '')
    .replace(/\s+/g, '')
}

export function buildDkimValue(publicKey: string): string {
  return `v=DKIM1; k=rsa; p=${normalizeDkimKey(publicKey)}`
}

export function buildDmarcValue(options: Pick<MailDnsOptions, 'dmarcPolicy' | 'dmarcReportTo'>): string {
  const parts = [`v=DMARC1`, `p=${options.dmarcPolicy || 'none'}`]
  if (options.dmarcReportTo) parts.push(`rua=mailto:${options.dmarcReportTo}`)

  return `${parts.join('; ')};`
}

/**
 * The full record set a mail-sending domain needs.
 *
 * Names are returned as the labels providers expect (`@` for the apex), since
 * every provider in this package normalises from that form.
 */
export function buildMailDnsRecords(options: MailDnsOptions): DnsRecord[] {
  if (!options.domain) throw new Error('A domain is required to build mail DNS records.')
  if (!options.mailHost) throw new Error('A mail host is required to build mail DNS records.')

  const ttl = options.ttl ?? 600
  const selector = options.dkimSelector || 'default'

  const records: DnsRecord[] = [
    {
      name: '@',
      type: 'MX',
      content: options.mailHost,
      priority: options.mxPriority ?? 10,
      ttl,
    },
    {
      name: '@',
      type: 'TXT',
      content: buildSpfValue(options),
      ttl,
    },
    {
      name: '_dmarc',
      type: 'TXT',
      content: buildDmarcValue(options),
      ttl,
    },
  ]

  // Only when there is a real key. See the note on `dkimPublicKey`.
  if (normalizeDkimKey(options.dkimPublicKey || '')) {
    records.push({
      name: `${selector}._domainkey`,
      type: 'TXT',
      content: buildDkimValue(options.dkimPublicKey!),
      ttl,
    })
  }

  return records
}

export interface MailDnsSyncResult {
  domain: string
  applied: Array<{ name: string, type: string, ok: boolean, message?: string }>
  /** True when every record was written. */
  ok: boolean
}

/**
 * Publish the record set, idempotently.
 *
 * Uses `upsertRecord` rather than create, so a redeploy converges instead of
 * accumulating duplicate SPF records — two SPF TXT records on one domain is a
 * permanent error under RFC 7208 and breaks mail that previously worked.
 *
 * Never throws. Mail DNS is one part of a deploy, and a zone that is
 * momentarily unreachable should surface as a reported failure rather than
 * roll back an otherwise healthy release.
 */
export async function syncMailDns(
  provider: DnsProvider,
  options: MailDnsOptions,
): Promise<MailDnsSyncResult> {
  const records = buildMailDnsRecords(options)
  const applied: MailDnsSyncResult['applied'] = []

  for (const record of records) {
    try {
      const result = await provider.upsertRecord(options.domain, record)
      applied.push({
        name: record.name,
        type: record.type,
        ok: Boolean(result.success),
        message: result.message,
      })
    }
    catch (error) {
      applied.push({
        name: record.name,
        type: record.type,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { domain: options.domain, applied, ok: applied.every(entry => entry.ok) }
}
