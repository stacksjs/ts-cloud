/**
 * Hetzner Cloud API client
 * @see https://docs.hetzner.cloud/
 */

const DEFAULT_API_URL = 'https://api.hetzner.cloud/v1'

export interface HetznerApiErrorBody {
  error?: {
    code?: string
    message?: string
    details?: unknown
  }
}

export interface HetznerServer {
  id: number
  name: string
  status: string
  public_net: {
    ipv4?: { ip: string }
    ipv6?: { ip: string }
  }
  private_net?: Array<{ ip: string }>
  labels?: Record<string, string>
  server_type: { name: string }
  datacenter: { name: string, location: { name: string } }
}

export interface HetznerFirewall {
  id: number
  name: string
  labels?: Record<string, string>
  rules?: HetznerFirewallRule[]
}

export interface HetznerFirewallRule {
  direction: 'in' | 'out'
  protocol: 'tcp' | 'udp' | 'icmp' | 'esp' | 'gre'
  port?: string
  source_ips: string[]
  description?: string
}

export interface HetznerSshKey {
  id: number
  name: string
  fingerprint: string
  public_key: string
  labels?: Record<string, string>
}

export interface HetznerAction {
  id: number
  status: 'running' | 'success' | 'error'
  progress?: number
  error?: { code: string, message: string }
}

export interface CreateServerOptions {
  name: string
  serverType: string
  image: string
  location?: string
  datacenter?: string
  sshKeys?: number[]
  userData?: string
  labels?: Record<string, string>
  firewalls?: Array<{ firewall: number }>
}

export interface CreateFirewallOptions {
  name: string
  rules: HetznerFirewallRule[]
  labels?: Record<string, string>
  applyTo?: Array<{ type: 'server', server: number }>
}

export interface CreateSshKeyOptions {
  name: string
  publicKey: string
  labels?: Record<string, string>
}

/** Minimal fetch signature the client relies on (always called with a string URL). */
export type HetznerFetch = (url: string, init?: RequestInit) => Promise<Response>

export interface HetznerClientOptions {
  apiToken: string
  baseUrl?: string
  fetchImpl?: HetznerFetch
}

export class HetznerClient {
  readonly name = 'hetzner'
  private apiToken: string
  private baseUrl: string
  private fetchImpl: HetznerFetch

  constructor(options: HetznerClientOptions) {
    this.apiToken = options.apiToken
    this.baseUrl = options.baseUrl ?? DEFAULT_API_URL
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    const text = await response.text()
    let data: T & HetznerApiErrorBody
    try {
      data = (text ? JSON.parse(text) : {}) as T & HetznerApiErrorBody
    }
    catch {
      // Non-JSON body (e.g. an HTML 502/503 from an upstream gateway). Surface
      // the raw text so the error is actionable instead of an opaque parse fail.
      if (!response.ok) {
        const snippet = text.trim().slice(0, 200) || response.statusText || 'Hetzner API error'
        throw new Error(`Hetzner API ${method} ${path} (${response.status}): ${snippet}`)
      }
      throw new Error(`Hetzner API ${method} ${path}: unexpected non-JSON response`)
    }

    if (!response.ok) {
      const message = data.error?.message || response.statusText || 'Hetzner API error'
      const code = data.error?.code ? ` [${data.error.code}]` : ''
      throw new Error(`Hetzner API ${method} ${path} (${response.status})${code}: ${message}`)
    }

    return data as T
  }

  async listServers(): Promise<HetznerServer[]> {
    const data = await this.request<{ servers: HetznerServer[] }>('GET', '/servers')
    return data.servers
  }

  async getServer(id: number): Promise<HetznerServer> {
    const data = await this.request<{ server: HetznerServer }>('GET', `/servers/${id}`)
    return data.server
  }

  async createServer(options: CreateServerOptions): Promise<{ server: HetznerServer, action: HetznerAction }> {
    const data = await this.request<{ server: HetznerServer, root_password?: string, action: HetznerAction }>('POST', '/servers', {
      name: options.name,
      server_type: options.serverType,
      image: options.image,
      location: options.location,
      datacenter: options.datacenter,
      ssh_keys: options.sshKeys,
      user_data: options.userData,
      labels: options.labels,
      firewalls: options.firewalls,
      start_after_create: true,
    })
    return { server: data.server, action: data.action }
  }

  async deleteServer(id: number): Promise<HetznerAction> {
    const data = await this.request<{ action: HetznerAction }>('DELETE', `/servers/${id}`)
    return data.action
  }

  async listFirewalls(): Promise<HetznerFirewall[]> {
    const data = await this.request<{ firewalls: HetznerFirewall[] }>('GET', '/firewalls')
    return data.firewalls
  }

  async createFirewall(options: CreateFirewallOptions): Promise<{ firewall: HetznerFirewall, actions: HetznerAction[] }> {
    const data = await this.request<{ firewall: HetznerFirewall, actions: HetznerAction[] }>('POST', '/firewalls', {
      name: options.name,
      rules: options.rules,
      labels: options.labels,
      apply_to: options.applyTo,
    })
    return { firewall: data.firewall, actions: data.actions }
  }

  /**
   * Replace a firewall's rule set in place. Used to keep an existing (reused)
   * firewall's rules in sync with the desired config without recreating it.
   */
  async setFirewallRules(firewallId: number, rules: HetznerFirewallRule[]): Promise<HetznerAction[]> {
    const data = await this.request<{ actions: HetznerAction[] }>('POST', `/firewalls/${firewallId}/actions/set_rules`, {
      rules,
    })
    return data.actions ?? []
  }

  async applyFirewallToResources(firewallId: number, applyTo: Array<{ type: 'server', server: number }>): Promise<HetznerAction[]> {
    const data = await this.request<{ actions: HetznerAction[] }>('POST', `/firewalls/${firewallId}/actions/apply_to_resources`, {
      apply_to: applyTo,
    })
    return data.actions
  }

  async listSshKeys(): Promise<HetznerSshKey[]> {
    const data = await this.request<{ ssh_keys: HetznerSshKey[] }>('GET', '/ssh_keys')
    return data.ssh_keys
  }

  async createSshKey(options: CreateSshKeyOptions): Promise<HetznerSshKey> {
    const data = await this.request<{ ssh_key: HetznerSshKey }>('POST', '/ssh_keys', {
      name: options.name,
      public_key: options.publicKey,
      labels: options.labels,
    })
    return data.ssh_key
  }

  async waitForAction(actionId: number, options?: { pollIntervalMs?: number, maxWaitMs?: number }): Promise<HetznerAction> {
    const pollInterval = options?.pollIntervalMs ?? 2000
    const maxWait = options?.maxWaitMs ?? 300000
    const start = Date.now()

    while (Date.now() - start < maxWait) {
      const data = await this.request<{ action: HetznerAction }>('GET', `/actions/${actionId}`)
      if (data.action.status === 'success') return data.action
      if (data.action.status === 'error') {
        throw new Error(data.action.error?.message || 'Hetzner action failed')
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }

    throw new Error(`Timed out waiting for Hetzner action ${actionId}`)
  }

  async waitForServerRunning(serverId: number, options?: { pollIntervalMs?: number, maxWaitMs?: number }): Promise<HetznerServer> {
    const pollInterval = options?.pollIntervalMs ?? 3000
    const maxWait = options?.maxWaitMs ?? 600000
    const start = Date.now()

    while (Date.now() - start < maxWait) {
      const server = await this.getServer(serverId)
      if (server.status === 'running') return server
      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }

    throw new Error(`Timed out waiting for server ${serverId} to reach running state`)
  }
}

export function resolveHetznerApiToken(configToken?: string): string {
  const token = configToken || process.env.HCLOUD_TOKEN || process.env.HETZNER_API_TOKEN
  if (!token) {
    throw new Error('Hetzner API token required. Set hetzner.apiToken in cloud.config.ts or HCLOUD_TOKEN / HETZNER_API_TOKEN.')
  }
  return token
}

/**
 * Normalize an OpenSSH public key to its `<type> <base64>` body, dropping the
 * trailing comment. Lets us match a local key against keys already registered
 * in the Hetzner project regardless of differing comments/whitespace.
 */
export function normalizeSshPublicKey(publicKey: string): string {
  const [type, body] = publicKey.trim().split(/\s+/)
  return body ? `${type} ${body}` : type
}
