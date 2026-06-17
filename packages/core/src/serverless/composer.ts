/**
 * Composes the CloudFormation template for a Vapor-style serverless application:
 * one code artifact wired into three Lambda functions (http/queue/cli) plus the
 * surrounding infrastructure (API Gateway v2, SQS + DLQ, EventBridge scheduler,
 * DynamoDB cache, assets S3 + CloudFront, IAM role, log groups).
 *
 * Activation model (v1): functions target `$LATEST`. The deploy orchestrator
 * swaps code with `UpdateFunctionCode` (fast, atomic per function) and passes the
 * current artifact via the `ArtifactBucket` / `ArtifactKey` stack parameters so
 * stack updates never revert the deployed code. Alias-based blue/green is a v2
 * refinement.
 */

import type { CloudConfig, EnvironmentType, ServerlessAppConfig } from '../types'
import type { CloudFormationTemplate } from '../cloudformation/types'
import { Fn } from '../cloudformation/types'
import { resolveServerlessAssetBucketName } from '../stack-naming'
import { resolveServerlessRuntime } from './runtime-resolve'

export interface ComposeOptions {
  config: Pick<CloudConfig, 'project'>
  environment: EnvironmentType
  app: ServerlessAppConfig
  /** Lambda handler strings per function (from packaging). */
  handlers: { http: string, queue: string, cli: string }
  /** Custom-runtime layer ARNs (PHP). */
  runtimeLayers?: string[]
}

export interface ComposedTemplate {
  template: CloudFormationTemplate
  /** Deterministic Lambda function names the orchestrator drives directly. */
  functionNames: { http: string, queue: string, cli: string }
  /** SQS queue names created (for the orchestrator + CLI commands). */
  queueNames: string[]
  /** Count of resources by CloudFormation type (for deploy summaries). */
  resourceSummary: Record<string, number>
}

/** Resolve the SQS queue names from the manifest. */
export function resolveQueueNames(app: ServerlessAppConfig, slug: string, env: EnvironmentType): string[] {
  if (app.queues === false) return []
  if (app.queues === undefined || app.queues === true) return [`${slug}-${env}-default`]
  return app.queues.map((q) => {
    const name = typeof q === 'string' ? q : Object.keys(q)[0]
    return `${slug}-${env}-${name}`
  })
}

export function composeServerlessAppTemplate(opts: ComposeOptions): ComposedTemplate {
  const { app, environment, handlers } = opts
  const slug = opts.config.project.slug
  const runtime = resolveServerlessRuntime(app).lambdaRuntime
  const architecture = app.architecture ?? 'x86_64'
  const region = opts.config.project.region

  const functionNames = {
    http: `${slug}-${environment}-http`,
    queue: `${slug}-${environment}-queue`,
    cli: `${slug}-${environment}-cli`,
  }
  const queueNames = resolveQueueNames(app, slug, environment)
  const hasQueue = queueNames.length > 0
  const imageMode = app.packaging === 'image'
  const schedulerEnabled = (app.scheduler ?? 'on') !== 'off'
  const cacheEnabled = (app.cache?.driver ?? 'dynamodb') === 'dynamodb'
  const assetsEnabled = Boolean(app.assets)
  const assetsBucket = resolveServerlessAssetBucketName(slug, environment)
  const tmpStorage = app.tmpStorage ?? 512

  const resources: Record<string, any> = {}
  const outputs: Record<string, any> = {}

  // ── IAM execution role (shared by all three functions) ─────────────────────
  const inlinePolicies: any[] = [
    {
      PolicyName: 'tscloud-serverless-app',
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          // Logs
          {
            Effect: 'Allow',
            Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
            Resource: Fn.sub('arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/*'),
          },
          // Cross-function invoke (deploy hooks invoke the CLI function)
          {
            Effect: 'Allow',
            Action: ['lambda:InvokeFunction'],
            Resource: Fn.sub('arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:' + `${slug}-${environment}-*`),
          },
          // Secrets Manager (project-scoped)
          {
            Effect: 'Allow',
            Action: ['secretsmanager:GetSecretValue', 'ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
            Resource: [
              Fn.sub('arn:aws:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:' + `${slug}/${environment}/*`),
              Fn.sub('arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/' + `${slug}/${environment}/*`),
            ],
          },
          // Assets + storage buckets
          {
            Effect: 'Allow',
            Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
            Resource: [
              Fn.sub(`arn:aws:s3:::${assetsBucket}`),
              Fn.sub(`arn:aws:s3:::${assetsBucket}/*`),
              ...(app.storage?.bucket
                ? [Fn.sub(`arn:aws:s3:::${app.storage.bucket}`), Fn.sub(`arn:aws:s3:::${app.storage.bucket}/*`)]
                : []),
            ],
          },
        ],
      },
    },
  ]

  if (hasQueue) {
    inlinePolicies[0].PolicyDocument.Statement.push({
      Effect: 'Allow',
      Action: ['sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl'],
      Resource: Fn.sub('arn:aws:sqs:${AWS::Region}:${AWS::AccountId}:' + `${slug}-${environment}-*`),
    })
  }
  if (cacheEnabled) {
    inlinePolicies[0].PolicyDocument.Statement.push({
      Effect: 'Allow',
      Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:BatchGetItem', 'dynamodb:BatchWriteItem'],
      Resource: Fn.sub('arn:aws:dynamodb:${AWS::Region}:${AWS::AccountId}:table/' + `${slug}-${environment}-cache*`),
    })
  }

  const managedPolicies = ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
  if (app.vpc?.subnets?.length)
    managedPolicies.push('arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole')

  resources.AppRole = {
    Type: 'AWS::IAM::Role',
    Properties: {
      RoleName: `${slug}-${environment}-app-role`,
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      },
      ManagedPolicyArns: managedPolicies,
      Policies: inlinePolicies,
    },
  }

  // ── Shared function building block ─────────────────────────────────────────
  const baseEnv = (mode: string): Record<string, string> => ({
    TSCLOUD_LAMBDA_MODE: mode,
    TSCLOUD_ENV: environment,
    ...(app.octane ? { TSCLOUD_OCTANE: '1' } : {}),
    ...(app.scheduler === 'sub-minute' ? { TSCLOUD_SCHEDULER: 'sub-minute' } : {}),
    ...(cacheEnabled ? { TSCLOUD_CACHE_TABLE: `${slug}-${environment}-cache` } : {}),
    ...(hasQueue ? { TSCLOUD_QUEUE: queueNames[0] } : {}),
    ...(app.env ?? {}),
  })

  // EFS shared filesystem mount (Vapor's /mnt/local). Requires a VPC.
  const efsEnabled = Boolean(app.efs)
  const efsOpts = typeof app.efs === 'object' ? app.efs : {}
  const efsMountPath = efsOpts.mountPath ?? '/mnt/local'
  const efsProvision = efsEnabled && !efsOpts.accessPointArn
  const efsAccessPoint: any = efsOpts.accessPointArn ?? (efsProvision ? Fn.getAtt('EfsAccessPoint', 'Arn') : undefined)

  // Data services (ElastiCache/Aurora/RDS Proxy/EFS) require the functions in a VPC.
  const subnets = app.vpc?.subnets ?? []
  const hasVpc = subnets.length > 0
  const needsDataVpc = app.cache?.driver === 'elasticache'
    || app.database?.connection === 'aurora-serverless'
    || Boolean(app.rdsProxy)
    || efsEnabled
  if (needsDataVpc && !hasVpc) {
    throw new Error('serverless app: elasticache / aurora-serverless / rdsProxy / efs require app.vpc.subnets (private subnets) to be set.')
  }

  const vpcConfig = hasVpc
    ? {
        VpcConfig: {
          SubnetIds: subnets,
          SecurityGroupIds: [
            ...(app.vpc?.securityGroups ?? []),
            ...(needsDataVpc ? [Fn.getAtt('DataSecurityGroup', 'GroupId')] : []),
          ],
        },
      }
    : {}

  // Functions must wait for the EFS mount targets before they can mount.
  const efsDependsOn = efsProvision ? subnets.map((_, i) => `EfsMountTarget${i}`) : []
  const efsConfig = efsEnabled
    ? { FileSystemConfigs: [{ Arn: efsAccessPoint, LocalMountPath: efsMountPath }] }
    : {}
  if (efsEnabled) {
    // `inlinePolicies` is referenced by AppRole; pushing here still applies.
    inlinePolicies[0].PolicyDocument.Statement.push({
      Effect: 'Allow',
      Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite', 'elasticfilesystem:ClientRootAccess', 'elasticfilesystem:DescribeMountTargets'],
      Resource: '*',
    })
  }

  function addFunction(logicalId: string, name: string, handler: string, mode: string, memory: number, timeout: number, reservedConcurrency?: number, tmp: number = tmpStorage): void {
    resources[`${logicalId}LogGroup`] = {
      Type: 'AWS::Logs::LogGroup',
      Properties: { LogGroupName: `/aws/lambda/${name}`, RetentionInDays: 14 },
    }
    // Container-image functions set the handler/runtime via the image itself and
    // are pinned to a mode using an `IMAGE_CMD`-style override env var so all
    // three share one image. Zip functions use the layer + handler string.
    const codeProps = imageMode
      ? {
          PackageType: 'Image',
          Code: { ImageUri: Fn.ref('ImageUri') },
          // Node base images take the handler as CMD; the PHP custom-runtime
          // image selects its mode from TSCLOUD_LAMBDA_MODE instead.
          ...(app.kind === 'php' ? {} : { ImageConfig: { Command: [handler] } }),
        }
      : {
          Runtime: runtime,
          Handler: handler,
          Code: { S3Bucket: Fn.ref('ArtifactBucket'), S3Key: Fn.ref('ArtifactKey') },
          ...(opts.runtimeLayers?.length ? { Layers: opts.runtimeLayers } : {}),
        }

    resources[logicalId] = {
      Type: 'AWS::Lambda::Function',
      DependsOn: [`${logicalId}LogGroup`, ...efsDependsOn],
      Properties: {
        FunctionName: name,
        Architectures: [architecture],
        MemorySize: memory,
        Timeout: timeout,
        Role: Fn.getAtt('AppRole', 'Arn'),
        Environment: { Variables: baseEnv(mode) },
        EphemeralStorage: { Size: tmp },
        ...codeProps,
        ...(reservedConcurrency !== undefined ? { ReservedConcurrentExecutions: reservedConcurrency } : {}),
        ...vpcConfig,
        ...efsConfig,
      },
    }
  }

  addFunction('HttpFunction', functionNames.http, handlers.http, 'http', app.memory ?? 1024, app.timeout ?? 28, app.concurrency, tmpStorage)
  addFunction('CliFunction', functionNames.cli, handlers.cli, 'cli', app.cliMemory ?? 1024, app.cliTimeout ?? 900, undefined, app.cliTmpStorage ?? tmpStorage)
  if (hasQueue)
    addFunction('QueueFunction', functionNames.queue, handlers.queue, 'queue', app.queueMemory ?? 1024, app.queueTimeout ?? 120, undefined, app.queueTmpStorage ?? tmpStorage)

  // ── HTTP API (API Gateway v2) — author the integration/route/permission that
  //    the generic builder omits ─────────────────────────────────────────────
  resources.HttpApi = {
    Type: 'AWS::ApiGatewayV2::Api',
    Properties: {
      Name: `${slug}-${environment}`,
      ProtocolType: 'HTTP',
    },
  }
  resources.HttpIntegration = {
    Type: 'AWS::ApiGatewayV2::Integration',
    Properties: {
      ApiId: Fn.ref('HttpApi'),
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: Fn.getAtt('HttpFunction', 'Arn'),
      PayloadFormatVersion: '2.0',
    },
  }
  resources.HttpRoute = {
    Type: 'AWS::ApiGatewayV2::Route',
    Properties: {
      ApiId: Fn.ref('HttpApi'),
      RouteKey: '$default',
      Target: Fn.join('/', ['integrations', Fn.ref('HttpIntegration')]),
    },
  }
  resources.HttpStage = {
    Type: 'AWS::ApiGatewayV2::Stage',
    Properties: {
      ApiId: Fn.ref('HttpApi'),
      StageName: '$default',
      AutoDeploy: true,
    },
  }
  resources.HttpPermission = {
    Type: 'AWS::Lambda::Permission',
    Properties: {
      FunctionName: Fn.ref('HttpFunction'),
      Action: 'lambda:InvokeFunction',
      Principal: 'apigateway.amazonaws.com',
      SourceArn: Fn.sub('arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${HttpApi}/*/*'),
    },
  }
  outputs.HttpApiEndpoint = {
    Description: 'HTTP API endpoint',
    Value: Fn.getAtt('HttpApi', 'ApiEndpoint'),
  }
  outputs.HttpApiId = { Description: 'HTTP API id', Value: Fn.ref('HttpApi') }

  // ── Custom domain(s) for the HTTP API ───────────────────────────────────────
  // Maps each `app.domain` to the API via an APIGW v2 regional custom domain.
  // The certificate comes from `certificateArn`, or is issued + DNS-validated
  // against `hostedZoneId`; with a hosted zone we also create the alias record.
  const domains = (Array.isArray(app.domain) ? app.domain : app.domain ? [app.domain] : []).filter(Boolean)
  if (domains.length) {
    if (!app.certificateArn && !app.hostedZoneId) {
      throw new Error('serverless app: a custom `domain` needs either `certificateArn` (pre-issued, regional) or `hostedZoneId` (to auto-issue + validate an ACM cert).')
    }

    let certRef: any = app.certificateArn
    if (!certRef) {
      resources.HttpCertificate = {
        Type: 'AWS::CertificateManager::Certificate',
        Properties: {
          DomainName: domains[0],
          ...(domains.length > 1 ? { SubjectAlternativeNames: domains.slice(1) } : {}),
          ValidationMethod: 'DNS',
          DomainValidationOptions: domains.map(d => ({ DomainName: d, HostedZoneId: app.hostedZoneId })),
        },
      }
      certRef = Fn.ref('HttpCertificate')
    }

    domains.forEach((d, i) => {
      const dn = `HttpDomain${i}`
      resources[dn] = {
        Type: 'AWS::ApiGatewayV2::DomainName',
        Properties: {
          DomainName: d,
          DomainNameConfigurations: [{ CertificateArn: certRef, EndpointType: 'REGIONAL' }],
        },
      }
      resources[`HttpApiMapping${i}`] = {
        Type: 'AWS::ApiGatewayV2::ApiMapping',
        DependsOn: ['HttpStage'],
        Properties: { ApiId: Fn.ref('HttpApi'), DomainName: Fn.ref(dn), Stage: '$default' },
      }
      if (app.hostedZoneId) {
        resources[`HttpDomainRecord${i}`] = {
          Type: 'AWS::Route53::RecordSet',
          Properties: {
            HostedZoneId: app.hostedZoneId,
            Name: d,
            Type: 'A',
            AliasTarget: {
              DNSName: Fn.getAtt(dn, 'RegionalDomainName'),
              HostedZoneId: Fn.getAtt(dn, 'RegionalHostedZoneId'),
            },
          },
        }
      }
      outputs[`CustomDomain${i}`] = { Description: `Custom domain ${d}`, Value: d }
      outputs[`CustomDomainTarget${i}`] = {
        Description: `Point ${d} (CNAME/alias) at this APIGW regional domain`,
        Value: Fn.getAtt(dn, 'RegionalDomainName'),
      }
    })
  }

  // ── SQS queues + DLQ + event source mappings ───────────────────────────────
  if (hasQueue) {
    resources.AppQueueDlq = {
      Type: 'AWS::SQS::Queue',
      Properties: {
        QueueName: `${slug}-${environment}-dlq`,
        MessageRetentionPeriod: 1209600, // 14 days
      },
    }
    queueNames.forEach((qName, i) => {
      const qId = `AppQueue${i}`
      resources[qId] = {
        Type: 'AWS::SQS::Queue',
        Properties: {
          QueueName: qName,
          VisibilityTimeout: Math.max(app.queueTimeout ?? 120, (app.queueTimeout ?? 120)),
          RedrivePolicy: {
            deadLetterTargetArn: Fn.getAtt('AppQueueDlq', 'Arn'),
            maxReceiveCount: app.queueTries ?? 3,
          },
        },
      }
      resources[`${qId}Mapping`] = {
        Type: 'AWS::Lambda::EventSourceMapping',
        Properties: {
          EventSourceArn: Fn.getAtt(qId, 'Arn'),
          FunctionName: Fn.ref('QueueFunction'),
          BatchSize: 1,
          FunctionResponseTypes: ['ReportBatchItemFailures'],
          ...(app.queueConcurrency
            ? { ScalingConfig: { MaximumConcurrency: Math.max(2, app.queueConcurrency) } }
            : {}),
        },
      }
      outputs[`QueueUrl${i}`] = { Description: `Queue URL: ${qName}`, Value: Fn.ref(qId) }
    })
  }

  // ── Scheduler (EventBridge → CLI function: `schedule:run` every minute) ─────
  if (schedulerEnabled) {
    resources.SchedulerRule = {
      Type: 'AWS::Events::Rule',
      Properties: {
        Name: `${slug}-${environment}-scheduler`,
        ScheduleExpression: 'rate(1 minute)',
        State: 'ENABLED',
        Targets: [{
          Id: 'cli',
          Arn: Fn.getAtt('CliFunction', 'Arn'),
          Input: JSON.stringify({ command: 'schedule:run' }),
        }],
      },
    }
    resources.SchedulerPermission = {
      Type: 'AWS::Lambda::Permission',
      Properties: {
        FunctionName: Fn.ref('CliFunction'),
        Action: 'lambda:InvokeFunction',
        Principal: 'events.amazonaws.com',
        SourceArn: Fn.getAtt('SchedulerRule', 'Arn'),
      },
    }
  }

  // ── Warming: keep N HTTP containers warm via scheduled pings ────────────────
  // EventBridge allows up to 5 targets per rule, each invoked concurrently — so
  // a rule with N targets warms N containers. For N > 5 we add more rules.
  if (app.warm && app.warm > 0) {
    const TARGETS_PER_RULE = 5
    const ruleCount = Math.ceil(app.warm / TARGETS_PER_RULE)
    let warmed = 0
    for (let r = 0; r < ruleCount; r++) {
      const targets = Math.min(TARGETS_PER_RULE, app.warm - warmed)
      resources[`WarmerRule${r}`] = {
        Type: 'AWS::Events::Rule',
        Properties: {
          Name: `${slug}-${environment}-warmer-${r}`,
          ScheduleExpression: 'rate(5 minutes)',
          State: 'ENABLED',
          Targets: Array.from({ length: targets }, (_, i) => ({
            Id: `warm-${r}-${i}`,
            Arn: Fn.getAtt('HttpFunction', 'Arn'),
            Input: JSON.stringify({ warmer: true }),
          })),
        },
      }
      warmed += targets
    }
    resources.WarmerPermission = {
      Type: 'AWS::Lambda::Permission',
      Properties: {
        FunctionName: Fn.ref('HttpFunction'),
        Action: 'lambda:InvokeFunction',
        Principal: 'events.amazonaws.com',
        SourceArn: Fn.sub('arn:aws:events:${AWS::Region}:${AWS::AccountId}:rule/' + `${slug}-${environment}-warmer-*`),
      },
    }
  }

  // ── DynamoDB cache table (zero-NAT default cache) ───────────────────────────
  if (cacheEnabled) {
    resources.CacheTable = {
      Type: 'AWS::DynamoDB::Table',
      Properties: {
        TableName: `${slug}-${environment}-cache`,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [{ AttributeName: 'key', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'key', KeyType: 'HASH' }],
        TimeToLiveSpecification: { AttributeName: 'expires_at', Enabled: true },
      },
    }
    outputs.CacheTableName = { Description: 'DynamoDB cache table', Value: Fn.ref('CacheTable') }
  }

  // ── Assets bucket + CloudFront ──────────────────────────────────────────────
  if (assetsEnabled) {
    resources.AssetsBucket = {
      Type: 'AWS::S3::Bucket',
      Properties: {
        BucketName: assetsBucket,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      },
    }
    resources.AssetsOAC = {
      Type: 'AWS::CloudFront::OriginAccessControl',
      Properties: {
        OriginAccessControlConfig: {
          Name: `${slug}-${environment}-assets-oac`,
          OriginAccessControlOriginType: 's3',
          SigningBehavior: 'always',
          SigningProtocol: 'sigv4',
        },
      },
    }
    resources.AssetsDistribution = {
      Type: 'AWS::CloudFront::Distribution',
      Properties: {
        DistributionConfig: {
          Enabled: true,
          DefaultCacheBehavior: {
            TargetOriginId: 'assets',
            ViewerProtocolPolicy: 'redirect-to-https',
            Compress: true,
            CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6', // Managed-CachingOptimized
          },
          Origins: [{
            Id: 'assets',
            DomainName: Fn.getAtt('AssetsBucket', 'RegionalDomainName'),
            OriginAccessControlId: Fn.ref('AssetsOAC'),
            S3OriginConfig: { OriginAccessIdentity: '' },
          }],
          // Custom asset CDN host (Vapor `asset-domain`). CloudFront requires a
          // us-east-1 ACM cert, supplied via assetCertificateArn.
          ...(app.assetDomain
            ? {
                Aliases: [app.assetDomain],
                ViewerCertificate: {
                  AcmCertificateArn: app.assetCertificateArn,
                  SslSupportMethod: 'sni-only',
                  MinimumProtocolVersion: 'TLSv1.2_2021',
                },
              }
            : {}),
        },
      },
    }
    if (app.assetDomain) {
      if (!app.assetCertificateArn)
        throw new Error('serverless app: `assetDomain` requires `assetCertificateArn` (a us-east-1 ACM cert — CloudFront only accepts certs from us-east-1).')
      if (app.hostedZoneId) {
        resources.AssetsDomainRecord = {
          Type: 'AWS::Route53::RecordSet',
          Properties: {
            HostedZoneId: app.hostedZoneId,
            Name: app.assetDomain,
            Type: 'A',
            AliasTarget: {
              DNSName: Fn.getAtt('AssetsDistribution', 'DomainName'),
              HostedZoneId: 'Z2FDTNDATAQYW2', // CloudFront's fixed hosted zone id
            },
          },
        }
      }
      outputs.AssetDomain = { Description: 'Custom asset CDN host', Value: app.assetDomain }
    }
    resources.AssetsBucketPolicy = {
      Type: 'AWS::S3::BucketPolicy',
      Properties: {
        Bucket: Fn.ref('AssetsBucket'),
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Action: 's3:GetObject',
            Resource: Fn.sub(`arn:aws:s3:::${assetsBucket}/*`),
            Condition: { StringEquals: { 'AWS:SourceArn': Fn.sub('arn:aws:cloudfront::${AWS::AccountId}:distribution/${AssetsDistribution}') } },
          }],
        },
      },
    }
    outputs.AssetsBucketName = { Description: 'Assets bucket', Value: Fn.ref('AssetsBucket') }
    outputs.AssetsCdnDomain = { Description: 'Assets CloudFront domain', Value: Fn.getAtt('AssetsDistribution', 'DomainName') }
  }

  // ── WAF (firewall) in front of the HTTP API ─────────────────────────────────
  if (app.firewall?.enabled) {
    const wafRules: any[] = []
    let priority = 0
    if (app.firewall.rateLimit) {
      wafRules.push({
        Name: 'rate-limit',
        Priority: priority++,
        Action: { Block: {} },
        Statement: { RateBasedStatement: { Limit: app.firewall.rateLimit, AggregateKeyType: 'IP' } },
        VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: `${slug}-${environment}-rate` },
      })
    }
    const managed: Record<string, string> = {
      sqlInjection: 'AWSManagedRulesSQLiRuleSet',
      xss: 'AWSManagedRulesCommonRuleSet',
      common: 'AWSManagedRulesCommonRuleSet',
      botControl: 'AWSManagedRulesBotControlRuleSet',
      ipReputation: 'AWSManagedRulesAmazonIpReputationList',
    }
    for (const rule of app.firewall.rules ?? []) {
      const name = managed[rule]
      if (!name) continue
      wafRules.push({
        Name: `managed-${rule}`,
        Priority: priority++,
        OverrideAction: { None: {} },
        Statement: { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: name } },
        VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: `${slug}-${environment}-${rule}` },
      })
    }
    resources.WebAcl = {
      Type: 'AWS::WAFv2::WebACL',
      Properties: {
        Name: `${slug}-${environment}-waf`,
        Scope: 'REGIONAL',
        DefaultAction: { Allow: {} },
        Rules: wafRules,
        VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: `${slug}-${environment}-waf` },
      },
    }
    resources.WebAclAssociation = {
      Type: 'AWS::WAFv2::WebACLAssociation',
      DependsOn: ['HttpStage'],
      Properties: {
        // API Gateway v2 stage ARN.
        ResourceArn: Fn.sub('arn:aws:apigateway:${AWS::Region}::/apis/${HttpApi}/stages/$default'),
        WebACLArn: Fn.getAtt('WebAcl', 'Arn'),
      },
    }
  }

  // ── VPC-attached data services (ElastiCache / Aurora / RDS Proxy) ────────────
  // These require the functions to be in a VPC; AWS requires private subnets.
  if (hasVpc && needsDataVpc) {
    // A managed security group shared by the data services + functions. The
    // intra-VPC ingress also covers NFS (2049) for the EFS mount targets.
    resources.DataSecurityGroup = {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupDescription: `${slug}-${environment} serverless data access`,
        SecurityGroupIngress: [{ IpProtocol: '-1', CidrIp: '10.0.0.0/8' }],
      },
    }
  }

  // EFS shared filesystem (Vapor's /mnt/local). Provision the FS + per-subnet
  // mount targets + an access point (posix uid/gid 1001) unless an existing
  // access point ARN was supplied.
  if (efsProvision) {
    resources.EfsFileSystem = {
      Type: 'AWS::EFS::FileSystem',
      Properties: {
        Encrypted: true,
        FileSystemTags: [{ Key: 'Name', Value: `${slug}-${environment}-efs` }],
      },
    }
    subnets.forEach((subnetId, i) => {
      resources[`EfsMountTarget${i}`] = {
        Type: 'AWS::EFS::MountTarget',
        Properties: {
          FileSystemId: Fn.ref('EfsFileSystem'),
          SubnetId: subnetId,
          SecurityGroups: [Fn.getAtt('DataSecurityGroup', 'GroupId')],
        },
      }
    })
    resources.EfsAccessPoint = {
      Type: 'AWS::EFS::AccessPoint',
      Properties: {
        FileSystemId: Fn.ref('EfsFileSystem'),
        PosixUser: { Uid: 1001, Gid: 1001 },
        RootDirectory: {
          Path: '/lambda',
          CreationInfo: { OwnerUid: 1001, OwnerGid: 1001, Permissions: '0755' },
        },
      },
    }
    outputs.EfsFileSystemId = { Description: 'EFS file system id', Value: Fn.ref('EfsFileSystem') }
  }

  // ElastiCache Redis (replication group, single node by default).
  if (app.cache?.driver === 'elasticache') {
    resources.CacheSubnetGroup = {
      Type: 'AWS::ElastiCache::SubnetGroup',
      Properties: { Description: `${slug}-${environment} cache subnets`, SubnetIds: subnets },
    }
    resources.CacheCluster = {
      Type: 'AWS::ElastiCache::ReplicationGroup',
      Properties: {
        ReplicationGroupId: `${slug}-${environment}-cache`,
        ReplicationGroupDescription: `${slug}-${environment} redis`,
        Engine: 'redis',
        CacheNodeType: 'cache.t4g.micro',
        NumCacheClusters: 1,
        AutomaticFailoverEnabled: false,
        CacheSubnetGroupName: Fn.ref('CacheSubnetGroup'),
        SecurityGroupIds: [Fn.getAtt('DataSecurityGroup', 'GroupId')],
        TransitEncryptionEnabled: false,
      },
    }
    outputs.CacheEndpoint = { Description: 'Redis primary endpoint', Value: Fn.getAtt('CacheCluster', 'PrimaryEndPoint.Address') }
  }

  // Aurora Serverless v2 cluster (MySQL by default) + RDS Proxy.
  if (app.database?.connection === 'aurora-serverless') {
    resources.DbSubnetGroup = {
      Type: 'AWS::RDS::DBSubnetGroup',
      Properties: { DBSubnetGroupDescription: `${slug}-${environment} db subnets`, SubnetIds: subnets },
    }
    resources.DbSecret = {
      Type: 'AWS::SecretsManager::Secret',
      Properties: {
        Name: `${slug}/${environment}/db`,
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: 'app' }),
          GenerateStringKey: 'password',
          PasswordLength: 32,
          ExcludePunctuation: true,
        },
      },
    }
    resources.DbCluster = {
      Type: 'AWS::RDS::DBCluster',
      Properties: {
        Engine: 'aurora-mysql',
        EngineMode: 'provisioned',
        DBClusterIdentifier: `${slug}-${environment}-db`,
        MasterUsername: Fn.sub('{{resolve:secretsmanager:${DbSecret}:SecretString:username}}'),
        MasterUserPassword: Fn.sub('{{resolve:secretsmanager:${DbSecret}:SecretString:password}}'),
        ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 },
        DBSubnetGroupName: Fn.ref('DbSubnetGroup'),
        VpcSecurityGroupIds: [Fn.getAtt('DataSecurityGroup', 'GroupId')],
      },
    }
    resources.DbInstance = {
      Type: 'AWS::RDS::DBInstance',
      Properties: {
        Engine: 'aurora-mysql',
        DBInstanceClass: 'db.serverless',
        DBClusterIdentifier: Fn.ref('DbCluster'),
      },
    }
    outputs.DbEndpoint = { Description: 'Aurora cluster endpoint', Value: Fn.getAtt('DbCluster', 'Endpoint.Address') }
  }

  // RDS Proxy for Lambda connection pooling (fronts the Aurora cluster).
  if (app.rdsProxy && app.database?.connection === 'aurora-serverless') {
    resources.DbProxyRole = {
      Type: 'AWS::IAM::Role',
      Properties: {
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Principal: { Service: 'rds.amazonaws.com' }, Action: 'sts:AssumeRole' }],
        },
        Policies: [{
          PolicyName: 'read-db-secret',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: Fn.ref('DbSecret') }],
          },
        }],
      },
    }
    resources.DbProxy = {
      Type: 'AWS::RDS::DBProxy',
      Properties: {
        DBProxyName: typeof app.rdsProxy === 'object' && app.rdsProxy.name ? app.rdsProxy.name : `${slug}-${environment}-proxy`,
        EngineFamily: 'MYSQL',
        RoleArn: Fn.getAtt('DbProxyRole', 'Arn'),
        Auth: [{ AuthScheme: 'SECRETS', SecretArn: Fn.ref('DbSecret'), IAMAuth: 'DISABLED' }],
        VpcSubnetIds: subnets,
        VpcSecurityGroupIds: [Fn.getAtt('DataSecurityGroup', 'GroupId')],
        RequireTLS: false,
      },
    }
    outputs.DbProxyEndpoint = { Description: 'RDS Proxy endpoint', Value: Fn.getAtt('DbProxy', 'Endpoint') }
  }

  // ── Outputs: function names ─────────────────────────────────────────────────
  outputs.HttpFunctionName = { Description: 'HTTP function name', Value: Fn.ref('HttpFunction') }
  outputs.CliFunctionName = { Description: 'CLI function name', Value: Fn.ref('CliFunction') }
  if (hasQueue)
    outputs.QueueFunctionName = { Description: 'Queue function name', Value: Fn.ref('QueueFunction') }

  const template: CloudFormationTemplate = {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `Serverless application for ${opts.config.project.name} (${slug}-${environment})`,
    Parameters: imageMode
      ? {
          ImageUri: { Type: 'String', Description: 'ECR image URI of the deployment artifact' },
        }
      : {
          ArtifactBucket: { Type: 'String', Description: 'S3 bucket holding the deployment artifact' },
          ArtifactKey: { Type: 'String', Description: 'S3 key of the deployment artifact (zip)' },
        },
    Resources: resources,
    Outputs: outputs,
  }

  // Resource summary by type.
  const resourceSummary: Record<string, number> = {}
  for (const r of Object.values(resources)) {
    resourceSummary[(r as any).Type] = (resourceSummary[(r as any).Type] ?? 0) + 1
  }

  void region // reserved for future region-pinned resources (e.g. us-east-1 certs)

  return { template, functionNames, queueNames, resourceSummary }
}
