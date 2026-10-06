/**
 * Make the Cloudflare R2 buckets a config declares exist, and look the way it
 * says.
 *
 * Runs on every deploy, so it is a reconcile rather than a create: each step
 * reads first and writes only what drifted, and a bucket that is already right
 * costs a handful of GETs and reports no changes. The order per bucket is the
 * order things depend on each other: the bucket, then the settings that live
 * on it (CORS, lifecycle, the `r2.dev` URL), then the custom domains, and last
 * the cache rule that is scoped to those domains' hostnames.
 *
 * What is NOT done, deliberately: nothing is ever deleted. A bucket or custom
 * domain dropped from config is left in place, because removing either loses
 * data or takes a public URL down, and a config edit should not be able to do
 * that silently.
 */
import type { R2BucketConfig, R2Config, R2LifecycleRule, R2MinTls } from '@ts-cloud/core'
import type { CloudflareRule } from '../dns/cloudflare'
import type { R2ApiLifecycleRule, R2BucketScope, R2CustomDomain } from './provider'
import { hostCondition } from '../cdn/cloudflare-rules'
import { CLOUDFLARE_MANAGED_RULE_PREFIX, CloudflareProvider, expressionShape, hostsInExpression } from '../dns/cloudflare'
import { R2NotEnabledError, R2Provider, sameCorsRules, sameLifecycleRules } from './provider'

/** What a deploy needs to know about one bucket after the reconcile. */
export interface R2BucketSummary {
  /** Bucket name. */
  name: string
  /**
   * Human-readable changes, e.g. `created`, `cors updated`,
   * `custom domain tiles.example.com attached`. Empty when already in sync.
   * In a dry run each entry starts with `would`.
   */
  changes: string[]
  /** Every declared custom domain and its state (`active`, `pending`, ...). */
  domains: Array<{ domain: string, status?: string }>
}

export interface R2ReconcileSummary {
  buckets: R2BucketSummary[]
  /** Problems that did not stop the reconcile: a domain that would not attach, a cache rule the token could not write. */
  warnings: string[]
}

export interface ReconcileR2BucketsOptions {
  /** Account API token with `Workers R2 Storage: Edit` (plus `Zone: Read` and cache-rule edit for custom domains and `cache`). */
  apiToken?: string
  /** Account the buckets live under. */
  accountId?: string
  /**
   * Zone id to use for custom domains inside that zone. Domains outside it,
   * or every domain when this is unset, have their zone looked up by apex.
   */
  zoneId?: string
  /** Progress lines. */
  log?: (message: string) => void
  /** Read everything, write nothing, and report what would change. */
  dryRun?: boolean
  /** Override `fetch` for the R2 calls, for tests. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
}

/** Anything carrying an `r2` block, at the top level or under `infrastructure`. */
export interface R2ConfigSource {
  infrastructure?: { r2?: R2Config }
  r2?: R2Config
}

/** Description given to the cache rule, after the managed prefix. */
const R2_CACHE_RULE_DESCRIPTION = 'r2 cache'

/** R2's bucket naming rule. Checked up front so a typo fails with a reason, not a 400. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/

/**
 * Reconcile every bucket in `config`'s `r2` block.
 *
 * Skips cleanly (logs and returns an empty summary) when there is no `r2`
 * block, and when the token or account id is missing (with a warning, since a
 * declared bucket that silently never appears is the worst outcome).
 *
 * Per-bucket problems that leave the rest of the bucket usable (a domain that
 * will not attach, a cache rule the token cannot write) become warnings. A
 * bucket that cannot be created, or any other API failure, throws.
 *
 * @throws {R2NotEnabledError} When R2 has never been enabled on the account
 */
export async function reconcileR2Buckets(
  config: R2ConfigSource,
  options: ReconcileR2BucketsOptions = {},
): Promise<R2ReconcileSummary> {
  const log = options.log ?? (() => {})
  const summary: R2ReconcileSummary = { buckets: [], warnings: [] }

  const r2 = config.infrastructure?.r2 ?? config.r2
  const declared = Object.entries(r2?.buckets ?? {})
  if (declared.length === 0) {
    log('R2: no buckets declared, skipping.')
    return summary
  }

  if (!options.apiToken || !options.accountId) {
    const missing = [!options.apiToken && 'CLOUDFLARE_API_TOKEN', !options.accountId && 'CLOUDFLARE_ACCOUNT_ID'].filter(Boolean).join(' and ')
    const message = `R2: ${declared.length} bucket(s) declared but ${missing} is not set, skipping.`
    log(message)
    summary.warnings.push(message)
    return summary
  }

  const dryRun = options.dryRun === true
  const r2Api = new R2Provider({ apiToken: options.apiToken, accountId: options.accountId, fetch: options.fetch })
  const cloudflare = new CloudflareProvider(options.apiToken, { zoneId: options.zoneId, accountId: options.accountId })

  // A hostname can only be one bucket's custom domain; catching the clash here
  // beats the second bucket's attach failing halfway through a deploy.
  const claimed = new Map<string, string>()

  for (const [key, bucketConfig] of declared) {
    const name = bucketConfig?.name
    if (!name || !BUCKET_NAME.test(name)) {
      summary.warnings.push(
        `R2: bucket '${key}' has an invalid name '${name ?? ''}' (3-63 chars: lowercase letters, digits, hyphens), skipping.`,
      )
      continue
    }

    log(`R2: ${dryRun ? 'checking' : 'reconciling'} bucket ${name}...`)
    const bucketSummary: R2BucketSummary = { name, changes: [], domains: [] }
    summary.buckets.push(bucketSummary)

    await reconcileBucket(bucketConfig, {
      r2: r2Api,
      cloudflare,
      dryRun,
      summary: bucketSummary,
      warnings: summary.warnings,
      claimed,
      log,
    })

    if (bucketSummary.changes.length === 0)
      log(`R2: ${name} is in sync.`)
    else
      for (const change of bucketSummary.changes) log(`R2: ${name}: ${change}`)
  }

  return summary
}

interface BucketContext {
  r2: R2Provider
  cloudflare: CloudflareProvider
  dryRun: boolean
  summary: R2BucketSummary
  warnings: string[]
  claimed: Map<string, string>
  log: (message: string) => void
}

/** One bucket, start to finish. */
async function reconcileBucket(bucket: R2BucketConfig, ctx: BucketContext): Promise<void> {
  const { r2, dryRun, summary, warnings } = ctx
  const name = bucket.name
  const scope: R2BucketScope = { jurisdiction: bucket.jurisdiction }
  // Records a change in the tense that fits the run. An empty string means the
  // change only exists in the other mode (a bucket is only "created" for real).
  const changed = (done: string, planned: string): void => {
    const text = dryRun ? (planned && `would ${planned}`) : done
    if (text)
      summary.changes.push(text)
  }

  // Everything below hangs off the bucket, so a failure here is not a warning:
  // it throws, and R2NotEnabledError reaches the caller with its message.
  let bucketExists: boolean
  if (dryRun) {
    bucketExists = (await r2.getBucket(name, scope)) !== null
  }
  else {
    const { created } = await r2.ensureBucket(name, { locationHint: bucket.locationHint, jurisdiction: bucket.jurisdiction })
    bucketExists = true
    if (created)
      changed('created', '')
  }
  // In a dry run a bucket that does not exist yet has no settings to read, so
  // every declared setting is reported as pending instead of reading 404s.
  if (!bucketExists)
    changed('', 'create bucket')

  const domains = normalizeDomains(bucket.customDomains)

  await step(ctx, `cors on ${name}`, async () => {
    if (!bucket.cors)
      return
    if (!bucketExists) {
      changed('cors updated', 'set cors')
      return
    }
    const current = await r2.getCors(name, scope)
    if (sameCorsRules(current, bucket.cors))
      return
    if (!dryRun)
      await r2.putCors(name, bucket.cors, scope)
    changed(bucket.cors.length === 0 ? 'cors removed' : 'cors updated', bucket.cors.length === 0 ? 'remove cors' : 'update cors')
  })

  await step(ctx, `lifecycle on ${name}`, async () => {
    if (!bucket.lifecycle)
      return
    const desired = bucket.lifecycle.map(toApiLifecycleRule)
    if (bucketExists) {
      const current = await r2.getLifecycle(name, scope)
      if (sameLifecycleRules(current, desired))
        return
    }
    if (!dryRun)
      await r2.putLifecycle(name, desired, scope)
    changed('lifecycle updated', 'update lifecycle')
  })

  await step(ctx, `r2.dev URL on ${name}`, async () => {
    const enabled = bucket.publicDevUrl === true
    if (!bucketExists) {
      // New buckets start with the r2.dev URL off, so only "on" is a change.
      if (enabled)
        changed('r2.dev URL enabled', 'enable r2.dev URL')
      return
    }
    const current = await r2.getManagedDomain(name, scope)
    if (current?.enabled === enabled)
      return
    if (!dryRun)
      await r2.setManagedDomain(name, enabled, scope)
    changed(enabled ? 'r2.dev URL enabled' : 'r2.dev URL disabled', enabled ? 'enable r2.dev URL' : 'disable r2.dev URL')
  })

  // Custom domains. Listed once for the bucket rather than once per domain.
  let attached: R2CustomDomain[] = []
  if (domains.length > 0 && bucketExists) {
    try {
      attached = await r2.listCustomDomains(name, scope)
    }
    catch (error) {
      if (error instanceof R2NotEnabledError)
        throw error
      warnings.push(`R2: could not list custom domains on ${name}: ${messageOf(error)}`)
    }
  }

  // Zone id per domain, needed both to attach and to write the cache rule.
  const zones = new Map<string, string>()

  for (const { domain, minTLS } of domains) {
    const owner = ctx.claimed.get(domain)
    if (owner && owner !== name) {
      warnings.push(`R2: ${domain} is declared on both ${owner} and ${name}; leaving it on ${owner}.`)
      continue
    }
    ctx.claimed.set(domain, name)

    const current = attached.find(entry => entry.domain.toLowerCase() === domain)
    const wantedTls = minTLS ?? '1.2'

    if (current && current.enabled && (current.minTLS ?? '1.0') === wantedTls) {
      summary.domains.push({ domain, status: domainStatus(current) })
      if (current.zoneId)
        zones.set(domain, current.zoneId)
      continue
    }

    await step(ctx, `custom domain ${domain} on ${name}`, async () => {
      if (current) {
        if (!dryRun)
          await r2.updateCustomDomain(name, current.domain, { enabled: true, minTLS: wantedTls }, scope)
        changed(`custom domain ${domain} updated`, `update custom domain ${domain}`)
        summary.domains.push({ domain, status: domainStatus({ ...current, enabled: true }) })
        if (current.zoneId)
          zones.set(domain, current.zoneId)
        return
      }

      const zoneId = await ctx.cloudflare.zoneIdFor(domain)
      zones.set(domain, zoneId)
      if (!dryRun)
        await r2.ensureCustomDomain(name, { domain, zoneId, minTLS: wantedTls }, scope, attached)
      changed(`custom domain ${domain} attached`, `attach custom domain ${domain}`)
      // Freshly attached domains still have ownership and the edge
      // certificate to validate, which takes a minute or two.
      summary.domains.push({ domain, status: dryRun ? 'not attached' : 'pending' })
    }, () => summary.domains.push({ domain, status: 'error' }))
  }

  if (bucket.cache && domains.length > 0)
    await reconcileCacheRule(bucket, domains.map(entry => entry.domain).filter(domain => ctx.claimed.get(domain) === name), zones, ctx, changed)
}

/**
 * Write the bucket's cache rule into each zone its custom domains live in.
 *
 * One rule per zone, scoped to that zone's hosts with {@link hostCondition} so
 * it never affects another hostname, and tagged with the managed prefix so
 * {@link CloudflareProvider.putManagedPhaseRules} merges it in place of the
 * last one instead of clobbering the zone's other cache rules.
 */
async function reconcileCacheRule(
  bucket: R2BucketConfig,
  hosts: string[],
  zones: Map<string, string>,
  ctx: BucketContext,
  changed: (done: string, planned: string) => void,
): Promise<void> {
  const parameters = cacheRuleParameters(bucket.cache!)
  if (!parameters || hosts.length === 0)
    return

  // Group by zone: a phase entrypoint is per zone, and one write per zone keeps
  // the rule count down on plans that cap it.
  const byZone = new Map<string, string[]>()
  for (const host of hosts) {
    let zoneId = zones.get(host)
    if (!zoneId) {
      try {
        zoneId = await ctx.cloudflare.zoneIdFor(host)
      }
      catch (error) {
        ctx.warnings.push(`R2: could not resolve the zone for ${host}, cache rule skipped: ${messageOf(error)}`)
        continue
      }
    }
    byZone.set(zoneId, [...(byZone.get(zoneId) ?? []), host])
  }

  for (const zoneHosts of byZone.values()) {
    const rule: CloudflareRule = {
      action: 'set_cache_settings',
      description: `${CLOUDFLARE_MANAGED_RULE_PREFIX} ${R2_CACHE_RULE_DESCRIPTION}`,
      expression: `(${hostCondition(zoneHosts)})`,
      enabled: true,
      action_parameters: parameters,
    }

    await step(ctx, `cache rule for ${zoneHosts.join(', ')}`, async () => {
      const existing = await ctx.cloudflare.getPhaseRules(zoneHosts[0]!, 'http_request_cache_settings')
      if (managedRuleInSync(existing, rule))
        return
      if (!ctx.dryRun) {
        const result = await ctx.cloudflare.putManagedPhaseRules(zoneHosts[0]!, 'http_request_cache_settings', [rule])
        if (!result.success)
          throw new Error(result.message || 'cache rule write failed')
      }
      changed(`cache rule updated for ${zoneHosts.join(', ')}`, `update cache rule for ${zoneHosts.join(', ')}`)
    })
  }
}

/** `action_parameters` for a `set_cache_settings` rule, or null when nothing is set. */
export function cacheRuleParameters(cache: NonNullable<R2BucketConfig['cache']>): Record<string, unknown> | null {
  if (cache.edgeTtl === undefined && cache.browserTtl === undefined)
    return null
  const parameters: Record<string, unknown> = { cache: true }
  if (cache.edgeTtl !== undefined)
    parameters.edge_ttl = { mode: 'override_origin', default: cache.edgeTtl }
  if (cache.browserTtl !== undefined)
    parameters.browser_ttl = { mode: 'override_origin', default: cache.browserTtl }
  return parameters
}

/**
 * Is `rule` already in effect in `existing`, so a PUT would change nothing?
 *
 * Not a plain equality check, because of how the managed merge stores rules:
 * rules with identical behaviour from different projects are folded into one
 * rule over the union of their hosts. So the rule is in sync when some managed
 * rule behaves identically and covers all of its hosts, and no OTHER managed
 * rule still claims any of them (which the merge would strip on write).
 */
export function managedRuleInSync(existing: CloudflareRule[], rule: CloudflareRule): boolean {
  const hosts = hostsInExpression(rule.expression)
  const shape = expressionShape(rule.expression)
  const isManaged = (candidate: CloudflareRule): boolean =>
    (candidate.description || '').startsWith(CLOUDFLARE_MANAGED_RULE_PREFIX)
  const sameBehaviour = (candidate: CloudflareRule): boolean =>
    candidate.action === rule.action
    && candidate.description === rule.description
    && (candidate.enabled ?? true) === (rule.enabled ?? true)
    && expressionShape(candidate.expression) === shape
    && stableJson(candidate.action_parameters) === stableJson(rule.action_parameters)

  let covered = false
  for (const candidate of existing) {
    if (!isManaged(candidate))
      continue
    const candidateHosts = hostsInExpression(candidate.expression)
    const overlaps = hosts.some(host => candidateHosts.includes(host))
    if (!overlaps)
      continue
    if (sameBehaviour(candidate) && hosts.every(host => candidateHosts.includes(host)) && !covered) {
      covered = true
      continue
    }
    return false
  }
  return covered
}

/** Config lifecycle rule (flat) to the API's nested transition shape. */
export function toApiLifecycleRule(rule: R2LifecycleRule): R2ApiLifecycleRule {
  const api: R2ApiLifecycleRule = {
    id: rule.id,
    enabled: rule.enabled ?? true,
    conditions: { prefix: rule.prefix ?? '' },
  }
  if (rule.expireAfterDays !== undefined)
    api.deleteObjectsTransition = { condition: { type: 'Age', maxAge: daysToSeconds(rule.expireAfterDays) } }
  else if (rule.expireOn !== undefined)
    api.deleteObjectsTransition = { condition: { type: 'Date', date: rule.expireOn } }
  if (rule.abortMultipartUploadsAfterDays !== undefined)
    api.abortMultipartUploadsTransition = { condition: { type: 'Age', maxAge: daysToSeconds(rule.abortMultipartUploadsAfterDays) } }
  if (rule.infrequentAccessAfterDays !== undefined) {
    api.storageClassTransitions = [{
      storageClass: 'InfrequentAccess',
      condition: { type: 'Age', maxAge: daysToSeconds(rule.infrequentAccessAfterDays) },
    }]
  }
  return api
}

/** The lifecycle API counts `maxAge` in seconds, not days. */
function daysToSeconds(days: number): number {
  return Math.round(days * 86_400)
}

/** Declared custom domains as `{ domain, minTLS }`, lowercased and de-duplicated. */
function normalizeDomains(domains: R2BucketConfig['customDomains']): Array<{ domain: string, minTLS?: R2MinTls }> {
  const seen = new Set<string>()
  const result: Array<{ domain: string, minTLS?: R2MinTls }> = []
  for (const entry of domains ?? []) {
    const value = typeof entry === 'string' ? { domain: entry } : entry
    const domain = value.domain?.trim().replace(/\.$/, '').toLowerCase()
    if (!domain || seen.has(domain))
      continue
    seen.add(domain)
    result.push({ domain, minTLS: value.minTLS })
  }
  return result
}

/**
 * One status word for a custom domain: `active` once both ownership and the
 * edge certificate are, the failing state when either has failed, otherwise
 * `pending`.
 */
export function domainStatus(domain: R2CustomDomain): string {
  if (!domain.enabled)
    return 'disabled'
  const ownership = domain.status?.ownership
  const ssl = domain.status?.ssl
  if (ownership === 'active' && ssl === 'active')
    return 'active'
  for (const state of [ownership, ssl]) {
    if (state === 'error' || state === 'blocked' || state === 'deactivated')
      return state
  }
  return 'pending'
}

/**
 * Run one reconcile step, turning its failure into a warning.
 *
 * A disabled account is the exception: it is the same answer for every step,
 * so it propagates rather than producing one identical warning per step.
 */
async function step(
  ctx: BucketContext,
  label: string,
  run: () => Promise<void>,
  onError?: () => void,
): Promise<void> {
  try {
    await run()
  }
  catch (error) {
    if (error instanceof R2NotEnabledError)
      throw error
    ctx.warnings.push(`R2: ${label} failed: ${messageOf(error)}`)
    onError?.()
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    return `{${entries.sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
