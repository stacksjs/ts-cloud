import { createHash } from 'node:crypto'
import { buildCloudFormationTemplate, createExistingStaticFullStackPreset } from '@ts-cloud/core'
import { CloudFormationClient } from '../aws/cloudformation'
import { CloudFrontClient } from '../aws/cloudfront'
import { STSClient } from '../aws/sts'
import type { DnsProvider } from '../dns/types'

export interface ExistingStaticFullStackOptions {
  name: string
  slug: string
  imageUri: string
  distributionId: string
  expectedAlias: string
  stackName?: string
  region?: string
  profile?: string
  pathPattern?: string
  originId?: string
  originDomain?: string
  certificateArn?: string
  originVerifySecret?: string
  desiredCount?: number
  database?: boolean
  cache?: boolean
  queue?: boolean
  apply?: boolean
  confirm?: string
  skipHealthCheck?: boolean
}

export interface ExistingStaticFullStackPlan {
  mode: 'plan' | 'apply'
  accountId: string
  stack: { name: string, existed: boolean, status?: string, templateSha256: string, resourceCount: number, resourceTypes: Record<string, number> }
  distribution: { id: string, alias: string, domainName: string, status: string, pathPattern: string, originId: string }
  artifact: { imageUri: string, digest: string }
  services: { database: boolean, cache: boolean, queue: boolean, mail: 'ses', desiredCount: number }
  outputs?: Record<string, string>
  health?: { url: string, status: number, latencyMs: number, body: unknown }
  cloudFrontApplied: boolean
  dnsApplied: boolean
  applied: boolean
  rollback: string[]
}

export interface ExistingStaticFullStackDependencies {
  cloudformation: Pick<CloudFormationClient, 'describeStacks' | 'createStack' | 'updateStack' | 'waitForStack'>
  cloudfront: Pick<CloudFrontClient, 'getDistribution' | 'upsertExistingDistributionOrigin'>
  sts: Pick<STSClient, 'getCallerIdentity'>
  dns?: Pick<DnsProvider, 'upsertRecord'>
  fetch: typeof fetch
  sleep: (milliseconds: number) => Promise<void>
}

function errorCode(error: unknown): string {
  const value = error as { code?: string, name?: string, statusCode?: number }
  return String(value?.code || value?.name || value?.statusCode || '')
}

function isMissingStack(error: unknown): boolean {
  return errorCode(error) === 'ValidationError' && String((error as Error).message).includes('does not exist')
}

function outputMap(outputs: Array<{ OutputKey: string, OutputValue: string }> | undefined): Record<string, string> {
  return Object.fromEntries((outputs || []).map(value => [value.OutputKey, value.OutputValue]))
}

function aliasesOf(distribution: any): string[] {
  const items = distribution?.Aliases?.Items ?? distribution?.Aliases
  if (Array.isArray(items)) return items.map(String)
  if (typeof items === 'string') return [items]
  return []
}

function validateOptions(options: ExistingStaticFullStackOptions): { stackName: string, region: string, pathPattern: string, originId: string, digest: string } {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(options.slug)) throw new Error('Slug must be a lowercase DNS-safe identifier')
  if (!/^[A-Z0-9]{8,32}$/.test(options.distributionId)) throw new Error('CloudFront distribution ID is invalid')
  if (!/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9-]{2,63}$/.test(options.expectedAlias)) throw new Error('Expected distribution alias is invalid')
  const digest = options.imageUri.match(/@((?:sha256:)[a-f0-9]{64})$/i)?.[1]
  if (!digest) throw new Error('Container image must use an immutable ECR digest URI ending in @sha256:<64 hex>')
  const stackName = options.stackName || `${options.slug}-backend`
  if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(stackName)) throw new Error('CloudFormation stack name is invalid')
  const pathPattern = options.pathPattern || '/api/*'
  if (!/^\/[A-Za-z0-9_.*?~!$&'()+,;=:@%/-]+\*$/.test(pathPattern) || pathPattern === '/*') throw new Error('Backend path must be a non-default wildcard pattern')
  const originId = options.originId || `${options.slug}-backend`
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(originId)) throw new Error('CloudFront origin ID is invalid')
  if (options.originVerifySecret && options.originVerifySecret.length < 24) throw new Error('Origin verification secret must contain at least 24 characters')
  return { stackName, region: options.region || 'us-east-1', pathPattern, originId, digest }
}

export function createExistingStaticFullStackDependencies(options: Pick<ExistingStaticFullStackOptions, 'region' | 'profile'>): ExistingStaticFullStackDependencies {
  const region = options.region || 'us-east-1'
  return {
    cloudformation: new CloudFormationClient(region, options.profile),
    cloudfront: new CloudFrontClient(options.profile),
    sts: new STSClient(region, options.profile),
    fetch,
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  }
}

export function generateExistingStaticFullStackTemplate(options: ExistingStaticFullStackOptions): Record<string, any> {
  const resolved = validateOptions(options)
  const config = createExistingStaticFullStackPreset({
    name: options.name,
    slug: options.slug,
    domain: options.originDomain || options.expectedAlias,
    imageUri: options.imageUri,
    certificateArn: options.certificateArn,
    originVerifySecret: options.originVerifySecret,
    desiredCount: options.desiredCount,
    database: options.database,
    cache: options.cache,
    queue: options.queue,
  })
  const template = buildCloudFormationTemplate(config as any) as Record<string, any>
  template.Description = `Managed backend for existing static frontend ${options.expectedAlias}`
  template.Metadata = { ManagedBy: 'ts-cloud', ExistingDistributionId: options.distributionId, ExistingDistributionAlias: options.expectedAlias, BackendPathPattern: resolved.pathPattern, ContainerDigest: resolved.digest }
  return template
}

async function waitForHealthyOrigin(dependencies: ExistingStaticFullStackDependencies, url: string, secret?: string): Promise<{ url: string, status: number, latencyMs: number, body: unknown }> {
  let lastError: unknown
  for (let attempt = 0; attempt < 30; attempt++) {
    const startedAt = Date.now()
    try {
      const response = await dependencies.fetch(url, { redirect: 'manual', headers: secret ? { 'x-origin-verify': secret } : undefined })
      const latencyMs = Date.now() - startedAt
      const text = await response.text()
      let body: unknown = text
      try { body = JSON.parse(text) }
      catch {}
      if (response.ok) return { url, status: response.status, latencyMs, body }
      lastError = new Error(`origin returned ${response.status}`)
    }
    catch (error) { lastError = error }
    if (attempt < 29) await dependencies.sleep(10_000)
  }
  throw new Error(`Backend origin did not become healthy: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

export async function deployExistingStaticFullStack(options: ExistingStaticFullStackOptions, injected?: ExistingStaticFullStackDependencies): Promise<ExistingStaticFullStackPlan> {
  const resolved = validateOptions(options)
  const dependencies = injected || createExistingStaticFullStackDependencies({ region: resolved.region, profile: options.profile })
  const [identity, distribution] = await Promise.all([dependencies.sts.getCallerIdentity(), dependencies.cloudfront.getDistribution(options.distributionId)])
  if (!identity.Account) throw new Error('AWS identity did not return an account ID')
  if (!distribution.Enabled) throw new Error(`CloudFront distribution ${options.distributionId} is disabled`)
  if (!aliasesOf(distribution).includes(options.expectedAlias)) throw new Error(`Distribution ${options.distributionId} does not contain expected alias ${options.expectedAlias}`)
  let existingStack: any
  try { existingStack = (await dependencies.cloudformation.describeStacks({ stackName: resolved.stackName })).Stacks[0] }
  catch (error) { if (!isMissingStack(error)) throw error }
  const template = generateExistingStaticFullStackTemplate(options)
  const templateBody = JSON.stringify(template)
  if (Buffer.byteLength(templateBody) > 51_200) throw new Error('Generated template exceeds the direct CloudFormation template body limit')
  const resourceTypes = Object.values(template.Resources || {}).reduce<Record<string, number>>((counts, resource: any) => { counts[resource.Type] = (counts[resource.Type] || 0) + 1; return counts }, {})
  const rollback = [
    `cloud cdn:origin:remove ${options.distributionId} ${options.originDomain || 'ALB_HOST'} --id ${resolved.originId} --path '${resolved.pathPattern}' --profile ${options.profile || 'default'} --apply --confirm 'remove:${options.distributionId}:${resolved.pathPattern}'`,
    `After CloudFront is deployed, restore external DNS if changed and delete stack ${resolved.stackName} only with an approved data-retention decision.`,
  ]
  const base: ExistingStaticFullStackPlan = {
    mode: options.apply ? 'apply' : 'plan',
    accountId: identity.Account,
    stack: { name: resolved.stackName, existed: !!existingStack, status: existingStack?.StackStatus, templateSha256: createHash('sha256').update(templateBody).digest('hex'), resourceCount: Object.keys(template.Resources || {}).length, resourceTypes },
    distribution: { id: distribution.Id, alias: options.expectedAlias, domainName: distribution.DomainName, status: distribution.Status, pathPattern: resolved.pathPattern, originId: resolved.originId },
    artifact: { imageUri: options.imageUri, digest: resolved.digest },
    services: { database: options.database !== false, cache: options.cache !== false, queue: options.queue !== false, mail: 'ses', desiredCount: options.desiredCount || 1 },
    cloudFrontApplied: false,
    dnsApplied: false,
    applied: false,
    rollback,
  }
  if (!options.apply) return base
  const confirmation = `${options.distributionId}:${resolved.pathPattern}:${resolved.stackName}`
  if (options.confirm !== confirmation) throw new Error(`Pass exact confirmation token ${confirmation} to provision the backend and change live routing`)
  if (existingStack) {
    try { await dependencies.cloudformation.updateStack({ stackName: resolved.stackName, templateBody, capabilities: ['CAPABILITY_NAMED_IAM'], tags: [{ Key: 'ManagedBy', Value: 'ts-cloud' }, { Key: 'Application', Value: options.slug }] }); await dependencies.cloudformation.waitForStack(resolved.stackName, 'stack-update-complete') }
    catch (error) { if (!String((error as Error).message).includes('No updates are to be performed')) throw error }
  }
  else {
    await dependencies.cloudformation.createStack({ stackName: resolved.stackName, templateBody, capabilities: ['CAPABILITY_NAMED_IAM'], onFailure: 'ROLLBACK', tags: [{ Key: 'ManagedBy', Value: 'ts-cloud' }, { Key: 'Application', Value: options.slug }] })
    await dependencies.cloudformation.waitForStack(resolved.stackName, 'stack-create-complete')
  }
  const stack = (await dependencies.cloudformation.describeStacks({ stackName: resolved.stackName })).Stacks[0]
  const outputs = outputMap(stack?.Outputs)
  const albDomain = outputs.AppLoadBalancerDnsName
  if (!albDomain) throw new Error('Backend stack did not return AppLoadBalancerDnsName')
  let dnsApplied = false
  if (options.originDomain && options.originDomain !== albDomain) {
    if (!dependencies.dns) throw new Error(`External DNS provider is required to map ${options.originDomain} to ${albDomain}`)
    const result = await dependencies.dns.upsertRecord(options.originDomain, { name: options.originDomain, type: 'CNAME', content: albDomain, ttl: 300 })
    if (!result.success) throw new Error(result.message || 'External DNS update failed')
    dnsApplied = true
  }
  const originHost = options.originDomain || albDomain
  const protocolPolicy = options.certificateArn ? 'https-only' : 'http-only'
  const health = options.skipHealthCheck ? undefined : await waitForHealthyOrigin(dependencies, `${protocolPolicy === 'https-only' ? 'https' : 'http'}://${originHost}/api/health`, options.originVerifySecret)
  await dependencies.cloudfront.upsertExistingDistributionOrigin(options.distributionId, { id: resolved.originId, domainName: originHost, pathPattern: resolved.pathPattern, protocolPolicy, customHeaders: options.originVerifySecret ? { 'X-Origin-Verify': options.originVerifySecret } : undefined })
  return { ...base, outputs, health, cloudFrontApplied: true, dnsApplied, applied: true }
}

export function estimateExistingStaticFullStackMonthlyCost(options: { desiredCount?: number, multiAzDatabase?: boolean } = {}): { monthlyUsd: number, components: Record<string, number>, assumptions: string[] } {
  const hours = 730
  const components = {
    fargate: hours * (options.desiredCount || 1) * (0.25 * 0.04048 + 0.5 * 0.004445),
    applicationLoadBalancer: hours * 0.0225,
    natGateway: hours * 0.045,
    postgres: hours * (options.multiAzDatabase ? 0.032 : 0.016),
    redis: hours * 2 * 0.016,
  }
  return { monthlyUsd: Number(Object.values(components).reduce((sum, value) => sum + value, 0).toFixed(2)), components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, Number(value.toFixed(2))])), assumptions: ['us-east-1 public on-demand rate snapshot, July 2026', 'one 0.25 vCPU/0.5 GB Linux Fargate task unless desiredCount is changed', 'one ALB before LCU charges and one NAT gateway before data processing', 'single-AZ db.t4g.micro PostgreSQL by default and two cache.t4g.micro Redis nodes', 'excludes storage, backups, CloudFront, data transfer, public IPv4, logs, email, queue requests, taxes, and free-tier credits'] }
}
