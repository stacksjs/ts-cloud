/**
 * Cloudflare R2, through Cloudflare's account REST API.
 *
 * R2 has two front doors and they are easy to confuse:
 *
 *  - **The S3-compatible endpoint** (`https://{account}.r2.cloudflarestorage.com`)
 *    reads and writes objects. It speaks SigV4 with an access key pair, and is
 *    what an application uses at runtime; see {@link r2S3Credentials}.
 *  - **The account API** (`/accounts/{id}/r2/...`) manages the buckets
 *    themselves: creation, CORS, lifecycle, custom domains, the `r2.dev` URL.
 *    It takes the account API token directly, as a Bearer token.
 *
 * This module is the second one. It mirrors {@link CloudflarePagesProvider}:
 * account-scoped, a thin authenticated `request`, and one method per API
 * concern. The `ensure*` methods read before they write, so a deploy that runs
 * them on every release only touches what actually drifted.
 */
import type { R2CorsRule, R2Jurisdiction, R2LocationHint, R2MinTls } from '@ts-cloud/core'
import { createHash } from 'node:crypto'

const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4'

/**
 * Cloudflare's answer when the account has never turned R2 on.
 *
 * R2 has to be enabled once, by a human, in the dashboard (it asks for a
 * payment method even on the free tier), and no API call can do it. Every R2
 * endpoint then fails with this code, which reads like a permissions problem
 * unless it is called out.
 */
export const R2_NOT_ENABLED_ERROR_CODE = 10042

/** Cloudflare's code for "the specified bucket does not exist". */
const BUCKET_NOT_FOUND_CODE = 10006

/** Cloudflare's code for "the CORS configuration does not exist". */
const CORS_NOT_FOUND_CODE = 10059

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

interface CloudflareApiResponse<T> {
  success: boolean
  errors: Array<{ code: number, message: string }>
  messages: unknown[]
  result: T
  result_info?: { cursor?: string, per_page?: number }
}

/** A failed call to the R2 account API, with Cloudflare's error codes kept. */
export class R2ApiError extends Error {
  readonly status: number
  readonly errors: Array<{ code: number, message: string }>

  constructor(message: string, status: number, errors: Array<{ code: number, message: string }> = []) {
    super(message)
    this.name = 'R2ApiError'
    this.status = status
    this.errors = errors
  }

  /** Whether Cloudflare reported this error code. */
  hasCode(code: number): boolean {
    return this.errors.some(error => error.code === code)
  }
}

/**
 * R2 is not enabled on the account. Only fixable in the dashboard.
 *
 * Thrown in place of the raw API error so a deploy can print one sentence the
 * operator can act on, rather than "Cloudflare API error: 10042".
 */
export class R2NotEnabledError extends R2ApiError {
  readonly accountId: string

  constructor(accountId: string, status: number, errors: Array<{ code: number, message: string }> = []) {
    super(
      `R2 is not enabled on Cloudflare account ${accountId}. Enable it once in the Cloudflare dashboard `
      + `(R2 Object Storage, then follow the prompt to activate it), then re-run the deploy.`,
      status,
      errors,
    )
    this.name = 'R2NotEnabledError'
    this.accountId = accountId
  }
}

export interface R2Bucket {
  name: string
  creation_date?: string
  location?: R2LocationHint
  jurisdiction?: R2Jurisdiction
  storage_class?: 'Standard' | 'InfrequentAccess'
}

/** A lifecycle rule as the API stores it (nested transitions). */
export interface R2ApiLifecycleRule {
  id: string
  enabled: boolean
  conditions: { prefix: string }
  deleteObjectsTransition?: { condition: { type: 'Age', maxAge: number } | { type: 'Date', date: string } }
  abortMultipartUploadsTransition?: { condition: { type: 'Age', maxAge: number } }
  storageClassTransitions?: Array<{
    storageClass: 'InfrequentAccess'
    condition: { type: 'Age', maxAge: number } | { type: 'Date', date: string }
  }>
}

/** A custom domain attached to a bucket, as the list endpoint returns it. */
export interface R2CustomDomain {
  domain: string
  enabled: boolean
  zoneId?: string
  zoneName?: string
  minTLS?: R2MinTls
  ciphers?: string[]
  status?: {
    ownership?: 'pending' | 'active' | 'deactivated' | 'blocked' | 'error' | 'unknown'
    ssl?: 'initializing' | 'pending' | 'active' | 'deactivated' | 'error' | 'unknown'
  }
}

/** The bucket's `*.r2.dev` URL and whether it serves. */
export interface R2ManagedDomain {
  bucketId?: string
  domain: string
  enabled: boolean
}

export interface R2ProviderOptions {
  /** Account API token with `Workers R2 Storage: Edit`. */
  apiToken: string
  /** Account the buckets live under. */
  accountId: string
  /** Override `fetch`, for tests. */
  fetch?: FetchLike
}

/** Options shared by every bucket-scoped call. */
export interface R2BucketScope {
  /**
   * The bucket's jurisdiction. A bucket created in `eu` (or any non-default
   * jurisdiction) does not exist as far as a request without the matching
   * header is concerned: it 404s rather than erroring helpfully.
   */
  jurisdiction?: R2Jurisdiction
}

/**
 * Cloudflare R2 bucket management, scoped to one account.
 */
export class R2Provider {
  readonly name = 'cloudflare-r2'
  private readonly apiToken: string
  private readonly accountId: string
  private readonly fetchImpl: FetchLike

  constructor(options: R2ProviderOptions) {
    if (!options.apiToken)
      throw new Error('Cloudflare R2 needs an API token')
    if (!options.accountId)
      throw new Error('Cloudflare R2 needs an account id')

    this.apiToken = options.apiToken
    this.accountId = options.accountId
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
  }

  /**
   * Make an authenticated request against the account-scoped R2 API.
   *
   * @param method - HTTP method
   * @param endpoint - Path below `/accounts/{id}/r2`, starting with a slash
   * @param body - JSON body
   * @param scope - Jurisdiction header, when the bucket has one
   * @returns The whole envelope, so list calls can read the cursor
   * @throws {R2NotEnabledError} When R2 has never been enabled on the account
   * @throws {R2ApiError} When Cloudflare reports any other failure
   */
  private async requestEnvelope<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    scope: R2BucketScope = {},
  ): Promise<CloudflareApiResponse<T>> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiToken}` }
    if (body !== undefined)
      headers['Content-Type'] = 'application/json'
    // `default` is what no header means; sending it anyway is harmless but
    // noisy in request logs, so only non-default jurisdictions are sent.
    if (scope.jurisdiction && scope.jurisdiction !== 'default')
      headers['cf-r2-jurisdiction'] = scope.jurisdiction

    const response = await this.fetchImpl(`${CLOUDFLARE_API_URL}/accounts/${this.accountId}/r2${endpoint}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    const text = await response.text()
    let data: CloudflareApiResponse<T>
    try {
      data = JSON.parse(text) as CloudflareApiResponse<T>
    }
    catch {
      throw new R2ApiError(
        `Cloudflare R2 API returned ${response.status} with a non-JSON body: ${text.slice(0, 200)}`,
        response.status,
      )
    }

    if (!data.success) {
      const errors = data.errors ?? []
      if (errors.some(error => error.code === R2_NOT_ENABLED_ERROR_CODE))
        throw new R2NotEnabledError(this.accountId, response.status, errors)

      const detail = errors.map(error => `${error.code}: ${error.message}`).join(', ')
      throw new R2ApiError(
        `Cloudflare R2 API error (${response.status}) on ${method} ${endpoint}: ${detail || text.slice(0, 200)}`,
        response.status,
        errors,
      )
    }

    return data
  }

  private async request<T>(method: string, endpoint: string, body?: unknown, scope?: R2BucketScope): Promise<T> {
    return (await this.requestEnvelope<T>(method, endpoint, body, scope)).result
  }

  /** Path of one bucket, with the name escaped. */
  private bucketPath(bucket: string): string {
    return `/buckets/${encodeURIComponent(bucket)}`
  }

  /**
   * Every bucket in the account (in the default jurisdiction, or in `scope`'s).
   *
   * Follows the cursor, so an account with more buckets than one page still
   * answers completely.
   */
  async listBuckets(scope: R2BucketScope = {}): Promise<R2Bucket[]> {
    const buckets: R2Bucket[] = []
    let cursor: string | undefined
    do {
      const query = new URLSearchParams({ per_page: '1000' })
      if (cursor)
        query.set('cursor', cursor)
      const page = await this.requestEnvelope<{ buckets?: R2Bucket[] }>('GET', `/buckets?${query}`, undefined, scope)
      const batch = page.result?.buckets ?? []
      buckets.push(...batch)
      // An empty page with a cursor would loop forever; stop on either signal.
      cursor = batch.length > 0 ? page.result_info?.cursor || undefined : undefined
    } while (cursor)
    return buckets
  }

  /**
   * Look up a bucket by name.
   *
   * @returns The bucket, or `null` when it does not exist
   */
  async getBucket(name: string, scope: R2BucketScope = {}): Promise<R2Bucket | null> {
    try {
      return await this.request<R2Bucket>('GET', this.bucketPath(name), undefined, scope)
    }
    catch (error) {
      // A missing bucket is an expected answer to "does this exist", not a
      // fault. A disabled account is not, so R2NotEnabledError passes through.
      if (error instanceof R2NotEnabledError)
        throw error
      if (error instanceof R2ApiError && (error.hasCode(BUCKET_NOT_FOUND_CODE) || error.status === 404))
        return null
      throw error
    }
  }

  /**
   * Create a bucket, or return the existing one.
   *
   * The location hint and jurisdiction only matter at creation: R2 cannot move
   * a bucket, so an existing bucket is returned as-is even if they differ.
   *
   * @returns The bucket, and whether this call is what created it
   */
  async ensureBucket(
    name: string,
    options: { locationHint?: R2LocationHint, jurisdiction?: R2Jurisdiction } = {},
  ): Promise<{ bucket: R2Bucket, created: boolean }> {
    const scope = { jurisdiction: options.jurisdiction }
    const existing = await this.getBucket(name, scope)
    if (existing)
      return { bucket: existing, created: false }

    const body: Record<string, string> = { name }
    if (options.locationHint)
      body.locationHint = options.locationHint
    const bucket = await this.request<R2Bucket>('POST', '/buckets', body, scope)
    return { bucket: { ...bucket, name: bucket?.name || name }, created: true }
  }

  /**
   * The bucket's CORS rules. A bucket that never had a policy answers with an
   * error rather than an empty list; that is reported as `[]`.
   */
  async getCors(bucket: string, scope: R2BucketScope = {}): Promise<R2CorsRule[]> {
    try {
      const result = await this.request<{ rules?: R2CorsRule[] }>('GET', `${this.bucketPath(bucket)}/cors`, undefined, scope)
      return result?.rules ?? []
    }
    catch (error) {
      if (error instanceof R2ApiError && !(error instanceof R2NotEnabledError)
        && (error.hasCode(CORS_NOT_FOUND_CODE) || error.status === 404)) {
        return []
      }
      throw error
    }
  }

  /**
   * Replace the bucket's CORS rules. An empty list deletes the policy, since
   * that is the only way the API expresses "no CORS".
   */
  async putCors(bucket: string, rules: R2CorsRule[], scope: R2BucketScope = {}): Promise<void> {
    if (rules.length === 0) {
      await this.request('DELETE', `${this.bucketPath(bucket)}/cors`, undefined, scope)
      return
    }
    await this.request('PUT', `${this.bucketPath(bucket)}/cors`, { rules }, scope)
  }

  /**
   * Set CORS only when it differs from what is there.
   *
   * @returns Whether anything was written
   */
  async ensureCors(bucket: string, rules: R2CorsRule[], scope: R2BucketScope = {}): Promise<boolean> {
    const current = await this.getCors(bucket, scope)
    if (sameCorsRules(current, rules))
      return false
    await this.putCors(bucket, rules, scope)
    return true
  }

  /** The bucket's lifecycle rules. */
  async getLifecycle(bucket: string, scope: R2BucketScope = {}): Promise<R2ApiLifecycleRule[]> {
    const result = await this.request<{ rules?: R2ApiLifecycleRule[] }>(
      'GET',
      `${this.bucketPath(bucket)}/lifecycle`,
      undefined,
      scope,
    )
    return result?.rules ?? []
  }

  /** Replace the bucket's lifecycle rules wholesale. */
  async putLifecycle(bucket: string, rules: R2ApiLifecycleRule[], scope: R2BucketScope = {}): Promise<void> {
    await this.request('PUT', `${this.bucketPath(bucket)}/lifecycle`, { rules }, scope)
  }

  /**
   * Set lifecycle rules only when they differ from what is there.
   *
   * @returns Whether anything was written
   */
  async ensureLifecycle(bucket: string, rules: R2ApiLifecycleRule[], scope: R2BucketScope = {}): Promise<boolean> {
    const current = await this.getLifecycle(bucket, scope)
    if (sameLifecycleRules(current, rules))
      return false
    await this.putLifecycle(bucket, rules, scope)
    return true
  }

  /** Custom domains attached to the bucket. */
  async listCustomDomains(bucket: string, scope: R2BucketScope = {}): Promise<R2CustomDomain[]> {
    const result = await this.request<{ domains?: R2CustomDomain[] }>(
      'GET',
      `${this.bucketPath(bucket)}/domains/custom`,
      undefined,
      scope,
    )
    return result?.domains ?? []
  }

  /**
   * Attach a custom domain.
   *
   * Cloudflare creates the proxied DNS record for the hostname itself, and
   * refuses when the hostname already has a record: that record has to go
   * first. This is the raw create; {@link ensureCustomDomain} is the
   * idempotent form.
   */
  async attachCustomDomain(
    bucket: string,
    options: { domain: string, zoneId: string, enabled?: boolean, minTLS?: R2MinTls },
    scope: R2BucketScope = {},
  ): Promise<R2CustomDomain> {
    return this.request<R2CustomDomain>('POST', `${this.bucketPath(bucket)}/domains/custom`, {
      domain: options.domain,
      zoneId: options.zoneId,
      enabled: options.enabled ?? true,
      minTLS: options.minTLS ?? '1.2',
    }, scope)
  }

  /** Change an attached domain's `enabled` or `minTLS`. */
  async updateCustomDomain(
    bucket: string,
    domain: string,
    changes: { enabled?: boolean, minTLS?: R2MinTls },
    scope: R2BucketScope = {},
  ): Promise<R2CustomDomain> {
    return this.request<R2CustomDomain>(
      'PUT',
      `${this.bucketPath(bucket)}/domains/custom/${encodeURIComponent(domain)}`,
      changes,
      scope,
    )
  }

  /**
   * Attach a domain if it is missing, or bring an attached one back to enabled
   * with the requested minimum TLS.
   *
   * @param existing - The bucket's current domains, when the caller already
   * listed them (saves a request per domain)
   * @returns What happened, and the domain's state afterwards
   */
  async ensureCustomDomain(
    bucket: string,
    options: { domain: string, zoneId: string, minTLS?: R2MinTls },
    scope: R2BucketScope = {},
    existing?: R2CustomDomain[],
  ): Promise<{ action: 'attached' | 'updated' | 'unchanged', domain: R2CustomDomain }> {
    const minTLS = options.minTLS ?? '1.2'
    const domains = existing ?? await this.listCustomDomains(bucket, scope)
    const current = domains.find(entry => entry.domain.toLowerCase() === options.domain.toLowerCase())

    if (!current) {
      const attached = await this.attachCustomDomain(bucket, { ...options, minTLS, enabled: true }, scope)
      return { action: 'attached', domain: { ...attached, domain: attached?.domain || options.domain } }
    }

    // An unset minTLS on the server means Cloudflare's default (1.0), so it
    // only counts as matching when 1.0 is what was asked for.
    const currentMinTls = current.minTLS ?? '1.0'
    if (current.enabled && currentMinTls === minTLS)
      return { action: 'unchanged', domain: current }

    const updated = await this.updateCustomDomain(bucket, current.domain, { enabled: true, minTLS }, scope)
    return { action: 'updated', domain: { ...current, ...updated } }
  }

  /** The bucket's `*.r2.dev` URL and whether it is serving. */
  async getManagedDomain(bucket: string, scope: R2BucketScope = {}): Promise<R2ManagedDomain> {
    return this.request<R2ManagedDomain>('GET', `${this.bucketPath(bucket)}/domains/managed`, undefined, scope)
  }

  /**
   * Turn the bucket's public `*.r2.dev` URL on or off, only writing when it
   * differs.
   *
   * @returns Whether anything was written, and the domain's state afterwards
   */
  async setManagedDomain(
    bucket: string,
    enabled: boolean,
    scope: R2BucketScope = {},
  ): Promise<{ changed: boolean, domain: R2ManagedDomain }> {
    const current = await this.getManagedDomain(bucket, scope)
    if (current?.enabled === enabled)
      return { changed: false, domain: current }

    const domain = await this.request<R2ManagedDomain>(
      'PUT',
      `${this.bucketPath(bucket)}/domains/managed`,
      { enabled },
      scope,
    )
    return { changed: true, domain }
  }
}

/** S3-compatible endpoint for an account's R2 buckets. */
export function r2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`
}

export interface R2S3Credentials {
  accessKeyId: string
  secretAccessKey: string
  /** `https://{accountId}.r2.cloudflarestorage.com` */
  endpoint: string
  /** R2 ignores the region; SigV4 still needs one, and `auto` is what R2 documents. */
  region: 'auto'
}

/**
 * Derive S3-compatible credentials from a Cloudflare API token.
 *
 * Cloudflare documents this mapping instead of issuing a separate key pair:
 * the Access Key ID is the token's **id**, and the Secret Access Key is the
 * SHA-256 of the token's **value**, as lowercase hex. The id is not part of
 * the token string, so it has to be asked for.
 *
 * The token's id is read from the account-scoped verify endpoint first. That
 * order matters: an account-owned token answers 401 at `/user/tokens/verify`,
 * which looks exactly like a revoked token. The user endpoint is tried second
 * so a user-owned token still works.
 *
 * The token needs R2 permissions for the derived keys to be any use; that is
 * not checked here, because the S3 endpoint will say so on first use.
 *
 * @throws {Error} When neither verify endpoint accepts the token
 */
export async function r2S3Credentials(options: {
  apiToken: string
  accountId: string
  fetch?: FetchLike
}): Promise<R2S3Credentials> {
  const { apiToken, accountId } = options
  if (!apiToken)
    throw new Error('r2S3Credentials needs an API token')
  if (!accountId)
    throw new Error('r2S3Credentials needs an account id')

  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init))
  const failures: string[] = []
  let tokenId: string | undefined

  for (const path of [`/accounts/${accountId}/tokens/verify`, '/user/tokens/verify']) {
    const response = await fetchImpl(`${CLOUDFLARE_API_URL}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiToken}` },
    })
    const data = await response.json().catch(() => null) as CloudflareApiResponse<{ id?: string, status?: string }> | null
    if (response.ok && data?.success && data.result?.id) {
      tokenId = data.result.id
      break
    }
    const detail = data?.errors?.map(error => `${error.code}: ${error.message}`).join(', ')
    failures.push(`${path} -> ${response.status}${detail ? ` (${detail})` : ''}`)
  }

  if (!tokenId)
    throw new Error(`Could not verify the Cloudflare API token to derive R2 credentials: ${failures.join('; ')}`)

  return {
    accessKeyId: tokenId,
    secretAccessKey: createHash('sha256').update(apiToken).digest('hex'),
    endpoint: r2Endpoint(accountId),
    region: 'auto',
  }
}

/**
 * JSON with sorted keys and no `undefined`, so two values that mean the same
 * thing serialize the same regardless of key order.
 */
function stableJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    return `{${entries.sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** A CORS rule reduced to what it means: sets compared as sets, empty lists as absent. */
function normalizeCorsRule(rule: R2CorsRule, keepId: boolean): unknown {
  const sorted = (values?: string[]): string[] | undefined =>
    values && values.length > 0 ? [...values].map(String).sort() : undefined
  return {
    id: keepId ? rule.id : undefined,
    allowed: {
      origins: sorted(rule.allowed?.origins),
      methods: sorted(rule.allowed?.methods?.map(method => method.toUpperCase())),
      headers: sorted(rule.allowed?.headers?.map(header => header.toLowerCase())),
    },
    exposeHeaders: sorted(rule.exposeHeaders?.map(header => header.toLowerCase())),
    maxAgeSeconds: rule.maxAgeSeconds,
  }
}

/**
 * Do two CORS policies say the same thing?
 *
 * Rule order is kept (R2 uses the first rule that matches a request), but the
 * values inside a rule are compared as sets. Ids are only compared when the
 * desired side sets them, since the API may assign its own.
 */
export function sameCorsRules(current: R2CorsRule[], desired: R2CorsRule[]): boolean {
  if (current.length !== desired.length)
    return false
  return desired.every((rule, index) => {
    const keepId = rule.id !== undefined
    return stableJson(normalizeCorsRule(current[index]!, keepId)) === stableJson(normalizeCorsRule(rule, keepId))
  })
}

/** Do two lifecycle rule lists say the same thing? Order-insensitive, keyed by id. */
export function sameLifecycleRules(current: R2ApiLifecycleRule[], desired: R2ApiLifecycleRule[]): boolean {
  if (current.length !== desired.length)
    return false
  const normalize = (rules: R2ApiLifecycleRule[]): string =>
    stableJson([...rules]
      .map(rule => ({
        ...rule,
        storageClassTransitions: rule.storageClassTransitions?.length ? rule.storageClassTransitions : undefined,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)))
  return normalize(current) === normalize(desired)
}
