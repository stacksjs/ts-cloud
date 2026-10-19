import { describe, expect, test } from 'bun:test'
import { HetznerClient } from './client'

/** A client whose requests are recorded and answered with `answer`. */
function recording(answer: unknown): { client: HetznerClient, bodies: unknown[] } {
  const bodies: unknown[] = []
  const client = new HetznerClient({
    apiToken: 'test',
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined)
      return new Response(JSON.stringify(answer), { status: 201, headers: { 'Content-Type': 'application/json' } })
    }) as any,
  })
  return { client, bodies }
}

describe('firewall targets', () => {
  test('apply a firewall to a server as { server: { id } }, the shape the API accepts', async () => {
    const { client, bodies } = recording({ actions: [] })
    await client.applyFirewallToResources(11840374, [{ type: 'server', server: 170466391 }])
    expect(bodies[0]).toEqual({ apply_to: [{ type: 'server', server: { id: 170466391 } }] })
  })

  test('create a firewall already applied to a server in the same shape', async () => {
    const { client, bodies } = recording({ firewall: { id: 1 }, actions: [] })
    await client.createFirewall({ name: 'fw', rules: [], applyTo: [{ type: 'server', server: 42 }] })
    expect((bodies[0] as any).apply_to).toEqual([{ type: 'server', server: { id: 42 } }])
  })
})
