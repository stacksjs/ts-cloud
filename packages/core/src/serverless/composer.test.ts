import type { CloudConfig, ServerlessAppConfig } from '../types'
import { describe, expect, it } from 'bun:test'
import { validateResourceLimits, validateTemplate } from '../template-validator'
import { composeServerlessAppTemplate, resolveQueueNames } from './composer'

const config = { project: { name: 'Demo', slug: 'demo', region: 'us-east-1' } } as Pick<CloudConfig, 'project'>
const handlers = { http: 'index.http', queue: 'index.queue', cli: 'index.cli' }

function compose(app: ServerlessAppConfig) {
  return composeServerlessAppTemplate({ config, environment: 'production', app, handlers })
}

describe('resolveQueueNames', () => {
  it('defaults to a single queue, supports arrays, and disables with false', () => {
    expect(resolveQueueNames({}, 'demo', 'production')).toEqual(['demo-production-default'])
    expect(resolveQueueNames({ queues: false }, 'demo', 'production')).toEqual([])
    expect(resolveQueueNames({ queues: ['emails', { invoices: 5 }] }, 'demo', 'production'))
      .toEqual(['demo-production-emails', 'demo-production-invoices'])
  })
})

describe('composeServerlessAppTemplate', () => {
  it('wires three functions sharing one artifact via parameters', () => {
    const { template, functionNames } = compose({ kind: 'node', entry: 'src/server.ts' })
    expect(functionNames).toEqual({ http: 'demo-production-http', queue: 'demo-production-queue', cli: 'demo-production-cli' })

    for (const id of ['HttpFunction', 'QueueFunction', 'CliFunction']) {
      const fn = template.Resources[id] as any
      expect(fn.Type).toBe('AWS::Lambda::Function')
      expect(fn.Properties.Code).toEqual({ S3Bucket: { Ref: 'ArtifactBucket' }, S3Key: { Ref: 'ArtifactKey' } })
    }
    expect(template.Parameters?.ArtifactBucket).toBeDefined()
    expect(template.Parameters?.ArtifactKey).toBeDefined()
  })

  it('authors the HTTP API integration + $default route + invoke permission', () => {
    const { template } = compose({ kind: 'node', entry: 'a.ts' })
    expect((template.Resources.HttpApi as any).Properties.ProtocolType).toBe('HTTP')
    expect((template.Resources.HttpIntegration as any).Properties.IntegrationType).toBe('AWS_PROXY')
    expect((template.Resources.HttpRoute as any).Properties.RouteKey).toBe('$default')
    expect((template.Resources.HttpPermission as any).Properties.Principal).toBe('apigateway.amazonaws.com')
  })

  it('creates the queue, DLQ, and event source mapping with batch failure reporting', () => {
    const { template } = compose({ kind: 'node', entry: 'a.ts', queues: ['jobs'], queueTries: 5 })
    expect((template.Resources.AppQueue0 as any).Properties.QueueName).toBe('demo-production-jobs')
    expect((template.Resources.AppQueueDlq as any).Type).toBe('AWS::SQS::Queue')
    const mapping = template.Resources.AppQueue0Mapping as any
    expect(mapping.Type).toBe('AWS::Lambda::EventSourceMapping')
    expect(mapping.Properties.FunctionResponseTypes).toContain('ReportBatchItemFailures')
    expect((template.Resources.AppQueue0 as any).Properties.RedrivePolicy.maxReceiveCount).toBe(5)
  })

  it('adds the EventBridge scheduler unless disabled', () => {
    const on = compose({ kind: 'node', entry: 'a.ts' })
    expect((on.template.Resources.SchedulerRule as any).Properties.ScheduleExpression).toBe('rate(1 minute)')

    const off = compose({ kind: 'node', entry: 'a.ts', scheduler: 'off' })
    expect(off.template.Resources.SchedulerRule).toBeUndefined()
  })

  it('omits queue resources and function when queues are disabled', () => {
    const { template } = compose({ kind: 'node', entry: 'a.ts', queues: false })
    expect(template.Resources.QueueFunction).toBeUndefined()
    expect(template.Resources.AppQueue0).toBeUndefined()
  })

  it('adds assets bucket + CloudFront when assets are configured', () => {
    const { template } = compose({ kind: 'node', entry: 'a.ts', assets: 'public' })
    expect((template.Resources.AssetsBucket as any).Properties.BucketName).toBe('demo-production-assets')
    expect((template.Resources.AssetsDistribution as any).Type).toBe('AWS::CloudFront::Distribution')
  })

  it('attaches runtime layers and VPC config for PHP', () => {
    const { template } = compose({
      kind: 'php',
      runtime: 'provided.al2023',
      architecture: 'arm64',
      vpc: { subnets: ['subnet-1', 'subnet-2'], securityGroups: ['sg-1'] },
    } as ServerlessAppConfig)
    // PHP composer call without layers still works; pass layers explicitly:
    const withLayers = composeServerlessAppTemplate({
      config,
      environment: 'production',
      app: { kind: 'php', runtime: 'provided.al2023', vpc: { subnets: ['subnet-1'] } },
      handlers,
      runtimeLayers: ['arn:aws:lambda:us-east-1:123:layer:php-83:1'],
    })
    const fn = withLayers.template.Resources.HttpFunction as any
    expect(fn.Properties.Layers).toEqual(['arn:aws:lambda:us-east-1:123:layer:php-83:1'])
    expect(fn.Properties.VpcConfig.SubnetIds).toEqual(['subnet-1'])
    expect((template.Resources.HttpFunction as any).Properties.Architectures).toEqual(['arm64'])
  })

  it('wires a WAF WebACL + association when firewall is enabled', () => {
    const { template } = compose({ kind: 'node', entry: 'a.ts', firewall: { enabled: true, rateLimit: 2000, rules: ['common', 'sqlInjection'] } })
    expect((template.Resources.WebAcl as any).Properties.Scope).toBe('REGIONAL')
    expect((template.Resources.WebAcl as any).Properties.Rules).toHaveLength(3)
    expect((template.Resources.WebAclAssociation as any).Type).toBe('AWS::WAFv2::WebACLAssociation')
  })

  it('creates ElastiCache + security group when cache.driver is elasticache', () => {
    const { template } = compose({ kind: 'node', entry: 'a.ts', cache: { driver: 'elasticache' }, vpc: { subnets: ['subnet-a', 'subnet-b'] } })
    expect((template.Resources.CacheCluster as any).Type).toBe('AWS::ElastiCache::ReplicationGroup')
    expect((template.Resources.DataSecurityGroup as any).Type).toBe('AWS::EC2::SecurityGroup')
    // No DynamoDB cache table when using elasticache.
    expect(template.Resources.CacheTable).toBeUndefined()
    // Functions join the VPC with the managed SG.
    const sg = (template.Resources.HttpFunction as any).Properties.VpcConfig.SecurityGroupIds
    expect(JSON.stringify(sg)).toContain('DataSecurityGroup')
  })

  it('creates Aurora Serverless v2 + RDS Proxy', () => {
    const { template } = compose({
      kind: 'php',
      database: { connection: 'aurora-serverless' },
      rdsProxy: true,
      vpc: { subnets: ['subnet-a', 'subnet-b'] },
    } as ServerlessAppConfig)
    expect((template.Resources.DbCluster as any).Properties.ServerlessV2ScalingConfiguration).toBeDefined()
    expect((template.Resources.DbInstance as any).Properties.DBInstanceClass).toBe('db.serverless')
    expect((template.Resources.DbProxy as any).Type).toBe('AWS::RDS::DBProxy')
  })

  it('adds warmer rules sized to the warm count (5 targets/rule)', () => {
    const { template } = compose({ kind: 'node', entry: 'a.ts', warm: 7 })
    expect((template.Resources.WarmerRule0 as any).Properties.Targets).toHaveLength(5)
    expect((template.Resources.WarmerRule1 as any).Properties.Targets).toHaveLength(2)
    expect((template.Resources.WarmerPermission as any).Properties.Principal).toBe('events.amazonaws.com')
  })

  it('omits warmer rules when warm is unset', () => {
    const { template } = compose({ kind: 'node', entry: 'a.ts' })
    expect(template.Resources.WarmerRule0).toBeUndefined()
  })

  it('sets TSCLOUD_OCTANE on functions when octane is enabled', () => {
    const { template } = compose({ kind: 'php', octane: true })
    expect((template.Resources.HttpFunction as any).Properties.Environment.Variables.TSCLOUD_OCTANE).toBe('1')
  })

  it('throws when data services are requested without VPC subnets', () => {
    expect(() => compose({ kind: 'node', entry: 'a.ts', cache: { driver: 'elasticache' } }))
      .toThrow(/require app\.vpc\.subnets/)
  })

  it('uses PackageType Image + ImageUri parameter in image mode', () => {
    const { template } = compose({ kind: 'node', entry: 'a.ts', packaging: 'image' })
    const fn = template.Resources.HttpFunction as any
    expect(fn.Properties.PackageType).toBe('Image')
    expect(fn.Properties.Code).toEqual({ ImageUri: { Ref: 'ImageUri' } })
    expect(fn.Properties.ImageConfig.Command).toEqual(['index.http'])
    expect(template.Parameters?.ImageUri).toBeDefined()
    expect(template.Parameters?.ArtifactBucket).toBeUndefined()
  })

  it('omits ImageConfig.Command for PHP images (mode comes from env)', () => {
    const { template } = compose({ kind: 'php', packaging: 'image' })
    const fn = template.Resources.HttpFunction as any
    expect(fn.Properties.PackageType).toBe('Image')
    expect(fn.Properties.ImageConfig).toBeUndefined()
  })

  it('derives a managed runtime for default Node (no layer needed)', () => {
    const { template } = compose({ kind: 'node', entry: 'a.ts' })
    expect((template.Resources.HttpFunction as any).Properties.Runtime).toBe('nodejs22.x')
  })

  it('derives provided.al2023 for newer Node and attaches the layer', () => {
    const { template } = composeServerlessAppTemplate({
      config,
      environment: 'production',
      app: { kind: 'node', entry: 'a.ts', runtimeVersion: '24' },
      handlers,
      runtimeLayers: ['arn:aws:lambda:us-east-1:1:layer:tscloud-node-24-x86_64:1'],
    })
    const fn = template.Resources.HttpFunction as any
    expect(fn.Properties.Runtime).toBe('provided.al2023')
    expect(fn.Properties.Layers).toEqual(['arn:aws:lambda:us-east-1:1:layer:tscloud-node-24-x86_64:1'])
  })

  it('derives provided.al2023 for Bun', () => {
    const { template } = compose({ kind: 'bun', entry: 'a.ts' })
    expect((template.Resources.HttpFunction as any).Properties.Runtime).toBe('provided.al2023')
  })

  it('provisions an APIGW custom domain + cert + alias when domain+hostedZoneId set', () => {
    const { template } = compose({ kind: 'node', entry: 'a.ts', domain: 'app.acme.com', hostedZoneId: 'Z123' })
    expect((template.Resources.HttpCertificate as any).Properties.ValidationMethod).toBe('DNS')
    expect((template.Resources.HttpDomain0 as any).Properties.DomainName).toBe('app.acme.com')
    expect((template.Resources.HttpApiMapping0 as any).Type).toBe('AWS::ApiGatewayV2::ApiMapping')
    expect((template.Resources.HttpDomainRecord0 as any).Properties.AliasTarget).toBeDefined()
  })

  it('uses a pre-issued certificateArn without creating a cert', () => {
    const { template } = compose({ kind: 'node', entry: 'a.ts', domain: ['a.acme.com', 'b.acme.com'], certificateArn: 'arn:aws:acm:us-east-1:1:certificate/x' })
    expect(template.Resources.HttpCertificate).toBeUndefined()
    expect((template.Resources.HttpDomain0 as any).Properties.DomainNameConfigurations[0].CertificateArn).toBe('arn:aws:acm:us-east-1:1:certificate/x')
    expect((template.Resources.HttpDomain1 as any).Properties.DomainName).toBe('b.acme.com')
  })

  it('throws when a custom domain has neither certificateArn nor hostedZoneId', () => {
    expect(() => compose({ kind: 'node', entry: 'a.ts', domain: 'app.acme.com' }))
      .toThrow(/certificateArn.*hostedZoneId/s)
  })

  it('applies per-function ephemeral storage (cli/queue tmp)', () => {
    const { template } = compose({ kind: 'node', entry: 'a.ts', tmpStorage: 512, cliTmpStorage: 2048, queueTmpStorage: 1024, queues: ['jobs'] })
    expect((template.Resources.HttpFunction as any).Properties.EphemeralStorage.Size).toBe(512)
    expect((template.Resources.CliFunction as any).Properties.EphemeralStorage.Size).toBe(2048)
    expect((template.Resources.QueueFunction as any).Properties.EphemeralStorage.Size).toBe(1024)
  })

  it('sets TSCLOUD_SCHEDULER=sub-minute env when scheduler is sub-minute', () => {
    const { template } = compose({ kind: 'php', scheduler: 'sub-minute' })
    expect((template.Resources.CliFunction as any).Properties.Environment.Variables.TSCLOUD_SCHEDULER).toBe('sub-minute')
  })

  it('passes structural + resource-limit validation', () => {
    const { template } = compose({ kind: 'node', entry: 'a.ts', queues: ['jobs'], assets: 'public' })
    const structural = validateTemplate(template as any)
    expect(structural.errors).toEqual([])
    const limits = validateResourceLimits(template as any)
    expect(limits.valid).toBe(true)
  })
})
