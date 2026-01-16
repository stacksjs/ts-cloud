import { describe, expect, it, beforeEach } from 'bun:test'
import {
  Route53RoutingManager,
  route53RoutingManager,
  DNSSECManager,
  dnssecManager,
  Route53ResolverManager,
  route53ResolverManager,
} from '.'

describe('Route53 Routing Manager', () => {
  let manager: Route53RoutingManager

  beforeEach(() => {
    manager = new Route53RoutingManager()
  })

  describe('Weighted Routing', () => {
    it('should create weighted policy', () => {
      const policy = manager.createWeightedPolicy({
        name: 'weighted-policy',
        weight: 70,
        setIdentifier: 'primary',
      })

      expect(policy.id).toContain('policy')
      expect(policy.type).toBe('weighted')
      expect(policy.weight).toBe(70)
    })

    it('should include health check', () => {
      const policy = manager.createWeightedPolicy({
        name: 'weighted-with-health',
        weight: 50,
        setIdentifier: 'region1',
        healthCheckId: 'hc-123',
      })

      expect(policy.healthCheckId).toBe('hc-123')
    })
  })

  describe('Latency Routing', () => {
    it('should create latency policy', () => {
      const policy = manager.createLatencyPolicy({
        name: 'latency-policy',
        region: 'us-east-1',
        setIdentifier: 'use1',
      })

      expect(policy.type).toBe('latency')
      expect(policy.region).toBe('us-east-1')
    })
  })

  describe('Failover Routing', () => {
    it('should create primary failover policy', () => {
      const policy = manager.createFailoverPolicy({
        name: 'primary-failover',
        failoverType: 'PRIMARY',
        setIdentifier: 'primary-endpoint',
        healthCheckId: 'hc-primary',
      })

      expect(policy.type).toBe('failover')
      expect(policy.failoverType).toBe('PRIMARY')
      expect(policy.healthCheckId).toBeDefined()
    })

    it('should create secondary failover policy', () => {
      const policy = manager.createFailoverPolicy({
        name: 'secondary-failover',
        failoverType: 'SECONDARY',
        setIdentifier: 'secondary-endpoint',
        healthCheckId: 'hc-secondary',
      })

      expect(policy.failoverType).toBe('SECONDARY')
    })
  })

  describe('Geolocation Routing', () => {
    it('should create geolocation policy by country', () => {
      const policy = manager.createGeolocationPolicy({
        name: 'geo-us',
        country: 'US',
        setIdentifier: 'us-endpoint',
      })

      expect(policy.type).toBe('geolocation')
      expect(policy.country).toBe('US')
    })

    it('should create geolocation policy by continent', () => {
      const policy = manager.createGeolocationPolicy({
        name: 'geo-europe',
        continent: 'EU',
        setIdentifier: 'eu-endpoint',
      })

      expect(policy.continent).toBe('EU')
    })
  })

  describe('Geoproximity Routing', () => {
    it('should create geoproximity policy with coordinates', () => {
      const policy = manager.createGeoproximityPolicy({
        name: 'geo-prox',
        coordinates: {
          latitude: 40.7128,
          longitude: -74.0060,
        },
        setIdentifier: 'nyc-endpoint',
      })

      expect(policy.type).toBe('geoproximity')
      expect(policy.coordinates).toBeDefined()
    })

    it('should create geoproximity policy with AWS region', () => {
      const policy = manager.createGeoproximityPolicy({
        name: 'geo-prox-region',
        awsRegion: 'us-west-2',
        setIdentifier: 'usw2-endpoint',
      })

      expect(policy.awsRegion).toBe('us-west-2')
    })

    it('should support bias', () => {
      const policy = manager.createGeoproximityPolicy({
        name: 'geo-prox-bias',
        awsRegion: 'us-east-1',
        bias: 20,
        setIdentifier: 'biased-endpoint',
      })

      expect(policy.bias).toBe(20)
    })
  })

  describe('Health Checks', () => {
    it('should create HTTP health check', async () => {
      const healthCheck = manager.createHTTPHealthCheck({
        name: 'http-health',
        resourcePath: '/health',
        fullyQualifiedDomainName: 'example.com',
        port: 80,
      })

      expect(healthCheck.id).toContain('health-check')
      expect(healthCheck.type).toBe('http')
      expect(healthCheck.healthCheckStatus).toBe('Unknown')

      // Wait for health check execution
      await new Promise(resolve => setTimeout(resolve, 150))

      expect(['Healthy', 'Unhealthy']).toContain(healthCheck.healthCheckStatus)
    })

    it('should create HTTPS health check', () => {
      const healthCheck = manager.createHTTPHealthCheck({
        name: 'https-health',
        resourcePath: '/api/health',
        fullyQualifiedDomainName: 'api.example.com',
        port: 443,
        enableSNI: true,
      })

      expect(healthCheck.type).toBe('https')
      expect(healthCheck.enableSNI).toBe(true)
    })

    it('should create TCP health check', async () => {
      const healthCheck = manager.createTCPHealthCheck({
        name: 'tcp-health',
        ipAddress: '192.0.2.1',
        port: 3306,
      })

      expect(healthCheck.type).toBe('tcp')
      expect(healthCheck.port).toBe(3306)

      await new Promise(resolve => setTimeout(resolve, 150))

      expect(['Healthy', 'Unhealthy']).toContain(healthCheck.healthCheckStatus)
    })

    it('should create calculated health check', async () => {
      const hc1 = manager.createHTTPHealthCheck({
        name: 'hc1',
        resourcePath: '/health',
        fullyQualifiedDomainName: 'server1.example.com',
      })

      const hc2 = manager.createHTTPHealthCheck({
        name: 'hc2',
        resourcePath: '/health',
        fullyQualifiedDomainName: 'server2.example.com',
      })

      const calculated = manager.createCalculatedHealthCheck({
        name: 'calculated-health',
        childHealthChecks: [hc1.id, hc2.id],
        healthThreshold: 1,
      })

      expect(calculated.type).toBe('calculated')
      expect(calculated.childHealthChecks).toHaveLength(2)

      await new Promise(resolve => setTimeout(resolve, 200))

      expect(['Healthy', 'Unhealthy']).toContain(calculated.healthCheckStatus)
    })
  })

  describe('Traffic Policies', () => {
    it('should create failover traffic policy', () => {
      const policy = manager.createFailoverTrafficPolicy({
        name: 'failover-policy',
        primaryEndpoint: '192.0.2.1',
        secondaryEndpoint: '192.0.2.2',
      })

      expect(policy.id).toContain('traffic-policy')
      expect(policy.version).toBe(1)
      expect(policy.document.rules.failover.ruleType).toBe('failover')
    })

    it('should create geoproximity traffic policy', () => {
      const policy = manager.createGeoproximityTrafficPolicy({
        name: 'geo-policy',
        locations: [
          { endpoint: '192.0.2.1', region: 'us-east-1' },
          { endpoint: '192.0.2.2', region: 'us-west-2' },
          { endpoint: '192.0.2.3', latitude: 51.5074, longitude: -0.1278, bias: 10 },
        ],
      })

      expect(policy.document.rules.geoproximity.ruleType).toBe('geoproximity')
      expect(policy.document.rules.geoproximity.locations).toHaveLength(3)
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate health check CloudFormation', () => {
      const healthCheck = manager.createHTTPHealthCheck({
        name: 'test-health',
        resourcePath: '/health',
        fullyQualifiedDomainName: 'example.com',
      })

      const cf = manager.generateHealthCheckCF(healthCheck)

      expect(cf.Type).toBe('AWS::Route53::HealthCheck')
      expect(cf.Properties.HealthCheckConfig.Type).toBe('HTTP')
    })

    it('should generate weighted record set CloudFormation', () => {
      const cf = manager.generateWeightedRecordSetCF({
        hostedZoneId: 'Z123456',
        name: 'example.com',
        type: 'A',
        ttl: 300,
        resourceRecords: ['192.0.2.1'],
        weight: 70,
        setIdentifier: 'primary',
      })

      expect(cf.Type).toBe('AWS::Route53::RecordSet')
      expect(cf.Properties.Weight).toBe(70)
    })

    it('should generate failover record set CloudFormation', () => {
      const cf = manager.generateFailoverRecordSetCF({
        hostedZoneId: 'Z123456',
        name: 'example.com',
        type: 'A',
        ttl: 60,
        resourceRecords: ['192.0.2.1'],
        failover: 'PRIMARY',
        setIdentifier: 'primary',
        healthCheckId: 'hc-123',
      })

      expect(cf.Properties.Failover).toBe('PRIMARY')
      expect(cf.Properties.HealthCheckId).toBe('hc-123')
    })
  })

  it('should use global instance', () => {
    expect(route53RoutingManager).toBeInstanceOf(Route53RoutingManager)
  })
})

describe('DNSSEC Manager', () => {
  let manager: DNSSECManager

  beforeEach(() => {
    manager = new DNSSECManager()
  })

  describe('DNSSEC Enablement', () => {
    it('should enable DNSSEC', async () => {
      const config = manager.enableDNSSEC({
        hostedZoneId: 'Z123456',
      })

      expect(config.id).toContain('dnssec')
      expect(config.status).toBe('SIGNING')

      await new Promise(resolve => setTimeout(resolve, 150))

      expect(config.status).toBe('SIGNED')
    })

    it('should disable DNSSEC', async () => {
      const config = manager.enableDNSSEC({
        hostedZoneId: 'Z123456',
      })

      const disabled = manager.disableDNSSEC(config.id)

      expect(disabled.status).toBe('DELETING')

      await new Promise(resolve => setTimeout(resolve, 150))

      expect(disabled.status).toBe('NOT_SIGNING')
    })
  })

  describe('KSK Management', () => {
    it('should create KSK', () => {
      const ksk = manager.createKSK({
        name: 'my-ksk',
        hostedZoneId: 'Z123456',
        kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/abc123',
      })

      expect(ksk.id).toContain('ksk')
      expect(ksk.status).toBe('ACTIVE')
      expect(ksk.flag).toBe(257)
      expect(ksk.dnskeyRecord).toBeDefined()
      expect(ksk.dsRecord).toBeDefined()
    })

    it('should deactivate KSK', () => {
      const ksk = manager.createKSK({
        name: 'test-ksk',
        hostedZoneId: 'Z123456',
        kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/abc123',
      })

      const deactivated = manager.deactivateKSK(ksk.id)

      expect(deactivated.status).toBe('INACTIVE')
    })

    it('should get DS record', () => {
      const ksk = manager.createKSK({
        name: 'test-ksk',
        hostedZoneId: 'Z123456',
        kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/abc123',
      })

      const dsRecord = manager.getDSRecord(ksk.id)

      expect(dsRecord).toContain(ksk.keyTag !== undefined ? ksk.keyTag.toString() : '')
    })
  })

  describe('DNSSEC Validation', () => {
    it('should validate DNSSEC', () => {
      const validation = manager.validateDNSSEC({
        domain: 'example.com',
      })

      expect(validation.id).toContain('validation')
      expect(['VALID', 'INVALID', 'INSECURE', 'BOGUS']).toContain(validation.validationStatus)
    })

    it('should detect insecure domain', () => {
      const validation = manager.validateDNSSEC({
        domain: 'insecure.example.com',
        checkDNSKEY: false,
        checkRRSIG: false,
      })

      expect(validation.validationStatus).toBe('INSECURE')
      expect(validation.dnskeyPresent).toBe(false)
      expect(validation.rrsigPresent).toBe(false)
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate DNSSEC CloudFormation', () => {
      const config = manager.enableDNSSEC({
        hostedZoneId: 'Z123456',
      })

      const cf = manager.generateDNSSECCF(config)

      expect(cf.Type).toBe('AWS::Route53::DNSSEC')
      expect(cf.Properties.HostedZoneId).toBe('Z123456')
    })

    it('should generate KSK CloudFormation', () => {
      const ksk = manager.createKSK({
        name: 'test-ksk',
        hostedZoneId: 'Z123456',
        kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/abc123',
      })

      const cf = manager.generateKSKCF(ksk)

      expect(cf.Type).toBe('AWS::Route53::KeySigningKey')
      expect(cf.Properties.Name).toBe('test-ksk')
    })
  })

  it('should use global instance', () => {
    expect(dnssecManager).toBeInstanceOf(DNSSECManager)
  })
})

describe('Route53 Resolver Manager', () => {
  let manager: Route53ResolverManager

  beforeEach(() => {
    manager = new Route53ResolverManager()
  })

  describe('Resolver Endpoints', () => {
    it('should create inbound endpoint', async () => {
      const endpoint = manager.createInboundEndpoint({
        name: 'inbound-endpoint',
        subnetIds: ['subnet-1', 'subnet-2'],
        securityGroupIds: ['sg-123'],
      })

      expect(endpoint.id).toContain('endpoint')
      expect(endpoint.direction).toBe('INBOUND')
      expect(endpoint.status).toBe('CREATING')

      await new Promise(resolve => setTimeout(resolve, 150))

      expect(endpoint.status).toBe('OPERATIONAL')
      expect(endpoint.ipAddresses[0].ip).toBeDefined()
    })

    it('should create outbound endpoint', () => {
      const endpoint = manager.createOutboundEndpoint({
        name: 'outbound-endpoint',
        subnetIds: ['subnet-1', 'subnet-2'],
        securityGroupIds: ['sg-123'],
      })

      expect(endpoint.direction).toBe('OUTBOUND')
    })
  })

  describe('Resolver Rules', () => {
    it('should create forward rule', async () => {
      const endpoint = manager.createOutboundEndpoint({
        name: 'outbound',
        subnetIds: ['subnet-1'],
        securityGroupIds: ['sg-123'],
      })

      const rule = manager.createForwardRule({
        name: 'forward-rule',
        domainName: 'corp.example.com',
        targetIps: [{ ip: '10.0.1.5' }, { ip: '10.0.2.5' }],
        resolverEndpointId: endpoint.id,
      })

      expect(rule.id).toContain('rule')
      expect(rule.ruleType).toBe('FORWARD')
      expect(rule.targetIps).toHaveLength(2)

      await new Promise(resolve => setTimeout(resolve, 150))

      expect(rule.status).toBe('COMPLETE')
    })

    it('should create system rule', () => {
      const rule = manager.createSystemRule({
        name: 'system-rule',
        domainName: 'amazonaws.com',
      })

      expect(rule.ruleType).toBe('SYSTEM')
    })
  })

  describe('DNS Firewall', () => {
    it('should create firewall domain list', async () => {
      const domainList = manager.createFirewallDomainList({
        name: 'malware-domains',
        domains: ['malware.example.com', 'phishing.example.com'],
      })

      expect(domainList.id).toContain('domain-list')
      expect(domainList.domains).toHaveLength(2)

      await new Promise(resolve => setTimeout(resolve, 150))

      expect(domainList.status).toBe('COMPLETE')
    })

    it('should create block rule', () => {
      const domainList = manager.createFirewallDomainList({
        name: 'blocked-domains',
        domains: ['blocked.example.com'],
      })

      const ruleGroup = manager.createBlockRule({
        name: 'block-malware',
        priority: 100,
        domainListId: domainList.id,
        blockResponse: 'NXDOMAIN',
      })

      expect(ruleGroup.rules).toHaveLength(1)
      expect(ruleGroup.rules[0].action).toBe('BLOCK')
      expect(ruleGroup.rules[0].blockResponse).toBe('NXDOMAIN')
    })

    it('should create allow rule', () => {
      const domainList = manager.createFirewallDomainList({
        name: 'allowed-domains',
        domains: ['trusted.example.com'],
      })

      const ruleGroup = manager.createAllowRule({
        name: 'allow-trusted',
        priority: 50,
        domainListId: domainList.id,
      })

      expect(ruleGroup.rules[0].action).toBe('ALLOW')
    })

    it('should create DNS firewall', () => {
      const domainList = manager.createFirewallDomainList({
        name: 'blocked',
        domains: ['bad.example.com'],
      })

      const ruleGroup = manager.createBlockRule({
        name: 'block-bad',
        priority: 100,
        domainListId: domainList.id,
      })

      const firewall = manager.createDNSFirewall({
        name: 'my-firewall',
        vpcId: 'vpc-123',
        ruleGroupAssociations: [
          {
            firewallRuleGroupId: ruleGroup.id,
            priority: 100,
            mutationProtection: 'ENABLED',
          },
        ],
      })

      expect(firewall.id).toContain('firewall')
      expect(firewall.firewallRuleGroupAssociations).toHaveLength(1)
    })

    it('should create malware protection firewall', () => {
      const firewall = manager.createMalwareProtectionFirewall({
        name: 'malware-protection',
        vpcId: 'vpc-123',
        maliciousDomains: ['malware1.com', 'malware2.com', 'phishing.com'],
      })

      expect(firewall.firewallRuleGroupAssociations).toHaveLength(1)
      expect(firewall.firewallRuleGroupAssociations[0].mutationProtection).toBe('ENABLED')
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate resolver endpoint CloudFormation', () => {
      const endpoint = manager.createInboundEndpoint({
        name: 'test-endpoint',
        subnetIds: ['subnet-1', 'subnet-2'],
        securityGroupIds: ['sg-123'],
      })

      const cf = manager.generateResolverEndpointCF(endpoint)

      expect(cf.Type).toBe('AWS::Route53Resolver::ResolverEndpoint')
      expect(cf.Properties.Direction).toBe('INBOUND')
      expect(cf.Properties.IpAddresses).toHaveLength(2)
    })

    it('should generate resolver rule CloudFormation', () => {
      const endpoint = manager.createOutboundEndpoint({
        name: 'outbound',
        subnetIds: ['subnet-1'],
        securityGroupIds: ['sg-123'],
      })

      const rule = manager.createForwardRule({
        name: 'forward',
        domainName: 'corp.example.com',
        targetIps: [{ ip: '10.0.1.5' }],
        resolverEndpointId: endpoint.id,
      })

      const cf = manager.generateResolverRuleCF(rule)

      expect(cf.Type).toBe('AWS::Route53Resolver::ResolverRule')
      expect(cf.Properties.RuleType).toBe('FORWARD')
    })

    it('should generate firewall rule group CloudFormation', () => {
      const domainList = manager.createFirewallDomainList({
        name: 'test-domains',
        domains: ['test.com'],
      })

      const ruleGroup = manager.createBlockRule({
        name: 'test-block',
        priority: 100,
        domainListId: domainList.id,
      })

      const cf = manager.generateFirewallRuleGroupCF(ruleGroup)

      expect(cf.Type).toBe('AWS::Route53Resolver::FirewallRuleGroup')
      expect(cf.Properties.FirewallRules).toHaveLength(1)
    })
  })

  it('should use global instance', () => {
    expect(route53ResolverManager).toBeInstanceOf(Route53ResolverManager)
  })
})
