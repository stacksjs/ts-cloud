/**
 * Make the Cloudflare Workers a config declares exist, run the declared code,
 * and serve their declared hostnames.
 *
 * Runs on every deploy, so it is a reconcile rather than a create. Per Worker:
 * bundle the entry (always, locally: the bundle is what the content hash is
 * taken over), upload only when the hash differs from the deployed one, then
 * attach each custom domain that is not already attached to it.
 *
 * What is NOT done, deliberately:
 *
 *  - Nothing is deleted or detached. A Worker or hostname dropped from config
 *    stays where it is, because removing either takes a URL down.
 *  - A hostname that something else already serves (an R2 bucket's custom
 *    domain, another Worker, an ordinary DNS record) is never taken over. The
 *    deploy warns with what is in the way and how to remove it, and moves on.
 *    Attaching anyway would either fail at Cloudflare or silently move traffic.
 */
import type { R2Config, R2Jurisdiction, WorkerConfig } from '@ts-cloud/core'
import type { WorkerBinding, WorkerCustomDomain, WorkerUpload } from './provider'
import { isAbsolute, resolve } from 'node:path'
import { CloudflareProvider } from '../dns/cloudflare'
import { R2Provider } from '../r2/provider'
import { bundleWorker } from './bundle'
import {
  CONTENT_HASH_BINDING,
  DEFAULT_COMPATIBILITY_DATE,
  workerContentHash,
  workerInSync,
  WorkersProvider,
} from './provider'

const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4'

/** What a deploy needs to know about one Worker after the reconcile. */
export interface WorkerSummary {
  /** Script name in Cloudflare. */
  name: string
  /**
   * Human-readable changes, e.g. `bundled 12.3 KB`, `uploaded`, `unchanged`,
   * `custom domain tiles.example.com attached`. In a dry run the writes start
   * with `would`.
   */
  changes: string[]
  /**
   * Every declared custom domain and its state: `active` (already attached),
   * `pending` (just attached, certificate still issuing), `not attached` (dry
   * run), `conflict` (something else serves it) or `error`.
   */
  domains: Array<{ domain: string, status?: string }>
}

export interface WorkersReconcileSummary {
  workers: WorkerSummary[]
  /** Problems that did not stop the reconcile: a hostname something else serves, a domain that would not attach. */
  warnings: string[]
}

export interface ReconcileCloudflareWorkersOptions {
  /** Account API token with `Workers Scripts: Edit` (plus `Workers Routes: Edit` and `Zone: Read` for custom domains). */
  apiToken?: string
  /** Account the Workers live under. */
  accountId?: string
  /** Directory `entry` paths are relative to. @default process.cwd() */
  projectRoot?: string
  /**
   * Zone id to use for custom domains inside that zone. Domains outside it,
   * or every domain when this is unset, have their zone looked up by apex.
   */
  zoneId?: string
  /** Progress lines. */
  log?: (message: string) => void
  /** Bundle and read everything, write nothing, and report what would change. */
  dryRun?: boolean
  /** Override `fetch` for the Workers, R2 and DNS lookups, for tests. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
}

/** Anything carrying a `workers` block (and optionally `r2`), at the top level or under `infrastructure`. */
export interface WorkersConfigSource {
  infrastructure?: { workers?: Record<string, WorkerConfig>, r2?: R2Config }
  workers?: Record<string, WorkerConfig>
  r2?: R2Config
}

/** Cloudflare's script naming rule. Checked up front so a typo fails with a reason, not a 400. */
const SCRIPT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/

/**
 * Reconcile every Worker in `config`'s `workers` block.
 *
 * Skips cleanly (logs and returns an empty summary) when there is no
 * `workers` block, and when the token or account id is missing (with a
 * warning, since a declared Worker that silently never deploys is the worst
 * outcome).
 *
 * A Worker whose entry will not bundle, or whose upload fails (including for
 * a missing token permission, reported as a `WorkersPermissionError`), throws:
 * the release may depend on it. Custom-domain problems are warnings.
 */
export async function reconcileCloudflareWorkers(
  config: WorkersConfigSource,
  options: ReconcileCloudflareWorkersOptions = {},
): Promise<WorkersReconcileSummary> {
  const log = options.log ?? (() => {})
  const summary: WorkersReconcileSummary = { workers: [], warnings: [] }

  const declared = Object.entries(config.infrastructure?.workers ?? config.workers ?? {})
  if (declared.length === 0) {
    log('Workers: none declared, skipping.')
    return summary
  }

  if (!options.apiToken || !options.accountId) {
    const missing = [!options.apiToken && 'CLOUDFLARE_API_TOKEN', !options.accountId && 'CLOUDFLARE_ACCOUNT_ID'].filter(Boolean).join(' and ')
    const message = `Workers: ${declared.length} Worker(s) declared but ${missing} is not set, skipping.`
    log(message)
    summary.warnings.push(message)
    return summary
  }

  const r2 = config.infrastructure?.r2 ?? config.r2
  const ctx: ReconcileContext = {
    workers: new WorkersProvider({ apiToken: options.apiToken, accountId: options.accountId, fetch: options.fetch }),
    r2: new R2Provider({ apiToken: options.apiToken, accountId: options.accountId, fetch: options.fetch }),
    cloudflare: new CloudflareProvider(options.apiToken, { zoneId: options.zoneId, accountId: options.accountId }),
    apiToken: options.apiToken,
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    projectRoot: options.projectRoot ?? process.cwd(),
    dryRun: options.dryRun === true,
    warnings: summary.warnings,
    log,
    r2ConfigDomains: r2ConfigDomains(r2),
    r2Buckets: r2,
    claimed: new Map(),
  }

  for (const [key, worker] of declared) {
    const name = worker?.name
    if (!name || !SCRIPT_NAME.test(name)) {
      summary.warnings.push(
        `Workers: '${key}' has an invalid name '${name ?? ''}' (1-63 chars: lowercase letters, digits, '-' and '_'), skipping.`,
      )
      continue
    }
    if (!worker.entry) {
      summary.warnings.push(`Workers: ${name} has no entry, skipping.`)
      continue
    }

    log(`Workers: ${ctx.dryRun ? 'checking' : 'reconciling'} ${name}...`)
    const workerSummary: WorkerSummary = { name, changes: [], domains: [] }
    summary.workers.push(workerSummary)

    await reconcileWorker(worker, workerSummary, ctx)
    for (const change of workerSummary.changes) log(`Workers: ${name}: ${change}`)
  }

  return summary
}

interface ReconcileContext {
  workers: WorkersProvider
  r2: R2Provider
  cloudflare: CloudflareProvider
  apiToken: string
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  projectRoot: string
  dryRun: boolean
  warnings: string[]
  log: (message: string) => void
  /** Hostname to bucket name, for custom domains the config's own `r2` block declares. */
  r2ConfigDomains: Map<string, string>
  r2Buckets?: R2Config
  /** Hostname to the Worker that claimed it first in this run. */
  claimed: Map<string, string>
  /** Every Worker custom domain on the account, listed once on first need. */
  attached?: WorkerCustomDomain[] | null
  /** Hostname to bucket name for every R2 custom domain on the account, scanned once on first need. */
  r2AccountDomains?: Map<string, string> | null
}

/** One Worker, start to finish. */
async function reconcileWorker(worker: WorkerConfig, summary: WorkerSummary, ctx: ReconcileContext): Promise<void> {
  const name = worker.name
  const entry = isAbsolute(worker.entry) ? worker.entry : resolve(ctx.projectRoot, worker.entry)

  // Bundling happens in a dry run too: it writes nothing remote, and the
  // bundle is what decides whether an upload is due.
  let bundle: Awaited<ReturnType<typeof bundleWorker>>
  try {
    bundle = await bundleWorker(entry)
  }
  catch (error) {
    throw new Error(`Worker ${name}: ${messageOf(error)}`)
  }
  summary.changes.push(`bundled ${formatSize(bundle.size)}`)

  const upload: WorkerUpload = {
    mainModule: bundle.name,
    modules: [{ name: bundle.name, content: bundle.content, type: bundle.type }],
    bindings: workerBindings(worker, ctx),
    compatibilityDate: worker.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
    compatibilityFlags: worker.compatibilityFlags ?? [],
  }

  // Script failures throw: the release may call this Worker, and a
  // permission error's message already names the missing permission.
  if (ctx.dryRun) {
    const current = await ctx.workers.getSettings(name)
    summary.changes.push(current && workerInSync(current, upload, workerContentHash(upload)) ? 'unchanged' : 'would upload')
  }
  else {
    const { action } = await ctx.workers.ensureModuleScript(name, upload)
    summary.changes.push(action === 'unchanged' ? 'unchanged' : 'uploaded')
  }

  for (const domain of normalizeDomains(worker.customDomains))
    await reconcileDomain(name, domain, summary, ctx)
}

/** One declared hostname on one Worker. */
async function reconcileDomain(name: string, domain: string, summary: WorkerSummary, ctx: ReconcileContext): Promise<void> {
  const report = (status: string): void => {
    summary.domains.push({ domain, status })
  }
  const conflict = (message: string): void => {
    ctx.warnings.push(`Workers: ${message}`)
    report('conflict')
  }

  const owner = ctx.claimed.get(domain)
  if (owner && owner !== name) {
    conflict(`${domain} is declared on both ${owner} and ${name}; leaving it on ${owner}.`)
    return
  }
  ctx.claimed.set(domain, name)

  // The config's own r2 block claims it: R2 reconciles first in a deploy, so
  // the bucket has (or is about to have) it. Caught without any API call.
  const configBucket = ctx.r2ConfigDomains.get(domain)
  if (configBucket) {
    conflict(
      `${domain} is also declared as a custom domain of the R2 bucket '${configBucket}' (r2.buckets). `
      + `A hostname serves either a bucket or a Worker. Remove it from the bucket's customDomains and detach it in the dashboard `
      + `(R2, ${configBucket}, Settings, Custom Domains) first; to serve the bucket through the Worker, bind it with bindings.r2Buckets instead.`,
    )
    return
  }

  const attached = await attachedDomains(ctx)
  if (attached === null) {
    report('error')
    return
  }

  const current = attached.find(entry => entry.hostname.toLowerCase() === domain)
  if (current?.service === name) {
    report('active')
    return
  }
  if (current) {
    conflict(
      `${domain} is attached to the Worker '${current.service}'. Detach it there first `
      + `(Workers & Pages, ${current.service}, Settings, Domains & Routes); it is not moved automatically.`,
    )
    return
  }

  // Not attached to any Worker yet. Before attaching, look for what else
  // might already answer for the hostname; Cloudflare would refuse the attach
  // with a less helpful message, or in the R2 case it is worth saying exactly
  // which bucket to detach it from.
  const bucket = (await r2AccountDomains(ctx))?.get(domain)
  if (bucket) {
    conflict(
      `${domain} is attached to the R2 bucket '${bucket}' as a custom domain. Detach it first `
      + `(R2, ${bucket}, Settings, Custom Domains, then re-run the deploy); it is not detached automatically. `
      + `To serve the bucket through the Worker, bind it with bindings.r2Buckets.`,
    )
    return
  }

  let zoneId: string
  try {
    zoneId = await ctx.cloudflare.zoneIdFor(domain)
  }
  catch (error) {
    ctx.warnings.push(`Workers: could not resolve the zone for ${domain}, not attached: ${messageOf(error)}`)
    report('error')
    return
  }

  const records = await dnsRecordsAt(ctx, zoneId, domain)
  if (records.length > 0) {
    const listed = records.map(record => `${record.type} ${record.content}`).join(', ')
    conflict(
      `${domain} already has a DNS record (${listed}). A Worker custom domain creates its own record, so Cloudflare will not attach over it. `
      + `Delete the record first (DNS, Records), then re-run the deploy; it is not deleted automatically.`,
    )
    return
  }

  if (ctx.dryRun) {
    summary.changes.push(`would attach custom domain ${domain}`)
    report('not attached')
    return
  }

  try {
    await ctx.workers.ensureCustomDomain(domain, { service: name, zoneId }, attached)
    summary.changes.push(`custom domain ${domain} attached`)
    // Keep the cached list current, so a later Worker claiming the same
    // hostname sees it as taken.
    attached.push({ id: '', hostname: domain, service: name, zone_id: zoneId })
    // Cloudflare still has to issue the edge certificate, which takes a
    // minute or two.
    report('pending')
  }
  catch (error) {
    ctx.warnings.push(`Workers: custom domain ${domain} on ${name} failed: ${messageOf(error)}`)
    report('error')
  }
}

/**
 * Every Worker custom domain in the account, listed once per reconcile.
 *
 * @returns `null` when the list cannot be read (with a warning, once), so the
 * domains are reported as errors rather than attached blind.
 */
async function attachedDomains(ctx: ReconcileContext): Promise<WorkerCustomDomain[] | null> {
  if (ctx.attached !== undefined)
    return ctx.attached
  try {
    ctx.attached = await ctx.workers.listCustomDomains()
  }
  catch (error) {
    ctx.warnings.push(`Workers: could not list Worker custom domains, none attached: ${messageOf(error)}`)
    ctx.attached = null
  }
  return ctx.attached
}

/**
 * Hostname to bucket for every R2 custom domain on the account, scanned once.
 *
 * Best effort: a token without R2 read cannot do this, and the DNS check and
 * Cloudflare's own refusal still stand behind it, so a failure is logged and
 * the scan is skipped. Only buckets in the default jurisdiction are listed,
 * plus any the config's r2 block names with another one.
 */
async function r2AccountDomains(ctx: ReconcileContext): Promise<Map<string, string> | null> {
  if (ctx.r2AccountDomains !== undefined)
    return ctx.r2AccountDomains
  const domains = new Map<string, string>()
  try {
    const buckets: Array<{ name: string, jurisdiction?: R2Jurisdiction }> = (await ctx.r2.listBuckets()).map(bucket => ({ name: bucket.name }))
    for (const bucket of Object.values(ctx.r2Buckets?.buckets ?? {})) {
      if (bucket.jurisdiction && bucket.jurisdiction !== 'default')
        buckets.push({ name: bucket.name, jurisdiction: bucket.jurisdiction })
    }
    for (const bucket of buckets) {
      const attached = await ctx.r2.listCustomDomains(bucket.name, { jurisdiction: bucket.jurisdiction }).catch(() => [])
      for (const entry of attached) domains.set(entry.domain.toLowerCase(), bucket.name)
    }
    ctx.r2AccountDomains = domains
  }
  catch (error) {
    ctx.log(`Workers: could not check R2 custom domains (${messageOf(error)}); relying on the DNS check.`)
    ctx.r2AccountDomains = null
  }
  return ctx.r2AccountDomains
}

/**
 * DNS records at exactly `hostname`. Best effort: a token without DNS read
 * gets an empty answer (logged), and Cloudflare's attach then decides.
 */
async function dnsRecordsAt(ctx: ReconcileContext, zoneId: string, hostname: string): Promise<Array<{ type: string, content: string }>> {
  try {
    const response = await ctx.fetch(
      `${CLOUDFLARE_API_URL}/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`,
      { method: 'GET', headers: { Authorization: `Bearer ${ctx.apiToken}` } },
    )
    const data = await response.json() as { success?: boolean, result?: Array<{ name?: string, type?: string, content?: string }> }
    if (!data?.success)
      throw new Error(`HTTP ${response.status}`)
    return (data.result ?? [])
      .filter(record => record.name?.toLowerCase() === hostname)
      .map(record => ({ type: record.type ?? '?', content: record.content ?? '' }))
  }
  catch (error) {
    ctx.log(`Workers: could not read DNS records for ${hostname} (${messageOf(error)}); attaching anyway.`)
    return []
  }
}

/**
 * Config bindings to the API's shape: R2 buckets (with the jurisdiction the
 * config's r2 block gives the bucket, if any) and plain-text vars.
 *
 * A name used twice, or the reserved content-hash name, is dropped with a
 * warning rather than letting the upload fail on it.
 */
export function workerBindings(worker: WorkerConfig, ctx: { warnings: string[], r2Buckets?: R2Config }): WorkerBinding[] {
  const bindings: WorkerBinding[] = []
  const seen = new Set<string>()
  const take = (binding: string): boolean => {
    if (binding === CONTENT_HASH_BINDING) {
      ctx.warnings.push(`Workers: ${worker.name}: binding name ${CONTENT_HASH_BINDING} is reserved for ts-cloud, ignored.`)
      return false
    }
    if (seen.has(binding)) {
      ctx.warnings.push(`Workers: ${worker.name}: binding ${binding} is declared twice; the first one wins.`)
      return false
    }
    seen.add(binding)
    return true
  }

  const jurisdictions = new Map<string, string>()
  for (const bucket of Object.values(ctx.r2Buckets?.buckets ?? {})) {
    if (bucket.jurisdiction && bucket.jurisdiction !== 'default')
      jurisdictions.set(bucket.name, bucket.jurisdiction)
  }

  for (const [binding, bucketName] of Object.entries(worker.bindings?.r2Buckets ?? {})) {
    if (!take(binding))
      continue
    const jurisdiction = jurisdictions.get(bucketName)
    bindings.push(jurisdiction
      ? { type: 'r2_bucket', name: binding, bucket_name: bucketName, jurisdiction }
      : { type: 'r2_bucket', name: binding, bucket_name: bucketName })
  }
  for (const [binding, text] of Object.entries(worker.bindings?.vars ?? {})) {
    if (take(binding))
      bindings.push({ type: 'plain_text', name: binding, text: String(text) })
  }
  return bindings
}

/** Hostname to bucket name for the custom domains the config's r2 block declares. */
function r2ConfigDomains(r2?: R2Config): Map<string, string> {
  const domains = new Map<string, string>()
  for (const bucket of Object.values(r2?.buckets ?? {})) {
    for (const entry of bucket?.customDomains ?? []) {
      const domain = normalizeHostname(typeof entry === 'string' ? entry : entry.domain)
      if (domain)
        domains.set(domain, bucket.name)
    }
  }
  return domains
}

/** Declared hostnames, lowercased, without a trailing dot, de-duplicated. */
function normalizeDomains(domains?: string[]): string[] {
  return [...new Set((domains ?? []).map(normalizeHostname).filter(Boolean))]
}

function normalizeHostname(domain?: string): string {
  return (domain ?? '').trim().replace(/\.$/, '').toLowerCase()
}

/** `123 B`, `12.3 KB`, `1.2 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
