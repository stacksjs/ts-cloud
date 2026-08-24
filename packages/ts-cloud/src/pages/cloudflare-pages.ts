/**
 * Deploy a built static site to Cloudflare Pages.
 *
 * Pages is the one Cloudflare product that is not reachable through the zone
 * API the rest of this codebase talks to: projects are account-scoped, and
 * uploads go through a separate content-addressed flow rather than a single
 * PUT. The shape of that flow drives this module:
 *
 *  - **Files are addressed by hash, not by path.** A deployment is a manifest
 *    mapping `/path` to a hash; the bytes are uploaded separately, and only for
 *    hashes the account has never seen. A redeploy of a site whose CSS did not
 *    change re-uploads nothing for that file, which is why `deployDirectory`
 *    checks `/pages/assets/check-missing` before sending anything.
 *  - **The hash is Cloudflare's own, not a plain digest.** It is a blake3 of
 *    the base64 payload concatenated with the file extension, truncated to 32
 *    hex characters. Getting this wrong does not error — it uploads fine and
 *    then serves 404s, because the manifest points at a hash the asset store
 *    does not hold under that name.
 *  - **Upload auth is a separate, short-lived JWT**, fetched from
 *    `/pages/projects/{name}/upload-token`. The account API token cannot be
 *    used against the asset endpoints.
 *
 * A custom domain is attached with {@link attachCustomDomain}, which is
 * idempotent, and still needs a CNAME in DNS — see {@link pagesDnsRecord}.
 */
import type { DnsRecord } from '../dns/types'

const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4'

/** Cloudflare's asset-upload ceiling. Larger files are rejected outright. */
export const PAGES_MAX_FILE_BYTES: number = 25 * 1024 * 1024

/** How many assets one upload request carries. Cloudflare's own limit. */
const UPLOAD_BATCH_SIZE = 100

/** Concurrent upload requests. Enough to saturate a link without tripping 429s. */
const UPLOAD_CONCURRENCY = 4

/**
 * Paths Cloudflare Pages treats as configuration rather than content, and
 * which therefore must not be uploaded as assets.
 */
const RESERVED_PATHS = new Set(['/_headers', '/_redirects', '/_routes.json', '/_worker.js'])

interface CloudflareApiResponse<T> {
  success: boolean
  errors: Array<{ code: number, message: string }>
  messages: unknown[]
  result: T
}

export interface CloudflarePagesProject {
  id: string
  name: string
  subdomain: string
  domains: string[]
  production_branch?: string
}

export interface CloudflarePagesDeployment {
  id: string
  url: string
  environment: string
  project_name: string
}

export interface CloudflarePagesOptions {
  /** Account-scoped API token with the `Cloudflare Pages: Edit` permission. */
  apiToken: string
  /** Account the project lives under. */
  accountId: string
}

/** One file in a deployment, already hashed. */
export interface PagesAsset {
  /** Site-absolute path, e.g. `/guide/index.html`. */
  path: string
  /** Cloudflare asset hash (32 hex chars). */
  hash: string
  /** Base64 of the file's bytes. */
  base64: string
  /** Extension without the dot, e.g. `html`. Empty when there is none. */
  extension: string
  /** Byte length of the original file, for reporting and limit checks. */
  size: number
}

export interface DeployDirectoryResult {
  deployment: CloudflarePagesDeployment
  /** Every asset in the manifest. */
  total: number
  /** Assets whose bytes had to be sent, the rest already being in the store. */
  uploaded: number
  /** Bytes actually transferred. */
  uploadedBytes: number
}

/**
 * Cloudflare Pages, scoped to one account.
 *
 * Mirrors {@link CloudflareProvider}: a thin authenticated `request`, and
 * methods that each map onto one API concern.
 */
export class CloudflarePagesProvider {
  readonly name = 'cloudflare-pages'
  private readonly apiToken: string
  private readonly accountId: string

  constructor(options: CloudflarePagesOptions) {
    if (!options.apiToken)
      throw new Error('Cloudflare Pages needs an API token')
    if (!options.accountId)
      throw new Error('Cloudflare Pages needs an account id')

    this.apiToken = options.apiToken
    this.accountId = options.accountId
  }

  /**
   * Make an authenticated request against the account-scoped Pages API.
   *
   * @param method - HTTP method
   * @param endpoint - Path below `/accounts/{id}`, starting with a slash
   * @param body - JSON body, or a `FormData` for multipart endpoints
   * @returns The unwrapped `result`
   * @throws {Error} When Cloudflare reports failure
   */
  private async request<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
    return requestWithAuth<T>(
      method,
      `/accounts/${this.accountId}${endpoint}`,
      `Bearer ${this.apiToken}`,
      body,
    )
  }

  /**
   * Look up a project by name.
   *
   * @param name - Project name
   * @returns The project, or `null` when it does not exist
   */
  async getProject(name: string): Promise<CloudflarePagesProject | null> {
    try {
      return await this.request<CloudflarePagesProject>('GET', `/pages/projects/${name}`)
    }
    catch (error) {
      // A missing project is an expected answer to "does this exist", not a
      // fault: only a genuine API failure should propagate.
      if (error instanceof Error && /\b8000007\b|not found/i.test(error.message))
        return null
      throw error
    }
  }

  /**
   * Create a direct-upload project, or return the existing one.
   *
   * Direct upload means ts-cloud pushes the built output itself rather than
   * Cloudflare cloning and building the repository. That keeps the build in
   * your CI, where the toolchain and secrets already are.
   *
   * @param name - Project name; also the `<name>.pages.dev` subdomain
   * @param productionBranch - Branch treated as production. @default 'main'
   * @returns The project, whether created here or already present
   */
  async ensureProject(name: string, productionBranch = 'main'): Promise<CloudflarePagesProject> {
    const existing = await this.getProject(name)
    if (existing)
      return existing

    return this.request<CloudflarePagesProject>('POST', '/pages/projects', {
      name,
      production_branch: productionBranch,
    })
  }

  /**
   * Short-lived JWT for the asset endpoints.
   *
   * The account API token is not accepted there, so this is fetched per deploy
   * rather than held.
   *
   * @param project - Project name
   */
  private async uploadToken(project: string): Promise<string> {
    const result = await this.request<{ jwt: string }>(
      'GET',
      `/pages/projects/${project}/upload-token`,
    )
    return result.jwt
  }

  /**
   * Ask which of these hashes the asset store does not already hold.
   *
   * @param jwt - Upload token
   * @param hashes - Every hash in the manifest
   * @returns The subset whose bytes still need sending
   */
  private async missingHashes(jwt: string, hashes: string[]): Promise<Set<string>> {
    const result = await requestWithAuth<string[]>(
      'POST',
      '/pages/assets/check-missing',
      `Bearer ${jwt}`,
      { hashes },
    )
    return new Set(result)
  }

  /**
   * Record hashes as present in the account's asset store.
   *
   * Uploading bytes is not by itself enough to make them findable: until the
   * hashes are upserted, `check-missing` keeps reporting them absent, and every
   * subsequent deploy re-uploads the entire site. Skipping this call is not
   * visible in a single deploy — it only shows up as an upload that never gets
   * cheaper.
   *
   * @param jwt - Upload token
   * @param hashes - Every hash in the manifest, not only the newly uploaded ones
   */
  private async upsertHashes(jwt: string, hashes: string[]): Promise<void> {
    await requestWithAuth('POST', '/pages/assets/upsert-hashes', `Bearer ${jwt}`, { hashes })
  }

  /**
   * Upload one batch of assets.
   *
   * @param jwt - Upload token
   * @param assets - At most {@link UPLOAD_BATCH_SIZE} assets
   */
  private async uploadBatch(jwt: string, assets: PagesAsset[]): Promise<void> {
    const payload = assets.map(asset => ({
      key: asset.hash,
      value: asset.base64,
      metadata: { contentType: contentTypeFor(asset.extension) },
      base64: true,
    }))

    await requestWithAuth('POST', '/pages/assets/upload', `Bearer ${jwt}`, payload)
  }

  /**
   * Create a deployment from an already-hashed manifest.
   *
   * @param project - Project name
   * @param assets - Every file in the site
   * @param branch - Branch to record. Matching the production branch publishes
   * to the live domain; anything else becomes a preview deployment.
   * @returns The created deployment
   */
  async createDeployment(
    project: string,
    assets: PagesAsset[],
    branch?: string,
  ): Promise<CloudflarePagesDeployment> {
    const manifest: Record<string, string> = {}
    for (const asset of assets)
      manifest[asset.path] = asset.hash

    const form = new FormData()
    form.append('manifest', JSON.stringify(manifest))
    if (branch)
      form.append('branch', branch)

    return this.request<CloudflarePagesDeployment>(
      'POST',
      `/pages/projects/${project}/deployments`,
      form,
    )
  }

  /**
   * Build, upload and deploy a directory.
   *
   * The whole flow: hash every file, ask what is missing, upload only that,
   * then create the deployment.
   *
   * @param options.project - Project name
   * @param options.directory - Directory to publish; becomes the site root
   * @param options.branch - Branch to record on the deployment
   * @param options.onProgress - Called as batches complete, for CLI output
   * @returns The deployment and what it cost to send
   * @throws {Error} When the directory is empty or a file exceeds the size limit
   */
  async deployDirectory(options: {
    project: string
    directory: string
    branch?: string
    onProgress?: (uploaded: number, total: number) => void
  }): Promise<DeployDirectoryResult> {
    const assets = await collectAssets(options.directory)
    if (assets.length === 0)
      throw new Error(`No files to deploy in ${options.directory}`)

    const jwt = await this.uploadToken(options.project)
    const missing = await this.missingHashes(jwt, assets.map(asset => asset.hash))
    const pending = assets.filter(asset => missing.has(asset.hash))

    const batches: PagesAsset[][] = []
    for (let i = 0; i < pending.length; i += UPLOAD_BATCH_SIZE)
      batches.push(pending.slice(i, i + UPLOAD_BATCH_SIZE))

    let done = 0
    for (let i = 0; i < batches.length; i += UPLOAD_CONCURRENCY) {
      const window = batches.slice(i, i + UPLOAD_CONCURRENCY)
      await Promise.all(window.map(batch => this.uploadBatch(jwt, batch)))
      done += window.reduce((sum, batch) => sum + batch.length, 0)
      options.onProgress?.(done, pending.length)
    }

    // Register every hash in the manifest, not just the ones uploaded now:
    // the store's index is what makes the next deploy incremental.
    await this.upsertHashes(jwt, assets.map(asset => asset.hash))

    const deployment = await this.createDeployment(options.project, assets, options.branch)

    return {
      deployment,
      total: assets.length,
      uploaded: pending.length,
      uploadedBytes: pending.reduce((sum, asset) => sum + asset.size, 0),
    }
  }

  /** Custom domains already attached to a project. */
  async listCustomDomains(project: string): Promise<string[]> {
    const result = await this.request<Array<{ name: string }>>(
      'GET',
      `/pages/projects/${project}/domains`,
    )
    return result.map(domain => domain.name)
  }

  /**
   * Attach a custom domain, or leave it attached.
   *
   * Idempotent so a deploy pipeline can call it on every run rather than
   * guarding with a lookup that races.
   *
   * @param project - Project name
   * @param domain - Hostname to serve, e.g. `buddy.sh`
   * @returns Whether this call is what attached it
   */
  async attachCustomDomain(project: string, domain: string): Promise<boolean> {
    const existing = await this.listCustomDomains(project)
    if (existing.includes(domain))
      return false

    await this.request('POST', `/pages/projects/${project}/domains`, { name: domain })
    return true
  }
}

/**
 * The DNS record that points a custom domain at a Pages project.
 *
 * Pages serves from a `*.pages.dev` host, so the zone needs a CNAME. Two things
 * are easy to get wrong here:
 *
 *  - **The target is the project's `subdomain`, not `<name>.pages.dev`.**
 *    Cloudflare only grants the bare name when it is free; a project named
 *    `buddy` whose name was taken is served from `buddy-5yo.pages.dev`.
 *    Deriving the host from the project name instead of reading `subdomain`
 *    produces a CNAME to a host that does not exist.
 *  - **It must be proxied.** An unproxied CNAME reaches Cloudflare's edge but
 *    arrives without the routing metadata Pages uses to pick a project, and
 *    answers 404.
 *
 * A CNAME at the apex is legal here only because Cloudflare flattens it.
 *
 * @param hostname - Public hostname, e.g. `buddy.sh` or `www.buddy.sh`
 * @param subdomain - The project's `subdomain`, e.g. `buddy-5yo.pages.dev`
 * @returns A record ready for `CloudflareProvider.upsertRecord`
 */
export function pagesDnsRecord(hostname: string, subdomain: string): DnsRecord {
  return {
    type: 'CNAME',
    name: hostname,
    // Tolerate being handed either the bare label or the full host.
    value: subdomain.endsWith('.pages.dev') ? subdomain : `${subdomain}.pages.dev`,
    ttl: 1, // 'automatic'; required for a proxied record
    proxied: true,
  } as DnsRecord
}

/**
 * Cloudflare's asset hash: BLAKE3 of `<base64><extension>`, first 32 hex chars.
 *
 * The extension is part of the input, so the same bytes saved as `.html` and
 * as `.txt` hash differently — which is deliberate, since the asset store
 * serves content type from the key.
 *
 * BLAKE3 specifically, and it has to come from a library: Bun's `CryptoHasher`
 * ships blake2b but not blake3. Substituting a different digest is not a
 * degradation that shows up as an error — the upload succeeds and the site
 * then serves 404s, because the manifest names a key the store does not hold.
 *
 * @param base64 - Base64 of the file's bytes
 * @param extension - Extension without the dot
 */
export async function pagesAssetHash(base64: string, extension: string): Promise<string> {
  const { blake3 } = await import('hash-wasm')
  return (await blake3(base64 + extension)).slice(0, 32)
}

/**
 * Walk a directory into a deployable manifest.
 *
 * Dotfiles are included: a built site legitimately contains `.well-known`, and
 * bunpress writes its output under a `.bunpress` root. Cloudflare's own
 * reserved paths are skipped, since uploading them as assets shadows the
 * configuration they are meant to be.
 *
 * @param directory - Site root
 * @returns One entry per file, hashed and base64-encoded
 * @throws {Error} When a file exceeds {@link PAGES_MAX_FILE_BYTES}
 */
export async function collectAssets(directory: string): Promise<PagesAsset[]> {
  const { readdir } = await import('node:fs/promises')
  const { join, relative, sep } = await import('node:path')

  const assets: PagesAsset[] = []

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile())
        continue

      const path = `/${relative(directory, full).split(sep).join('/')}`
      if (RESERVED_PATHS.has(path))
        continue

      const bytes = await Bun.file(full).bytes()
      if (bytes.byteLength > PAGES_MAX_FILE_BYTES) {
        throw new Error(
          `${path} is ${bytes.byteLength} bytes, over the Cloudflare Pages limit of ${PAGES_MAX_FILE_BYTES}`,
        )
      }

      const base64 = Buffer.from(bytes).toString('base64')
      const dot = entry.name.lastIndexOf('.')
      const extension = dot > 0 ? entry.name.slice(dot + 1) : ''

      assets.push({
        path,
        hash: await pagesAssetHash(base64, extension),
        base64,
        extension,
        size: bytes.byteLength,
      })
    }
  }

  await walk(directory)
  // Deterministic order keeps a manifest diffable between runs.
  assets.sort((a, b) => a.path.localeCompare(b.path))
  return assets
}

/**
 * Content type stored alongside an asset.
 *
 * Pages serves what the manifest recorded, so an unknown extension has to fall
 * back to something a browser will download rather than render as text.
 */
function contentTypeFor(extension: string): string {
  const types: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    mjs: 'application/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    map: 'application/json; charset=utf-8',
    xml: 'application/xml; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    pdf: 'application/pdf',
    webmanifest: 'application/manifest+json',
  }

  return types[extension.toLowerCase()] || 'application/octet-stream'
}

/**
 * One authenticated Cloudflare request, shared by the account API and the
 * JWT-authenticated asset API.
 *
 * @param method - HTTP method
 * @param endpoint - Path below the API root
 * @param authorization - Full `Authorization` header value
 * @param body - JSON body, or `FormData` to send as multipart
 * @returns The unwrapped `result`
 * @throws {Error} When Cloudflare reports failure
 */
async function requestWithAuth<T>(
  method: string,
  endpoint: string,
  authorization: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { Authorization: authorization }
  let payload: FormData | string | undefined

  if (body instanceof FormData) {
    // Content-Type is deliberately unset: fetch has to add the multipart
    // boundary itself, and setting it by hand produces a body the API cannot
    // parse.
    payload = body
  }
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  const response = await fetch(`${CLOUDFLARE_API_URL}${endpoint}`, {
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
    throw new Error(
      `Cloudflare Pages API returned ${response.status} with a non-JSON body: ${text.slice(0, 200)}`,
    )
  }

  if (!data.success) {
    const detail = (data.errors ?? []).map(error => `${error.code}: ${error.message}`).join(', ')
    throw new Error(`Cloudflare Pages API error (${response.status}): ${detail || text.slice(0, 200)}`)
  }

  return data.result
}
