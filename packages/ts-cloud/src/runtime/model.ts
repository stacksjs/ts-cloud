export type WorkloadProvider = 'systemd' | 'docker' | 'oci' | 'ecs' | 'lambda'
export type WorkloadKind = 'service' | 'container' | 'task' | 'function' | 'process'
export type WorkloadStatus = 'starting' | 'running' | 'degraded' | 'stopping' | 'stopped' | 'failed' | 'unknown'
export type LifecycleAction =
  'start' | 'stop' | 'restart' | 'redeploy' | 'scale' | 'logs' | 'exec' | 'inspect' | 'files'

export interface RuntimeLink {
  project?: string
  environment?: string
  service?: string
  release?: string
  deployment?: string
  server?: string
  providerId?: string
}

export interface RuntimeResourceUsage {
  cpuPercent?: number
  memoryBytes?: number
  memoryLimitBytes?: number
  ephemeralBytes?: number
  ephemeralLimitBytes?: number
}

export interface RuntimeNetwork {
  id: string
  name?: string
  mode?: string
  addresses?: string[]
  ports?: Array<{ container?: number; host?: number; protocol?: string; address?: string }>
}

export interface RuntimeMount {
  source?: string
  target: string
  type?: string
  readOnly?: boolean
}

export interface RuntimeContainer {
  id: string
  name: string
  image?: string
  imageDigest?: string
  runtime?: string
  status: WorkloadStatus
  rawStatus?: string
  exitCode?: number
  reason?: string
  resources?: RuntimeResourceUsage
  networks?: RuntimeNetwork[]
  mounts?: RuntimeMount[]
}

export interface RuntimeReplica {
  id: string
  name?: string
  status: WorkloadStatus
  rawStatus?: string
  createdAt?: string
  startedAt?: string
  stoppedAt?: string
  restartCount?: number
  host?: string
  pid?: number
  containers?: RuntimeContainer[]
  resources?: RuntimeResourceUsage
}

export interface LifecycleCapability {
  supported: boolean
  reason?: string
  requiresRecentAuth?: boolean
  requiresConfirmation?: boolean
}

export type LifecycleCapabilities = Record<LifecycleAction, LifecycleCapability>

export interface RuntimeWorkload {
  id: string
  provider: WorkloadProvider
  kind: WorkloadKind
  name: string
  displayName?: string
  status: WorkloadStatus
  rawStatus?: string
  health?: 'healthy' | 'unhealthy' | 'unknown'
  desiredReplicas?: number
  runningReplicas?: number
  image?: string
  runtime?: string
  version?: string
  architecture?: string
  ageSeconds?: number
  restartCount?: number
  tags: Record<string, string>
  links: RuntimeLink
  resources?: RuntimeResourceUsage
  replicas: RuntimeReplica[]
  networks: RuntimeNetwork[]
  mounts: RuntimeMount[]
  capabilities: LifecycleCapabilities
  config: Record<string, unknown>
  discoveredAt: string
  sourceId: string
}

export interface RuntimeSourceStatus {
  id: string
  provider: WorkloadProvider
  status: 'fresh' | 'stale' | 'unreachable' | 'unauthorized' | 'error'
  discoveredAt: string
  staleAfterSeconds: number
  message?: string
  itemCount: number
}

export interface RuntimeInventory {
  generatedAt: string
  workloads: RuntimeWorkload[]
  sources: RuntimeSourceStatus[]
  degraded: boolean
}

export interface RuntimeDiscoveryContext {
  project?: string
  environment?: string
  server?: string
  now?: Date
}

export interface RuntimeDiscoveryAdapter {
  id: string
  provider: WorkloadProvider
  discover(context: RuntimeDiscoveryContext): Promise<RuntimeWorkload[]>
}

export function runtimeId(provider: WorkloadProvider, source: string, nativeId: string): string {
  return [provider, source, nativeId].map((value) => encodeURIComponent(value)).join(':')
}

export function unsupportedCapabilities(reason: string): LifecycleCapabilities {
  return Object.fromEntries(
    (['start', 'stop', 'restart', 'redeploy', 'scale', 'logs', 'exec', 'inspect', 'files'] as LifecycleAction[]).map(
      (action) => [action, { supported: false, reason }],
    ),
  ) as LifecycleCapabilities
}

export function capabilities(
  supported: LifecycleAction[],
  unsupportedReason: string,
  elevated: LifecycleAction[] = ['exec', 'files'],
): LifecycleCapabilities {
  const result = unsupportedCapabilities(unsupportedReason)
  for (const action of supported) {
    result[action] = {
      supported: true,
      requiresConfirmation: !['logs', 'inspect'].includes(action),
      requiresRecentAuth: elevated.includes(action),
    }
  }
  return result
}
