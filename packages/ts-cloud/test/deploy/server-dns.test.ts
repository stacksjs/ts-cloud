import type { DnsProvider, DnsRecord, DnsRecordResult } from '../../src/dns/types'
import { describe, expect, it } from 'bun:test'
import { collectServerDnsDomains, hetznerBoxIpv6, removeStaleServerAddressRecords } from '../../src/deploy/server-dns'

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

describe('hetznerBoxIpv6', () => {
  it('turns the reported /64 into the address the box actually holds', () => {
    // Hetzner's API reports the block, not the address; publishing the block
    // verbatim gives an AAAA record nothing answers on.
    expect(hetznerBoxIpv6('2a01:4f8:c014:6186::/64')).toBe('2a01:4f8:c014:6186::1')
  })

  it('passes a plain address through untouched', () => {
    expect(hetznerBoxIpv6('2a01:4f8:c014:6186::1')).toBe('2a01:4f8:c014:6186::1')
  })

  it('has nothing to say about a missing or empty address', () => {
    expect(hetznerBoxIpv6(undefined)).toBeUndefined()
    expect(hetznerBoxIpv6('')).toBeUndefined()
    expect(hetznerBoxIpv6('   ')).toBeUndefined()
  })
})
