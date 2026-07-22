import { describe, expect, it } from 'bun:test'
import { CloudFormationBuilder } from '../builder'

function template(dnsProvider?: 'route53' | 'external') {
  return new CloudFormationBuilder({
    project: { name: 'API', slug: 'api', region: 'us-east-1' },
    environments: { production: { type: 'production' } },
    infrastructure: {
      apiGateway: {
        type: 'http',
        customDomain: { domain: 'api.example.com', certificateArn: 'arn:aws:acm:us-east-1:123:certificate/one', dnsProvider },
      },
    } as any,
  }).build()
}

describe('API Gateway custom domain DNS ownership', () => {
  it('retains Route53 as the default', () => {
    const result = template()
    expect(result.Resources.ApiDNSRecord?.Type).toBe('AWS::Route53::RecordSet')
    expect(result.Outputs?.ApiCustomDomainTarget).toBeDefined()
  })

  it('returns the regional DNS target without creating a Route53 record for external DNS', () => {
    const result = template('external')
    expect(result.Resources.ApiDNSRecord).toBeUndefined()
    expect(result.Resources.ApiCustomDomain).toBeDefined()
    expect(result.Outputs?.ApiCustomDomainTarget?.Value).toEqual({ 'Fn::GetAtt': ['ApiCustomDomain', 'RegionalDomainName'] })
  })
})
