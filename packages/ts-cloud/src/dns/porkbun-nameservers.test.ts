import { afterEach, describe, expect, it } from 'bun:test'
import { PorkbunProvider } from './porkbun'

/**
 * These pin the two endpoint PATHS, which is unusual for a unit test and
 * warranted here.
 *
 * Both methods swallow their errors — `getNameServers` returns `[]` and
 * `updateNameServers` returns `false` — so a wrong path does not throw, it
 * produces a plausible-looking negative answer. That is exactly what happened:
 * they called `/dns/getNS/` and `/dns/updateNS/`, which 404, and the symptoms
 * were "this domain appears to have no nameservers" and "Porkbun declined the
 * change". Neither points at a URL.
 *
 * Nameservers belong to the DOMAIN, not to the zone's records, and Porkbun's
 * API splits on that line.
 */
const realFetch = globalThis.fetch

function captureFetch(response: unknown) {
  const calls: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url))
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return calls
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('PorkbunProvider nameservers', () => {
  it('reads them from the domain endpoint', async () => {
    const calls = captureFetch({ status: 'SUCCESS', ns: ['a.ns.porkbun.com', 'b.ns.porkbun.com'] })
    const provider = new PorkbunProvider('key', 'secret')

    const nameservers = await provider.getNameServers('example.com')

    expect(nameservers).toEqual(['a.ns.porkbun.com', 'b.ns.porkbun.com'])
    expect(calls[0]).toContain('/domain/getNs/example.com')
    expect(calls[0]).not.toContain('/dns/')
  })

  it('writes them to the domain endpoint', async () => {
    const calls = captureFetch({ status: 'SUCCESS' })
    const provider = new PorkbunProvider('key', 'secret')

    const ok = await provider.updateNameServers('example.com', ['x.ns.cloudflare.com', 'y.ns.cloudflare.com'])

    expect(ok).toBe(true)
    expect(calls[0]).toContain('/domain/updateNs/example.com')
    expect(calls[0]).not.toContain('/dns/')
  })

  it('uses the registrable domain for a subdomain', async () => {
    const calls = captureFetch({ status: 'SUCCESS', ns: [] })
    const provider = new PorkbunProvider('key', 'secret')

    await provider.getNameServers('www.example.com')

    // Delegation is a property of the registered domain; asking about a
    // subdomain has to resolve to the same call.
    expect(calls[0]).toContain('/domain/getNs/example.com')
  })
})
