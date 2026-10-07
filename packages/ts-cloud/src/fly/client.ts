/**
 * Fly.io API client, on the Machines REST API: apps, Machines, leases,
 * volumes, secrets, IP assignments and certificates. Paths and payloads follow
 * Fly's API reference and its own Go client (superfly/fly-go `flaps`), which
 * flyctl itself uses - IP allocation and certificates moved there from the
 * GraphQL API.
 *
 * @see https://docs.fly.io/machines/api/
 */

export const FLY_MACHINES_API = 'https://api.machines.dev/v1'

export class FlyApiError extends Error {
  constructor(message: string, readonly status: number, readonly path: string) {
    super(message)
    this.name = 'FlyApiError'
  }
}

export interface FlyApp {
  id?: string
  name: string
  organization?: { slug?: string }
  status?: string
}

export interface FlyService {
  protocol: 'tcp' | 'udp'
  internal_port: number
  ports: Array<{ port: number, handlers: string[], force_https?: boolean }>
  autostop?: 'off' | 'stop' | 'suspend'
  autostart?: boolean
  min_machines_running?: number
  checks?: Array<{ type: 'http' | 'tcp', interval?: string, timeout?: string, grace_period?: string, method?: string, path?: string }>
}

export interface FlyMachineConfig {
  image: string
  env?: Record<string, string>
  guest?: { cpu_kind: 'shared' | 'performance', cpus: number, memory_mb: number }
  services?: FlyService[]
  mounts?: Array<{ volume: string, path: string }>
  restart?: { policy: 'no' | 'always' | 'on-failure', max_retries?: number }
  metadata?: Record<string, string>
}

export interface FlyMachine {
  id: string
  name?: string
  state: string
  region: string
  instance_id?: string
  config: FlyMachineConfig
}

export interface FlyVolume {
  id: string
  name: string
  region: string
  size_gb: number
  attached_machine_id?: string | null
  state?: string
}

export type FlyIpType = 'v4' | 'v6' | 'shared_v4' | 'private_v6'

export interface FlyIpAssignment {
  ip: string
  region?: string
  shared?: boolean
  egress?: boolean
}

/** The kind of a listed address, read as fly-go reads it. */
export function flyIpType(assignment: FlyIpAssignment): FlyIpType {
  const v6 = assignment.ip.includes(':')
  if (v6 && assignment.ip.startsWith('fdaa:'))
    return 'private_v6'
  if (assignment.shared)
    return 'shared_v4'
  return v6 ? 'v6' : 'v4'
}

export interface FlyCertificate {
  hostname: string
  configured?: boolean
  status?: string
  /** The records the hostname needs for the certificate to be issued. */
  dns_requirements?: { a?: string[], aaaa?: string[], cname?: string, acme_challenge?: { name: string, target: string } }
}

export interface FlyClientOptions {
  /** `FLY_API_TOKEN`: a deploy or org token. */
  token: string
  fetch?: typeof fetch
}

export class FlyClient {
  private readonly token: string
  private readonly fetch: typeof fetch

  constructor(options: FlyClientOptions) {
    if (!options.token)
      throw new Error('Fly.io needs an API token: set FLY_API_TOKEN (`fly tokens create deploy` makes one scoped to an app).')
    this.token = options.token
    this.fetch = options.fetch ?? fetch
  }

  private async rest<T>(method: 'GET' | 'POST' | 'DELETE', path: string, options: { body?: unknown, query?: Record<string, string>, headers?: Record<string, string>, notFound?: 'null' } = {}): Promise<T> {
    const url = new URL(`${FLY_MACHINES_API}${path}`)
    for (const [key, value] of Object.entries(options.query ?? {}))
      url.searchParams.set(key, value)

    const response = await this.fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })

    if (response.status === 404 && options.notFound === 'null')
      return null as T
    const text = await response.text()
    const body = text ? safeJson(text) : undefined
    if (!response.ok) {
      const detail = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : text || response.statusText
      throw new FlyApiError(`Fly.io ${method} ${path} failed (${response.status}): ${detail}`, response.status, path)
    }
    return body as T
  }

  /** The app, or null when there is none by that name. */
  getApp(name: string): Promise<FlyApp | null> {
    return this.rest<FlyApp | null>('GET', `/apps/${encodeURIComponent(name)}`, { notFound: 'null' })
  }

  createApp(name: string, org: string): Promise<FlyApp> {
    return this.rest<FlyApp>('POST', '/apps', { body: { app_name: name, org_slug: org } })
  }

  async listMachines(app: string): Promise<FlyMachine[]> {
    return (await this.rest<FlyMachine[] | null>('GET', `/apps/${encodeURIComponent(app)}/machines`)) ?? []
  }

  createMachine(app: string, input: { region: string, config: FlyMachineConfig, name?: string, min_secrets_version?: number }): Promise<FlyMachine> {
    return this.rest<FlyMachine>('POST', `/apps/${encodeURIComponent(app)}/machines`, { body: input })
  }

  /** Update a Machine's config. `nonce` is the lease the update is made under. */
  updateMachine(app: string, id: string, input: { config: FlyMachineConfig, min_secrets_version?: number }, nonce: string): Promise<FlyMachine> {
    return this.rest<FlyMachine>('POST', `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}`, {
      body: input,
      headers: { 'fly-machine-lease-nonce': nonce },
    })
  }

  /** Take a Machine's lease, so no other deploy updates it meanwhile. Returns the nonce. */
  async acquireLease(app: string, id: string, ttlSeconds = 120): Promise<string> {
    const lease = await this.rest<{ data?: { nonce?: string } }>('POST', `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}/lease`, { body: { ttl: ttlSeconds } })
    const nonce = lease.data?.nonce
    if (!nonce)
      throw new FlyApiError(`Fly.io gave no lease nonce for Machine ${id}`, 200, `/machines/${id}/lease`)
    return nonce
  }

  async releaseLease(app: string, id: string, nonce: string): Promise<void> {
    await this.rest('DELETE', `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}/lease`, { headers: { 'fly-machine-lease-nonce': nonce } })
  }

  /** Wait for a Machine to reach a state, up to `timeoutSeconds` (Fly allows up to 60 per call). */
  async waitForState(app: string, id: string, state: 'started' | 'stopped', options: { instanceId?: string, timeoutSeconds?: number } = {}): Promise<void> {
    await this.rest('GET', `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}/wait`, {
      query: { state, timeout: String(options.timeoutSeconds ?? 60), ...(options.instanceId ? { instance_id: options.instanceId } : {}) },
    })
  }

  async listVolumes(app: string): Promise<FlyVolume[]> {
    return (await this.rest<FlyVolume[] | null>('GET', `/apps/${encodeURIComponent(app)}/volumes`)) ?? []
  }

  createVolume(app: string, input: { name: string, region: string, size_gb: number }): Promise<FlyVolume> {
    return this.rest<FlyVolume>('POST', `/apps/${encodeURIComponent(app)}/volumes`, { body: { ...input, encrypted: true } })
  }

  /**
   * Set secrets, leaving the app's others alone. Returns the secrets version,
   * which a Machine created or updated after it must be given as
   * `min_secrets_version` to be sure of seeing them.
   */
  async setSecrets(app: string, values: Record<string, string>): Promise<number> {
    const result = await this.rest<{ version: number }>('POST', `/apps/${encodeURIComponent(app)}/secrets`, { body: { values } })
    return result.version
  }

  async listIpAssignments(app: string): Promise<FlyIpAssignment[]> {
    return (await this.rest<{ ips?: FlyIpAssignment[] }>('GET', `/apps/${encodeURIComponent(app)}/ip_assignments`)).ips ?? []
  }

  /** Assign an address. A shared IPv4 is the organization's, shared with its other apps. */
  async assignIp(app: string, type: 'v6' | 'shared_v4' | 'v4'): Promise<FlyIpAssignment> {
    const assigned = await this.rest<{ ip?: string | null, shared?: boolean, region?: string }>('POST', `/apps/${encodeURIComponent(app)}/ip_assignments`, { body: { type } })
    if (!assigned.ip)
      throw new FlyApiError(`Fly.io assigned no ${type} address to ${app}`, 200, `/apps/${app}/ip_assignments`)
    return { ip: assigned.ip, shared: assigned.shared ?? type === 'shared_v4', region: assigned.region }
  }

  /** Request a Let's Encrypt certificate for a custom hostname, or report the one requested before. */
  async requestCertificate(app: string, hostname: string): Promise<FlyCertificate> {
    return this.rest<FlyCertificate>('POST', `/apps/${encodeURIComponent(app)}/certificates/acme`, { body: { hostname } })
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}
