import type { CLI } from '@stacksjs/clapp'
import type { EnvironmentType } from '@ts-cloud/core'
import type { LifecycleAction, RuntimeInventory, RuntimeWorkload } from '../../src/runtime'
import { readFile, writeFile } from 'node:fs/promises'
import { initializeDashboardControlPlane } from '../../src/deploy/dashboard-control-plane'
import { DurableOperationQueue } from '../../src/queue'
import { RuntimeOperationService } from '../../src/runtime'
import * as output from '../../src/utils/cli'
import { loadValidatedConfig } from './shared'

interface RuntimeOptions {
  env?: string
  provider?: string
  status?: string
  search?: string
  json?: boolean
}

function age(seconds?: number): string {
  if (seconds == null) return '—'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

function memory(bytes?: number): string {
  return bytes == null ? '—' : output.formatBytes(bytes)
}

export function runtimeRows(workloads: RuntimeWorkload[]): string[][] {
  return workloads.map(workload => [
    workload.id,
    workload.name,
    workload.provider,
    workload.kind,
    workload.status,
    workload.desiredReplicas == null ? '—' : `${workload.runningReplicas ?? 0}/${workload.desiredReplicas}`,
    workload.image ?? workload.runtime ?? '—',
    memory(workload.resources?.memoryBytes ?? workload.resources?.memoryLimitBytes),
    age(workload.ageSeconds),
  ])
}

function filterInventory(inventory: RuntimeInventory, options: RuntimeOptions): RuntimeInventory {
  const query = options.search?.toLowerCase()
  return {
    ...inventory,
    workloads: inventory.workloads.filter(workload =>
      (!options.provider || workload.provider === options.provider)
      && (!options.status || workload.status === options.status)
      && (!query || `${workload.name} ${workload.id} ${workload.links.service ?? ''} ${Object.values(workload.tags).join(' ')}`.toLowerCase().includes(query))),
  }
}

async function context(environment?: string) {
  const config = await loadValidatedConfig()
  const env = (environment ?? Object.keys(config.environments ?? {})[0] ?? 'production') as EnvironmentType
  if (!Object.hasOwn(config.environments ?? {}, env)) throw new Error(`Environment ${env} was not found`)
  const service = new RuntimeOperationService(config, env)
  return { config, env, service }
}

async function confirmedName(workload: RuntimeWorkload, supplied?: string): Promise<string> {
  if (supplied !== undefined) return supplied
  return output.prompt(`Type ${workload.name} to confirm`, '')
}

async function durableOperation(
  workload: RuntimeWorkload,
  action: LifecycleAction,
  replicas: number | undefined,
  confirm: string,
  environment: EnvironmentType,
  service: RuntimeOperationService,
): Promise<{ result: Awaited<ReturnType<RuntimeOperationService['run']>>, operationId: string }> {
  return durableRuntimeTask(workload, `runtime.${action}`, { workloadId: workload.id, provider: workload.provider, action, replicas: replicas ?? null }, environment, () => service.run({ workloadId: workload.id, action, replicas, confirm, recentAuth: true }))
}

async function durableRuntimeTask<T extends { ok: boolean, stdout?: string, stderr?: string, error?: string, command?: string }>(
  workload: RuntimeWorkload,
  kind: string,
  input: Record<string, unknown>,
  environment: EnvironmentType,
  execute: () => Promise<T>,
): Promise<{ result: T, operationId: string }> {
  const config = await loadValidatedConfig()
  const controlPlane = initializeDashboardControlPlane(process.cwd(), config)
  const queue = new DurableOperationQueue(controlPlane.store, { workerId: `cli:${process.pid}` })
  try {
    const environmentRecord = controlPlane.environments.get(environment)
    const resource = controlPlane.store.listResources(controlPlane.project.id, environmentRecord?.id).find(item => item.slug === workload.links.service)
    const actor = controlPlane.store.getActorByExternalId('system', 'cli') ?? controlPlane.store.createActor({ kind: 'system', externalId: 'cli', displayName: 'ts-cloud CLI', metadata: { source: 'cli' } })
    const queued = queue.enqueue({
      projectId: controlPlane.project.id,
      environmentId: environmentRecord?.id,
      resourceId: resource?.id,
      actorId: actor.id,
      kind,
      input,
      lockKey: resource ? `resource:${resource.id}` : `runtime:${workload.id}`,
      providerKey: workload.provider,
      maxAttempts: 1,
      timeoutSeconds: 3600,
      resumePolicy: 'fail',
      cancellationMode: 'provider_non_cancellable',
      retentionDays: 90,
    }).operation
    if (!queue.claim(queued.id)) throw new Error(`Workload is locked by another operation. Inspect ${queued.id} with cloud ops:show.`)
    try {
      const result = await execute()
      if (result.stdout) queue.appendLog(queued.id, result.stdout, { stream: 'stdout' })
      if (result.stderr) queue.appendLog(queued.id, result.stderr, { stream: 'stderr' })
      if (result.ok) queue.complete(queued.id, { ok: true, command: result.command ?? null })
      else queue.fail(queued.id, result.error ?? result.stderr ?? 'Runtime operation failed', { ok: false })
      return { result, operationId: queued.id }
    }
    catch (error) {
      queue.fail(queued.id, error instanceof Error ? error.message : String(error), { ok: false, threw: true })
      throw error
    }
  }
  finally { controlPlane.store.close() }
}

export function registerRuntimeCommands(app: CLI): void {
  app.command('runtime:list', 'List services, containers, ECS tasks, and Lambda functions')
    .option('--env <environment>', 'Target environment')
    .option('--provider <provider>', 'Filter systemd, docker, ecs, or lambda')
    .option('--status <status>', 'Filter normalized runtime status')
    .option('--search <query>', 'Search names, IDs, services, and tags')
    .option('--json', 'Print normalized JSON')
    .action(async (options: RuntimeOptions) => {
      try {
        const { service } = await context(options.env)
        const inventory = filterInventory(await service.inventory(), options)
        if (options.json) output.info(JSON.stringify(inventory, null, 2))
        else {
          output.table(['ID', 'Name', 'Provider', 'Kind', 'Status', 'Replicas', 'Image / runtime', 'Memory', 'Age'], runtimeRows(inventory.workloads))
          for (const source of inventory.sources.filter(source => source.status !== 'fresh')) output.warn(`${source.id}: ${source.status}${source.message ? ` — ${source.message}` : ''}`)
        }
      }
      catch (error) { output.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
    })

  app.command('runtime:inspect <workload>', 'Inspect normalized config, replicas, networks, mounts, links, and capabilities')
    .option('--env <environment>', 'Target environment')
    .action(async (id: string, options: { env?: string }) => {
      try {
        const { service } = await context(options.env)
        const workload = await service.workload(id)
        if (!workload) throw new Error('Workload was not found in this project and environment')
        output.info(JSON.stringify(workload, null, 2))
      }
      catch (error) { output.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
    })

  app.command('runtime:logs <workload>', 'Read bounded logs for one authorized runtime target')
    .option('--env <environment>', 'Target environment')
    .option('--lines <count>', 'Maximum log lines', { default: '200' })
    .option('--json', 'Print structured JSON')
    .action(async (id: string, options: { env?: string, lines?: string, json?: boolean }) => {
      try {
        const { service } = await context(options.env)
        const logs = await service.logs(id, { limit: Number(options.lines) || 200 })
        if (options.json) output.info(JSON.stringify(logs, null, 2))
        else for (const line of logs.lines) console.log(`${line.timestamp ?? '—'} ${line.message}`)
      }
      catch (error) { output.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
    })

  app.command('runtime:action <workload> <action>', 'Start, stop, restart, redeploy, or scale one workload')
    .option('--env <environment>', 'Target environment')
    .option('--replicas <count>', 'Desired replicas for scale')
    .option('--confirm <name>', 'Exact workload name confirmation')
    .action(async (id: string, rawAction: string, options: { env?: string, replicas?: string, confirm?: string }) => {
      try {
        const action = rawAction as LifecycleAction
        if (!['start', 'stop', 'restart', 'redeploy', 'scale'].includes(action)) throw new Error('Action must be start, stop, restart, redeploy, or scale')
        const replicas = options.replicas == null ? undefined : Number(options.replicas)
        if (action === 'scale' && (!Number.isInteger(replicas) || replicas! < 0)) throw new Error('Scale requires a non-negative integer --replicas value')
        const { env, service } = await context(options.env)
        const inventory = await service.inventory()
        const workload = inventory.workloads.find(item => item.id === id)
        if (!workload) throw new Error('Workload was not found in this project and environment')
        const scoped = new RuntimeOperationService((await loadValidatedConfig()), env, { inventory: async () => inventory })
        const result = await durableOperation(workload, action, replicas, await confirmedName(workload, options.confirm), env, scoped)
        if (!result.result.ok) throw new Error(result.result.error ?? result.result.stderr ?? 'Runtime operation failed')
        output.success(`${action} completed for ${workload.name} · operation ${result.operationId}`)
        if (result.result.stdout) output.info(result.result.stdout)
      }
      catch (error) { output.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
    })

  app.command('runtime:exec <workload>', 'Run a scoped diagnostic preset or container command')
    .option('--env <environment>', 'Target environment')
    .option('--preset <preset>', 'Read-only preset: process, sockets, or filesystem')
    .option('--command <command>', 'Free-form command (Docker containers only)')
    .option('--confirm <name>', 'Exact workload name confirmation')
    .action(async (id: string, options: { env?: string, preset?: string, command?: string, confirm?: string }) => {
      try {
        const { env, service } = await context(options.env)
        const inventory = await service.inventory(); const workload = inventory.workloads.find(item => item.id === id)
        if (!workload) throw new Error('Workload was not found in this project and environment')
        const preset = ['process', 'sockets', 'filesystem'].includes(String(options.preset)) ? options.preset as 'process' | 'sockets' | 'filesystem' : undefined
        if (options.preset && !preset) throw new Error('Preset must be process, sockets, or filesystem')
        if (!preset && !options.command) throw new Error('Pass --preset or --command')
        const confirm = await confirmedName(workload, options.confirm)
        const result = await durableRuntimeTask(workload, 'runtime.exec', { workloadId: id, provider: workload.provider, preset: preset ?? null, freeForm: !!options.command }, env, () => service.exec({ workloadId: id, preset, command: options.command, confirm, recentAuth: true }))
        if (!result.result.ok) throw new Error(result.result.error ?? result.result.stderr ?? 'Exec failed')
        if (result.result.stdout) output.info(result.result.stdout)
        if (result.result.stderr) output.warn(result.result.stderr)
        output.success(`Exec completed for ${workload.name} · operation ${result.operationId}`)
      }
      catch (error) { output.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
    })

  app.command('runtime:download <workload> <remote> <local>', 'Download a bounded file from a service-owned path')
    .option('--env <environment>', 'Target environment')
    .option('--confirm <name>', 'Exact workload name confirmation')
    .action(async (id: string, remote: string, local: string, options: { env?: string, confirm?: string }) => {
      try {
        const { env, service } = await context(options.env)
        const inventory = await service.inventory(); const workload = inventory.workloads.find(item => item.id === id)
        if (!workload) throw new Error('Workload was not found in this project and environment')
        const confirm = await confirmedName(workload, options.confirm)
        const result = await durableRuntimeTask(workload, 'runtime.file.read', { workloadId: id, provider: workload.provider, path: remote }, env, () => service.readFile({ workloadId: id, path: remote, confirm, recentAuth: true }))
        if (!result.result.ok || !result.result.contentBase64) throw new Error(result.result.error ?? 'File download failed')
        await writeFile(local, Buffer.from(result.result.contentBase64, 'base64'))
        output.success(`Downloaded ${result.result.size ?? 0} bytes to ${local} · operation ${result.operationId}${result.result.truncated ? ' (truncated)' : ''}`)
      }
      catch (error) { output.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
    })

  app.command('runtime:upload <workload> <local> <remote>', 'Upload and atomically replace a file in a service-owned path')
    .option('--env <environment>', 'Target environment')
    .option('--confirm <name>', 'Exact workload name confirmation')
    .action(async (id: string, local: string, remote: string, options: { env?: string, confirm?: string }) => {
      try {
        const { env, service } = await context(options.env)
        const inventory = await service.inventory(); const workload = inventory.workloads.find(item => item.id === id)
        if (!workload) throw new Error('Workload was not found in this project and environment')
        const confirm = await confirmedName(workload, options.confirm); const contentBase64 = (await readFile(local)).toString('base64')
        const result = await durableRuntimeTask(workload, 'runtime.file.write', { workloadId: id, provider: workload.provider, path: remote, bytes: Buffer.from(contentBase64, 'base64').byteLength }, env, () => service.writeFile({ workloadId: id, path: remote, contentBase64, confirm, recentAuth: true }))
        if (!result.result.ok) throw new Error(result.result.error ?? 'File upload failed')
        output.success(`Uploaded ${result.result.size ?? 0} bytes to ${remote} · operation ${result.operationId}`)
      }
      catch (error) { output.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
    })
}
