import { afterEach, describe, expect, it } from 'bun:test'
import { DashboardRequestError, requestJson } from './requestJson'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('dashboard request parsing', () => {
  it('retains the API error message', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: false, error: 'Port is reserved.' }), { status: 409 }),
      )) as typeof fetch
    await expect(requestJson('/api/firewall')).rejects.toEqual(
      new DashboardRequestError('Port is reserved.', 409, { ok: false, error: 'Port is reserved.' }),
    )
  })

  it('turns an HTML proxy response into a bounded useful error', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('<h1>Bad gateway</h1><p>upstream unavailable</p>', { status: 502 }))) as typeof fetch
    await expect(requestJson('/api/databases')).rejects.toThrow('Bad gateway upstream unavailable')
  })
})
