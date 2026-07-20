import type { DnsProvider, DnsRecord, DnsRecordResult } from '../../src/dns/types'
import { describe, expect, it } from 'bun:test'
import { collectServerDnsDomains, removeStaleServerAddressRecords } from '../../src/deploy/server-dns'

describe('collectServerDnsDomains', () => {
  it('includes server, process, and redirect-only sites', () => {
    expect([...collectServerDnsDomains({
      static: { domain: 'example.com', deploy: 'server' },
      api: { domain: 'example.com', start: 'bun server.ts' },
      redirect: { domain: 'www.example.com', redirect: 'https://example.com' },
      bucket: { domain: 'assets.example.com', deploy: 's3' },
    })]).toEqual(['example.com', 'www.example.com'])
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
    const provider = {
      listRecords: async () => ({ success: true, records }),
      deleteRecord: async (_zone: string, record: DnsRecord) => {
        deleted.push(record)
        return { success: true }
      },
    } as unknown as DnsProvider

    expect(await removeStaleServerAddressRecords(provider, 'example.com', 'www.example.com', '178.105.248.188')).toEqual([])
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
})
