import type { DnsProvider, DnsRecord, DnsRecordResult, DnsRecordType } from './types'
import { describe, expect, it } from 'bun:test'
import { delegateZone, isNameserverRegistrar, sameNameservers } from './delegation'

const CF_NS = ['alex.ns.cloudflare.com', 'melany.ns.cloudflare.com']
const REGISTRAR_NS = ['curitiba.porkbun.com', 'salvador.porkbun.com']

const rec = (type: DnsRecordType, name: string, content: string, extra: Partial<DnsRecordResult> = {}): DnsRecordResult =>
  ({ type, name, content, ...extra })

/** A registrar that both serves records and controls the delegation. */
function fakeRegistrar(records: DnsRecordResult[], nameservers = REGISTRAR_NS) {
  let current = [...nameservers]
  const base: DnsProvider = {
    name: 'porkbun',
    async listRecords() {
      return { success: true, records: [...records] }
    },
    async createRecord() {
      return { success: true }
    },
    async upsertRecord() {
      return { success: true }
    },
    async deleteRecord() {
      return { success: true }
    },
    async canManageDomain() {
      return true
    },
    async listDomains() {
      return ['example.com']
    },
  }

  return {
    ...base,
    async getNameServers() {
      return [...current]
    },
    async updateNameServers(_domain: string, next: string[]) {
      current = [...next]
      return true
    },
    get nameservers() {
      return current
    },
  }
}

/** A destination that hosts the zone. `swallow` drops a record silently. */
function fakeHost(options: { swallow?: (r: DnsRecord) => boolean, nameServers?: string[] } = {}) {
  const zone: DnsRecordResult[] = []
  const base: DnsProvider = {
    name: 'cloudflare',
    async listRecords() {
      return { success: true, records: [...zone] }
    },
    async createRecord() {
      return { success: true }
    },
    async upsertRecord(_domain, record) {
      // A provider that reports success and stores nothing is exactly the
      // failure the read-back exists to catch.
      if (!options.swallow?.(record))
        zone.push({ ...record } as DnsRecordResult)
      return { success: true }
    },
    async deleteRecord() {
      return { success: true }
    },
    async canManageDomain() {
      return true
    },
    async listDomains() {
      return ['example.com']
    },
  }

  return {
    ...base,
    zone,
    async createZone(domain: string) {
      return {
        id: 'zone-1',
        name: domain,
        status: 'pending',
        nameServers: options.nameServers ?? CF_NS,
        created: true,
      }
    },
  }
}

const ZONE: DnsRecordResult[] = [
  rec('A', 'example.com', '203.0.113.10'),
  rec('A', 'www.example.com', '203.0.113.10'),
  rec('A', 'mail.example.com', '203.0.113.10'),
  rec('MX', 'example.com', 'mail.example.com', { priority: 10 }),
  rec('TXT', 'example.com', 'v=spf1 ip4:203.0.113.10 ~all'),
  rec('TXT', '_dmarc.example.com', 'v=DMARC1; p=quarantine'),
  rec('NS', 'example.com', 'curitiba.porkbun.com'),
]

describe('sameNameservers', () => {
  it('ignores order and trailing dots', () => {
    expect(sameNameservers(['a.ns.com', 'b.ns.com'], ['B.NS.COM.', 'a.ns.com'])).toBe(true)
  })

  it('treats an empty set as not matching, so a failed read never reads as delegated', () => {
    expect(sameNameservers([], CF_NS)).toBe(false)
  })
})

describe('delegateZone', () => {
  it('copies the zone, verifies it, then moves the nameservers', async () => {
    const registrar = fakeRegistrar(ZONE)
    const host = fakeHost()

    const report = await delegateZone({
      domain: 'example.com',
      registrar,
      host,
      proxiedHosts: ['example.com', 'www.example.com'],
    })

    expect(report.status).toBe('delegated')
    expect(report.missing).toEqual([])
    expect(registrar.nameservers).toEqual(CF_NS)

    // The delegation itself is never copied.
    expect(host.zone.some(r => r.type === 'NS')).toBe(false)
    // Mail survives, and its address record is NOT proxied.
    expect(host.zone.find(r => r.type === 'MX')?.content).toBe('mail.example.com')
    expect(host.zone.find(r => r.name === 'mail.example.com')?.proxied).toBe(false)
    expect(host.zone.find(r => r.name === 'www.example.com')?.proxied).toBe(true)
    // SPF and DMARC came across.
    expect(host.zone.filter(r => r.type === 'TXT')).toHaveLength(2)
  })

  it('refuses to delegate when a record did not arrive', async () => {
    const registrar = fakeRegistrar(ZONE)
    // The MX vanishes silently — mail would break the moment the NS moved.
    const host = fakeHost({ swallow: r => r.type === 'MX' })

    const report = await delegateZone({ domain: 'example.com', registrar, host })

    expect(report.status).toBe('blocked')
    expect(report.missing.map(r => r.type)).toContain('MX')
    expect(registrar.nameservers).toEqual(REGISTRAR_NS)
    expect(report.warnings.join(' ')).toContain('incomplete')
  })

  it('is a no-op once the registrar already points at the host', async () => {
    const registrar = fakeRegistrar(ZONE, CF_NS)
    const host = fakeHost()

    const report = await delegateZone({ domain: 'example.com', registrar, host })

    // Re-importing here would resurrect anything deleted at the destination
    // since the move.
    expect(report.status).toBe('already-delegated')
    expect(host.zone).toHaveLength(0)
  })

  it('changes nothing on a dry run', async () => {
    const registrar = fakeRegistrar(ZONE)
    const host = fakeHost()

    const report = await delegateZone({ domain: 'example.com', registrar, host, dryRun: true })

    expect(report.status).toBe('ready')
    expect(host.zone).toHaveLength(0)
    expect(registrar.nameservers).toEqual(REGISTRAR_NS)
  })

  it('will not delegate to a host that reports no nameservers', async () => {
    const registrar = fakeRegistrar(ZONE)
    const host = fakeHost({ nameServers: [] })

    const report = await delegateZone({ domain: 'example.com', registrar, host })

    expect(report.status).toBe('blocked')
    expect(registrar.nameservers).toEqual(REGISTRAR_NS)
  })
})

describe('isNameserverRegistrar', () => {
  it('recognises a provider that can change delegation', () => {
    expect(isNameserverRegistrar(fakeRegistrar(ZONE))).toBe(true)
    expect(isNameserverRegistrar({ name: 'x' })).toBe(false)
  })
})
