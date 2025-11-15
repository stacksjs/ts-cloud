import { describe, expect, it } from 'bun:test'
import { DNS } from '../src/modules/dns'
import { TemplateBuilder } from '../src/template-builder'

describe('DNS Module', () => {
  describe('createHostedZone', () => {
    it('should create a hosted zone', () => {
      const { zone, logicalId } = DNS.createHostedZone({
        domain: 'example.com',
        slug: 'my-app',
        environment: 'production',
      })

      expect(zone.Type).toBe('AWS::Route53::HostedZone')
      expect(zone.Properties.Name).toBe('example.com')
      expect(zone.Properties.HostedZoneConfig?.Comment).toContain('example.com')
      expect(logicalId).toBeDefined()
    })

    it('should create hosted zone with custom comment', () => {
      const { zone } = DNS.createHostedZone({
        domain: 'example.com',
        slug: 'my-app',
        environment: 'production',
        comment: 'Custom DNS zone',
      })

      expect(zone.Properties.HostedZoneConfig?.Comment).toBe('Custom DNS zone')
    })
  })

  describe('createRecord', () => {
    it('should create an A record with values', () => {
      const { record } = DNS.createRecord({
        hostedZoneId: 'Z1234567890ABC',
        name: 'example.com',
        type: 'A',
        ttl: 300,
        values: ['192.0.2.1'],
      })

      expect(record.Type).toBe('AWS::Route53::RecordSet')
      expect(record.Properties.Name).toBe('example.com')
      expect(record.Properties.Type).toBe('A')
      expect(record.Properties.TTL).toBe(300)
      expect(record.Properties.ResourceRecords).toContain('192.0.2.1')
    })

    it('should create an alias record', () => {
      const { record } = DNS.createRecord({
        hostedZoneId: 'Z1234567890ABC',
        name: 'www.example.com',
        type: 'A',
        aliasTarget: {
          dnsName: 'd123.cloudfront.net',
          hostedZoneId: 'Z2FDTNDATAQYW2',
          evaluateTargetHealth: false,
        },
      })

      expect(record.Properties.AliasTarget).toBeDefined()
      expect(record.Properties.AliasTarget?.DNSName).toBe('d123.cloudfront.net')
      expect(record.Properties.TTL).toBeUndefined() // Alias records don't have TTL
    })

    it('should use hosted zone name instead of ID', () => {
      const { record } = DNS.createRecord({
        hostedZoneName: 'example.com',
        name: 'api.example.com',
        type: 'A',
        values: ['192.0.2.2'],
      })

      expect(record.Properties.HostedZoneName).toBe('example.com')
      expect(record.Properties.HostedZoneId).toBeUndefined()
    })
  })

  describe('createCloudFrontAlias', () => {
    it('should create CloudFront alias record', () => {
      const { record } = DNS.createCloudFrontAlias(
        'www.example.com',
        'd123.cloudfront.net',
        'Z1234567890ABC',
      )

      expect(record.Properties.Type).toBe('A')
      expect(record.Properties.AliasTarget?.DNSName).toBe('d123.cloudfront.net')
      expect(record.Properties.AliasTarget?.HostedZoneId).toBe('Z2FDTNDATAQYW2')
      expect(record.Properties.AliasTarget?.EvaluateTargetHealth).toBe(false)
    })
  })

  describe('createAlbAlias', () => {
    it('should create ALB alias record with health check', () => {
      const { record } = DNS.createAlbAlias(
        'api.example.com',
        'my-alb-123.us-east-1.elb.amazonaws.com',
        'Z35SXDOTRQ7X7K',
        'Z1234567890ABC',
      )

      expect(record.Properties.Type).toBe('A')
      expect(record.Properties.AliasTarget?.DNSName).toBe('my-alb-123.us-east-1.elb.amazonaws.com')
      expect(record.Properties.AliasTarget?.EvaluateTargetHealth).toBe(true)
    })
  })

  describe('createCname', () => {
    it('should create CNAME record', () => {
      const { record } = DNS.createCname(
        'blog.example.com',
        'myblog.wordpress.com',
        'Z1234567890ABC',
      )

      expect(record.Properties.Type).toBe('CNAME')
      expect(record.Properties.ResourceRecords).toContain('myblog.wordpress.com')
      expect(record.Properties.TTL).toBe(300)
    })

    it('should create CNAME with custom TTL', () => {
      const { record } = DNS.createCname(
        'cdn.example.com',
        'd123.cloudfront.net',
        'Z1234567890ABC',
        600,
      )

      expect(record.Properties.TTL).toBe(600)
    })
  })

  describe('createWwwRedirect', () => {
    it('should create www redirect to apex domain', () => {
      const { record } = DNS.createWwwRedirect('example.com', 'Z1234567890ABC')

      expect(record.Properties.Name).toBe('www.example.com')
      expect(record.Properties.Type).toBe('CNAME')
      expect(record.Properties.ResourceRecords).toContain('example.com')
    })
  })

  describe('createMxRecords', () => {
    it('should create MX records with priorities', () => {
      const { record } = DNS.createMxRecords(
        'example.com',
        [
          { priority: 10, server: 'mail1.example.com' },
          { priority: 20, server: 'mail2.example.com' },
        ],
        'Z1234567890ABC',
      )

      expect(record.Properties.Type).toBe('MX')
      expect(record.Properties.ResourceRecords).toContain('10 mail1.example.com')
      expect(record.Properties.ResourceRecords).toContain('20 mail2.example.com')
    })
  })

  describe('createTxtRecord', () => {
    it('should create TXT record with quoted value', () => {
      const { record } = DNS.createTxtRecord(
        'example.com',
        'v=spf1 include:_spf.example.com ~all',
        'Z1234567890ABC',
      )

      expect(record.Properties.Type).toBe('TXT')
      expect(record.Properties.ResourceRecords?.[0]).toBe('"v=spf1 include:_spf.example.com ~all"')
    })
  })

  describe('createSpfRecord', () => {
    it('should create SPF record', () => {
      const { record } = DNS.createSpfRecord(
        'example.com',
        'v=spf1 include:_spf.google.com ~all',
        'Z1234567890ABC',
      )

      expect(record.Properties.Type).toBe('TXT')
      expect(record.Properties.ResourceRecords?.[0]).toContain('v=spf1')
    })
  })

  describe('createDmarcRecord', () => {
    it('should create DMARC record with policy', () => {
      const { record } = DNS.createDmarcRecord(
        'example.com',
        'quarantine',
        'dmarc@example.com',
        'Z1234567890ABC',
      )

      expect(record.Properties.Name).toBe('_dmarc.example.com')
      expect(record.Properties.Type).toBe('TXT')
      expect(record.Properties.ResourceRecords?.[0]).toContain('p=quarantine')
      expect(record.Properties.ResourceRecords?.[0]).toContain('rua=mailto:dmarc@example.com')
    })

    it('should create DMARC with different policies', () => {
      const policies: Array<'none' | 'quarantine' | 'reject'> = ['none', 'quarantine', 'reject']

      for (const policy of policies) {
        const { record } = DNS.createDmarcRecord(
          'example.com',
          policy,
          'dmarc@example.com',
          'Z1234567890ABC',
        )

        expect(record.Properties.ResourceRecords?.[0]).toContain(`p=${policy}`)
      }
    })
  })

  describe('Integration with TemplateBuilder', () => {
    it('should create complete DNS setup in template', () => {
      const template = new TemplateBuilder('DNS Infrastructure')

      // Create hosted zone
      const { zone, logicalId: zoneId } = DNS.createHostedZone({
        domain: 'example.com',
        slug: 'my-app',
        environment: 'production',
      })
      template.addResource(zoneId, zone)

      // Create A record for apex
      const { record: apexRecord, logicalId: apexId } = DNS.createCloudFrontAlias(
        'example.com',
        'd123.cloudfront.net',
        'Z1234567890ABC',
      )
      template.addResource(apexId, apexRecord)

      // Create www redirect
      const { record: wwwRecord, logicalId: wwwId } = DNS.createWwwRedirect(
        'example.com',
        'Z1234567890ABC',
      )
      template.addResource(wwwId, wwwRecord)

      const result = template.build()

      expect(result.Resources[zoneId]).toBeDefined()
      expect(result.Resources[apexId]).toBeDefined()
      expect(result.Resources[wwwId]).toBeDefined()
    })

    it('should generate valid JSON template', () => {
      const template = new TemplateBuilder('DNS Test')

      const { zone, logicalId } = DNS.createHostedZone({
        domain: 'test.com',
        slug: 'test',
        environment: 'development',
      })

      template.addResource(logicalId, zone)

      const json = template.toJSON()
      const parsed = JSON.parse(json)

      expect(parsed.Resources[logicalId].Type).toBe('AWS::Route53::HostedZone')
      expect(parsed.Resources[logicalId].Properties.Name).toBe('test.com')
    })
  })
})
