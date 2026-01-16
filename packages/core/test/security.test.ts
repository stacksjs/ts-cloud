import { describe, expect, it } from 'bun:test'
import { Security } from '../src/modules/security'
import { TemplateBuilder } from '../src/template-builder'

describe('Security Module', () => {
  describe('createCertificate', () => {
    it('should create a basic SSL certificate', () => {
      const { certificate, logicalId } = Security.createCertificate({
        domain: 'example.com',
        slug: 'my-app',
        environment: 'production',
      })

      expect(certificate.Type).toBe('AWS::CertificateManager::Certificate')
      expect(certificate.Properties.DomainName).toBe('example.com')
      expect(certificate.Properties.ValidationMethod).toBe('DNS')
      expect(certificate.Properties.SubjectAlternativeNames).toContain('example.com')
      expect(logicalId).toBeDefined()
    })

    it('should create certificate with wildcard subdomain', () => {
      const { certificate } = Security.createCertificate({
        domain: 'example.com',
        subdomains: ['*'],
        slug: 'my-app',
        environment: 'production',
      })

      expect(certificate.Properties.SubjectAlternativeNames).toContain('example.com')
      expect(certificate.Properties.SubjectAlternativeNames).toContain('*.example.com')
      expect(certificate.Properties.SubjectAlternativeNames).toHaveLength(2)
    })

    it('should create certificate with specific subdomains', () => {
      const { certificate } = Security.createCertificate({
        domain: 'example.com',
        subdomains: ['www', 'api', 'cdn'],
        slug: 'my-app',
        environment: 'production',
      })

      expect(certificate.Properties.SubjectAlternativeNames).toContain('example.com')
      expect(certificate.Properties.SubjectAlternativeNames).toContain('www.example.com')
      expect(certificate.Properties.SubjectAlternativeNames).toContain('api.example.com')
      expect(certificate.Properties.SubjectAlternativeNames).toContain('cdn.example.com')
    })

    it('should support email validation', () => {
      const { certificate } = Security.createCertificate({
        domain: 'example.com',
        slug: 'my-app',
        environment: 'production',
        validationMethod: 'EMAIL',
      })

      expect(certificate.Properties.ValidationMethod).toBe('EMAIL')
      expect(certificate.Properties.DomainValidationOptions).toBeUndefined()
    })

    it('should add DNS validation with Route53 when hostedZoneId provided', () => {
      const { certificate } = Security.createCertificate({
        domain: 'example.com',
        subdomains: ['www'],
        slug: 'my-app',
        environment: 'production',
        validationMethod: 'DNS',
        hostedZoneId: 'Z1234567890ABC',
      })

      expect(certificate.Properties.DomainValidationOptions).toBeDefined()
      expect(certificate.Properties.DomainValidationOptions).toHaveLength(2)
      expect(certificate.Properties.DomainValidationOptions?.[0]).toEqual({
        DomainName: 'example.com',
        HostedZoneId: 'Z1234567890ABC',
      })
      expect(certificate.Properties.DomainValidationOptions?.[1]).toEqual({
        DomainName: 'www.example.com',
        HostedZoneId: 'Z1234567890ABC',
      })
    })
  })

  describe('createKmsKey', () => {
    it('should create a KMS key with default settings', () => {
      const { key, alias, logicalId, aliasId } = Security.createKmsKey({
        description: 'Encryption key for user data',
        slug: 'my-app',
        environment: 'production',
      })

      expect(key.Type).toBe('AWS::KMS::Key')
      expect(key.Properties.Description).toBe('Encryption key for user data')
      expect(key.Properties.Enabled).toBe(true)
      expect(key.Properties.EnableKeyRotation).toBe(true)
      expect(key.Properties.KeySpec).toBe('SYMMETRIC_DEFAULT')
      expect(key.Properties.KeyUsage).toBe('ENCRYPT_DECRYPT')
      expect(key.Properties.MultiRegion).toBe(false)

      expect(alias?.Type).toBe('AWS::KMS::Alias')
      expect(alias?.Properties.AliasName).toBe('alias/my-app-production')
      expect(logicalId).toBeDefined()
      expect(aliasId).toBeDefined()
    })

    it('should create multi-region KMS key', () => {
      const { key } = Security.createKmsKey({
        description: 'Multi-region key',
        slug: 'my-app',
        environment: 'production',
        multiRegion: true,
      })

      expect(key.Properties.MultiRegion).toBe(true)
    })

    it('should disable rotation when requested', () => {
      const { key } = Security.createKmsKey({
        description: 'No rotation key',
        slug: 'my-app',
        environment: 'production',
        enableRotation: false,
      })

      expect(key.Properties.EnableKeyRotation).toBe(false)
    })

    it('should have valid key policy', () => {
      const { key } = Security.createKmsKey({
        description: 'Test key',
        slug: 'my-app',
        environment: 'production',
      })

      expect(key.Properties.KeyPolicy.Version).toBe('2012-10-17')
      expect(key.Properties.KeyPolicy.Statement).toBeArray()
      expect(key.Properties.KeyPolicy.Statement.length).toBeGreaterThan(0)

      // Check root account permissions
      const rootStatement = key.Properties.KeyPolicy.Statement[0]
      expect(rootStatement.Effect).toBe('Allow')
      expect(rootStatement.Action).toBe('kms:*')
    })
  })

  describe('createFirewall', () => {
    it('should create a WAF Web ACL with default settings', () => {
      const { webAcl, logicalId } = Security.createFirewall({
        slug: 'my-app',
        environment: 'production',
      })

      expect(webAcl.Type).toBe('AWS::WAFv2::WebACL')
      expect(webAcl.Properties.Scope).toBe('CLOUDFRONT')
      expect(webAcl.Properties.DefaultAction.Allow).toBeDefined()
      expect(webAcl.Properties.DefaultAction.Block).toBeUndefined()
      expect(webAcl.Properties.VisibilityConfig.CloudWatchMetricsEnabled).toBe(true)
      expect(logicalId).toBeDefined()
    })

    it('should create regional WAF', () => {
      const { webAcl } = Security.createFirewall({
        slug: 'my-app',
        environment: 'production',
        scope: 'REGIONAL',
      })

      expect(webAcl.Properties.Scope).toBe('REGIONAL')
    })

    it('should support block as default action', () => {
      const { webAcl } = Security.createFirewall({
        slug: 'my-app',
        environment: 'production',
        defaultAction: 'block',
      })

      expect(webAcl.Properties.DefaultAction.Block).toBeDefined()
      expect(webAcl.Properties.DefaultAction.Allow).toBeUndefined()
    })
  })

  describe('setRateLimit', () => {
    it('should add rate limit rule', () => {
      const { webAcl } = Security.createFirewall({
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Security.setRateLimit(webAcl, {
        name: 'RateLimit',
        priority: 1,
        requestsPerWindow: 2000,
      })

      expect(updated.Properties.Rules).toHaveLength(1)
      expect(updated.Properties.Rules?.[0].Name).toBe('RateLimit')
      expect(updated.Properties.Rules?.[0].Priority).toBe(1)
      expect(updated.Properties.Rules?.[0].Statement.RateBasedStatement?.Limit).toBe(2000)
      expect(updated.Properties.Rules?.[0].Statement.RateBasedStatement?.AggregateKeyType).toBe('IP')
      expect(updated.Properties.Rules?.[0].Action?.Block).toBeDefined()
    })

    it('should support FORWARDED_IP aggregation', () => {
      const { webAcl } = Security.createFirewall({
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Security.setRateLimit(webAcl, {
        name: 'RateLimit',
        priority: 1,
        requestsPerWindow: 1000,
        aggregateKeyType: 'FORWARDED_IP',
      })

      expect(updated.Properties.Rules?.[0].Statement.RateBasedStatement?.AggregateKeyType).toBe('FORWARDED_IP')
    })
  })

  describe('blockCountries', () => {
    it('should add geo-blocking rule', () => {
      const { webAcl } = Security.createFirewall({
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Security.blockCountries(webAcl, {
        name: 'BlockRiskyCountries',
        priority: 2,
        countryCodes: ['CN', 'RU', 'KP'],
      })

      expect(updated.Properties.Rules).toHaveLength(1)
      expect(updated.Properties.Rules?.[0].Statement.GeoMatchStatement?.CountryCodes).toEqual(['CN', 'RU', 'KP'])
      expect(updated.Properties.Rules?.[0].Action?.Block).toBeDefined()
    })
  })

  describe('blockIpAddresses', () => {
    it('should create IP set and add blocking rule', () => {
      const { webAcl } = Security.createFirewall({
        slug: 'my-app',
        environment: 'production',
      })

      const { webAcl: updated, ipSet, ipSetLogicalId } = Security.blockIpAddresses(
        webAcl,
        {
          name: 'BlockedIPs',
          priority: 3,
          ipAddresses: ['192.0.2.0/24', '198.51.100.42/32'],
        },
        'my-app',
        'production',
      )

      expect(ipSet.Type).toBe('AWS::WAFv2::IPSet')
      expect(ipSet.Properties.IPAddressVersion).toBe('IPV4')
      expect(ipSet.Properties.Addresses).toEqual(['192.0.2.0/24', '198.51.100.42/32'])
      expect(ipSetLogicalId).toBeDefined()

      expect(updated.Properties.Rules).toHaveLength(1)
      expect(updated.Properties.Rules?.[0].Statement.IPSetReferenceStatement).toBeDefined()
    })

    it('should support IPv6 addresses', () => {
      const { webAcl } = Security.createFirewall({
        slug: 'my-app',
        environment: 'production',
      })

      const { ipSet } = Security.blockIpAddresses(
        webAcl,
        {
          name: 'BlockedIPv6',
          priority: 4,
          ipAddresses: ['2001:0db8::/32'],
          ipVersion: 'IPV6',
        },
        'my-app',
        'production',
      )

      expect(ipSet.Properties.IPAddressVersion).toBe('IPV6')
      expect(ipSet.Properties.Addresses).toContain('2001:0db8::/32')
    })
  })

  describe('addManagedRules', () => {
    it('should add AWS managed rule group', () => {
      const { webAcl } = Security.createFirewall({
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Security.addManagedRules(webAcl, {
        name: 'AWSCoreRuleSet',
        priority: 5,
        vendorName: 'AWS',
        ruleName: 'AWSManagedRulesCommonRuleSet',
      })

      expect(updated.Properties.Rules).toHaveLength(1)
      expect(updated.Properties.Rules?.[0].Statement.ManagedRuleGroupStatement?.VendorName).toBe('AWS')
      expect(updated.Properties.Rules?.[0].Statement.ManagedRuleGroupStatement?.Name).toBe('AWSManagedRulesCommonRuleSet')
    })

    it('should support excluding rules from managed rule group', () => {
      const { webAcl } = Security.createFirewall({
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Security.addManagedRules(webAcl, {
        name: 'CoreRuleSet',
        priority: 6,
        vendorName: 'AWS',
        ruleName: 'AWSManagedRulesCommonRuleSet',
        excludedRules: ['SizeRestrictions_BODY', 'GenericRFI_BODY'],
      })

      expect(updated.Properties.Rules?.[0].Statement.ManagedRuleGroupStatement?.ExcludedRules).toHaveLength(2)
      expect(updated.Properties.Rules?.[0].Statement.ManagedRuleGroupStatement?.ExcludedRules?.[0].Name).toBe('SizeRestrictions_BODY')
    })

    it('should have predefined managed rule groups', () => {
      expect(Security.ManagedRuleGroups.CoreRuleSet.vendorName).toBe('AWS')
      expect(Security.ManagedRuleGroups.CoreRuleSet.ruleName).toBe('AWSManagedRulesCommonRuleSet')
      expect(Security.ManagedRuleGroups.SqlDatabase.ruleName).toBe('AWSManagedRulesSQLiRuleSet')
      expect(Security.ManagedRuleGroups.AmazonIpReputation.ruleName).toBe('AWSManagedRulesAmazonIpReputationList')
    })
  })

  describe('Integration with TemplateBuilder', () => {
    it('should create complete security infrastructure', () => {
      const template = new TemplateBuilder('Security Infrastructure')

      // 1. Create SSL certificate
      const { certificate, logicalId: certId } = Security.createCertificate({
        domain: 'example.com',
        subdomains: ['*'],
        slug: 'my-app',
        environment: 'production',
        hostedZoneId: 'Z1234567890ABC',
      })
      template.addResource(certId, certificate)

      // 2. Create KMS key
      const { key, alias, logicalId: keyId, aliasId } = Security.createKmsKey({
        description: 'Application encryption key',
        slug: 'my-app',
        environment: 'production',
      })
      template.addResource(keyId, key)
      if (alias && aliasId) {
        template.addResource(aliasId, alias)
      }

      // 3. Create WAF with multiple rules
      const { webAcl, logicalId: wafId } = Security.createFirewall({
        slug: 'my-app',
        environment: 'production',
        scope: 'CLOUDFRONT',
      })

      // Add rate limiting
      Security.setRateLimit(webAcl, {
        name: 'RateLimit',
        priority: 1,
        requestsPerWindow: 2000,
      })

      // Add managed rules
      Security.addManagedRules(webAcl, {
        name: 'CoreRules',
        priority: 2,
        ...Security.ManagedRuleGroups.CoreRuleSet,
      })

      // Add geo-blocking
      Security.blockCountries(webAcl, {
        name: 'GeoBlock',
        priority: 3,
        countryCodes: ['CN', 'RU'],
      })

      // Add IP blocking
      const { webAcl: finalWebAcl, ipSet, ipSetLogicalId } = Security.blockIpAddresses(
        webAcl,
        {
          name: 'IPBlock',
          priority: 4,
          ipAddresses: ['192.0.2.0/24'],
        },
        'my-app',
        'production',
      )

      template.addResource(wafId, finalWebAcl)
      template.addResource(ipSetLogicalId, ipSet)

      const result = template.build()

      // Certificate + Key + Alias + WebACL + IPSet = 5 resources
      expect(Object.keys(result.Resources)).toHaveLength(5)
      expect(result.Resources[certId].Type).toBe('AWS::CertificateManager::Certificate')
      expect(result.Resources[keyId].Type).toBe('AWS::KMS::Key')
      expect(result.Resources[wafId].Type).toBe('AWS::WAFv2::WebACL')
      expect(result.Resources[wafId]!.Properties!.Rules).toHaveLength(4)
    })

    it('should generate valid JSON template', () => {
      const template = new TemplateBuilder('Security Test')

      const { certificate, logicalId } = Security.createCertificate({
        domain: 'test.com',
        slug: 'test',
        environment: 'development',
      })

      template.addResource(logicalId, certificate)

      const json = template.toJSON()
      const parsed = JSON.parse(json)

      expect(parsed.Resources[logicalId].Type).toBe('AWS::CertificateManager::Certificate')
      expect(parsed.Resources[logicalId].Properties.DomainName).toBe('test.com')
    })
  })

  describe('Multiple rules in WAF', () => {
    it('should handle multiple rules with correct priorities', () => {
      const { webAcl } = Security.createFirewall({
        slug: 'my-app',
        environment: 'production',
      })

      Security.setRateLimit(webAcl, {
        name: 'RateLimit',
        priority: 1,
        requestsPerWindow: 2000,
      })

      Security.blockCountries(webAcl, {
        name: 'GeoBlock',
        priority: 2,
        countryCodes: ['XX'],
      })

      Security.addManagedRules(webAcl, {
        name: 'CoreRules',
        priority: 3,
        ...Security.ManagedRuleGroups.CoreRuleSet,
      })

      expect(webAcl.Properties.Rules).toHaveLength(3)
      expect(webAcl.Properties.Rules?.[0].Priority).toBe(1)
      expect(webAcl.Properties.Rules?.[1].Priority).toBe(2)
      expect(webAcl.Properties.Rules?.[2].Priority).toBe(3)
    })
  })
})
