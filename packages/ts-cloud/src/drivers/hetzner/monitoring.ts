import type { HetznerClient, HetznerServerMetrics } from './client'
import type { RemoteExecOptions } from '../shared/remote-exec'
import { sshExecOrThrow } from '../shared/remote-exec'

export interface HetznerHostHistoryPoint {
  timestamp: string
  cpuUsedPercent: number
  cpuUserPercent: number
  cpuSystemPercent: number
  cpuIowaitPercent: number
  memoryUsedPercent: number
  memoryUsedBytes: number
  memoryAvailableBytes: number
  swapUsedPercent: number
  swapUsedBytes: number
}

export interface HetznerProviderMetricPoint {
  timestamp: string
  value: number
}

export interface HetznerServerMonitoring {
  from: string
  to: string
  cores: number
  host: HetznerHostHistoryPoint[]
  provider: Record<string, HetznerProviderMetricPoint[]>
  summary: {
    cpuAveragePercent: number | null
    cpuPeakPercent: number | null
    memoryAveragePercent: number | null
    memoryPeakPercent: number | null
    memoryMinimumAvailableBytes: number | null
    swapPeakPercent: number | null
  }
}

interface SadfTimestamp {
  date?: string
  time?: string
}

interface SadfStatistic {
  timestamp?: SadfTimestamp
  'cpu-load'?: Array<{
    cpu?: string
    user?: number
    system?: number
    iowait?: number
    idle?: number
  }>
  memory?: {
    memused?: number
    'memused-percent'?: number
    avail?: number
    swpused?: number
    'swpused-percent'?: number
  }
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function bytesFromKiB(value: unknown): number {
  return finite(value) * 1024
}

function timestamp(value: SadfTimestamp | undefined): string | null {
  const date = value?.date?.trim()
  const time = value?.time?.trim()
  if (!date || !time) return null
  const instant = new Date(`${date}T${time}Z`)
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null
}

export function parseSadfHostHistory(raw: string, from: Date, to: Date): HetznerHostHistoryPoint[] {
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const statistics = (parsed?.sysstat?.hosts ?? []).flatMap(
    (host: { statistics?: SadfStatistic[] }) => host.statistics ?? [],
  ) as SadfStatistic[]
  const points: HetznerHostHistoryPoint[] = []
  for (const statistic of statistics) {
    const at = timestamp(statistic.timestamp)
    if (!at) continue
    const time = new Date(at).getTime()
    if (time < from.getTime() || time > to.getTime()) continue
    const cpu = statistic['cpu-load']?.find(item => item.cpu === 'all') ?? statistic['cpu-load']?.[0]
    const idle = finite(cpu?.idle, 100)
    points.push({
      timestamp: at,
      cpuUsedPercent: Math.max(0, Math.min(100, 100 - idle)),
      cpuUserPercent: finite(cpu?.user),
      cpuSystemPercent: finite(cpu?.system),
      cpuIowaitPercent: finite(cpu?.iowait),
      memoryUsedPercent: finite(statistic.memory?.['memused-percent']),
      memoryUsedBytes: bytesFromKiB(statistic.memory?.memused),
      memoryAvailableBytes: bytesFromKiB(statistic.memory?.avail),
      swapUsedPercent: finite(statistic.memory?.['swpused-percent']),
      swapUsedBytes: bytesFromKiB(statistic.memory?.swpused),
    })
  }
  return points.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

export function providerMetricSeries(metrics: HetznerServerMetrics): Record<string, HetznerProviderMetricPoint[]> {
  return Object.fromEntries(
    Object.entries(metrics.time_series ?? {}).map(([name, series]) => [
      name,
      (series.values ?? [])
        .map(([seconds, value]) => ({
          timestamp: new Date(Number(seconds) * 1000).toISOString(),
          value: finite(value, Number.NaN),
        }))
        .filter(point => Number.isFinite(point.value)),
    ]),
  )
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function maximum(values: number[]): number | null {
  return values.length ? Math.max(...values) : null
}

function minimum(values: number[]): number | null {
  return values.length ? Math.min(...values) : null
}

export async function collectHetznerServerMonitoring(options: {
  client: HetznerClient
  serverId: number
  cores: number
  from: Date
  to: Date
  step?: number
  remote: RemoteExecOptions & { host: string }
}): Promise<HetznerServerMonitoring> {
  const [providerMetrics, sadf] = await Promise.all([
    options.client.getServerMetrics(options.serverId, {
      types: ['cpu', 'disk', 'network'],
      start: options.from,
      end: options.to,
      step: options.step,
    }),
    sshExecOrThrow(options.remote.host, 'LC_ALL=C sadf -j -- -u -r -S', options.remote).catch(() => ''),
  ])
  const host = parseSadfHostHistory(sadf, options.from, options.to)
  const provider = providerMetricSeries(providerMetrics)
  const providerCpu = provider.cpu ?? []
  const normalizedProviderCpu = providerCpu.map(point =>
    Math.max(0, Math.min(100, point.value / Math.max(1, options.cores))),
  )
  const hostCpu = host.map(point => point.cpuUsedPercent)
  const cpu = normalizedProviderCpu.length ? normalizedProviderCpu : hostCpu
  const memory = host.map(point => point.memoryUsedPercent)
  const swap = host.map(point => point.swapUsedPercent)

  return {
    from: options.from.toISOString(),
    to: options.to.toISOString(),
    cores: options.cores,
    host,
    provider,
    summary: {
      cpuAveragePercent: average(cpu),
      cpuPeakPercent: maximum(cpu),
      memoryAveragePercent: average(memory),
      memoryPeakPercent: maximum(memory),
      memoryMinimumAvailableBytes: minimum(host.map(point => point.memoryAvailableBytes)),
      swapPeakPercent: maximum(swap),
    },
  }
}
