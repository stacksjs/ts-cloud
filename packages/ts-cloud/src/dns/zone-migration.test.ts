import type { ResourceRecordSet } from '../aws/route53'
import { describe, expect, it } from 'bun:test'
import { planZoneMigration } from './zone-migration'

const ZONE = 'example.com'

function plan(sets: ResourceRecordSet[]) {
  return planZoneMigration(sets, ZONE)
}

function rr(name: string, type: string, values: string[], TTL = 300): ResourceRecordSet {
  return { Name: name, Type: type, TTL, ResourceRecords: values.map(Value => ({ Value })) }
}

describe('planZoneMigration', () => {
  it('drops the records the destination issues itself', () => {
    const result = plan([
      rr('example.com.', 'SOA', ['ns-1.awsdns-01.com. hostmaster.amazon.com. 1 7200 900 1209600 86400']),
      rr('example.com.', 'NS', ['ns-1.awsdns-01.com.']),
    ])

    expect(result.records).toHaveLength(0)
    expect(result.skipped.map(s => s.type).sort()).toEqual(['NS', 'SOA'])
  })

  it('keeps a subdomain delegation, which is a real record rather than the zone apex', () => {
    const result = plan([rr('sub.example.com.', 'NS', ['ns1.other-provider.net.'])])

    expect(result.records).toEqual([
      expect.objectContaining({ name: 'sub.example.com', type: 'NS', content: 'ns1.other-provider.net' }),
    ])
  })

  it('reassembles a TXT value that DNS split at the 255-byte boundary', () => {
    // A DKIM key long enough to be stored as two character-strings. Treating
    // this as literal text publishes a key containing a quote and a space, and
    // every signature check against it fails.
    const result = plan([
      rr('mail._domainkey.example.com.', 'TXT', ['"v=DKIM1; k=rsa; p=FIRSTHALF" "SECONDHALF"']),
    ])

    expect(result.records[0].content).toBe('v=DKIM1; k=rsa; p=FIRSTHALFSECONDHALF')
  })

  it('keeps two TXT records at one name separate', () => {
    // SPF and a verification token share a name but are distinct records;
    // concatenating them would produce one nonsense policy.
    const result = plan([
      rr('example.com.', 'TXT', ['"v=spf1 include:amazonses.com ~all"', '"token-value"']),
    ])

    expect(result.records.map(r => r.content)).toEqual(['v=spf1 include:amazonses.com ~all', 'token-value'])
  })

  it('splits MX priority out of the value', () => {
    const result = plan([rr('example.com.', 'MX', ['10 mail.example.com.'])])

    expect(result.records[0]).toMatchObject({ type: 'MX', content: 'mail.example.com', priority: 10 })
  })

  it('splits all four SRV fields, so the target is not stored as RDATA text', () => {
    const result = plan([rr('_imaps._tcp.example.com.', 'SRV', ['0 1 993 mail.example.com.'])])

    expect(result.records[0]).toMatchObject({
      type: 'SRV',
      priority: 0,
      weight: 1,
      port: 993,
      content: 'mail.example.com',
    })
  })

  it('flattens an ALIAS to a CNAME', () => {
    const result = plan([
      {
        Name: 'cdn.example.com.',
        Type: 'A',
        AliasTarget: { HostedZoneId: 'Z2FDTNDATAQYW2', DNSName: 'd111.cloudfront.net.', EvaluateTargetHealth: false },
      },
    ])

    expect(result.records[0]).toMatchObject({ name: 'cdn.example.com', type: 'CNAME', content: 'd111.cloudfront.net' })
    expect(result.records[0].translatedFrom).toContain('ALIAS')
  })

  it('collapses an A/AAAA ALIAS pair into a single CNAME', () => {
    // Both address families resolve through the same hostname, and a CNAME
    // answers for both. Emitting two records would make the second overwrite
    // the first at any provider that keys on name+type.
    const alias = { HostedZoneId: 'Z2FDTNDATAQYW2', DNSName: 'd111.cloudfront.net.', EvaluateTargetHealth: false }
    const result = plan([
      { Name: 'cdn.example.com.', Type: 'A', AliasTarget: alias },
      { Name: 'cdn.example.com.', Type: 'AAAA', AliasTarget: alias },
    ])

    expect(result.records).toHaveLength(1)
  })

  it('refuses to migrate a routing-policy record rather than collapsing it', () => {
    const result = plan([
      { ...rr('api.example.com.', 'A', ['1.2.3.4']), SetIdentifier: 'us-east-1', Weight: 100 },
    ])

    expect(result.records).toHaveLength(0)
    expect(result.skipped[0].reason).toContain('routing policy')
    expect(result.warnings.join(' ')).toContain('NOT migrated')
  })

  it('warns when a health-checked ALIAS loses its health check', () => {
    const result = plan([
      {
        Name: 'cdn.example.com.',
        Type: 'A',
        AliasTarget: { HostedZoneId: 'Z', DNSName: 'd111.cloudfront.net.', EvaluateTargetHealth: true },
      },
    ])

    expect(result.warnings.join(' ')).toContain('health check')
  })
})
