import { afterEach, describe, expect, it } from 'bun:test'
import { CloudflareProvider } from './cloudflare'

const realFetch = globalThis.fetch

interface Call { method: string, url: string, body: any }

/**
 * Stand in for the two endpoints this touches: zone lookup, and the managed
 * headers themselves. Everything else 404s, so a request that goes somewhere
 * unexpected fails the test rather than passing quietly.
 */
function mockCloudflare(managedRequestHeaders: Array<{ id: string, enabled: boolean }>): Call[] {
  const calls: Call[] = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url: href, body })

    const json = (result: unknown) => new Response(
      JSON.stringify({ success: true, errors: [], messages: [], result }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

    if (href.includes('/zones?name='))
      return json([{ id: 'zone-1', name: 'example.com' }])

    if (href.includes('/managed_headers')) {
      if (method === 'GET')
        return json({ managed_request_headers: managedRequestHeaders, managed_response_headers: [] })
      return json({ managed_request_headers: body?.managed_request_headers ?? [], managed_response_headers: [] })
    }

    return new Response(JSON.stringify({ success: false, errors: [{ message: `unexpected ${method} ${href}` }] }), { status: 404 })
  }) as typeof fetch

  return calls
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('CloudflareProvider managed request headers', () => {
  it('reads the catalogue as a map of id to enabled', async () => {
    mockCloudflare([
      { id: 'add_visitor_location_headers', enabled: false },
      { id: 'add_true_client_ip_headers', enabled: true },
    ])

    const headers = await new CloudflareProvider('token').getManagedRequestHeaders('example.com')

    expect(headers.add_visitor_location_headers).toBe(false)
    expect(headers.add_true_client_ip_headers).toBe(true)
  })

  it('enables a transform that is off, and says what it changed', async () => {
    const calls = mockCloudflare([{ id: 'add_visitor_location_headers', enabled: false }])

    const result = await new CloudflareProvider('token')
      .applyManagedRequestHeaders('example.com', { add_visitor_location_headers: true })

    expect(result.changed).toEqual([{ id: 'add_visitor_location_headers', from: false, to: true }])
    expect(result.failed).toEqual([])

    const patch = calls.find(c => c.method === 'PATCH')
    expect(patch?.body.managed_request_headers).toEqual([{ id: 'add_visitor_location_headers', enabled: true }])
    // Cloudflare rejects a body that omits the response side, even when only
    // the request side is being changed.
    expect(patch?.body.managed_response_headers).toEqual([])
  })

  it('writes nothing when the transform is already as declared', async () => {
    const calls = mockCloudflare([{ id: 'add_visitor_location_headers', enabled: true }])

    const result = await new CloudflareProvider('token')
      .applyManagedRequestHeaders('example.com', { add_visitor_location_headers: true })

    expect(result.changed).toEqual([])
    expect(calls.some(c => c.method === 'PATCH')).toBe(false)
  })

  it('turns one off as readily as on — declaring false is a declaration', async () => {
    const calls = mockCloudflare([{ id: 'add_visitor_location_headers', enabled: true }])

    const result = await new CloudflareProvider('token')
      .applyManagedRequestHeaders('example.com', { add_visitor_location_headers: false })

    expect(result.changed).toEqual([{ id: 'add_visitor_location_headers', from: true, to: false }])
    expect(calls.find(c => c.method === 'PATCH')?.body.managed_request_headers)
      .toEqual([{ id: 'add_visitor_location_headers', enabled: false }])
  })

  it('makes no request at all when nothing is declared', async () => {
    const calls = mockCloudflare([{ id: 'add_visitor_location_headers', enabled: false }])

    const result = await new CloudflareProvider('token').applyManagedRequestHeaders('example.com', {})

    expect(result).toEqual({ changed: [], failed: [] })
    expect(calls).toEqual([])
  })

  it('names an id the zone does not know, instead of PATCHing into a generic error', async () => {
    const calls = mockCloudflare([{ id: 'add_visitor_location_headers', enabled: false }])

    const result = await new CloudflareProvider('token')
      .applyManagedRequestHeaders('example.com', { add_visitors_location_header: true })

    expect(result.changed).toEqual([])
    expect(result.failed[0]).toMatchObject({ id: 'add_visitors_location_header' })
    expect(result.failed[0].error).toContain('not a managed request header transform')
    expect(calls.some(c => c.method === 'PATCH')).toBe(false)
  })

  it('applies the transforms it recognises even when another id is wrong', async () => {
    mockCloudflare([
      { id: 'add_visitor_location_headers', enabled: false },
      { id: 'add_true_client_ip_headers', enabled: false },
    ])

    const result = await new CloudflareProvider('token').applyManagedRequestHeaders('example.com', {
      add_visitor_location_headers: true,
      nonsense_transform: true,
    })

    expect(result.changed).toEqual([{ id: 'add_visitor_location_headers', from: false, to: true }])
    expect(result.failed).toHaveLength(1)
  })

  it('reports every declared transform when the catalogue cannot be read', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes('/zones?name=')) {
        return new Response(
          JSON.stringify({ success: true, errors: [], messages: [], result: [{ id: 'zone-1', name: 'example.com' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ success: false, errors: [{ message: 'token lacks Zone Settings:Read' }] }), { status: 403 })
    }) as typeof fetch

    const result = await new CloudflareProvider('token')
      .applyManagedRequestHeaders('example.com', { add_visitor_location_headers: true })

    expect(result.changed).toEqual([])
    expect(result.failed[0].error).toContain('could not read managed headers')
  })

  it('collects a failure per transform rather than throwing the deploy', async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url)
      if (href.includes('/zones?name=')) {
        return new Response(
          JSON.stringify({ success: true, errors: [], messages: [], result: [{ id: 'zone-1', name: 'example.com' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(
          JSON.stringify({ success: true, errors: [], messages: [], result: { managed_request_headers: [{ id: 'add_visitor_location_headers', enabled: false }] } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ success: false, errors: [{ message: 'insufficient permissions' }] }), { status: 403 })
    }) as typeof fetch

    const result = await new CloudflareProvider('token')
      .applyManagedRequestHeaders('example.com', { add_visitor_location_headers: true })

    expect(result.changed).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].id).toBe('add_visitor_location_headers')
  })
})
