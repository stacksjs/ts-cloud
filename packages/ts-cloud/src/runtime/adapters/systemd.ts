import type { RuntimeDiscoveryAdapter, RuntimeDiscoveryContext, RuntimeWorkload } from '../model'
import { capabilities, runtimeId } from '../model'
import { ageSeconds, bytes, normalizeRuntimeStatus, redactRuntimeConfig } from '../normalize'

export interface SystemdUnitRecord {
  unit: string
  load?: string
  active?: string
  sub?: string
  description?: string
  enabled?: string
  pid?: number
  memoryBytes?: number
  restartCount?: number
  activeSince?: string
  fragmentPath?: string
  workingDirectory?: string
  user?: string
  environment?: Record<string, string>
}

export function parseSystemdRecords(output: string): SystemdUnitRecord[] {
  const records: SystemdUnitRecord[] = []
  for (const line of output.split('\n')) {
    if (!line.startsWith('TSCLOUD_SYSTEMD\t')) continue
    const [
      ,
      unit,
      load,
      active,
      sub,
      description,
      enabled,
      pid,
      memory,
      restarts,
      since,
      fragment,
      workingDirectory,
      user,
    ] = line.split('\t')
    if (!unit || !/^[A-Za-z0-9_.@:-]+\.service$/.test(unit)) continue
    records.push({
      unit,
      load,
      active,
      sub,
      description,
      enabled,
      pid: Number(pid) || undefined,
      memoryBytes: bytes(memory),
      restartCount: Number(restarts) || 0,
      activeSince: since || undefined,
      fragmentPath: fragment || undefined,
      workingDirectory: workingDirectory?.startsWith('/') ? workingDirectory : undefined,
      user: user || undefined,
    })
  }
  return records
}

export function systemdWorkloads(
  records: SystemdUnitRecord[],
  context: RuntimeDiscoveryContext,
  sourceId: string = context.server ?? 'local',
): RuntimeWorkload[] {
  const now = context.now ?? new Date()
  return records.map((record) => {
    const status = normalizeRuntimeStatus(record.active === 'active' ? record.sub || record.active : record.active)
    const name = record.unit.replace(/\.service$/, '')
    const managedService =
      /^(.*?) (?:release [^ ]+|queue worker|daemon |scheduler)(?: |$)/.exec(record.description ?? '')?.[1] ??
      (context.project && name.startsWith(`${context.project}-`)
        ? name.slice(context.project.length + 1).split('@', 1)[0]
        : undefined)
    const release = name.includes('@') ? name.slice(name.indexOf('@') + 1) : undefined
    const mounts = record.workingDirectory ? [{ target: record.workingDirectory, type: 'working-directory' }] : []
    const supported = [
      'start',
      'stop',
      'restart',
      'logs',
      'exec',
      'inspect',
      ...(mounts.length ? ['files'] : []),
    ] as import('../model').LifecycleAction[]
    return {
      id: runtimeId('systemd', sourceId, record.unit),
      provider: 'systemd',
      kind: 'service',
      name,
      displayName: record.description || name,
      status,
      rawStatus: [record.load, record.active, record.sub].filter(Boolean).join('/'),
      health: status === 'running' ? 'healthy' : status === 'failed' ? 'unhealthy' : 'unknown',
      desiredReplicas: 1,
      runningReplicas: status === 'running' ? 1 : 0,
      ageSeconds: ageSeconds(record.activeSince, now),
      restartCount: record.restartCount,
      tags: { enabled: record.enabled ?? 'unknown' },
      links: {
        project: context.project,
        environment: context.environment,
        server: context.server ?? sourceId.replace(/^systemd:/, ''),
        service: managedService,
        release,
        providerId: record.unit,
      },
      resources: { memoryBytes: record.memoryBytes },
      replicas: [
        {
          id: runtimeId('systemd', sourceId, `${record.unit}:main`),
          name: 'main',
          status,
          pid: record.pid,
          startedAt: record.activeSince,
          restartCount: record.restartCount,
          resources: { memoryBytes: record.memoryBytes },
        },
      ],
      networks: [],
      mounts,
      capabilities: capabilities(
        supported,
        mounts.length
          ? 'This systemd runtime does not support redeploy or replica scaling through the scoped explorer'
          : 'File transfer requires a provider-reported service working directory; redeploy and scaling are unavailable',
      ),
      config: redactRuntimeConfig({
        fragmentPath: record.fragmentPath,
        workingDirectory: record.workingDirectory,
        user: record.user,
        environment: record.environment,
        enabled: record.enabled,
      }),
      discoveredAt: now.toISOString(),
      sourceId,
    }
  })
}

export class SystemdDiscoveryAdapter implements RuntimeDiscoveryAdapter {
  readonly id: string
  readonly provider = 'systemd' as const
  constructor(
    private readonly read: (context: RuntimeDiscoveryContext) => Promise<string>,
    id = 'systemd:local',
  ) {
    this.id = id
  }
  async discover(context: RuntimeDiscoveryContext): Promise<RuntimeWorkload[]> {
    return systemdWorkloads(parseSystemdRecords(await this.read(context)), context, this.id)
  }
}
