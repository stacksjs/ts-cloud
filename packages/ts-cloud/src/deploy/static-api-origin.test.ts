import { afterEach, describe, expect, it } from 'bun:test'
import type { AWSRequestOptions } from '../aws/client'
import type { StaticApiOriginDependencies } from './static-api-origin'
import { AWSClient } from '../aws/client'
import { CloudFrontClient } from '../aws/cloudfront'
import { deployStaticApiOrigin, estimateStaticApiOriginMonthlyCost, verifyStaticApiOrigin } from './static-api-origin'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const CF_NS = 'xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/"'

/**
 * A real CloudFrontClient answering from CloudFront XML through AWSClient's own
 * parser, so these tests see the shapes production does. The stubs above used
 * to declare `Aliases.Items` as a string[] in both responses; the client
 * returned a raw `{ CNAME }` node, and every real deploy rejected its alias.
 */
function cloudFrontServing(aliases: string[]): StaticApiOriginDependencies['cloudfront'] {
  const aliasesXml = aliases.length
    ? `<Aliases><Quantity>${aliases.length}</Quantity><Items>${aliases.map(a => `<CNAME>${a}</CNAME>`).join('')}</Items></Aliases>`
    : '<Aliases><Quantity>0</Quantity></Aliases>'
  const config = `<CallerReference>ref</CallerReference><Comment></Comment><Enabled>true</Enabled>${aliasesXml}<Origins><Quantity>1</Quantity><Items><Origin><Id>static</Id><DomainName>bucket.s3.amazonaws.com</DomainName><S3OriginConfig><OriginAccessIdentity></OriginAccessIdentity></S3OriginConfig></Origin></Items></Origins><DefaultCacheBehavior><TargetOriginId>static</TargetOriginId><ViewerProtocolPolicy>redirect-to-https</ViewerProtocolPolicy></DefaultCacheBehavior><CacheBehaviors><Quantity>0</Quantity></CacheBehaviors>`
  const bodies: Record<string, string> = {
    '/2020-05-31/distribution/E123456789AB': `<Distribution ${CF_NS}><Id>E123456789AB</Id><ARN>arn:aws:cloudfront::923076644019:distribution/E123456789AB</ARN><Status>Deployed</Status><DomainName>d.example.cloudfront.net</DomainName><DistributionConfig>${config}</DistributionConfig></Distribution>`,
    '/2020-05-31/distribution/E123456789AB/config': `<DistributionConfig ${CF_NS}>${config}</DistributionConfig>`,
    '/2020-05-31/origin-access-control': `<OriginAccessControlList ${CF_NS}><Marker></Marker><MaxItems>100</MaxItems><IsTruncated>false</IsTruncated><Quantity>0</Quantity></OriginAccessControlList>`,
  }
  const parser: any = new AWSClient()
  return new CloudFrontClient(undefined, {
    request: async (request: AWSRequestOptions) => {
      const xml = bodies[request.path]
      if (request.method !== 'GET' || !xml)
        throw new Error(`unexpected CloudFront ${request.method} ${request.path}`)
      const body = parser.parseXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`)
      return request.returnHeaders ? { body, headers: { etag: 'E2QWRUHAPOMQZL' } } : body
    },
  })
}

function dependencies(overrides: Partial<StaticApiOriginDependencies> = {}): {
  dependencies: StaticApiOriginDependencies
  calls: string[]
} {
  const calls: string[] = []
  const value: StaticApiOriginDependencies = {
    sts: { getCallerIdentity: async () => ({ Account: '923076644019', Arn: 'arn:aws:iam::923076644019:user/chris' }) },
    cloudfront: {
      getDistribution: async () => ({
        Id: 'E123456789AB',
        ARN: 'arn:aws:cloudfront::923076644019:distribution/E123456789AB',
        Status: 'Deployed',
        DomainName: 'd.example.cloudfront.net',
        Enabled: true,
        Aliases: { Quantity: 1, Items: ['example.com'] },
      }),
      getDistributionConfig: async () => ({
        ETag: 'one',
        DistributionConfig: {
          Enabled: true,
          Origins: { Quantity: 1, Items: { Origin: [{ Id: 'static', DomainName: 'bucket.s3.amazonaws.com' }] } },
          DefaultCacheBehavior: { TargetOriginId: 'static', ViewerProtocolPolicy: 'redirect-to-https' },
          CacheBehaviors: { Quantity: 0, Items: [] },
          // The raw parsed config: <Items><CNAME>..</CNAME></Items>, not a string[].
          Aliases: { Quantity: 1, Items: { CNAME: 'example.com' } },
        },
      }),
      listOriginAccessControls: async () => [],
      findOrCreateOriginAccessControl: async () => {
        calls.push('oac')
        return { Id: 'OAC123', Name: 'hello-lambda-url', isNew: true }
      },
      upsertExistingDistributionOrigin: async (_id, input) => {
        calls.push(`origin:${input.domainName}:${input.originAccessControlId}`)
        return {
          distributionId: 'E123456789AB',
          originId: input.id,
          domainName: input.domainName,
          pathPattern: input.pathPattern,
          changed: true,
          applied: true,
          etag: 'two',
        }
      },
    },
    iam: {
      getRole: async () => {
        throw Object.assign(new Error('missing'), { code: 'NoSuchEntity' })
      },
      createRole: async () => {
        calls.push('role')
        return { RoleName: 'hello-execution', RoleId: 'role', Arn: 'arn:aws:iam::923076644019:role/hello-execution' }
      },
      putRolePolicy: async () => {
        calls.push('policy')
      },
    },
    lambda: {
      functionExists: async () => false,
      getFunction: async () => ({ Configuration: { State: 'Active' } }),
      createFunctionWithCode: async () => {
        calls.push('function')
        return { State: 'Pending' }
      },
      updateFunctionCodeInline: async () => ({ State: 'Active' }),
      updateFunctionConfiguration: async () => ({ State: 'Active' }),
      waitForFunctionActive: async () => ({ State: 'Active' }),
      getFunctionUrl: async () => null,
      createFunctionUrl: async () => {
        calls.push('url')
        return { FunctionUrl: 'https://abc.lambda-url.us-east-1.on.aws/', AuthType: 'AWS_IAM' }
      },
      addPermission: async (value) => {
        calls.push(`permission:${value.Action}`)
        return {}
      },
    },
    logs: {
      createLogGroup: async () => {
        calls.push('log-group')
      },
      putRetentionPolicy: async () => {
        calls.push('retention')
      },
    },
    sleep: async () => {},
    ...overrides,
  }
  return { dependencies: value, calls }
}

describe('static API origin deployment', () => {
  it('produces a read-only plan with rollback metadata', async () => {
    const fake = dependencies()
    const plan = await deployStaticApiOrigin(
      { distributionId: 'E123456789AB', expectedAlias: 'example.com', functionName: 'hello' },
      fake.dependencies,
    )
    expect(plan.mode).toBe('plan')
    expect(plan.applied).toBe(false)
    expect(plan.accountId).toBe('923076644019')
    expect(plan.origin.pathPattern).toBe('/api/*')
    expect(plan.rollback.removeFunction).toBe(true)
    expect(fake.calls).toEqual([])
  })

  it('refuses an identity-safe but alias-mismatched target', async () => {
    const fake = dependencies()
    await expect(
      deployStaticApiOrigin(
        { distributionId: 'E123456789AB', expectedAlias: 'wrong.example.com', functionName: 'hello' },
        fake.dependencies,
      ),
    ).rejects.toThrow('does not contain expected alias')
    expect(fake.calls).toEqual([])
  })

  it('requires the exact distribution and path confirmation', async () => {
    const fake = dependencies()
    await expect(
      deployStaticApiOrigin(
        {
          distributionId: 'E123456789AB',
          expectedAlias: 'example.com',
          functionName: 'hello',
          apply: true,
          confirm: 'wrong',
        },
        fake.dependencies,
      ),
    ).rejects.toThrow('exact confirmation token')
    expect(fake.calls).toEqual([])
  })

  it('creates a private function URL and both CloudFront permissions before patching', async () => {
    const fake = dependencies()
    const plan = await deployStaticApiOrigin(
      {
        distributionId: 'E123456789AB',
        expectedAlias: 'example.com',
        functionName: 'hello',
        apply: true,
        confirm: 'E123456789AB:/api/*',
      },
      fake.dependencies,
    )
    expect(plan.applied).toBe(true)
    expect(fake.calls).toEqual([
      'role',
      'policy',
      'log-group',
      'retention',
      'function',
      'url',
      'oac',
      'permission:lambda:InvokeFunctionUrl',
      'permission:lambda:InvokeFunction',
      'origin:abc.lambda-url.us-east-1.on.aws:OAC123',
    ])
  })
})

describe('static API origin alias checks against the real CloudFront client', () => {
  it('plans for an alias among several on a real distribution', async () => {
    const fake = dependencies({ cloudfront: cloudFrontServing(['www.example.com', 'example.com']) })
    const plan = await deployStaticApiOrigin(
      { distributionId: 'E123456789AB', expectedAlias: 'example.com', functionName: 'hello' },
      fake.dependencies,
    )
    expect(plan.mode).toBe('plan')
    expect(fake.calls).toEqual([])
  })

  it('plans for a single alias, which the parser yields as a bare string', async () => {
    const fake = dependencies({ cloudfront: cloudFrontServing(['example.com']) })
    const plan = await deployStaticApiOrigin(
      { distributionId: 'E123456789AB', expectedAlias: 'example.com', functionName: 'hello' },
      fake.dependencies,
    )
    expect(plan.mode).toBe('plan')
  })

  it('still refuses an alias the real distribution does not have', async () => {
    const fake = dependencies({ cloudfront: cloudFrontServing(['www.example.com', 'example.com']) })
    await expect(
      deployStaticApiOrigin(
        { distributionId: 'E123456789AB', expectedAlias: 'wrong.example.com', functionName: 'hello' },
        fake.dependencies,
      ),
    ).rejects.toThrow('does not contain expected alias')
  })

  it('falls back to the raw config aliases when the distribution reports none', async () => {
    const base = dependencies().dependencies.cloudfront
    const fake = dependencies({
      cloudfront: {
        ...base,
        getDistribution: async () => ({ ...(await base.getDistribution('E123456789AB')), Aliases: { Quantity: 0, Items: [] } }),
        getDistributionConfig: async () => {
          const config = await base.getDistributionConfig('E123456789AB')
          return { ...config, DistributionConfig: { ...config.DistributionConfig, Aliases: { Quantity: 2, Items: { CNAME: ['www.example.com', 'example.com'] } } } }
        },
      },
    })
    const plan = await deployStaticApiOrigin(
      { distributionId: 'E123456789AB', expectedAlias: 'example.com', functionName: 'hello' },
      fake.dependencies,
    )
    expect(plan.mode).toBe('plan')
  })
})

describe('static API origin verification and cost', () => {
  it('hashes the frontend, checks health, and captures Lambda init duration', async () => {
    globalThis.fetch = (async (url: string | URL | Request) =>
      String(url).endsWith('/api/health')
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
        : new Response('<html>unchanged</html>', { status: 200 })) as typeof fetch
    const digest = 'ac59ce692c60be4e9bb135be8fa32ad2b1f3d32b8832dd38996d28824e44e9ce'
    const result = await verifyStaticApiOrigin({
      alias: 'example.com',
      expectedFrontendSha256: digest,
      functionName: 'hello',
      logs: {
        filterLogEvents: async () => ({ events: [{ message: 'REPORT RequestId: one Init Duration: 142.53 ms' }] }),
      },
      now: () => new Date('2026-07-21T00:00:00Z'),
    })
    expect(result.frontend.sha256).toBe(digest)
    expect(result.frontend.unchanged).toBe(true)
    expect(result.api.healthy).toBe(true)
    expect(result.coldStart.initDurationMs).toBe(142.53)
  })

  it('shows the low-volume serverless cost boundary', () => {
    const cost = estimateStaticApiOriginMonthlyCost({ requests: 100_000, averageDurationMs: 100 })
    expect(cost.lambdaUsd).toBe(0)
    expect(cost.alwaysOnFargateAndAlbUsd).toBeGreaterThan(20)
  })
})
