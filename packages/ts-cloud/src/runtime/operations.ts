import type { CloudConfig, CloudDriver, ComputeTarget, EnvironmentType } from '@ts-cloud/core'
import type { ECSClient } from '../aws/ecs'
import type { CloudWatchLogsClient } from '../aws/cloudwatch-logs'
import { CloudWatchLogsClient as LiveCloudWatchLogsClient } from '../aws/cloudwatch-logs'
import { ECSClient as LiveECSClient } from '../aws/ecs'
import { createCloudDriver } from '../drivers'
import type { LifecycleAction, RuntimeInventory, RuntimeWorkload } from './model'
import { resolveRuntimeInventory } from './service'

const MAX_OUTPUT_BYTES = 64 * 1024
const SAFE_SYSTEMD = /^[A-Za-z0-9_.@:-]+\.service$/
const SAFE_CONTAINER = /^[a-fA-F0-9]{12,128}$/
const SENSITIVE_PATHS = ['/boot', '/dev', '/etc', '/proc', '/root', '/run', '/sys', '/var/run']

export interface RuntimeOperationInput {
  workloadId: string
  action: LifecycleAction
  confirm?: string
  replicas?: number
  recentAuth?: boolean
}

export interface RuntimeOperationResult {
  ok: boolean
  workloadId: string
  action: LifecycleAction
  command?: string
  stdout?: string
  stderr?: string
  error?: string
  workload?: RuntimeWorkload
}

export interface RuntimeLogResult {
  workloadId: string
  provider: RuntimeWorkload['provider']
  lines: Array<{ timestamp?: string, message: string }>
  nextCursor?: string
  truncated: boolean
}

interface EcsMutator extends Pick<ECSClient, 'scaleService' | 'forceNewDeployment'> {}
interface LogReader extends Pick<CloudWatchLogsClient, 'filterLogEvents'> {}

export interface RuntimeOperationDependencies {
  driver?: CloudDriver
  ecs?: EcsMutator
  logs?: LogReader
  inventory?: () => Promise<RuntimeInventory>
}

function bounded(value: string): string {
  const encoded = Buffer.from(value)
  return encoded.byteLength <= MAX_OUTPUT_BYTES ? value : `${encoded.subarray(0, MAX_OUTPUT_BYTES - 24).toString('utf8')}\n[output truncated]`
}

function safeCount(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.min(10_000, Math.max(0, Math.floor(value!))) : fallback
}

function ecsTarget(workload: RuntimeWorkload): { cluster: string, service: string } | undefined {
  const config = workload.config as { clusterArn?: unknown }
  const cluster = typeof config.clusterArn === 'string' ? config.clusterArn : undefined
  const service = workload.links.providerId || workload.name
  return cluster && service ? { cluster, service } : undefined
}

function remoteTarget(targets: ComputeTarget[], workload: RuntimeWorkload): ComputeTarget | undefined {
  return targets.find(target => target.id === workload.links.server) ?? (targets.length === 1 ? targets[0] : undefined)
}

function remoteLifecycleCommand(workload: RuntimeWorkload, action: LifecycleAction): string[] | undefined {
  if (workload.provider === 'systemd') {
    const unit = workload.links.providerId
    if (!unit || !SAFE_SYSTEMD.test(unit) || !['start', 'stop', 'restart'].includes(action)) return undefined
    return [`systemctl ${action} ${unit}`, `systemctl is-active ${unit} 2>/dev/null || true`]
  }
  if (workload.provider === 'docker') {
    const id = workload.links.providerId
    if (!id || !SAFE_CONTAINER.test(id) || !['start', 'stop', 'restart'].includes(action)) return undefined
    return [`docker ${action} ${id}`, `docker inspect --format '{{.State.Status}}' ${id}`]
  }
  return undefined
}

/**
 * Permit file operations only below a service-owned root or a discovered bind/
 * volume target. Host-sensitive trees stay forbidden even if a mount points at
 * one. This function never follows the requested path on the dashboard host.
 */
export function authorizeRuntimePath(_workload: RuntimeWorkload, _requested: string): { ok: true, path: string } | { ok: false, error: string } {
  if (!_requested.startsWith('/') || _requested.includes('\0')) return { ok: false, error: 'An absolute path is required.' }
  const segments: string[] = []
  for (const segment of _requested.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!segments.length) return { ok: false, error: 'Path traversal is not allowed.' }
      segments.pop()
    }
    else segments.push(segment)
  }
  const normalized = `/${segments.join('/')}`
  if (SENSITIVE_PATHS.some(root => normalized === root || normalized.startsWith(`${root}/`))) return { ok: false, error: 'Sensitive host paths are not available through runtime file access.' }
  const project = _workload.links.project?.replace(/[^A-Za-z0-9_-]/g, '')
  const service = _workload.links.service?.replace(/[^A-Za-z0-9_-]/g, '')
  const allowed = [
    ...(project && service ? [`/var/www/${project}/${service}`, `/srv/${project}/${service}`] : []),
    ..._workload.mounts.map(mount => mount.target).filter(path => path.startsWith('/')),
  ]
  if (!allowed.some(root => normalized === root || normalized.startsWith(`${root.replace(/\/$/, '')}/`))) return { ok: false, error: 'Path is outside this service’s owned roots.' }
  return { ok: true, path: normalized }
}

export const DIAGNOSTIC_PRESETS = {
  process: ['ps', '-eo', 'pid,ppid,user,%cpu,%mem,etime,command', '--sort=-%cpu'],
  sockets: ['ss', '-lntup'],
  filesystem: ['df', '-h'],
} as const

export class RuntimeOperationService {
  private readonly region: string
  private readonly profile?: string
  constructor(private readonly config: CloudConfig, private readonly environment: EnvironmentType, private readonly dependencies: RuntimeOperationDependencies = {}) {
    this.region = config.aws?.region ?? config.project.region ?? 'us-east-1'
    this.profile = config.aws?.profile
  }

  async inventory(): Promise<RuntimeInventory> {
    return this.dependencies.inventory?.() ?? resolveRuntimeInventory(this.config, this.environment, { driver: this.dependencies.driver })
  }

  async workload(id: string): Promise<RuntimeWorkload | undefined> {
    return (await this.inventory()).workloads.find(workload => workload.id === id)
  }

  async run(input: RuntimeOperationInput): Promise<RuntimeOperationResult> {
    const workload = await this.workload(input.workloadId)
    const base = { workloadId: input.workloadId, action: input.action }
    if (!workload) return { ...base, ok: false, error: 'Workload was not found in the current project and environment.' }
    const capability = workload.capabilities[input.action]
    if (!capability.supported) return { ...base, ok: false, error: capability.reason ?? `${input.action} is unsupported for ${workload.provider}.` }
    if (capability.requiresConfirmation && input.confirm !== workload.name) return { ...base, ok: false, error: `Type "${workload.name}" to ${input.action} this workload.` }
    if (capability.requiresRecentAuth && !input.recentAuth) return { ...base, ok: false, error: 'Sign in again before using elevated runtime access.' }
    if (input.action === 'inspect') return { ...base, ok: true, workload }

    if (workload.provider === 'systemd' || workload.provider === 'docker') {
      const commands = remoteLifecycleCommand(workload, input.action)
      if (!commands) return { ...base, ok: false, error: `${input.action} is not implemented for ${workload.provider}.` }
      const driver = this.dependencies.driver ?? createCloudDriver({ config: this.config })
      const targets = await driver.findComputeTargets({ slug: this.config.project.slug, environment: this.environment, role: 'app' })
      const target = remoteTarget(targets, workload)
      if (!target) return { ...base, ok: false, error: 'The workload server is no longer reachable in this scope.' }
      const result = await driver.runRemoteDeploy({ targets: [target], commands: ['set -uo pipefail', ...commands], timeoutSeconds: 60, comment: `ts-cloud runtime:${input.action}`, tags: { Project: this.config.project.slug, Environment: this.environment, Role: 'app' } })
      return { ...base, ok: result.success, command: commands[0], stdout: bounded(result.perInstance?.[0]?.output ?? ''), stderr: bounded(result.perInstance?.[0]?.error ?? result.error ?? ''), error: result.success ? undefined : (result.error ?? 'Runtime operation failed.') }
    }

    if (workload.provider === 'ecs') {
      const target = ecsTarget(workload)
      if (!target) return { ...base, ok: false, error: 'ECS cluster or service identity is unavailable.' }
      const ecs = this.dependencies.ecs ?? new LiveECSClient(this.region, this.profile)
      if (input.action === 'scale') {
        const replicas = safeCount(input.replicas, workload.desiredReplicas ?? 1)
        await ecs.scaleService(target.cluster, target.service, replicas)
        return { ...base, ok: true, command: `ecs scale ${workload.name} ${replicas}` }
      }
      if (input.action === 'start' || input.action === 'stop') {
        const replicas = input.action === 'stop' ? 0 : Math.max(1, workload.desiredReplicas ?? 1)
        await ecs.scaleService(target.cluster, target.service, replicas)
        return { ...base, ok: true, command: `ecs scale ${workload.name} ${replicas}` }
      }
      if (input.action === 'restart' || input.action === 'redeploy') {
        await ecs.forceNewDeployment(target.cluster, target.service)
        return { ...base, ok: true, command: `ecs redeploy ${workload.name}` }
      }
    }
    return { ...base, ok: false, error: `${input.action} is not implemented for ${workload.provider}.` }
  }

  async logs(workloadId: string, input: { limit?: number, since?: Date } = {}): Promise<RuntimeLogResult> {
    const workload = await this.workload(workloadId)
    if (!workload) throw new Error('Workload was not found in the current project and environment.')
    if (!workload.capabilities.logs.supported) throw new Error(workload.capabilities.logs.reason ?? 'Logs are unsupported for this workload.')
    const limit = Math.min(1000, Math.max(1, Math.floor(input.limit ?? 200)))
    if (workload.provider === 'lambda') {
      const logs = this.dependencies.logs ?? new LiveCloudWatchLogsClient(this.region, this.profile)
      const result = await logs.filterLogEvents({ logGroupName: `/aws/lambda/${workload.name}`, startTime: input.since?.getTime(), limit })
      const lines = (result.events ?? []).slice(0, limit).map(event => ({ timestamp: event.timestamp == null ? undefined : new Date(event.timestamp).toISOString(), message: bounded(String(event.message ?? '')) }))
      return { workloadId, provider: workload.provider, lines, nextCursor: result.nextToken, truncated: (result.events?.length ?? 0) >= limit }
    }
    const driver = this.dependencies.driver ?? createCloudDriver({ config: this.config })
    const targets = await driver.findComputeTargets({ slug: this.config.project.slug, environment: this.environment, role: 'app' })
    const target = remoteTarget(targets, workload)
    if (!target) throw new Error('The workload server is no longer reachable in this scope.')
    const providerId = workload.links.providerId ?? ''
    const command = workload.provider === 'systemd' && SAFE_SYSTEMD.test(providerId)
      ? `journalctl -u ${providerId} --no-pager -n ${limit} -o short-iso`
      : workload.provider === 'docker' && SAFE_CONTAINER.test(providerId)
        ? `docker logs --timestamps --tail ${limit} ${providerId} 2>&1`
        : undefined
    if (!command) throw new Error('Log target identity is invalid.')
    const result = await driver.runRemoteDeploy({ targets: [target], commands: [command], timeoutSeconds: 30, comment: 'ts-cloud runtime:logs', tags: { Project: this.config.project.slug, Environment: this.environment, Role: 'app' } })
    if (!result.success) throw new Error(result.error ?? result.perInstance?.[0]?.error ?? 'Log read failed.')
    const raw = bounded(result.perInstance?.[0]?.output ?? '')
    const lines = raw.split('\n').filter(Boolean).slice(-limit).map((message) => {
      const match = /^(\d{4}-\d{2}-\d{2}T\S+)\s+(.*)$/.exec(message)
      return { timestamp: match?.[1], message: match?.[2] ?? message }
    })
    return { workloadId, provider: workload.provider, lines, truncated: raw.includes('[output truncated]') || lines.length >= limit }
  }
}
