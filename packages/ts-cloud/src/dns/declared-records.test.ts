import type { DnsProvider, DnsRecord, DnsRecordResult, DnsRecordType } from './types'
import { describe, expect, it } from 'bun:test'
import { policyTag, qualifyName, reconcileDeclaredRecords, resolveDeclaredRecords } from './declared-records'

/** In-memory DnsProvider that records every mutation. */
function fakeProvider(initial: DnsRecordResult[] = []) {
  const zone: DnsRecordResult[] = [...initial]
  const calls: Array<{ op: 'create' | 'upsert' | 'delete', record: DnsRecord }> = []

  const provider: DnsProvider = {
    name: 'fake',
    async listRecords() {
      return { success: true, records: [...zone] }
    },
    async createRecord(_domain, record) {
      calls.push({ op: 'create', record })
      zone.push({ ...record } as DnsRecordResult)
      return { success: true }
    },
    async upsertRecord(_domain, record) {
      calls.push({ op: 'upsert', record })
      const i = zone.findIndex(r => r.type === record.type && r.name === record.name)
      if (i >= 0) zone[i] = { ...zone[i], ...record } as DnsRecordResult
      else zone.push({ ...record } as DnsRecordResult)
      return { success: true }
    },
    async deleteRecord(_domain, record) {
      calls.push({ op: 'delete', record })
      const i = zone.findIndex(r => r.type === record.type && r.name === record.name && r.content === record.content)
      if (i >= 0) zone.splice(i, 1)
      return { success: true }
    },
    async canManageDomain() {
      return true
    },
    async listDomains() {
      return ['example.com']
    },
  }

  return { provider, zone, calls }
}

const rec = (type: DnsRecordType, name: string, content: string, extra: Partial<DnsRecordResult> = {}): DnsRecordResult =>
  ({ type, name, content, ...extra })

const run = (records: Parameters<typeof resolveDeclaredRecords>[0], existing: DnsRecordResult[] = []) => {
  const f = fakeProvider(existing)
  return reconcileDeclaredRecords({
    provider: f.provider,
    zone: 'example.com',
    records: resolveDeclaredRecords(records, 'example.com'),
  }).then(report => ({ ...f, report }))
}

describe('qualifyName', () => {
  it('treats @, empty and omitted as the apex', () => {
    expect(qualifyName('@', 'example.com')).toBe('example.com')
    expect(qualifyName('', 'example.com')).toBe('example.com')
    expect(qualifyName(undefined, 'example.com')).toBe('example.com')
  })

  it('qualifies a bare label and leaves an FQDN alone', () => {
    expect(qualifyName('autodiscover', 'example.com')).toBe('autodiscover.example.com')
    expect(qualifyName('autodiscover.example.com', 'example.com')).toBe('autodiscover.example.com')
  })
})

describe('policyTag', () => {
  it('recognises SPF and DMARC, and nothing else', () => {
    expect(policyTag('v=spf1 include:x -all')).toBe('v=spf1')
    expect(policyTag('"v=DMARC1; p=none"')).toBe('v=dmarc1')
    expect(policyTag('google-site-verification=abc')).toBeUndefined()
  })
})

describe('declared records default to DNS-only', () => {
  it('never proxies unless asked', () => {
    // Mail records cannot be proxied, and a proxied autodiscover CNAME sends
    // clients to the CDN instead of Microsoft.
    const resolved = resolveDeclaredRecords(
      [{ type: 'CNAME', name: 'autodiscover', content: 'autodiscover.outlook.com' }],
      'example.com',
    )
    expect(resolved[0].proxied).toBe(false)
  })
})

describe('SPF is replaced, never duplicated', () => {
  it('removes the old SPF before creating the new one', async () => {
    // Two v=spf1 records is a permerror: receivers conclude the domain has no
    // usable SPF at all, so mail that passed before starts failing. The old
    // record must go first — create-then-delete would publish both at once.
    const { calls, zone, report } = await run(
      [{ type: 'TXT', name: '@', content: 'v=spf1 include:spf.protection.outlook.com ~all' }],
      [rec('TXT', 'example.com', 'v=spf1 include:old.example ~all')],
    )

    const ops = calls.map(c => c.op)
    expect(ops).toEqual(['delete', 'create'])
    expect(zone.filter(r => r.type === 'TXT' && r.content.startsWith('v=spf1'))).toHaveLength(1)
    expect(report.outcomes[0].action).toBe('updated')
  })

  it('leaves unrelated TXT records at the same name untouched', async () => {
    const { zone } = await run(
      [{ type: 'TXT', name: '@', content: 'v=spf1 include:spf.protection.outlook.com ~all' }],
      [
        rec('TXT', 'example.com', 'google-site-verification=abc123'),
        rec('TXT', 'example.com', 'v=spf1 include:old.example ~all'),
      ],
    )

    expect(zone.some(r => r.content === 'google-site-verification=abc123')).toBe(true)
    expect(zone.filter(r => r.type === 'TXT')).toHaveLength(2)
  })

  it('does nothing when the SPF already matches', async () => {
    const spf = 'v=spf1 include:spf.protection.outlook.com ~all'
    const { calls, report } = await run([{ type: 'TXT', name: '@', content: spf }], [rec('TXT', 'example.com', spf)])
    expect(calls).toHaveLength(0)
    expect(report.outcomes[0].action).toBe('unchanged')
  })
})

describe('ordinary TXT records coexist', () => {
  it('adds a verification token beside an existing one', async () => {
    const { zone } = await run(
      [{ type: 'TXT', name: '@', content: 'MS=ms12345' }],
      [rec('TXT', 'example.com', 'google-site-verification=abc123')],
    )
    expect(zone.filter(r => r.type === 'TXT')).toHaveLength(2)
  })
})

describe('MX records', () => {
  it('creates the declared MX', async () => {
    const { zone, report } = await run([
      { type: 'MX', name: '@', content: 'x-com.mail.protection.outlook.com', priority: 0 },
    ])
    expect(zone).toHaveLength(1)
    expect(report.outcomes[0].action).toBe('created')
  })

  it('reports a stray MX instead of deleting it', async () => {
    // A leftover MX from a previous provider splits delivery, so the operator
    // has to see it — but deleting another party's record on a shared zone is
    // the worse failure, so it is only reported.
    const { zone, report } = await run(
      [{ type: 'MX', name: '@', content: 'x-com.mail.protection.outlook.com', priority: 0 }],
      [rec('MX', 'example.com', 'aspmx.l.google.com', { priority: 1 })],
    )

    expect(zone.filter(r => r.type === 'MX')).toHaveLength(2)
    expect(report.warnings.some(w => w.includes('aspmx.l.google.com') && w.includes('split'))).toBe(true)
  })

  it('updates priority without duplicating the record', async () => {
    const { zone } = await run(
      [{ type: 'MX', name: '@', content: 'mx.example.net', priority: 0 }],
      [rec('MX', 'example.com', 'mx.example.net', { priority: 10 })],
    )
    expect(zone.filter(r => r.type === 'MX')).toHaveLength(1)
    expect(zone[0].priority).toBe(0)
  })
})

describe('singleton types', () => {
  it('updates a CNAME in place rather than adding a second', async () => {
    const { zone } = await run(
      [{ type: 'CNAME', name: 'autodiscover', content: 'autodiscover.outlook.com' }],
      [rec('CNAME', 'autodiscover.example.com', 'old.example.net')],
    )
    expect(zone).toHaveLength(1)
    expect(zone[0].content).toBe('autodiscover.outlook.com')
  })
})

describe('failure handling', () => {
  it('reports a listing failure without touching anything', async () => {
    const provider: DnsProvider = {
      ...fakeProvider().provider,
      async listRecords() {
        return { success: false, records: [], message: 'token lacks DNS:Read' }
      },
    }
    const report = await reconcileDeclaredRecords({
      provider,
      zone: 'example.com',
      records: resolveDeclaredRecords([{ type: 'MX', name: '@', content: 'mx.example.net', priority: 0 }], 'example.com'),
    })
    expect(report.outcomes).toHaveLength(0)
    expect(report.warnings[0]).toContain('token lacks DNS:Read')
  })

  it('keeps going when one record fails', async () => {
    const f = fakeProvider()
    const provider: DnsProvider = {
      ...f.provider,
      async createRecord(_d, record) {
        if (record.type === 'MX') return { success: false, message: 'rejected' }
        return { success: true }
      },
    }
    const report = await reconcileDeclaredRecords({
      provider,
      zone: 'example.com',
      records: resolveDeclaredRecords(
        [
          { type: 'MX', name: '@', content: 'mx.example.net', priority: 0 },
          { type: 'TXT', name: '_dmarc', content: 'v=DMARC1; p=none' },
        ],
        'example.com',
      ),
    })
    expect(report.outcomes.map(o => o.action)).toEqual(['failed', 'created'])
  })
})
