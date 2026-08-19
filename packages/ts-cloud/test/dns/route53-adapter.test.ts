import { describe, expect, it } from 'bun:test'
import { Route53Provider } from '../../src/dns/route53-adapter'

function providerWithRecorder() {
  const changes: any[] = []
  const provider = new Route53Provider('us-east-1', 'zone-id')
  ;(provider as any).client = {
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
