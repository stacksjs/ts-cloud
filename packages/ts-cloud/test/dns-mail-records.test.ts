import type { DnsProvider, DnsRecord } from '../src/dns/types'
import { describe, expect, it } from 'bun:test'
import {
  buildDkimValue,
  buildDmarcValue,
  buildMailDnsRecords,
  buildSpfValue,
  normalizeDkimKey,
  syncMailDns,
} from '../src/dns/mail-records'

const BASE = { domain: 'example.com', mailHost: 'mail.example.com', ip: '203.0.113.10' }

function recordFor(records: DnsRecord[], type: string, name = '@'): DnsRecord | undefined {
  return records.find(record => record.type === type && record.name === name)
}

describe('buildSpfValue', () => {
  it('authorises the sending ip and softfails everything else', () => {
    expect(buildSpfValue({ ip: '203.0.113.10' })).toBe('v=spf1 ip4:203.0.113.10 ~all')
  })

  it('accepts includes with or without the mechanism prefix', () => {
    expect(buildSpfValue({ ip: '203.0.113.10', spfIncludes: ['amazonses.com', 'include:_spf.google.com'] }))
      .toBe('v=spf1 ip4:203.0.113.10 include:amazonses.com include:_spf.google.com ~all')
  })

  it('is still valid with no ip, for a domain that only sends via includes', () => {
    expect(buildSpfValue({ spfIncludes: ['amazonses.com'] })).toBe('v=spf1 include:amazonses.com ~all')
  })

  it('softfails rather than hardfails, so a forgotten sender does not bounce', () => {
    expect(buildSpfValue({ ip: '203.0.113.10' }).endsWith('~all')).toBe(true)
  })
})

describe('normalizeDkimKey', () => {
  it('strips PEM armour and newlines, which a TXT record cannot carry', () => {
    const pem = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBg\nkqhkiG9w0B\n-----END PUBLIC KEY-----\n'
    expect(normalizeDkimKey(pem)).toBe('MIIBIjANBgkqhkiG9w0B')
  })

  it('leaves an already-normalised key alone', () => {
    expect(normalizeDkimKey('MIIBIjANBg')).toBe('MIIBIjANBg')
  })
})

describe('buildDkimValue', () => {
  it('produces a v=DKIM1 record with the bare key', () => {
    expect(buildDkimValue('MIIBIjANBg')).toBe('v=DKIM1; k=rsa; p=MIIBIjANBg')
  })
})

describe('buildDmarcValue', () => {
  it('defaults to a reporting-only policy', () => {
    // p=reject on a domain nobody has audited would silently destroy mail.
    expect(buildDmarcValue({})).toBe('v=DMARC1; p=none;')
  })

  it('includes an aggregate report address when given one', () => {
    expect(buildDmarcValue({ dmarcPolicy: 'quarantine', dmarcReportTo: 'dmarc@example.com' }))
      .toBe('v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com;')
  })
})

describe('buildMailDnsRecords', () => {
  it('produces MX, SPF and DMARC at minimum', () => {
    const records = buildMailDnsRecords(BASE)
    expect(records).toHaveLength(3)
    expect(recordFor(records, 'MX')?.content).toBe('mail.example.com')
    expect(recordFor(records, 'MX')?.priority).toBe(10)
    expect(recordFor(records, 'TXT')?.content).toContain('v=spf1')
    expect(recordFor(records, 'TXT', '_dmarc')?.content).toContain('v=DMARC1')
  })

  it('adds DKIM under the selector when a key is supplied', () => {
    const records = buildMailDnsRecords({ ...BASE, dkimPublicKey: 'MIIBIjANBg', dkimSelector: 'default' })
    expect(records).toHaveLength(4)
    expect(recordFor(records, 'TXT', 'default._domainkey')?.content).toBe('v=DKIM1; k=rsa; p=MIIBIjANBg')
  })

  it('omits DKIM entirely rather than publishing an empty key', () => {
    // A broken signature is a stronger negative signal than no signature.
    for (const key of ['', '   ', '-----BEGIN PUBLIC KEY-----\n-----END PUBLIC KEY-----']) {
      const records = buildMailDnsRecords({ ...BASE, dkimPublicKey: key })
      expect(records.some(record => record.name.includes('_domainkey'))).toBe(false)
    }
  })

  it('honours a custom selector', () => {
    const records = buildMailDnsRecords({ ...BASE, dkimPublicKey: 'AAA', dkimSelector: 'ots' })
    expect(recordFor(records, 'TXT', 'ots._domainkey')).toBeDefined()
  })

  it('emits exactly one SPF record, since two is a permanent error', () => {
    const spf = buildMailDnsRecords({ ...BASE, dkimPublicKey: 'AAA' })
      .filter(record => record.type === 'TXT' && record.content.startsWith('v=spf1'))
    expect(spf).toHaveLength(1)
  })

  it('refuses to build without a domain or a mail host', () => {
    expect(() => buildMailDnsRecords({ ...BASE, domain: '' })).toThrow(/domain is required/)
    expect(() => buildMailDnsRecords({ ...BASE, mailHost: '' })).toThrow(/mail host is required/)
  })
})

describe('syncMailDns', () => {
  function fakeProvider(overrides: Partial<DnsProvider> = {}): DnsProvider {
    return {
      name: 'fake',
      createRecord: async () => ({ success: true }),
      upsertRecord: async () => ({ success: true }),
      deleteRecord: async () => ({ success: true }),
      ...overrides,
    } as DnsProvider
  }

  it('upserts every record and reports success', async () => {
    const seen: DnsRecord[] = []
    const result = await syncMailDns(
      fakeProvider({ upsertRecord: async (_d, record) => { seen.push(record); return { success: true } } }),
      { ...BASE, dkimPublicKey: 'AAA' },
    )

    expect(result.ok).toBe(true)
    expect(result.applied).toHaveLength(4)
    expect(seen.map(record => record.type).sort()).toEqual(['MX', 'TXT', 'TXT', 'TXT'])
  })

  it('upserts rather than creates, so a redeploy cannot duplicate SPF', async () => {
    let created = 0
    let upserted = 0
    await syncMailDns(
      fakeProvider({
        createRecord: async () => { created++; return { success: true } },
        upsertRecord: async () => { upserted++; return { success: true } },
      }),
      BASE,
    )

    expect(created).toBe(0)
    expect(upserted).toBe(3)
  })

  it('reports a failed record without throwing, so a deploy is not rolled back', async () => {
    const result = await syncMailDns(
      fakeProvider({ upsertRecord: async () => { throw new Error('zone unreachable') } }),
      BASE,
    )

    expect(result.ok).toBe(false)
    expect(result.applied.every(entry => !entry.ok)).toBe(true)
    expect(result.applied[0].message).toContain('zone unreachable')
  })

  it('reports a provider that answers unsuccessfully rather than throwing', async () => {
    const result = await syncMailDns(
      fakeProvider({ upsertRecord: async () => ({ success: false, message: 'rate limited' }) }),
      BASE,
    )

    expect(result.ok).toBe(false)
    expect(result.applied[0].message).toBe('rate limited')
  })
})
