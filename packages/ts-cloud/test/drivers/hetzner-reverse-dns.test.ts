import { expect, it } from 'bun:test'
import { planServerReverseDns } from '../../src/drivers/hetzner/reverse-dns'
import { HetznerClient, type HetznerServer } from '../../src/drivers/hetzner/client'

it('converges both public PTR records and rejects malformed hostnames', () => {
  const hostname = 'mail.example.com'
  const server = { public_net: { ipv4: { ip: '203.0.113.10' }, ipv6: { ip: '2001:db8:1234::/64' } } } as HetznerServer
  expect(planServerReverseDns(server)).toEqual([])
  expect(planServerReverseDns(server, hostname)).toEqual([{ ip: '203.0.113.10', hostname }, { ip: '2001:db8:1234::1', hostname }])
  server.public_net.ipv4!.dns_ptr = hostname
  server.public_net.ipv6!.dns_ptr = [{ ip: '2001:db8:1234::1', dns_ptr: hostname }]
  expect(planServerReverseDns(server, hostname)).toEqual([])
  for (const value of ['localhost', 'mail.example.com\nwrong', '-mail.example.com', 'https://mail.example.com']) expect(() => planServerReverseDns(server, value)).toThrow()
})

it('uses the provider PTR action with an explicit hostname', async () => {
  const client = new HetznerClient({ apiToken: 'fixture-token', fetchImpl: async (url, init) => {
    expect(url).toBe('https://api.hetzner.cloud/v1/servers/123/actions/change_dns_ptr')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ ip: '203.0.113.10', dns_ptr: 'mail.example.com' })
    return Response.json({ action: { id: 456, status: 'success' } })
  } })
  expect((await client.changeServerReverseDns(123, '203.0.113.10', 'mail.example.com')).id).toBe(456)
})
