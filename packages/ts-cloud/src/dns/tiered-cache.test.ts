import { afterEach, describe, expect, it } from 'bun:test'
import { CloudflareProvider } from './cloudflare'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** A zone whose two tiered-cache switches start at `initial`, recording every write. */
function zone(initial: { tiered: string, smart: string }) {
  const state = { ...initial }
  const writes: Array<{ path: string, value: string }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const json = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { headers: { 'content-type': 'application/json' } })
    if (url.pathname.endsWith('/zones'))
      return json([{ id: 'zone-1', name: 'example.com', status: 'active' }])
    const key = url.pathname.endsWith('/argo/tiered_caching') ? 'tiered' : url.pathname.endsWith('/tiered_cache_smart_topology_enable') ? 'smart' : null
    if (!key)
      return json({})
    if (method === 'PATCH') {
      const value = JSON.parse(String(init?.body)).value
      state[key] = value
      writes.push({ path: url.pathname.split('/').slice(-2).join('/'), value })
    }
    return json({ id: key, value: state[key] })
  }) as typeof fetch
  return { state, writes }
}

describe('applyTieredCache', () => {
  it('turns on tiered caching and smart topology, tiers first', async () => {
    const { state, writes } = zone({ tiered: 'off', smart: 'off' })
    const result = await new CloudflareProvider('token').applyTieredCache('example.com', 'smart')
    expect(state).toEqual({ tiered: 'on', smart: 'on' })
    expect(writes.map(w => w.path)).toEqual(['argo/tiered_caching', 'cache/tiered_cache_smart_topology_enable'])
    expect(result.changed.map(c => c.id)).toEqual(['tiered_caching', 'tiered_cache_smart_topology_enable'])
    expect(result.failed).toEqual([])
  })

  it('writes nothing when the zone already matches', async () => {
    const { writes } = zone({ tiered: 'on', smart: 'on' })
    const result = await new CloudflareProvider('token').applyTieredCache('example.com', 'smart')
    expect(writes).toEqual([])
    expect(result.changed).toEqual([])
  })

  it('generic keeps tiers but no smart topology; off turns smart off first', async () => {
    const generic = zone({ tiered: 'off', smart: 'on' })
    await new CloudflareProvider('token').applyTieredCache('example.com', 'generic')
    expect(generic.state).toEqual({ tiered: 'on', smart: 'off' })

    const off = zone({ tiered: 'on', smart: 'on' })
    await new CloudflareProvider('token').applyTieredCache('example.com', 'off')
    expect(off.state).toEqual({ tiered: 'off', smart: 'off' })
    expect(off.writes.map(w => w.path)).toEqual(['cache/tiered_cache_smart_topology_enable', 'argo/tiered_caching'])
  })
})
