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
    globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
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
    }, { preconnect: originalFetch.preconnect })

    const result = await new PorkbunProvider('api-key', 'secret-key', 5).listRecords('example.com')
    expect(result.success).toBe(true)
    expect(calls).toBe(2)
  })

  it('retries transient API failures before returning records', async () => {
    let calls = 0
    globalThis.fetch = Object.assign(async (..._args: Parameters<typeof fetch>) => {
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
    }, { preconnect: originalFetch.preconnect })

    const result = await new PorkbunProvider('api-key', 'secret-key').listRecords('example.com')
    expect(result.success).toBe(true)
    expect(result.records).toHaveLength(1)
    expect(calls).toBe(2)
  })

  it('deletes a listed record directly by its Porkbun id', async () => {
    const requests: string[] = []
    globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
      requests.push(String(input))
      return Response.json({ status: 'SUCCESS' })
    }, { preconnect: originalFetch.preconnect })

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
    globalThis.fetch = Object.assign(async (..._args: Parameters<typeof fetch>) => {
      calls += 1
      return new Response('forbidden', { status: 403 })
    }, { preconnect: originalFetch.preconnect })

    const result = await new PorkbunProvider('api-key', 'secret-key').listRecords('example.com')
    expect(result.success).toBe(false)
    expect(result.message).toContain('403')
    expect(calls).toBe(1)
  })
})
