import type { RuntimeContainer, RuntimeDiscoveryAdapter, RuntimeDiscoveryContext, RuntimeMount, RuntimeNetwork, RuntimeWorkload } from '../model'
import { capabilities, runtimeId } from '../model'
import { ageSeconds, normalizeRuntimeStatus, redactRuntimeConfig } from '../normalize'

export interface DockerInspectRecord {
  Id: string
  Name?: string
  Config?: { Image?: string, Labels?: Record<string, string>, Env?: string[] }
  State?: { Status?: string, Running?: boolean, StartedAt?: string, FinishedAt?: string, ExitCode?: number, Error?: string, OOMKilled?: boolean, Restarting?: boolean }
  RestartCount?: number
  HostConfig?: { NetworkMode?: string, Memory?: number, NanoCpus?: number }
  Mounts?: Array<{ Source?: string, Destination?: string, Type?: string, RW?: boolean }>
  NetworkSettings?: { Networks?: Record<string, { NetworkID?: string, IPAddress?: string, GlobalIPv6Address?: string }>, Ports?: Record<string, Array<{ HostIp?: string, HostPort?: string }> | null> }
  Image?: string
}

export function parseDockerInspect(output: string): DockerInspectRecord[] {
  const trimmed = output.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed)
  if (!Array.isArray(parsed)) throw new Error('Docker inspect output must be an array')
  return parsed.filter(item => item && typeof item.Id === 'string')
}

function dockerNetworks(record: DockerInspectRecord): RuntimeNetwork[] {
  const ports = Object.entries(record.NetworkSettings?.Ports ?? {}).flatMap(([target, bindings]) => {
    const [container, protocol] = target.split('/')
    return (bindings ?? []).map(binding => ({ container: Number(container) || undefined, host: Number(binding.HostPort) || undefined, protocol, address: binding.HostIp }))
  })
  return Object.entries(record.NetworkSettings?.Networks ?? {}).map(([name, network]) => ({
    id: network.NetworkID || name,
    name,
    mode: record.HostConfig?.NetworkMode,
    addresses: [network.IPAddress, network.GlobalIPv6Address].filter(Boolean) as string[],
    ports,
  }))
}

function dockerMounts(record: DockerInspectRecord): RuntimeMount[] {
  return (record.Mounts ?? []).filter(mount => !!mount.Destination).map(mount => ({ source: mount.Source, target: mount.Destination!, type: mount.Type, readOnly: mount.RW === false }))
}

export function dockerWorkloads(records: DockerInspectRecord[], context: RuntimeDiscoveryContext, sourceId: string = context.server ?? 'local'): RuntimeWorkload[] {
  const now = context.now ?? new Date()
  return records.map((record) => {
    const rawStatus = record.State?.OOMKilled ? 'oomkilled' : (record.State?.Restarting ? 'starting' : record.State?.Status)
    const status = normalizeRuntimeStatus(rawStatus)
    const name = (record.Name ?? record.Id.slice(0, 12)).replace(/^\//, '')
    const labels = record.Config?.Labels ?? {}
    const mounts = dockerMounts(record)
    const networks = dockerNetworks(record)
    const container: RuntimeContainer = {
      id: record.Id,
      name,
      image: record.Config?.Image,
      imageDigest: record.Image,
      runtime: 'docker',
      status,
      rawStatus,
      exitCode: record.State?.ExitCode,
      reason: record.State?.Error,
      resources: { memoryLimitBytes: record.HostConfig?.Memory || undefined },
      networks,
      mounts,
    }
    return {
      id: runtimeId('docker', sourceId, record.Id), provider: 'docker', kind: 'container', name, status, rawStatus,
      health: status === 'running' ? 'healthy' : (status === 'failed' ? 'unhealthy' : 'unknown'),
      desiredReplicas: 1, runningReplicas: status === 'running' ? 1 : 0, image: record.Config?.Image, runtime: 'docker',
      ageSeconds: ageSeconds(record.State?.StartedAt, now), restartCount: record.RestartCount ?? 0, tags: labels,
      links: { project: context.project, environment: context.environment, server: context.server, service: labels['com.docker.compose.service'] ?? labels['ts-cloud.service'] ?? name, release: labels['ts-cloud.release'], providerId: record.Id },
      resources: container.resources, replicas: [{ id: runtimeId('docker', sourceId, `${record.Id}:0`), name, status, rawStatus, startedAt: record.State?.StartedAt, stoppedAt: record.State?.FinishedAt, restartCount: record.RestartCount, containers: [container], resources: container.resources }],
      networks, mounts, capabilities: capabilities(['start', 'stop', 'restart', 'redeploy', 'logs', 'exec', 'inspect', 'files'], 'standalone Docker containers cannot scale; scale the owning Compose service'),
      config: redactRuntimeConfig({ image: record.Config?.Image, labels, environmentKeys: (record.Config?.Env ?? []).map(value => value.split('=', 1)[0]), networkMode: record.HostConfig?.NetworkMode }),
      discoveredAt: now.toISOString(), sourceId,
    }
  })
}

export class DockerDiscoveryAdapter implements RuntimeDiscoveryAdapter {
  readonly id: string
  readonly provider = 'docker' as const
  constructor(private readonly inspect: (context: RuntimeDiscoveryContext) => Promise<string>, id = 'docker:local') { this.id = id }
  async discover(context: RuntimeDiscoveryContext): Promise<RuntimeWorkload[]> { return dockerWorkloads(parseDockerInspect(await this.inspect(context)), context, this.id) }
}
