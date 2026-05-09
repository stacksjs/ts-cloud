/**
 * InfrastructureGenerator integration tests for the compute-app deploy flow.
 *
 * Drives the generator with a config that has `infrastructure.compute` set
 * and asserts the resulting CloudFormation template contains the deploy
 * staging bucket, EC2 with the right tags, and the IAM policy granting
 * the instance read access to its own deploy bucket.
 */

import type { CloudConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { InfrastructureGenerator } from '../src/generators/infrastructure'

function generate(config: CloudConfig, environment: 'production' | 'staging' | 'development' = 'production'): any {
  const generator = new InfrastructureGenerator({ config, environment })
  generator.generate()
  return JSON.parse(generator.toJSON())
}

const baseConfig: CloudConfig = {
  project: { name: 'My App', slug: 'my-app', region: 'us-east-1' },
  environments: { production: { type: 'production' } },
  sites: {
    web: {
      domain: 'my-app.example.com',
      root: '.output',
      build: 'bun run build',
      start: 'bun run server.ts',
      port: 3000,
    },
  },
  infrastructure: {
    compute: {
      size: 'small',
      runtime: 'bun',
      systemPackages: ['sqlite'],
    },
    database: 'sqlite',
    dns: {
      provider: 'route53',
      hostedZoneId: 'Z01234567890ABC',
      domain: 'my-app.example.com',
    },
  },
}

describe('InfrastructureGenerator (compute-app mode)', () => {
  it('provisions a deploy staging bucket with the conventional name + 7-day lifecycle', () => {
    const template = generate(baseConfig)

    const buckets = Object.entries(template.Resources).filter(
      ([, r]: [string, any]) => r.Type === 'AWS::S3::Bucket',
    )
    const deployBucket = buckets.find(
      ([, r]: [string, any]) => r.Properties?.BucketName === 'my-app-production-deploy',
    )

    expect(deployBucket).toBeDefined()
    const props = (deployBucket![1] as any).Properties
    expect(props.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    })
    expect(props.LifecycleConfiguration.Rules[0]).toMatchObject({
      Status: 'Enabled',
      ExpirationInDays: 7,
      Prefix: 'releases/',
    })
  })

  it('exposes a deployBucketName output that the deploy command can read', () => {
    const template = generate(baseConfig)
    expect(template.Outputs?.deployBucketName).toBeDefined()
    expect(template.Outputs.deployBucketName.Value).toEqual({
      Ref: expect.stringContaining('DeployBucket'),
    })
  })

  it('tags the EC2 instance with Project / Environment / Role / ManagedBy', () => {
    const template = generate(baseConfig)
    const instances = Object.entries(template.Resources).filter(
      ([, r]: [string, any]) => r.Type === 'AWS::EC2::Instance',
    )
    expect(instances.length).toBeGreaterThan(0)

    const tags: Array<{ Key: string, Value: string }> = (instances[0][1] as any).Properties.Tags || []
    const tagMap = Object.fromEntries(tags.map(t => [t.Key, t.Value]))

    expect(tagMap.Project).toBe('my-app')
    expect(tagMap.Environment).toBe('production')
    expect(tagMap.Role).toBe('app')
    expect(tagMap.ManagedBy).toBe('ts-cloud')
  })

  it('grants the instance IAM role s3:GetObject on the deploy bucket only', () => {
    const template = generate(baseConfig)
    const role = Object.values(template.Resources).find(
      (r: any) => r.Type === 'AWS::IAM::Role',
    ) as any

    expect(role).toBeDefined()
    const policies = role.Properties.Policies || []
    const deployPolicy = policies.find((p: any) => p.PolicyName === 'DeployBucketRead')
    expect(deployPolicy).toBeDefined()

    const stmt = deployPolicy.PolicyDocument.Statement[0]
    expect(stmt.Action).toEqual(['s3:GetObject', 's3:ListBucket'])
    expect(stmt.Resource).toEqual([
      'arn:aws:s3:::my-app-production-deploy',
      'arn:aws:s3:::my-app-production-deploy/*',
    ])
  })

  it('opens 80/443 plus the API and SSR site ports in the security group, but NOT 22', () => {
    const template = generate({
      ...baseConfig,
      sites: {
        api: {
          domain: 'api.my-app.example.com',
          root: '.output/api',
          start: 'bun run api.ts',
          port: 4000,
        },
      },
    })

    const sg = Object.values(template.Resources).find(
      (r: any) => r.Type === 'AWS::EC2::SecurityGroup',
    ) as any
    const ingressPorts = (sg.Properties.SecurityGroupIngress as any[]).map(i => i.FromPort)

    // SSH is closed by default — shell access is via SSM Session Manager,
    // deploys go through SSM Run Command. No port 22 needed.
    expect(ingressPorts).not.toContain(22)

    expect(ingressPorts).toContain(80)
    expect(ingressPorts).toContain(443)
    expect(ingressPorts).toContain(3008)
    expect(ingressPorts).toContain(4000)
  })

  it('routes the public /api/* CloudFront origin to the API port', () => {
    const template = generate({
      ...baseConfig,
      sites: {
        public: {
          domain: 'my-app.example.com',
          root: 'dist',
        },
      },
      infrastructure: {
        ...baseConfig.infrastructure!,
        storage: {
          public: {
            website: {
              indexDocument: 'index.html',
              errorDocument: 'index.html',
            },
          },
        },
        ssl: {
          enabled: true,
          certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/test',
        },
      },
    })

    const distribution = Object.values(template.Resources).find(
      (r: any) => r.Type === 'AWS::CloudFront::Distribution',
    ) as any
    const origins = distribution.Properties.DistributionConfig.Origins
    const apiOrigin = origins.find((origin: any) => String(origin.Id).includes('-api'))

    expect(apiOrigin.CustomOriginConfig.HTTPPort).toBe(3008)
    expect(distribution.Properties.DistributionConfig.CacheBehaviors).toContainEqual(
      expect.objectContaining({
        PathPattern: '/api/*',
        TargetOriginId: apiOrigin.Id,
      }),
    )
  })

  it('honors infrastructure.api.port for the public API CloudFront origin', () => {
    const template = generate({
      ...baseConfig,
      sites: {
        public: {
          domain: 'my-app.example.com',
          root: 'dist',
        },
      },
      infrastructure: {
        ...baseConfig.infrastructure!,
        api: { port: 4010 },
        storage: {
          public: {
            website: {
              indexDocument: 'index.html',
              errorDocument: 'index.html',
            },
          },
        },
        ssl: {
          enabled: true,
          certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/test',
        },
      },
    })

    const sg = Object.values(template.Resources).find(
      (r: any) => r.Type === 'AWS::EC2::SecurityGroup',
    ) as any
    const distribution = Object.values(template.Resources).find(
      (r: any) => r.Type === 'AWS::CloudFront::Distribution',
    ) as any
    const ingressPorts = (sg.Properties.SecurityGroupIngress as any[]).map(i => i.FromPort)
    const apiOrigin = distribution.Properties.DistributionConfig.Origins.find((origin: any) => String(origin.Id).includes('-api'))

    expect(ingressPorts).toContain(4010)
    expect(apiOrigin.CustomOriginConfig.HTTPPort).toBe(4010)
  })

  it('mounts docs and blog website buckets under the public CloudFront distribution', () => {
    const template = generate({
      ...baseConfig,
      sites: {
        public: {
          domain: 'my-app.example.com',
          root: 'dist',
        },
      },
      infrastructure: {
        ...baseConfig.infrastructure!,
        storage: {
          public: {
            website: {
              indexDocument: 'index.html',
              errorDocument: '404.html',
            },
          },
          docs: {
            website: {
              indexDocument: 'index.html',
              errorDocument: '404.html',
            },
            path: '/docs',
          },
          blog: {
            website: {
              indexDocument: 'index.html',
              errorDocument: '404.html',
            },
            mountPath: '/blog',
          },
        },
        ssl: {
          enabled: true,
          certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/test',
        },
      },
    })

    const distributions = Object.values(template.Resources).filter(
      (r: any) => r.Type === 'AWS::CloudFront::Distribution',
    ) as any[]
    expect(distributions).toHaveLength(1)

    const distributionConfig = distributions[0].Properties.DistributionConfig
    expect(distributionConfig.Aliases).toEqual(['my-app.example.com'])
    expect(distributionConfig.Aliases).not.toContain('docs.my-app.example.com')
    expect(distributionConfig.Aliases).not.toContain('blog.my-app.example.com')

    const origins = distributionConfig.Origins.map((origin: any) => origin.Id)
    expect(origins).toContain('S3-my-app-production-public')
    expect(origins).toContain('S3-my-app-production-docs')
    expect(origins).toContain('S3-my-app-production-blog')

    const pathPatterns = distributionConfig.CacheBehaviors.map((behavior: any) => behavior.PathPattern)
    expect(pathPatterns).toContain('/docs')
    expect(pathPatterns).toContain('/docs/*')
    expect(pathPatterns).toContain('/blog')
    expect(pathPatterns).toContain('/blog/*')

    const recordNames = Object.values(template.Resources)
      .filter((r: any) => r.Type === 'AWS::Route53::RecordSet')
      .map((r: any) => r.Properties.Name)
    expect(recordNames).toContain('my-app.example.com')
    expect(recordNames).not.toContain('docs.my-app.example.com')
    expect(recordNames).not.toContain('blog.my-app.example.com')
  })

  it('reopens port 22 when compute.allowSsh is explicitly true', () => {
    const template = generate({
      ...baseConfig,
      infrastructure: {
        ...baseConfig.infrastructure!,
        compute: {
          ...baseConfig.infrastructure!.compute!,
          allowSsh: true,
        },
      },
    })

    const sg = Object.values(template.Resources).find(
      (r: any) => r.Type === 'AWS::EC2::SecurityGroup',
    ) as any
    const ingressPorts = (sg.Properties.SecurityGroupIngress as any[]).map(i => i.FromPort)

    expect(ingressPorts).toContain(22)
    expect(ingressPorts).toContain(80)
    expect(ingressPorts).toContain(443)
  })

  it('does NOT provision the EC2 stack when infrastructure.compute is absent', () => {
    const staticConfig: CloudConfig = {
      ...baseConfig,
      infrastructure: {
        // no compute → static mode, no EC2
        dns: baseConfig.infrastructure!.dns,
      },
    }
    const template = generate(staticConfig)

    const ec2 = Object.values(template.Resources).find(
      (r: any) => r.Type === 'AWS::EC2::Instance',
    )
    const deployBucket = Object.values(template.Resources).find(
      (r: any) => r.Type === 'AWS::S3::Bucket'
        && r.Properties?.BucketName === 'my-app-production-deploy',
    )
    expect(ec2).toBeUndefined()
    expect(deployBucket).toBeUndefined()
  })
})

describe('InfrastructureGenerator: per-environment compute deep-merge', () => {
  it('merges environments.<env>.infrastructure.compute field-by-field instead of replacing', () => {
    const config: CloudConfig = {
      project: { name: 'My App', slug: 'my-app', region: 'us-east-1' },
      environments: {
        production: {
          type: 'production',
          infrastructure: {
            compute: { size: 'large' as any },
          },
        },
        staging: { type: 'staging' },
      },
      sites: {
        web: {
          domain: 'my-app.example.com',
          root: '.output',
          start: 'bun run server.ts',
          port: 3000,
        },
      },
      infrastructure: {
        compute: {
          size: 'small' as any,
          runtime: 'bun',
          systemPackages: ['sqlite'],
        },
        dns: {
          provider: 'route53',
          hostedZoneId: 'Z01234567890ABC',
          domain: 'my-app.example.com',
        },
      },
    }

    // Production override changes size; runtime + systemPackages should be inherited
    // from the top-level defaults (no replacement).
    const prodTemplate = generate(config, 'production')
    const prodInstance = Object.values(prodTemplate.Resources).find(
      (r: any) => r.Type === 'AWS::EC2::Instance',
    ) as any

    // 'large' resolves to a different instance type than 'small'
    expect(prodInstance.Properties.InstanceType).not.toBe('t3.small')

    // Staging uses defaults entirely
    const stagingTemplate = generate(config, 'staging')
    const stagingInstance = Object.values(stagingTemplate.Resources).find(
      (r: any) => r.Type === 'AWS::EC2::Instance',
    ) as any

    expect(stagingInstance.Properties.InstanceType).toBe('t3.small')
  })
})
