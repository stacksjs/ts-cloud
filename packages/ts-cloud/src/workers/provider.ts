/**
 * Cloudflare Workers, through Cloudflare's account REST API.
 *
 * Two concerns live here, matching the two halves of a Worker deploy:
 *
 *  - **Scripts** (`/accounts/{id}/workers/scripts/{name}`). An ES module
 *    Worker is uploaded as `multipart/form-data`: one `metadata` part holding
 *    JSON (`main_module`, `bindings`, `compatibility_date`, ...), and one part
 *    per module, named by its file name and typed
 *    `application/javascript+module`. A PUT creates a new version and deploys
 *    it to 100% in one call, so there is no separate "publish" step.
 *  - **Custom domains** (`/accounts/{id}/workers/domains`). Account-scoped
 *    even though each hostname lives in a zone; Cloudflare creates the DNS
 *    record and the edge certificate itself when a hostname is attached.
 *
 * Mirrors {@link R2Provider}: account-scoped, a thin authenticated `request`,
 * typed errors, and `ensure*` methods that read before they write, so a deploy
 * that runs them on every release only touches what actually changed.
 *
 * ## Skipping unchanged uploads
 *
 * Cloudflare's script `etag` is computed server-side over its own encoding of
 * the upload, so it cannot be predicted from local bytes. Instead the upload
 * carries a `plain_text` binding, {@link CONTENT_HASH_BINDING}, holding a
 * SHA-256 over everything that goes into it (modules, bindings, compatibility
 * settings). `GET .../settings` returns plain-text bindings with their text,
 * so the next deploy compares hashes and skips the upload when they match. As
 * a side effect the running Worker can read `env.TS_CLOUD_CONTENT_HASH` to
 * tell which build is live.
 */
import { createHash } from 'node:crypto'

const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4'

/** Name of the `plain_text` binding that carries the upload's content hash. */
export const CONTENT_HASH_BINDING = 'TS_CLOUD_CONTENT_HASH'

/** Compatibility date used when a Worker does not set one. Fixed, so deploys are reproducible. */
export const DEFAULT_COMPATIBILITY_DATE = '2025-09-01'

/** MIME type Cloudflare requires on an ES module part. */
export const WORKER_MODULE_TYPE = 'application/javascript+module'

/** Cloudflare's code for "this Worker does not exist on your account". */
const SCRIPT_NOT_FOUND_CODE = 10007

/**
 * Codes Cloudflare uses when the token is valid but lacks a permission:
 * `10000` ("Authentication error", the usual one on Workers endpoints) and
 * `9109` ("Unauthorized to access requested resource").
 */
const PERMISSION_ERROR_CODES = [10000, 9109]

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

interface CloudflareApiResponse<T> {
  success: boolean
  errors: Array<{ code: number, message: string }>
  messages: unknown[]
  result: T
}

/** A failed call to the Workers API, with Cloudflare's error codes kept. */
export class WorkersApiError extends Error {
  readonly status: number
  readonly errors: Array<{ code: number, message: string }>

  constructor(message: string, status: number, errors: Array<{ code: number, message: string }> = []) {
    super(message)
    this.name = 'WorkersApiError'
    this.status = status
    this.errors = errors
  }

  /** Whether Cloudflare reported this error code. */
  hasCode(code: number): boolean {
    return this.errors.some(error => error.code === code)
  }
}

/**
 * The API token is missing a permission the call needs.
 *
 * Cloudflare answers these with a bare "Authentication error", which reads
 * like a bad token. This names the permission instead, so the operator knows
 * which box to tick on the token.
 */
export class WorkersPermissionError extends WorkersApiError {
  /** The token permission that would make the call succeed, as the dashboard names it. */
  readonly permission: string

  constructor(permission: string, detail: string, status: number, errors: Array<{ code: number, message: string }> = []) {
    super(
      `The Cloudflare API token is missing the "${permission}" permission (${detail}). `
      + `Edit the token in the Cloudflare dashboard (My Profile, API Tokens), add it, then re-run the deploy.`,
      status,
      errors,
    )
    this.name = 'WorkersPermissionError'
    this.permission = permission
  }
}

/** One binding as the API takes and returns it. Only the types ts-cloud writes are spelled out. */
export type WorkerBinding =
  | { type: 'r2_bucket', name: string, bucket_name: string, jurisdiction?: string }
  | { type: 'plain_text', name: string, text: string }
  | { type: string, name: string, [key: string]: unknown }

/** One module of an upload. */
export interface WorkerModule {
  /** File name, also the multipart part name, e.g. `worker.js`. */
  name: string
  content: string
  type: typeof WORKER_MODULE_TYPE
}

export interface WorkerUpload {
  /** Name of the module the runtime starts from; must be one of `modules`. */
  mainModule: string
  modules: WorkerModule[]
  bindings?: WorkerBinding[]
  compatibilityDate?: string
  compatibilityFlags?: string[]
}

/** What `GET .../settings` returns that ts-cloud reads. */
export interface WorkerSettings {
  bindings?: WorkerBinding[]
  compatibility_date?: string
  compatibility_flags?: string[]
  tags?: string[]
  [key: string]: unknown
}

/** The script object an upload returns. */
export interface WorkerScript {
  id?: string
  etag?: string
  created_on?: string
  modified_on?: string
  [key: string]: unknown
}

/** A hostname attached to a Worker, as the domains endpoints return it. */
export interface WorkerCustomDomain {
  id: string
  hostname: string
  service: string
  zone_id?: string
  zone_name?: string
  environment?: string
  cert_id?: string
}

export interface WorkersProviderOptions {
  /** Account API token with `Workers Scripts: Edit` (plus `Workers Routes: Edit` for custom domains). */
  apiToken: string
  /** Account the Workers live under. */
  accountId: string
  /** Override `fetch`, for tests. */
  fetch?: FetchLike
}

/**
 * Cloudflare Workers script and custom-domain management, scoped to one account.
 */
export class WorkersProvider {
  readonly name = 'cloudflare-workers'
  private readonly apiToken: string
  private readonly accountId: string
  private readonly fetchImpl: FetchLike

  constructor(options: WorkersProviderOptions) {
    if (!options.apiToken)
      throw new Error('Cloudflare Workers needs an API token')
    if (!options.accountId)
      throw new Error('Cloudflare Workers needs an account id')

    this.apiToken = options.apiToken
    this.accountId = options.accountId
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
  }

  /**
   * Make an authenticated request against the account-scoped Workers API.
   *
   * @param method - HTTP method
   * @param endpoint - Path below `/accounts/{id}/workers`, starting with a slash
   * @param body - JSON body, or a `FormData` for the multipart upload (whose
   * boundary `fetch` sets, so no Content-Type is sent for it here)
   * @throws {WorkersPermissionError} When the token lacks the permission the call needs
   * @throws {WorkersApiError} When Cloudflare reports any other failure
   */
  private async request<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiToken}` }
    let payload: RequestInit['body']
    if (body instanceof FormData) {
      payload = body
    }
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }

    const response = await this.fetchImpl(`${CLOUDFLARE_API_URL}/accounts/${this.accountId}/workers${endpoint}`, {
      method,
      headers,
      body: payload,
    })

    const text = await response.text()
    let data: CloudflareApiResponse<T>
    try {
      data = JSON.parse(text) as CloudflareApiResponse<T>
    }
    catch {
      throw new WorkersApiError(
        `Cloudflare Workers API returned ${response.status} with a non-JSON body: ${text.slice(0, 200)}`,
        response.status,
      )
    }

    if (!data.success) {
      const errors = data.errors ?? []
      const detail = errors.map(error => `${error.code}: ${error.message}`).join(', ')
      if (isPermissionFailure(response.status, errors))
        throw new WorkersPermissionError(permissionFor(endpoint), `${method} ${endpoint} -> ${response.status}${detail ? `, ${detail}` : ''}`, response.status, errors)
      throw new WorkersApiError(
        `Cloudflare Workers API error (${response.status}) on ${method} ${endpoint}: ${detail || text.slice(0, 200)}`,
        response.status,
        errors,
      )
    }

    return data.result
  }

  /** Path of one script, with the name escaped. */
  private scriptPath(name: string): string {
    return `/scripts/${encodeURIComponent(name)}`
  }

  /**
   * A script's settings: bindings (plain-text ones with their text),
   * compatibility date and flags, tags.
   *
   * @returns The settings, or `null` when no script by that name exists
   */
  async getSettings(name: string): Promise<WorkerSettings | null> {
    try {
      return await this.request<WorkerSettings>('GET', `${this.scriptPath(name)}/settings`)
    }
    catch (error) {
      // A missing script is an expected answer to "is this deployed yet",
      // not a fault. A permission failure is not, so it passes through.
      if (error instanceof WorkersPermissionError)
        throw error
      if (error instanceof WorkersApiError && (error.hasCode(SCRIPT_NOT_FOUND_CODE) || error.status === 404))
        return null
      throw error
    }
  }

  /** Alias of {@link getSettings}, for symmetry with the other providers' `get*`. */
  async getScript(name: string): Promise<WorkerSettings | null> {
    return this.getSettings(name)
  }

  /**
   * Upload (and deploy) an ES module Worker.
   *
   * Bindings are sent as given; `secret_text` bindings already on the script
   * are kept (`keep_bindings`), so secrets set out of band survive a deploy
   * that does not know their values. This is the raw upload;
   * {@link ensureModuleScript} is the idempotent form.
   */
  async uploadModuleScript(name: string, upload: WorkerUpload): Promise<WorkerScript> {
    return this.request<WorkerScript>('PUT', this.scriptPath(name), buildUploadForm(upload))
  }

  /**
   * Upload a Worker unless the deployed one was built from the same input.
   *
   * Adds the {@link CONTENT_HASH_BINDING} binding to the upload, and compares
   * it (plus every declared binding, so a binding edited in the dashboard is
   * put back) against what `GET .../settings` returns.
   *
   * @returns What happened and the content hash
   */
  async ensureModuleScript(
    name: string,
    upload: WorkerUpload,
  ): Promise<{ action: 'created' | 'updated' | 'unchanged', hash: string }> {
    const hash = workerContentHash(upload)
    const current = await this.getSettings(name)
    if (current && workerInSync(current, upload, hash))
      return { action: 'unchanged', hash }

    await this.uploadModuleScript(name, withContentHash(upload, hash))
    return { action: current ? 'updated' : 'created', hash }
  }

  /**
   * Hostnames attached to Workers in the account, optionally filtered.
   *
   * @param filter - `service` (Worker name), `hostname`, `zone_id` ...
   */
  async listCustomDomains(filter: { service?: string, hostname?: string, zoneId?: string } = {}): Promise<WorkerCustomDomain[]> {
    const query = new URLSearchParams()
    if (filter.service)
      query.set('service', filter.service)
    if (filter.hostname)
      query.set('hostname', filter.hostname)
    if (filter.zoneId)
      query.set('zone_id', filter.zoneId)
    const search = query.toString()
    const suffix = search ? `?${search}` : ''
    return (await this.request<WorkerCustomDomain[]>('GET', `/domains${suffix}`)) ?? []
  }

  /**
   * Attach a hostname to a Worker. This is the raw call: Cloudflare will move
   * a hostname that another Worker serves, so callers that must not do that
   * check {@link listCustomDomains} first (as {@link ensureCustomDomain} does).
   */
  async attachCustomDomain(
    hostname: string,
    options: { service: string, zoneId?: string, environment?: string },
  ): Promise<WorkerCustomDomain> {
    const body: Record<string, string> = {
      hostname,
      service: options.service,
      // Deprecated on Cloudflare's side but still accepted, and required by
      // older API revisions; `production` is what every Worker has.
      environment: options.environment ?? 'production',
    }
    if (options.zoneId)
      body.zone_id = options.zoneId
    return this.request<WorkerCustomDomain>('PUT', '/domains', body)
  }

  /** Detach a hostname from its Worker, by the domain's id (from {@link listCustomDomains}). */
  async detachCustomDomain(domainId: string): Promise<void> {
    await this.request('DELETE', `/domains/${encodeURIComponent(domainId)}`)
  }

  /**
   * Attach a hostname unless it is already attached to this Worker.
   *
   * Refuses (throws) when the hostname is attached to a different Worker:
   * moving it would take that Worker's URL down, which a deploy of this one
   * should not do silently.
   *
   * @param existing - Attached domains, when the caller already listed them
   */
  async ensureCustomDomain(
    hostname: string,
    options: { service: string, zoneId?: string },
    existing?: WorkerCustomDomain[],
  ): Promise<{ action: 'attached' | 'unchanged', domain: WorkerCustomDomain }> {
    const domains = existing ?? await this.listCustomDomains({ hostname })
    const current = domains.find(entry => entry.hostname.toLowerCase() === hostname.toLowerCase())
    if (current && current.service === options.service)
      return { action: 'unchanged', domain: current }
    if (current) {
      throw new Error(
        `${hostname} is attached to the Worker '${current.service}'. Detach it there first `
        + `(Workers & Pages, ${current.service}, Settings, Domains & Routes); ts-cloud does not move it.`,
      )
    }
    const domain = await this.attachCustomDomain(hostname, options)
    return { action: 'attached', domain: { ...domain, hostname: domain?.hostname || hostname } }
  }
}

/** Is this failure the token lacking a permission, rather than a bad request? */
function isPermissionFailure(status: number, errors: Array<{ code: number }>): boolean {
  if (errors.some(error => PERMISSION_ERROR_CODES.includes(error.code)))
    return true
  // A 403 with no code is also a permission answer; a 403 WITH some other
  // code (e.g. a plan limit) is not, and keeps its own message.
  return (status === 401 || status === 403) && errors.length === 0
}

/** The token permission an endpoint needs, named as Cloudflare's token editor names it. */
function permissionFor(endpoint: string): string {
  if (endpoint.startsWith('/domains'))
    return 'Workers Routes: Edit (zone, for Workers custom domains) and Workers Scripts: Edit (account)'
  return 'Workers Scripts: Edit (account)'
}

/**
 * The multipart body for an upload: a `metadata` part with the JSON settings,
 * then one file part per module.
 *
 * `metadata` is a plain string field, as wrangler sends it; a Blob would give
 * it a filename, which the API could take for a module.
 */
export function buildUploadForm(upload: WorkerUpload): FormData {
  if (!upload.modules.some(module => module.name === upload.mainModule))
    throw new Error(`Worker main module '${upload.mainModule}' is not one of the uploaded modules`)

  const metadata = {
    main_module: upload.mainModule,
    bindings: upload.bindings ?? [],
    compatibility_date: upload.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
    compatibility_flags: upload.compatibilityFlags ?? [],
    keep_bindings: ['secret_text'],
  }

  const form = new FormData()
  form.append('metadata', JSON.stringify(metadata))
  for (const module of upload.modules)
    form.append(module.name, new Blob([module.content], { type: module.type }), module.name)
  return form
}

/**
 * SHA-256 over everything an upload deploys, independent of key order and of
 * the content-hash binding itself.
 */
export function workerContentHash(upload: WorkerUpload): string {
  const canonical = {
    mainModule: upload.mainModule,
    modules: [...upload.modules]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(module => ({ name: module.name, type: module.type, sha256: sha256(module.content) })),
    bindings: [...(upload.bindings ?? [])]
      .filter(binding => binding.name !== CONTENT_HASH_BINDING)
      .sort((a, b) => a.name.localeCompare(b.name)),
    compatibilityDate: upload.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
    compatibilityFlags: [...(upload.compatibilityFlags ?? [])].sort(),
  }
  return sha256(stableJson(canonical))
}

/** The upload with its content-hash binding set (replacing any stale one). */
export function withContentHash(upload: WorkerUpload, hash: string = workerContentHash(upload)): WorkerUpload {
  return {
    ...upload,
    bindings: [
      ...(upload.bindings ?? []).filter(binding => binding.name !== CONTENT_HASH_BINDING),
      { type: 'plain_text', name: CONTENT_HASH_BINDING, text: hash },
    ],
  }
}

/**
 * Is the deployed script the one `upload` would produce?
 *
 * The hash covers the code and settings; the binding check catches a binding
 * changed in the dashboard since, which leaves the hash binding untouched.
 */
export function workerInSync(settings: WorkerSettings, upload: WorkerUpload, hash: string): boolean {
  const bindings = settings.bindings ?? []
  const marker = bindings.find(binding => binding.name === CONTENT_HASH_BINDING && binding.type === 'plain_text')
  if (!marker || (marker as { text?: unknown }).text !== hash)
    return false
  return (upload.bindings ?? []).every((wanted) => {
    const current = bindings.find(binding => binding.name === wanted.name)
    if (!current || current.type !== wanted.type)
      return false
    // Only the field that says what the binding points at is compared: the
    // API may echo optional fields (a jurisdiction) differently from how they
    // were sent, and comparing those would re-upload on every deploy.
    const key = wanted.type === 'r2_bucket' ? 'bucket_name' : wanted.type === 'plain_text' ? 'text' : undefined
    return !key || (current as Record<string, unknown>)[key] === (wanted as Record<string, unknown>)[key]
  })
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** JSON with sorted keys and no `undefined`, so equal values serialize equally. */
function stableJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    return `{${entries.sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
