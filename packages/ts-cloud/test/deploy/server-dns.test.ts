import type { DnsProvider, DnsRecord, DnsRecordResult } from '../../src/dns/types'
import { describe, expect, it } from 'bun:test'
import {
  collectServerDnsDomains,
  hostAcceptsIpv6,
  normalizePublicIpv6,
  reconcileAddressRecords,
  removeStaleServerAddressRecords,
} from '../../src/deploy/server-dns'

describe('collectServerDnsDomains', () => {
  it('includes server, process, and redirect-only sites', () => {
    expect([
      ...collectServerDnsDomains({
        static: { domain: 'example.com', deploy: 'server' },
        api: { domain: 'example.com', start: 'bun server.ts' },
        redirect: { domain: 'www.example.com', redirect: 'https://example.com' },
        bucket: { domain: 'assets.example.com', deploy: 's3' },
      }),
    ]).toEqual(['example.com', 'www.example.com'])
  })
})

describe('removeStaleServerAddressRecords', () => {
  it('removes duplicate stale addresses only for the managed hostname', async () => {
    const records: DnsRecordResult[] = [
      { id: '1', name: 'www', type: 'A', content: '178.105.248.188' },
      { id: '2', name: 'www', type: 'A', content: '49.12.8.203' },
      { id: '3', name: 'api', type: 'A', content: '49.12.8.203' },
    ]
    const deleted: DnsRecordResult[] = []
    const listTypes: Array<string | undefined> = []
    const provider = {
      listRecords: async (_zone: string, type?: string) => {
        listTypes.push(type)
        return { success: true, records }
      },
      deleteRecord: async (_zone: string, record: DnsRecord) => {
        deleted.push(record)
        return { success: true }
      },
    } as unknown as DnsProvider

    expect(
      await removeStaleServerAddressRecords(provider, 'example.com', 'www.example.com', '178.105.248.188'),
    ).toEqual([])
    expect(listTypes).toEqual([undefined])
    expect(deleted).toEqual([{ id: '2', name: 'www', type: 'A', content: '49.12.8.203' }])
  })

  it('preserves records when the desired address is not visible yet', async () => {
    let deletes = 0
    const provider = {
      listRecords: async () => ({
        success: true,
        records: [
          { name: '@', type: 'A', content: '192.0.2.1' },
          { name: '@', type: 'A', content: '192.0.2.2' },
        ],
      }),
      deleteRecord: async () => {
        deletes += 1
        return { success: true }
      },
    } as unknown as DnsProvider

    expect(await removeStaleServerAddressRecords(provider, 'example.com', 'example.com', '178.105.248.188')).toEqual([])
    expect(deletes).toBe(0)
  })

  it('cleans stale AAAA records without touching the A records', async () => {
    // A stale AAAA is the dangerous one: dual-stack clients prefer IPv6, so a
    // leftover address keeps taking traffic long after the box moved.
    const records: DnsRecordResult[] = [
      { id: '1', name: '@', type: 'AAAA', content: '2a01:4f8:c014:6186::1' },
      { id: '2', name: '@', type: 'AAAA', content: '2a01:4f8:dead:beef::1' },
      { id: '3', name: '@', type: 'A', content: '49.12.8.203' },
    ]
    const deleted: DnsRecordResult[] = []
    const provider = {
      listRecords: async () => ({ success: true, records }),
      deleteRecord: async (_zone: string, record: DnsRecord) => {
        deleted.push(record as DnsRecordResult)
        return { success: true }
      },
    } as unknown as DnsProvider

    expect(
      await removeStaleServerAddressRecords(
        provider,
        'example.com',
        'example.com',
        '2a01:4f8:c014:6186::1',
        'AAAA',
      ),
    ).toEqual([])
    expect(deleted).toEqual([{ id: '2', name: '@', type: 'AAAA', content: '2a01:4f8:dead:beef::1' }])
  })
})

describe('normalizePublicIpv6', () => {
  it('turns a reported /64 into the address the box actually holds', () => {
    // Hetzner's API reports the block, not the address; publishing the block
    // verbatim gives an AAAA record nothing answers on.
    expect(normalizePublicIpv6('2a01:4f8:c014:6186::/64')).toBe('2a01:4f8:c014:6186::1')
  })

  it('passes a plain address through untouched', () => {
    // AWS reports one address per network interface, already usable.
    expect(normalizePublicIpv6('2600:1f18:6210:cd00:aaaa::5')).toBe('2600:1f18:6210:cd00:aaaa::5')
  })

  it('has nothing to say about a missing or empty address', () => {
    expect(normalizePublicIpv6(undefined)).toBeUndefined()
    expect(normalizePublicIpv6('')).toBeUndefined()
    expect(normalizePublicIpv6('   ')).toBeUndefined()
  })
})

describe('hostAcceptsIpv6', () => {
  it('keeps mail hosts on IPv4', () => {
    // The mail server binds IPv4 and the box's v6 address has no PTR, so an
    // AAAA here turns deliveries into deferrals.
    for (const host of ['mail.example.com', 'smtp.example.com', 'imap.example.com', 'mx.example.com'])
      expect(hostAcceptsIpv6(host)).toBe(false)
  })

  it('allows every web host', () => {
    for (const host of ['example.com', 'www.example.com', 'dashboard.example.com', 'mailbox.example.com'])
      expect(hostAcceptsIpv6(host)).toBe(true)
  })
})

describe('reconcileAddressRecords', () => {
  interface Written { type: string; content: string }

  function providerWith(records: DnsRecordResult[], written: Written[]) {
    return {
      name: 'test',
      listRecords: async () => ({ success: true, records }),
      upsertRecord: async (_zone: string, record: DnsRecord) => {
        written.push({ type: record.type, content: record.content })
        records.push({ id: String(records.length + 1), name: record.name, type: record.type, content: record.content })
        return { success: true }
      },
      deleteRecord: async () => ({ success: true }),
    } as unknown as DnsProvider
  }

  it('publishes both families when the box has an IPv6 address', async () => {
    const written: Written[] = []
    const report = await reconcileAddressRecords({
      provider: providerWith([], written),
      zone: 'example.com',
      fqdn: 'example.com',
      ipv4: '178.105.248.188',
      ipv6: '2a01:4f8:c014:6186::1',
    })

    expect(written).toEqual([
      { type: 'A', content: '178.105.248.188' },
      { type: 'AAAA', content: '2a01:4f8:c014:6186::1' },
    ])
    expect(report.published.map(r => r.type)).toEqual(['A', 'AAAA'])
    expect(report.warnings).toEqual([])
  })

  it('publishes IPv4 only for a mail host, even on a dual-stack box', async () => {
    const written: Written[] = []
    const report = await reconcileAddressRecords({
      provider: providerWith([], written),
      zone: 'example.com',
      fqdn: 'mail.example.com',
      ipv4: '178.105.248.188',
      ipv6: '2a01:4f8:c014:6186::1',
    })

    expect(written).toEqual([{ type: 'A', content: '178.105.248.188' }])
    expect(report.published.map(r => r.type)).toEqual(['A'])
  })

  it('skips the AAAA pass entirely when the box has no IPv6', async () => {
    const written: Written[] = []
    await reconcileAddressRecords({
      provider: providerWith([], written),
      zone: 'example.com',
      fqdn: 'example.com',
      ipv4: '178.105.248.188',
    })

    expect(written).toEqual([{ type: 'A', content: '178.105.248.188' }])
  })

  it('reports a failed write instead of claiming the record is published', async () => {
    const provider = {
      name: 'test',
      listRecords: async () => ({ success: true, records: [] }),
      upsertRecord: async () => ({ success: false, message: 'zone is locked' }),
      deleteRecord: async () => ({ success: true }),
    } as unknown as DnsProvider

    const report = await reconcileAddressRecords({
      provider,
      zone: 'example.com',
      fqdn: 'example.com',
      ipv4: '178.105.248.188',
      ipv6: '2a01:4f8:c014:6186::1',
    })

    expect(report.published).toEqual([])
    expect(report.warnings).toHaveLength(2)
    expect(report.warnings[0]).toContain('zone is locked')
  })

  it('catches a phantom success — an upsert that reported OK but wrote nothing', async () => {
    const provider = {
      name: 'test',
      listRecords: async () => ({ success: true, records: [] }),
      upsertRecord: async () => ({ success: true }),
      deleteRecord: async () => ({ success: true }),
    } as unknown as DnsProvider

    const report = await reconcileAddressRecords({
      provider,
      zone: 'example.com',
      fqdn: 'example.com',
      ipv4: '178.105.248.188',
    })

    expect(report.published).toEqual([])
    expect(report.warnings[0]).toContain('no matching A record exists')
  })
})
