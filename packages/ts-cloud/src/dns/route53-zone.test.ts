import { describe, expect, it } from 'bun:test'
import { Route53Provider } from './route53-adapter'

/** The three calls `createZone` makes, answered from a list of zones. */
function fakeClient(zones: Array<{ Id: string, Name: string, private?: boolean, nameServers: string[] }>) {
  const created: string[] = []
  const client = {
    listHostedZonesByName: async () => ({
      HostedZones: zones.map(z => ({ Id: z.Id, Name: z.Name, Config: { PrivateZone: !!z.private } })),
      IsTruncated: false,
      MaxItems: '100',
    }),
    getHostedZone: async ({ Id }: { Id: string }) => {
      const zone = zones.find(z => z.Id === Id)!
      return { HostedZone: { Id: zone.Id, Name: zone.Name }, DelegationSet: { NameServers: zone.nameServers } }
    },
    createHostedZone: async ({ Name }: { Name: string }) => {
      created.push(Name)
      return { HostedZone: { Id: '/hostedzone/ZNEW', Name }, DelegationSet: { NameServers: ['ns-9.awsdns-09.org.'] }, ChangeInfo: { Id: 'c', Status: 'PENDING', SubmittedAt: '' }, Location: '' }
    },
  }
  return { client: client as any, created }
}

describe('Route53Provider.createZone', () => {
  it('reuses the public zone of that exact name and reports its nameservers', async () => {
    const { client, created } = fakeClient([{ Id: '/hostedzone/ZOLD', Name: 'example.com.', nameServers: ['NS-1.awsdns-01.org.', 'ns-2.awsdns-02.com'] }])
    const zone = await new Route53Provider('us-east-1', undefined, client).createZone('Example.com.')
    expect(zone).toEqual({ id: 'ZOLD', name: 'example.com', status: 'active', nameServers: ['ns-1.awsdns-01.org', 'ns-2.awsdns-02.com'], created: false })
    expect(created).toEqual([])
  })

  it('creates a zone where there is none', async () => {
    const { client, created } = fakeClient([])
    const zone = await new Route53Provider('us-east-1', undefined, client).createZone('example.com')
    expect(zone).toEqual({ id: 'ZNEW', name: 'example.com', status: 'active', nameServers: ['ns-9.awsdns-09.org'], created: true })
    expect(created).toEqual(['example.com.'])
  })

  it('does not take a parent zone or a private zone for the domain\'s own', async () => {
    // Route 53 answers a by-name listing from the nearest name onward, so a
    // parent or a neighbour can come back first.
    const { client, created } = fakeClient([
      { Id: '/hostedzone/ZPRIV', Name: 'app.example.com.', private: true, nameServers: [] },
      { Id: '/hostedzone/ZPARENT', Name: 'example.com.', nameServers: ['ns-1.awsdns-01.org'] },
    ])
    const zone = await new Route53Provider('us-east-1', undefined, client).createZone('app.example.com')
    expect(zone.created).toBe(true)
    expect(created).toEqual(['app.example.com.'])
  })
})
