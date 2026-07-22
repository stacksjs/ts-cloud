import { createHash } from 'node:crypto'
import { CloudFrontClient } from '../aws/cloudfront'
import { CloudWatchLogsClient } from '../aws/cloudwatch-logs'
import { IAMClient } from '../aws/iam'
import { LambdaClient } from '../aws/lambda'
import { STSClient } from '../aws/sts'

export interface StaticApiOriginOptions {
  distributionId: string
  expectedAlias: string
  functionName: string
  profile?: string
  region?: string
  pathPattern?: string
  originId?: string
  roleName?: string
  memorySize?: number
  timeout?: number
  logRetentionDays?: number
  code?: string
  apply?: boolean
  confirm?: string
}

export interface StaticApiOriginPlan {
  mode: 'plan' | 'apply'
  accountId: string
  identityArn?: string
  distribution: { id: string; arn: string; alias: string; domainName: string; status: string }
  function: { name: string; existed: boolean; runtime: 'nodejs22.x'; urlExisted: boolean; url?: string }
  role: { name: string; existed: boolean; arn: string }
  origin: { id: string; pathPattern: string; existed: boolean; behaviorExisted: boolean; accessControlExisted: boolean }
  changes: string[]
  rollback: { command: string; removeFunction: boolean; removeRole: boolean }
  applied: boolean
}

export interface StaticApiOriginVerification {
  frontend: { url: string; status: number; sha256: string; unchanged?: boolean; bytes: number }
  api: { url: string; status: number; latencyMs: number; healthy: boolean; body: unknown }
  coldStart: { observed: boolean; initDurationMs?: number }
  verifiedAt: string
}

export interface StaticApiOriginDependencies {
  cloudfront: Pick<
    CloudFrontClient,
    | 'getDistribution'
    | 'getDistributionConfig'
    | 'listOriginAccessControls'
    | 'findOrCreateOriginAccessControl'
    | 'upsertExistingDistributionOrigin'
  >
  iam: Pick<IAMClient, 'getRole' | 'createRole' | 'putRolePolicy'>
  lambda: Pick<
    LambdaClient,
    | 'functionExists'
    | 'getFunction'
    | 'createFunctionWithCode'
    | 'updateFunctionCodeInline'
    | 'updateFunctionConfiguration'
    | 'waitForFunctionActive'
    | 'getFunctionUrl'
    | 'createFunctionUrl'
    | 'addPermission'
  >
  logs: Pick<CloudWatchLogsClient, 'createLogGroup' | 'putRetentionPolicy'>
  sts: Pick<STSClient, 'getCallerIdentity'>
  sleep: (milliseconds: number) => Promise<void>
}

const DEFAULT_HANDLER = `let coldStart = true
const initializedAt = new Date().toISOString()
export const handler = async (event) => {
  const currentColdStart = coldStart
  coldStart = false
  const path = event.rawPath || event.requestContext?.http?.path || '/'
  const statusCode = path === '/api/health' || path === '/health' ? 200 : 404
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({ ok: statusCode === 200, service: 'ts-cloud-static-api', path, coldStart: currentColdStart, initializedAt })
  }
}
`

function errorCode(error: unknown): string {
  const value = error as { code?: string; name?: string; statusCode?: number }
  return String(value?.code || value?.name || value?.statusCode || '')
}

function isMissing(error: unknown): boolean {
  return ['NoSuchEntity', 'ResourceNotFoundException', '404'].includes(errorCode(error))
}

function isAlreadyExists(error: unknown): boolean {
  return ['EntityAlreadyExists', 'ResourceAlreadyExistsException', 'ResourceConflictException', '409'].includes(
    errorCode(error),
  )
}

function collection(value: any, singular: string): any[] {
  const items = value?.Items
  if (!items) return []
  if (Array.isArray(items)) return items
  const nested = items[singular]
  if (nested === undefined) return []
  return Array.isArray(nested) ? nested : [nested]
}

function aliasesOf(value: any): string[] {
  const items = value?.Aliases?.Items
  if (Array.isArray(items)) return items.map(String)
  if (typeof items === 'string') return [items]
  return []
}

function validateOptions(
  options: StaticApiOriginOptions,
): Required<
  Pick<
    StaticApiOriginOptions,
    'region' | 'pathPattern' | 'originId' | 'roleName' | 'memorySize' | 'timeout' | 'logRetentionDays'
  >
> {
  if (!/^[A-Z0-9]{8,32}$/.test(options.distributionId)) throw new Error('CloudFront distribution ID is invalid')
  if (
    !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9-]{2,63}$/.test(options.expectedAlias)
  )
    throw new Error('Expected CloudFront alias is invalid')
  if (!/^[A-Za-z0-9-_]{1,64}$/.test(options.functionName)) throw new Error('Lambda function name is invalid')
  const pathPattern = options.pathPattern?.startsWith('/') ? options.pathPattern : `/${options.pathPattern || 'api/*'}`
  if (pathPattern === '/' || pathPattern === '/*' || !pathPattern.endsWith('*'))
    throw new Error('API path must be a non-default wildcard pattern such as /api/*')
  const originId = options.originId || `${options.functionName}-url`
  const roleName = options.roleName || `${options.functionName}-execution`
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(roleName)) throw new Error('IAM role name is invalid')
  const memorySize = options.memorySize ?? 256
  const timeout = options.timeout ?? 10
  const logRetentionDays = options.logRetentionDays ?? 14
  if (memorySize < 128 || memorySize > 10240) throw new Error('Lambda memory must be between 128 and 10240 MB')
  if (timeout < 1 || timeout > 900) throw new Error('Lambda timeout must be between 1 and 900 seconds')
  return {
    region: options.region || 'us-east-1',
    pathPattern,
    originId,
    roleName,
    memorySize,
    timeout,
    logRetentionDays,
  }
}

export function createStaticApiOriginDependencies(
  options: Pick<StaticApiOriginOptions, 'profile' | 'region'>,
): StaticApiOriginDependencies {
  const region = options.region || 'us-east-1'
  return {
    cloudfront: new CloudFrontClient(options.profile),
    iam: new IAMClient(region, options.profile),
    lambda: new LambdaClient(region, options.profile),
    logs: new CloudWatchLogsClient(region, options.profile),
    sts: new STSClient(region, options.profile),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  }
}

export async function deployStaticApiOrigin(
  options: StaticApiOriginOptions,
  injected?: StaticApiOriginDependencies,
): Promise<StaticApiOriginPlan> {
  const resolved = validateOptions(options)
  const dependencies =
    injected || createStaticApiOriginDependencies({ profile: options.profile, region: resolved.region })
  const [identity, distribution, distributionConfig] = await Promise.all([
    dependencies.sts.getCallerIdentity(),
    dependencies.cloudfront.getDistribution(options.distributionId),
    dependencies.cloudfront.getDistributionConfig(options.distributionId),
  ])
  if (!identity.Account) throw new Error('AWS identity did not return an account ID')
  if (!distribution.Enabled) throw new Error(`CloudFront distribution ${options.distributionId} is disabled`)
  const aliases = aliasesOf(distribution).length
    ? aliasesOf(distribution)
    : aliasesOf(distributionConfig.DistributionConfig)
  if (!aliases.includes(options.expectedAlias))
    throw new Error(`Distribution ${options.distributionId} does not contain expected alias ${options.expectedAlias}`)

  let role: { Arn: string } | undefined
  let roleExisted = true
  try {
    role = await dependencies.iam.getRole({ RoleName: resolved.roleName })
  } catch (error) {
    if (!isMissing(error)) throw error
    roleExisted = false
  }
  const expectedRoleArn = role?.Arn || `arn:aws:iam::${identity.Account}:role/${resolved.roleName}`
  const functionExisted = await dependencies.lambda.functionExists(options.functionName)
  const functionUrl = functionExisted ? await dependencies.lambda.getFunctionUrl(options.functionName) : null
  const oacs = await dependencies.cloudfront.listOriginAccessControls()
  const oacName = `${options.functionName}-lambda-url`
  const accessControlExisted = oacs.some(
    (value) => value.Name === oacName && value.OriginAccessControlOriginType === 'lambda',
  )
  const origins = collection(distributionConfig.DistributionConfig.Origins, 'Origin')
  const behaviors = collection(distributionConfig.DistributionConfig.CacheBehaviors, 'CacheBehavior')
  const originExisted = origins.some((value) => String(value.Id) === resolved.originId)
  const behaviorExisted = behaviors.some((value) => String(value.PathPattern) === resolved.pathPattern)
  const changes = [
    ...(!roleExisted
      ? [`create IAM execution role ${resolved.roleName}`]
      : [`reconcile IAM execution policy ${resolved.roleName}`]),
    ...(functionExisted
      ? [`update Lambda ${options.functionName} code and configuration`]
      : [`create Lambda ${options.functionName}`]),
    ...(!functionUrl ? ['create private AWS_IAM function URL'] : []),
    ...(!accessControlExisted ? [`create Lambda origin access control ${oacName}`] : []),
    'grant CloudFront function-URL and invocation permissions',
    `${behaviorExisted ? 'reconcile' : 'add'} ${resolved.pathPattern} behavior without changing the default behavior`,
  ]
  const rollback = {
    command: `cloud cdn:origin:remove ${options.distributionId} FUNCTION_URL_HOST --id ${resolved.originId} --path '${resolved.pathPattern}' --apply --confirm 'remove:${options.distributionId}:${resolved.pathPattern}'`,
    removeFunction: !functionExisted,
    removeRole: !roleExisted,
  }
  const base: StaticApiOriginPlan = {
    mode: options.apply ? 'apply' : 'plan',
    accountId: identity.Account,
    identityArn: identity.Arn,
    distribution: {
      id: distribution.Id,
      arn: distribution.ARN,
      alias: options.expectedAlias,
      domainName: distribution.DomainName,
      status: distribution.Status,
    },
    function: {
      name: options.functionName,
      existed: functionExisted,
      runtime: 'nodejs22.x',
      urlExisted: !!functionUrl,
      url: functionUrl?.FunctionUrl,
    },
    role: { name: resolved.roleName, existed: roleExisted, arn: expectedRoleArn },
    origin: {
      id: resolved.originId,
      pathPattern: resolved.pathPattern,
      existed: originExisted,
      behaviorExisted,
      accessControlExisted,
    },
    changes,
    rollback,
    applied: false,
  }
  if (!options.apply) return base
  const confirmation = `${options.distributionId}:${resolved.pathPattern}`
  if (options.confirm !== confirmation)
    throw new Error(`Pass exact confirmation token ${confirmation} to mutate the live distribution`)

  if (!role) {
    role = await dependencies.iam.createRole({
      RoleName: resolved.roleName,
      Description: `Execution role for ${options.functionName}`,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      }),
      Tags: [{ Key: 'ManagedBy', Value: 'ts-cloud' }],
    })
  }
  await dependencies.iam.putRolePolicy({
    RoleName: resolved.roleName,
    PolicyName: 'lambda-logs',
    PolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          Resource: `arn:aws:logs:${resolved.region}:${identity.Account}:log-group:/aws/lambda/${options.functionName}:*`,
        },
      ],
    }),
  })
  try {
    await dependencies.logs.createLogGroup(`/aws/lambda/${options.functionName}`, { ManagedBy: 'ts-cloud' })
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
  }
  await dependencies.logs.putRetentionPolicy(`/aws/lambda/${options.functionName}`, resolved.logRetentionDays)

  const code = options.code || DEFAULT_HANDLER
  if (functionExisted) {
    await dependencies.lambda.updateFunctionCodeInline(options.functionName, code, 'index.mjs')
    await dependencies.lambda.waitForFunctionActive(options.functionName)
    await dependencies.lambda.updateFunctionConfiguration({
      FunctionName: options.functionName,
      Runtime: 'nodejs22.x',
      Role: role.Arn,
      Handler: 'index.handler',
      Description: `Private API origin for ${options.expectedAlias}`,
      Timeout: resolved.timeout,
      MemorySize: resolved.memorySize,
    })
  } else {
    let lastError: unknown
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await dependencies.lambda.createFunctionWithCode({
          FunctionName: options.functionName,
          Runtime: 'nodejs22.x',
          Role: role.Arn,
          Handler: 'index.handler',
          Code: code,
          Filename: 'index.mjs',
          Description: `Private API origin for ${options.expectedAlias}`,
          Timeout: resolved.timeout,
          MemorySize: resolved.memorySize,
        })
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        if (
          !String((error as Error).message)
            .toLowerCase()
            .includes('role')
        )
          throw error
        await dependencies.sleep(1000)
      }
    }
    if (lastError) throw lastError
  }
  await dependencies.lambda.waitForFunctionActive(options.functionName)
  const url =
    functionUrl ||
    (await dependencies.lambda.createFunctionUrl({
      FunctionName: options.functionName,
      AuthType: 'AWS_IAM',
      InvokeMode: 'BUFFERED',
    }))
  if (!url.FunctionUrl) throw new Error('Lambda did not return a function URL')
  const urlHost = new URL(url.FunctionUrl).hostname
  const oac = await dependencies.cloudfront.findOrCreateOriginAccessControl(oacName, 'lambda')
  const sourceArn = distribution.ARN || `arn:aws:cloudfront::${identity.Account}:distribution/${options.distributionId}`
  const permissions = [
    {
      FunctionName: options.functionName,
      StatementId: 'AllowCloudFrontFunctionUrl',
      Action: 'lambda:InvokeFunctionUrl',
      Principal: 'cloudfront.amazonaws.com',
      SourceArn: sourceArn,
      FunctionUrlAuthType: 'AWS_IAM' as const,
    },
    {
      FunctionName: options.functionName,
      StatementId: 'AllowCloudFrontInvoke',
      Action: 'lambda:InvokeFunction',
      Principal: 'cloudfront.amazonaws.com',
      SourceArn: sourceArn,
      InvokedViaFunctionUrl: true,
    },
  ]
  for (const permission of permissions) {
    try {
      await dependencies.lambda.addPermission(permission)
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
    }
  }
  await dependencies.cloudfront.upsertExistingDistributionOrigin(options.distributionId, {
    id: resolved.originId,
    domainName: urlHost,
    pathPattern: resolved.pathPattern,
    originAccessControlId: oac.Id,
  })
  return { ...base, function: { ...base.function, url: url.FunctionUrl }, applied: true }
}

export async function verifyStaticApiOrigin(options: {
  alias: string
  expectedFrontendSha256?: string
  logs?: Pick<CloudWatchLogsClient, 'filterLogEvents'>
  functionName?: string
  now?: () => Date
}): Promise<StaticApiOriginVerification> {
  const frontendUrl = `https://${options.alias}/`
  const apiUrl = `https://${options.alias}/api/health`
  const frontendResponse = await fetch(frontendUrl, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } })
  const frontendBytes = new Uint8Array(await frontendResponse.arrayBuffer())
  const frontendSha256 = createHash('sha256').update(frontendBytes).digest('hex')
  const startedAt = Date.now()
  const apiResponse = await fetch(apiUrl, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } })
  const latencyMs = Date.now() - startedAt
  const text = await apiResponse.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {}
  let initDurationMs: number | undefined
  if (options.logs && options.functionName) {
    const result = await options.logs.filterLogEvents({
      logGroupName: `/aws/lambda/${options.functionName}`,
      startTime: startedAt - 60_000,
      filterPattern: '"Init Duration"',
      limit: 25,
    })
    for (const event of result.events || []) {
      const match = event.message?.match(/Init Duration:\s*([0-9.]+)\s*ms/i)
      if (match) initDurationMs = Number(match[1])
    }
  }
  return {
    frontend: {
      url: frontendUrl,
      status: frontendResponse.status,
      sha256: frontendSha256,
      unchanged: options.expectedFrontendSha256 ? frontendSha256 === options.expectedFrontendSha256 : undefined,
      bytes: frontendBytes.byteLength,
    },
    api: { url: apiUrl, status: apiResponse.status, latencyMs, healthy: apiResponse.ok && !!(body as any)?.ok, body },
    coldStart: { observed: initDurationMs !== undefined, initDurationMs },
    verifiedAt: (options.now?.() || new Date()).toISOString(),
  }
}

export function estimateStaticApiOriginMonthlyCost(options: {
  requests: number
  averageDurationMs: number
  memoryMb?: number
  includeFreeTier?: boolean
}): { lambdaUsd: number; alwaysOnFargateAndAlbUsd: number; assumptions: string[] } {
  const memoryGb = (options.memoryMb || 256) / 1024
  const billableRequests = Math.max(0, options.requests - (options.includeFreeTier === false ? 0 : 1_000_000))
  const billableGbSeconds = Math.max(
    0,
    options.requests * (options.averageDurationMs / 1000) * memoryGb -
      (options.includeFreeTier === false ? 0 : 400_000),
  )
  const lambdaUsd = (billableRequests / 1_000_000) * 0.2 + billableGbSeconds * 0.0000166667
  const fargateCompute = 730 * (0.25 * 0.04048 + 0.5 * 0.004445)
  const alb = 730 * 0.0225
  return {
    lambdaUsd: Number(lambdaUsd.toFixed(2)),
    alwaysOnFargateAndAlbUsd: Number((fargateCompute + alb).toFixed(2)),
    assumptions: [
      'us-east-1 public list rates snapshot, July 2026',
      'Lambda x86 request and duration pricing with optional monthly free tier',
      'Fargate comparison uses one always-on 0.25 vCPU/0.5 GB task plus one ALB before LCU charges',
      'excludes CloudFront, data transfer, logs, taxes, and application data services',
    ],
  }
}
