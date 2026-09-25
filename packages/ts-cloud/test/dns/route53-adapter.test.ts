import { describe, expect, it } from 'bun:test'
import { parseTxtStrings, Route53Provider, toTxtStrings } from '../../src/dns/route53-adapter'

function providerWithRecorder() {
  const changes: any[] = []
  const provider = new Route53Provider('us-east-1', 'zone-id')
  ;(provider as any).client = {
    // An empty zone: nothing at the name yet, so create stays a CREATE.
    listResourceRecordSets: async () => ({ ResourceRecordSets: [], IsTruncated: false }),
    changeResourceRecordSets: async (request: any) => {
      changes.push(request)
      return { ChangeInfo: { Id: 'change-id' } }
    },
  }
  return { provider, changes }
}

describe('Route53 record names', () => {
  it('joins a relative record name to the hosted zone', async () => {
    const { provider, changes } = providerWithRecorder()

    const result = await provider.createRecord('stacksjs.com', {
      name: 'dashboard.whitepaper',
      type: 'A',
      content: '178.105.248.188',
      ttl: 300,
    })

    expect(result.success).toBe(true)
    expect(changes[0].ChangeBatch.Changes[0].ResourceRecordSet.Name).toBe(
      'dashboard.whitepaper.stacksjs.com.',
    )
  })

  it('preserves a fully qualified record name and resolves an apex marker', async () => {
    const { provider, changes } = providerWithRecorder()

    await provider.upsertRecord('stacksjs.com', {
      name: 'dashboard.whitepaper.stacksjs.com.',
      type: 'A',
      content: '178.105.248.188',
    })
    await provider.upsertRecord('stacksjs.com', {
      name: '',
      type: 'A',
      content: '178.105.248.188',
    })

    expect(changes[0].ChangeBatch.Changes[0].ResourceRecordSet.Name).toBe(
      'dashboard.whitepaper.stacksjs.com.',
    )
    expect(changes[1].ChangeBatch.Changes[0].ResourceRecordSet.Name).toBe('stacksjs.com.')
  })
})

interface FakeSet { Name: string, Type: string, TTL: number, ResourceRecords: Array<{ Value: string }> }

/**
 * A Route53 that enforces its own rules: CREATE fails on an existing set,
 * DELETE must name the set exactly, UPSERT replaces it.
 */
function fakeRoute53(initial: FakeSet[] = []) {
  const sets: FakeSet[] = initial.map(s => ({ ...s, ResourceRecords: [...s.ResourceRecords] }))
  const calls: string[] = []
  const find = (name: string, type: string) => sets.findIndex(s => s.Name === name && s.Type === type)
  const client = {
    async listResourceRecordSets(params: { StartRecordName?: string, StartRecordType?: string }) {
      const at = find(params.StartRecordName ?? '', params.StartRecordType ?? '')
      return { ResourceRecordSets: at === -1 ? [] : [sets[at]], IsTruncated: false }
    },
    async changeResourceRecordSets(params: any) {
      for (const change of params.ChangeBatch.Changes) {
        const set = change.ResourceRecordSet as FakeSet
        const at = find(set.Name, set.Type)
        calls.push(`${change.Action} ${set.Type} ${set.Name} [${set.ResourceRecords.map(r => r.Value).join(', ')}]`)
        if (change.Action === 'CREATE') {
          if (at !== -1) throw new Error('InvalidChangeBatch: record set already exists')
          sets.push(set)
        }
        else if (change.Action === 'UPSERT') {
          if (at === -1) sets.push(set)
          else sets[at] = set
        }
        else if (change.Action === 'DELETE') {
          const same = at !== -1 && JSON.stringify(sets[at].ResourceRecords) === JSON.stringify(set.ResourceRecords) && sets[at].TTL === set.TTL
          if (!same) throw new Error('InvalidChangeBatch: values provided do not match the current values')
          sets.splice(at, 1)
        }
      }
      return { ChangeInfo: { Id: 'change-1' } }
    },
  }
  const provider = new Route53Provider('us-east-1', 'Z123')
  ;(provider as any).client = client
  return { provider, sets, calls }
}

const NAME = '_acme-challenge.example.com.'
const values = (sets: FakeSet[]) => sets.find(s => s.Name === NAME)?.ResourceRecords.map(r => r.Value) ?? []

describe('Route53Provider multi-valued records', () => {
  it('creates a set when there is none, and adds to it when there is', async () => {
    const { provider, sets, calls } = fakeRoute53()

    expect((await provider.createRecord('example.com', { name: '_acme-challenge', type: 'TXT', content: 'apex' })).success).toBe(true)
    expect((await provider.createRecord('example.com', { name: '_acme-challenge', type: 'TXT', content: 'wildcard' })).success).toBe(true)

    expect(values(sets)).toEqual(['"apex"', '"wildcard"'])
    expect(calls.map(c => c.split(' ')[0])).toEqual(['CREATE', 'UPSERT'])
  })

  it('does not rewrite a set that already holds the value', async () => {
    const { provider, calls } = fakeRoute53([{ Name: NAME, Type: 'TXT', TTL: 60, ResourceRecords: [{ Value: '"apex"' }] }])

    expect((await provider.createRecord('example.com', { name: '_acme-challenge', type: 'TXT', content: 'apex' })).success).toBe(true)
    expect(calls).toEqual([])
  })

  it('removes one value and keeps the other', async () => {
    const { provider, sets } = fakeRoute53([{ Name: NAME, Type: 'TXT', TTL: 60, ResourceRecords: [{ Value: '"apex"' }, { Value: '"wildcard"' }] }])

    expect((await provider.deleteRecord('example.com', { name: '_acme-challenge', type: 'TXT', content: 'apex' })).success).toBe(true)

    expect(values(sets)).toEqual(['"wildcard"'])
  })

  it('deletes the set with its last value, and treats an absent value as done', async () => {
    const { provider, sets, calls } = fakeRoute53([{ Name: NAME, Type: 'TXT', TTL: 60, ResourceRecords: [{ Value: '"wildcard"' }] }])

    expect((await provider.deleteRecord('example.com', { name: '_acme-challenge', type: 'TXT', content: 'wildcard' })).success).toBe(true)
    expect(sets).toEqual([])
    expect((await provider.deleteRecord('example.com', { name: '_acme-challenge', type: 'TXT', content: 'wildcard' })).success).toBe(true)
    expect(calls.map(c => c.split(' ')[0])).toEqual(['DELETE'])
  })
})

describe('Route53Provider long TXT values', () => {
  // A 2048-bit DKIM record is ~410 characters; Route53 caps one string at 255.
  const DKIM = `v=DKIM1; k=rsa; p=${'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA'.repeat(9)}IDAQAB`
  const DKIM_NAME = 'mail._domainkey.example.com.'
  const strings = (value: string) => [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1])

  it('writes a value over 255 characters as several strings of at most 255', async () => {
    const { provider, sets } = fakeRoute53()

    expect((await provider.upsertRecord('example.com', { name: 'mail._domainkey', type: 'TXT', content: DKIM })).success).toBe(true)

    const stored = sets.find(s => s.Name === DKIM_NAME)!.ResourceRecords[0].Value
    expect(DKIM.length).toBeGreaterThan(255)
    expect(strings(stored).length).toBe(Math.ceil(DKIM.length / 255))
    expect(strings(stored).every(part => part.length <= 255)).toBe(true)
    expect(strings(stored).join('')).toBe(DKIM)
  })

  it('reads a split value back as the one value it is', async () => {
    const { provider } = fakeRoute53([{ Name: DKIM_NAME, Type: 'TXT', TTL: 600, ResourceRecords: [{ Value: toTxtStrings(DKIM) }] }])
    ;(provider as any).getHostedZoneId = async () => 'Z123'
    ;(provider as any).client.listResourceRecordSets = async () => ({
      ResourceRecordSets: [{ Name: DKIM_NAME, Type: 'TXT', TTL: 600, ResourceRecords: [{ Value: toTxtStrings(DKIM) }] }],
      IsTruncated: false,
    })

    const listed = await provider.listRecords('example.com')

    expect(listed.success).toBe(true)
    expect(listed.records.find(r => r.type === 'TXT')?.content).toBe(DKIM)
  })

  it('treats the same text split differently as already present, and can delete it', async () => {
    // Another tool split this key at 200 characters instead of 255.
    const splitElsewhere = `"${DKIM.slice(0, 200)}" "${DKIM.slice(200)}"`
    const { provider, sets, calls } = fakeRoute53([{ Name: DKIM_NAME, Type: 'TXT', TTL: 600, ResourceRecords: [{ Value: splitElsewhere }] }])

    expect((await provider.createRecord('example.com', { name: 'mail._domainkey', type: 'TXT', content: DKIM })).success).toBe(true)
    expect(calls).toEqual([])

    expect((await provider.deleteRecord('example.com', { name: 'mail._domainkey', type: 'TXT', content: DKIM })).success).toBe(true)
    expect(sets).toEqual([])
  })

  it('keeps quotes and backslashes intact through a round trip', () => {
    const text = `say "hi" \\ ${'x'.repeat(300)}`

    expect(parseTxtStrings(toTxtStrings(text))).toBe(text)
    expect(toTxtStrings('short')).toBe('"short"')
  })
})
