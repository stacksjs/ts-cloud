import { afterEach, describe, expect, it } from 'bun:test'
import type { DnsRecordResult } from '../../src/dns/types'
import { PorkbunProvider } from '../../src/dns/porkbun'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('PorkbunProvider retries', () => {
  it('times out a stalled request and retries it', async () => {
    let calls = 0
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        calls += 1
        if (calls > 1) {
          return Response.json({
            status: 'SUCCESS',
            records: [],
          })
        }

        const signal = args[1]?.signal
        await new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
        throw new Error('unreachable')
      },
      { preconnect: originalFetch.preconnect },
    )

    const result = await new PorkbunProvider('api-key', 'secret-key', 5).listRecords('example.com')
    expect(result.success).toBe(true)
    expect(calls).toBe(2)
  })

  it('retries transient API failures before returning records', async () => {
    let calls = 0
    globalThis.fetch = Object.assign(
      async (..._args: Parameters<typeof fetch>) => {
        calls += 1
        if (calls === 1) {
          return new Response('temporarily unavailable', {
            status: 503,
            headers: { 'retry-after': '0' },
          })
        }
        return Response.json({
          status: 'SUCCESS',
          records: [{ id: '1', name: 'www.example.com', type: 'A', content: '192.0.2.1', ttl: '600' }],
        })
      },
      { preconnect: originalFetch.preconnect },
    )

    const result = await new PorkbunProvider('api-key', 'secret-key').listRecords('example.com')
    expect(result.success).toBe(true)
    expect(result.records).toHaveLength(1)
    expect(calls).toBe(2)
  })

  it('deletes a listed record directly by its Porkbun id', async () => {
    const requests: string[] = []
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        requests.push(String(input))
        return Response.json({ status: 'SUCCESS' })
      },
      { preconnect: originalFetch.preconnect },
    )

    const result = await new PorkbunProvider('api-key', 'secret-key').deleteRecord('example.com', {
      id: '12345',
      name: 'www.example.com',
      type: 'A',
      content: '192.0.2.1',
    } as DnsRecordResult)

    expect(result.success).toBe(true)
    expect(requests).toEqual(['https://api.porkbun.com/api/json/v3/dns/delete/example.com/12345'])
  })

  it('does not retry permanent authorization failures', async () => {
    let calls = 0
    globalThis.fetch = Object.assign(
      async (..._args: Parameters<typeof fetch>) => {
        calls += 1
        return new Response('forbidden', { status: 403 })
      },
      { preconnect: originalFetch.preconnect },
    )

    const result = await new PorkbunProvider('api-key', 'secret-key').listRecords('example.com')
    expect(result.success).toBe(false)
    expect(result.message).toContain('403')
    expect(calls).toBe(1)
  })
})

describe('PorkbunProvider apex A records vs the parking ALIAS', () => {
  /**
   * Fake Porkbun that reproduces the real behaviour: `/dns/create` for an
   * address record is accepted and reported SUCCESS, but the record is only
   * actually stored when no ALIAS/CNAME occupies that name.
   */
  function fakePorkbun(initial: DnsRecordResult[]) {
    const zone = [...initial]
    let nextId = 100
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        const path = String(url)
        const body = init?.body ? JSON.parse(String(init.body)) : {}
        if (path.includes('/dns/retrieve/'))
          return Response.json({ status: 'SUCCESS', records: zone })
        if (path.includes('/dns/delete/')) {
          const id = path.split('/').pop()!
          const i = zone.findIndex(r => r.id === id)
          if (i >= 0) zone.splice(i, 1)
          return Response.json({ status: 'SUCCESS' })
        }
        if (path.includes('/dns/create/')) {
          const name = body.name ? `${body.name}.example.com` : 'example.com'
          const blocked = zone.some(r => (r.type === 'ALIAS' || r.type === 'CNAME') && r.name === name)
          // SUCCESS either way — the silent discard is the whole bug.
          if (!blocked)
            zone.push({ id: String(nextId++), name, type: body.type, content: body.content } as DnsRecordResult)
          return Response.json({ status: 'SUCCESS', id: nextId })
        }
        return Response.json({ status: 'SUCCESS' })
      },
      { preconnect: originalFetch.preconnect },
    )
    return zone
  }

  it('clears the parking ALIAS so the apex A record actually persists', async () => {
    const zone = fakePorkbun([
      { id: '1', name: 'example.com', type: 'ALIAS', content: 'pixie.porkbun.com' } as DnsRecordResult,
      { id: '2', name: 'example.com', type: 'MX', content: 'mail.example.com' } as DnsRecordResult,
    ])

    const result = await new PorkbunProvider('k', 's', 5)
      .upsertRecord('example.com', { name: 'example.com', type: 'A', content: '178.105.248.188', ttl: 300 })

    expect(result.success).toBe(true)
    expect(zone.some(r => r.type === 'A' && r.content === '178.105.248.188')).toBe(true)
    // The conflicting ALIAS is gone; unrelated records are untouched.
    expect(zone.some(r => r.type === 'ALIAS')).toBe(false)
    expect(zone.some(r => r.type === 'MX')).toBe(true)
  })

  it('reports failure instead of success when the record did not persist', async () => {
    // A zone whose ALIAS cannot be deleted — the write is voided and the
    // deploy must hear about it rather than logging a green DNS step.
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request) => {
        const path = String(url)
        if (path.includes('/dns/retrieve/')) {
          return Response.json({
            status: 'SUCCESS',
            records: [{ id: '1', name: 'example.com', type: 'ALIAS', content: 'pixie.porkbun.com' }],
          })
        }
        if (path.includes('/dns/delete/'))
          return Response.json({ status: 'ERROR', message: 'cannot delete' })
        return Response.json({ status: 'SUCCESS', id: 9 })
      },
      { preconnect: originalFetch.preconnect },
    )

    const result = await new PorkbunProvider('k', 's', 5)
      .upsertRecord('example.com', { name: 'example.com', type: 'A', content: '1.2.3.4', ttl: 300 })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/ALIAS|no A record/i)
  })

  it('leaves a CNAME alone when writing an unrelated TXT record', async () => {
    const zone = fakePorkbun([
      { id: '1', name: 'www.example.com', type: 'CNAME', content: 'example.com' } as DnsRecordResult,
    ])

    await new PorkbunProvider('k', 's', 5)
      .upsertRecord('example.com', { name: 'example.com', type: 'TXT', content: 'v=spf1 -all', ttl: 300 })

    expect(zone.some(r => r.type === 'CNAME')).toBe(true)
  })
})
