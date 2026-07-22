import type { ControlPlaneOperation, ControlPlaneStore, JsonValue } from '../control-plane'
import { DurableOperationQueue } from '../queue'

export * from './ssh-driver'
export * from './queue'

export type ServerProvider = 'aws' | 'hetzner' | 'ssh'
export type ServerRole = 'application' | 'build' | 'worker' | 'monitoring' | 'backup' | 'control_plane'
export interface ServerFacts {
  os?: string
  arch?: string
  cpuCores?: number
  memoryBytes?: number
  diskBytes?: number
  diskFreeBytes?: number
  dnsOk?: boolean
  timeSkewSeconds?: number
  tools?: Record<string, string>
  ports?: number[]
  privilege?: string
  proxyVersion?: string
  runtimeVersions?: Record<string, string>
  firewall?: string
  network?: Record<string, JsonValue>
}
export interface ValidationFinding {
  code: string
  severity: 'info' | 'warning' | 'error'
  message: string
  remediation?: string
}
export interface ServerValidation {
  valid: boolean
  facts: ServerFacts
  findings: ValidationFinding[]
  validatedAt: string
  validatorVersion: string
}
export interface FleetServer {
  id: string
  organizationId: string
  projectId: string
  resourceId: string
  name: string
  provider: ServerProvider
  providerId?: string
  region?: string
  zone?: string
  endpoint: string
  sshUser: string
  sshPort: number
  credentialRef: string
  hostKeyAlgorithm?: string
  hostKeyFingerprint?: string
  pendingHostKey?: string
  roles: ServerRole[]
  labels: Record<string, string>
  taints: string[]
  capacity: Record<string, number>
  usage: Record<string, number>
  capabilities: Record<string, { supported: boolean; reason?: string }>
  status: 'pending' | 'validating' | 'ready' | 'degraded' | 'unreachable' | 'draining' | 'drained' | 'archived'
  trustState: 'unverified' | 'pinned' | 'rotation_pending' | 'blocked'
  validation?: ServerValidation
  bootstrapVersion?: string
  heartbeatAt?: string
  lastSeenAt?: string
  archivedAt?: string
  version: number
  createdAt: string
  updatedAt: string
}
export interface FleetDriver {
  provider: ServerProvider
  discover(
    projectId: string,
  ): Promise<Array<{ providerId: string; name: string; endpoint: string; region?: string; zone?: string }>>
  test(
    server: FleetServer,
  ): Promise<{ reachable: boolean; hostKeyAlgorithm: string; hostKeyFingerprint: string; latencyMs: number }>
  validate(server: FleetServer): Promise<ServerFacts>
  bootstrap(server: FleetServer, steps: string[]): Promise<{ version: string }>
  capabilities(server?: FleetServer): FleetServer['capabilities']
}
type Row = Record<string, unknown>
const optional = (value: unknown): string | undefined => (value == null ? undefined : String(value))
const json = <T>(value: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(value)) as T
  } catch {
    return fallback
  }
}
const mapServer = (row: Row): FleetServer => ({
  id: String(row.id),
  organizationId: String(row.organization_id),
  projectId: String(row.project_id),
  resourceId: String(row.resource_id),
  name: String(row.name),
  provider: String(row.provider) as ServerProvider,
  providerId: optional(row.provider_id),
  region: optional(row.region),
  zone: optional(row.zone),
  endpoint: String(row.endpoint),
  sshUser: String(row.ssh_user),
  sshPort: Number(row.ssh_port),
  credentialRef: String(row.credential_ref),
  hostKeyAlgorithm: optional(row.host_key_algorithm),
  hostKeyFingerprint: optional(row.host_key_fingerprint),
  pendingHostKey: optional(row.pending_host_key),
  roles: json(row.roles, []),
  labels: json(row.labels, {}),
  taints: json(row.taints, []),
  capacity: json(row.capacity, {}),
  usage: json(row.usage, {}),
  capabilities: json(row.capabilities, {}),
  status: String(row.status) as FleetServer['status'],
  trustState: String(row.trust_state) as FleetServer['trustState'],
  validation: json(row.validation, undefined),
  bootstrapVersion: optional(row.bootstrap_version),
  heartbeatAt: optional(row.heartbeat_at),
  lastSeenAt: optional(row.last_seen_at),
  archivedAt: optional(row.archived_at),
  version: Number(row.version),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
})

export class FleetStore {
  constructor(
    readonly control: ControlPlaneStore,
    private now: () => Date = () => new Date(),
    private id: () => string = () => crypto.randomUUID(),
  ) {}
  get(id: string): FleetServer | undefined {
    const row = this.control.database.query<Row, [string]>('SELECT * FROM fleet_servers WHERE id=?').get(id)
    return row ? mapServer(row) : undefined
  }
  list(projectId: string, includeArchived: boolean = false): FleetServer[] {
    return this.control.database
      .query<Row, [string]>('SELECT * FROM fleet_servers WHERE project_id=? ORDER BY name')
      .all(projectId)
      .map(mapServer)
      .filter((value) => includeArchived || value.status !== 'archived')
  }
  findProvider(organizationId: string, provider: ServerProvider, providerId: string): FleetServer | undefined {
    const row = this.control.database
      .query<Row, [string, string, string]>(
        'SELECT * FROM fleet_servers WHERE organization_id=? AND provider=? AND provider_id=? AND archived_at IS NULL',
      )
      .get(organizationId, provider, providerId)
    return row ? mapServer(row) : undefined
  }
  create(input: Omit<FleetServer, 'id' | 'version' | 'createdAt' | 'updatedAt'>): FleetServer {
    const id = this.id(),
      at = this.now().toISOString()
    this.control.database.run(
      'INSERT INTO fleet_servers (id,organization_id,project_id,resource_id,name,provider,provider_id,region,zone,endpoint,ssh_user,ssh_port,credential_ref,host_key_algorithm,host_key_fingerprint,pending_host_key,roles,labels,taints,capacity,usage,capabilities,status,trust_state,validation,bootstrap_version,heartbeat_at,last_seen_at,archived_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.organizationId,
        input.projectId,
        input.resourceId,
        input.name,
        input.provider,
        input.providerId ?? null,
        input.region ?? null,
        input.zone ?? null,
        input.endpoint,
        input.sshUser,
        input.sshPort,
        input.credentialRef,
        input.hostKeyAlgorithm ?? null,
        input.hostKeyFingerprint ?? null,
        input.pendingHostKey ?? null,
        JSON.stringify(input.roles),
        JSON.stringify(input.labels),
        JSON.stringify(input.taints),
        JSON.stringify(input.capacity),
        JSON.stringify(input.usage),
        JSON.stringify(input.capabilities),
        input.status,
        input.trustState,
        JSON.stringify(input.validation ?? {}),
        input.bootstrapVersion ?? null,
        input.heartbeatAt ?? null,
        input.lastSeenAt ?? null,
        input.archivedAt ?? null,
        at,
        at,
      ],
    )
    return this.get(id)!
  }
  update(id: string, patch: Partial<FleetServer>): FleetServer {
    const value = this.get(id)
    if (!value) throw new Error('Server was not found.')
    const next = { ...value, ...patch },
      at = this.now().toISOString()
    this.control.database.run(
      'UPDATE fleet_servers SET name=?,provider_id=?,region=?,zone=?,endpoint=?,ssh_user=?,ssh_port=?,credential_ref=?,host_key_algorithm=?,host_key_fingerprint=?,pending_host_key=?,roles=?,labels=?,taints=?,capacity=?,usage=?,capabilities=?,status=?,trust_state=?,validation=?,bootstrap_version=?,heartbeat_at=?,last_seen_at=?,archived_at=?,version=version+1,updated_at=? WHERE id=?',
      [
        next.name,
        next.providerId ?? null,
        next.region ?? null,
        next.zone ?? null,
        next.endpoint,
        next.sshUser,
        next.sshPort,
        next.credentialRef,
        next.hostKeyAlgorithm ?? null,
        next.hostKeyFingerprint ?? null,
        next.pendingHostKey ?? null,
        JSON.stringify(next.roles),
        JSON.stringify(next.labels),
        JSON.stringify(next.taints),
        JSON.stringify(next.capacity),
        JSON.stringify(next.usage),
        JSON.stringify(next.capabilities),
        next.status,
        next.trustState,
        JSON.stringify(next.validation ?? {}),
        next.bootstrapVersion ?? null,
        next.heartbeatAt ?? null,
        next.lastSeenAt ?? null,
        next.archivedAt ?? null,
        at,
        id,
      ],
    )
    return this.get(id)!
  }
}
const endpoint = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9a-fA-F:]+\])$/
export interface FleetBootstrapResult {
  preview: boolean
  steps: string[]
  operation?: ControlPlaneOperation
}
export class FleetService {
  readonly queue: DurableOperationQueue
  constructor(
    readonly store: FleetStore,
    readonly drivers: FleetDriver[],
    queue?: DurableOperationQueue,
    private now: () => Date = () => new Date(),
  ) {
    this.queue = queue ?? new DurableOperationQueue(store.control)
  }
  private driver(provider: ServerProvider): FleetDriver {
    const value = this.drivers.find((item) => item.provider === provider)
    if (!value) throw new Error(`No ${provider} fleet driver is configured.`)
    return value
  }
  enroll(input: {
    organizationId: string
    projectId: string
    name: string
    provider: ServerProvider
    providerId?: string
    region?: string
    zone?: string
    endpoint: string
    sshUser: string
    sshPort?: number
    credentialRef: string
    roles: ServerRole[]
    labels?: Record<string, string>
  }): FleetServer {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.name)) throw new Error('Server name is invalid.')
    if (!endpoint.test(input.endpoint) || input.sshUser === 'root' || !input.credentialRef.startsWith('secret://'))
      throw new Error('Enrollment requires a valid endpoint, non-root SSH user, and secret credential reference.')
    const existing = input.providerId
      ? this.store.findProvider(input.organizationId, input.provider, input.providerId)
      : undefined
    if (existing)
      return this.store.update(existing.id, { endpoint: input.endpoint, region: input.region, zone: input.zone })
    const resource = this.store.control.createResource({
        projectId: input.projectId,
        kind: 'server',
        slug: input.name,
        name: input.name,
        provider: input.provider,
        providerId: input.providerId,
      }),
      driver = this.driver(input.provider)
    return this.store.create({
      ...input,
      resourceId: resource.id,
      sshPort: input.sshPort ?? 22,
      labels: input.labels ?? {},
      taints: [],
      capacity: {},
      usage: {},
      capabilities: driver.capabilities(),
      status: 'pending',
      trustState: 'unverified',
    })
  }
  async test(id: string): Promise<FleetServer> {
    const server = this.store.get(id)
    if (!server) throw new Error('Server was not found.')
    const result = await this.driver(server.provider).test(server)
    if (!result.reachable) return this.store.update(id, { status: 'unreachable' })
    if (server.hostKeyFingerprint && server.hostKeyFingerprint !== result.hostKeyFingerprint)
      return this.store.update(id, {
        status: 'degraded',
        trustState: 'rotation_pending',
        pendingHostKey: result.hostKeyFingerprint,
      })
    return this.store.update(id, {
      hostKeyAlgorithm: result.hostKeyAlgorithm,
      hostKeyFingerprint: result.hostKeyFingerprint,
      pendingHostKey: undefined,
      trustState: 'pinned',
      status: 'validating',
      lastSeenAt: this.now().toISOString(),
    })
  }
  reviewHostKey(id: string, fingerprint: string): FleetServer {
    const server = this.store.get(id)
    if (!server || server.pendingHostKey !== fingerprint) throw new Error('Pending host key does not match.')
    return this.store.update(id, {
      hostKeyFingerprint: fingerprint,
      pendingHostKey: undefined,
      trustState: 'pinned',
      status: 'validating',
    })
  }
  async validate(id: string): Promise<FleetServer> {
    const server = this.store.get(id)
    if (!server || server.trustState !== 'pinned') throw new Error('Pin the SSH host key before validation.')
    const facts = await this.driver(server.provider).validate(server),
      findings: ValidationFinding[] = []
    if (!['x64', 'arm64', 'x86_64', 'aarch64'].includes(facts.arch ?? ''))
      findings.push({
        code: 'arch.unsupported',
        severity: 'error',
        message: 'Unsupported architecture.',
        remediation: 'Use x86_64 or arm64 Linux.',
      })
    for (const tool of ['curl', 'tar'])
      if (!facts.tools?.[tool])
        findings.push({
          code: `tool.${tool}`,
          severity: 'error',
          message: `${tool} is missing.`,
          remediation: `Install ${tool} before bootstrap.`,
        })
    if (Math.abs(facts.timeSkewSeconds ?? 0) > 60)
      findings.push({
        code: 'time.skew',
        severity: 'error',
        message: 'Clock skew exceeds 60 seconds.',
        remediation: 'Enable NTP synchronization.',
      })
    if (!facts.dnsOk)
      findings.push({
        code: 'dns.failed',
        severity: 'error',
        message: 'DNS validation failed.',
        remediation: 'Repair resolver configuration.',
      })
    const validation: ServerValidation = {
        valid: !findings.some((value) => value.severity === 'error'),
        facts,
        findings,
        validatedAt: this.now().toISOString(),
        validatorVersion: '1',
      },
      capacity: Record<string, number> = {
        cpu: facts.cpuCores ?? 0,
        memoryBytes: facts.memoryBytes ?? 0,
        diskBytes: facts.diskBytes ?? 0,
      }
    return this.store.update(id, { validation, capacity, status: validation.valid ? 'ready' : 'degraded' })
  }
  bootstrap(id: string, confirmed: boolean = false): FleetBootstrapResult {
    const server = this.store.get(id)
    if (!server?.validation?.valid) throw new Error('A healthy validation report is required.')
    const steps = [
      'install runtime dependencies',
      'install ts-cloud agent',
      'configure heartbeat',
      'verify least-privilege access',
    ]
    if (!confirmed) return { preview: true, steps }
    const operation = this.queue.enqueue({
      projectId: server.projectId,
      resourceId: server.resourceId,
      kind: 'fleet.bootstrap',
      input: { serverId: id, steps },
      lockKey: `server:${id}`,
      providerKey: server.provider,
    }).operation
    return { preview: false, steps, operation }
  }
  heartbeat(
    id: string,
    input: { usage: Record<string, number>; capabilities?: FleetServer['capabilities'] },
  ): FleetServer {
    const server = this.store.get(id)
    if (!server) throw new Error('Server was not found.')
    const at = this.now().toISOString()
    return this.store.update(id, {
      usage: input.usage,
      capabilities: input.capabilities ?? server.capabilities,
      heartbeatAt: at,
      lastSeenAt: at,
      status: server.status === 'draining' || server.status === 'drained' ? server.status : 'ready',
    })
  }
  drain(id: string, drained: boolean = false): FleetServer {
    return this.store.update(id, { status: drained ? 'drained' : 'draining' })
  }
  uncordon(id: string): FleetServer {
    return this.store.update(id, { status: 'ready' })
  }
  archive(id: string, confirmation: string): FleetServer {
    const server = this.store.get(id)
    if (!server || confirmation !== server.name) throw new Error('Exact server name confirmation is required.')
    return this.store.update(id, { status: 'archived', archivedAt: this.now().toISOString() })
  }
}
