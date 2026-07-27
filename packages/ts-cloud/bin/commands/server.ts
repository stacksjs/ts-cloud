import type { CLI } from '@stacksjs/clapp'
import type { EnvironmentType } from '@ts-cloud/core'
import type { HetznerResizeCheckpoint } from '../../src/drivers/hetzner/resize-state'
import type { ServerProvider, ServerRole } from '../../src/fleet'
import { resolveProjectStackName } from '@ts-cloud/core'
import * as cli from '../../src/utils/cli'
import { initializeDashboardControlPlane } from '../../src/deploy/dashboard-control-plane'
import { HetznerClient, resolveHetznerApiToken } from '../../src/drivers/hetzner/client'
import { resolveHetznerSettings } from '../../src/drivers/hetzner/config'
import { buildHetznerFirewallRules } from '../../src/drivers/hetzner/firewall-rules'
import { collectHetznerServerMonitoring } from '../../src/drivers/hetzner/monitoring'
import {
  applyHetznerHostOptimization,
  collectHetznerHostOptimizationReport,
  resolveHetznerHostOptimizationPlan,
  verifyHetznerHostContinuity,
  verifyHetznerHostOptimization,
} from '../../src/drivers/hetzner/host-optimization'
import { resolveHetznerServerType } from '../../src/drivers/hetzner/instance-sizes'
import { executeHetznerServerResize, planHetznerServerResize } from '../../src/drivers/hetzner/resize'
import { collectHetznerResizeManifest, prepareHetznerResize, verifyHetznerResize } from '../../src/drivers/hetzner/resize-remote'
import { acquireResizeLock, readResizeCheckpoint, writeResizeCheckpoint } from '../../src/drivers/hetzner/resize-state'
import { readDriverState } from '../../src/drivers/hetzner/state'
import { usesRpxProxy } from '../../src/drivers/shared/rpx-gateway'
import { FleetService, FleetStore, SshFleetDriver } from '../../src/fleet'
import { unsupportedCommand } from './capability-command'
import { loadValidatedConfig } from './shared'

async function context() {
  const config = await loadValidatedConfig(),
    controlPlane = initializeDashboardControlPlane(process.cwd(), config),
    store = new FleetStore(controlPlane.store),
    service = new FleetService(store, [
      new SshFleetDriver('aws'),
      new SshFleetDriver('hetzner'),
      new SshFleetDriver('ssh'),
    ])
  return { controlPlane, store, service }
}
async function use<T>(callback: (value: Awaited<ReturnType<typeof context>>) => Promise<T>) {
  const value = await context()
  try {
    return await callback(value)
  } finally {
    value.controlPlane.store.close()
  }
}
const find = (value: Awaited<ReturnType<typeof context>>, name: string) => {
  const server = value.store.list(value.controlPlane.project.id).find((item) => item.id === name || item.name === name)
  if (!server) throw new Error(`Server ${name} was not found.`)
  return server
}
const fail = (error: unknown) => {
  cli.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

interface ResizeCommandOptions {
  env?: string
  apply?: boolean
  confirm?: string
  upgradeDisk?: boolean
  wait?: boolean
  pollSeconds?: string
  maxWaitMinutes?: string
  json?: boolean
}

interface OptimizeCommandOptions {
  env?: string
  apply?: boolean
  confirm?: string
  json?: boolean
}

interface MonitoringCommandOptions {
  env?: string
  range?: string
  step?: string
  json?: boolean
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function monitoringRange(value = '3h'): number {
  const match = value.match(/^(\d+)(m|h)$/)
  if (!match) throw new Error('--range must use minutes or hours, for example 30m or 3h.')
  const milliseconds = Number(match[1]) * (match[2] === 'h' ? 3_600_000 : 60_000)
  if (milliseconds < 5 * 60_000 || milliseconds > 24 * 3_600_000)
    throw new Error('--range must be between 5 minutes and 24 hours.')
  return milliseconds
}

function formatMonitoringValue(value: number | null, suffix = '%'): string {
  return value == null ? 'unavailable' : `${value.toFixed(1)}${suffix}`
}

async function runHetznerMonitoring(name: string, options: MonitoringCommandOptions): Promise<void> {
  const config = await loadValidatedConfig()
  if (config.cloud?.provider !== 'hetzner') throw new Error('server:monitoring currently requires the Hetzner provider.')

  const environment = (options.env ?? process.env.CLOUD_ENV ?? 'production') as EnvironmentType
  const stackName = resolveProjectStackName(config, environment)
  const driverState = await readDriverState(stackName)
  if (!driverState?.serverId) throw new Error(`No pinned Hetzner server was found for ${stackName}.`)
  if (![driverState.serverName, String(driverState.serverId), driverState.stackName].includes(name))
    throw new Error(`Refusing to read ${name}: project state is pinned to ${driverState.serverName}.`)

  const settings = resolveHetznerSettings(config)
  const client = new HetznerClient({ apiToken: resolveHetznerApiToken(settings.apiToken, config) })
  const server = await client.getServer(driverState.serverId)
  const host = driverState.publicIp ?? server.public_net.ipv4?.ip
  if (!host) throw new Error(`Server ${server.name} has no public IPv4 address.`)

  const to = new Date()
  const from = new Date(to.getTime() - monitoringRange(options.range))
  const step = Math.min(3600, Math.max(60, positiveInteger(options.step, 60)))
  const result = await collectHetznerServerMonitoring({
    client,
    serverId: server.id,
    cores: Math.max(1, Number(server.server_type.cores) || 1),
    from,
    to,
    step,
    remote: {
      host,
      user: driverState.sshUser ?? settings.sshUser,
      identityFile: settings.sshPrivateKeyPath,
      connectTimeoutSec: 15,
    },
  })

  if (options.json) {
    console.log(JSON.stringify({ schemaVersion: 1, server: server.name, result }, null, 2))
    return
  }
  cli.table(
    ['Server', 'Window', 'CPU average / peak', 'RAM average / peak', 'Minimum available', 'Swap peak'],
    [
      [
        server.name,
        `${result.from} to ${result.to}`,
        `${formatMonitoringValue(result.summary.cpuAveragePercent)} / ${formatMonitoringValue(result.summary.cpuPeakPercent)}`,
        `${formatMonitoringValue(result.summary.memoryAveragePercent)} / ${formatMonitoringValue(result.summary.memoryPeakPercent)}`,
        result.summary.memoryMinimumAvailableBytes == null
          ? 'unavailable'
          : `${(result.summary.memoryMinimumAvailableBytes / 1024 ** 3).toFixed(2)} GB`,
        formatMonitoringValue(result.summary.swapPeakPercent),
      ],
    ],
  )
}

function resizePlanOutput(plan: Awaited<ReturnType<typeof planHetznerServerResize>>) {
  const price = plan.targetType.prices?.find((item) => item.location === plan.location)
  return {
    serverId: plan.serverId,
    serverName: plan.serverName,
    location: plan.location,
    from: plan.currentType.name,
    to: plan.targetType.name,
    capacityAvailable: plan.capacityAvailable,
    alreadyComplete: plan.alreadyComplete,
    upgradeDisk: plan.upgradeDisk,
    target: {
      cores: plan.targetType.cores,
      memoryGb: plan.targetType.memory,
      diskGb: plan.targetType.disk,
      architecture: plan.targetType.architecture,
      cpuType: plan.targetType.cpu_type,
    },
    price: price
      ? {
          hourlyNet: price.price_hourly.net,
          hourlyGross: price.price_hourly.gross,
          monthlyNet: price.price_monthly.net,
          monthlyGross: price.price_monthly.gross,
        }
      : undefined,
  }
}

function logResizePlan(plan: Awaited<ReturnType<typeof planHetznerServerResize>>): void {
  const output = resizePlanOutput(plan)
  cli.table(
    ['Server', 'Location', 'Resize', 'Capacity', 'CPU / RAM / disk', 'Monthly'],
    [
      [
        `${output.serverName} (${output.serverId})`,
        output.location,
        `${output.from} -> ${output.to}`,
        output.capacityAvailable ? 'available' : 'waiting',
        `${output.target.cores ?? 0} / ${output.target.memoryGb ?? 0} GB / ${output.target.diskGb ?? 0} GB`,
        output.price?.monthlyGross ?? output.price?.monthlyNet ?? 'not reported',
      ],
    ],
  )
}

async function runHetznerResize(name: string, type: string, options: ResizeCommandOptions): Promise<void> {
  const config = await loadValidatedConfig()
  if (config.cloud?.provider !== 'hetzner') throw new Error('server:resize currently requires the Hetzner provider.')

  const environment = (options.env ?? process.env.CLOUD_ENV ?? 'production') as EnvironmentType
  const stackName = resolveProjectStackName(config, environment)
  const driverState = await readDriverState(stackName)
  const settings = resolveHetznerSettings(config)
  const client = new HetznerClient({ apiToken: resolveHetznerApiToken(settings.apiToken, config) })
  const recordedMatches =
    driverState &&
    (name === driverState.serverName || name === String(driverState.serverId) || name === driverState.stackName)
  const server = recordedMatches
    ? await client.getServer(driverState.serverId!)
    : (await client.listServers()).find((item) => item.name === name || String(item.id) === name)
  if (!server) throw new Error(`Hetzner server ${name} was not found.`)
  if (driverState?.serverId && driverState.serverId !== server.id) {
    throw new Error(`Refusing to resize ${name}: project state is pinned to server ${driverState.serverId}.`)
  }

  const targetType = resolveHetznerServerType(type)
  const upgradeDisk = options.upgradeDisk !== false
  const initialPlan = await planHetznerServerResize(client, server.id, targetType, upgradeDisk)
  if (options.json) console.log(JSON.stringify({ schemaVersion: 1, plan: resizePlanOutput(initialPlan) }, null, 2))
  else logResizePlan(initialPlan)
  if (!options.apply) {
    if (!options.json) cli.info(`Preview only. Re-run with --apply --confirm ${server.name} to execute.`)
    return
  }
  if (options.confirm !== server.name) {
    throw new Error(`Resize requires --confirm ${server.name}.`)
  }

  const host = driverState?.publicIp ?? server.public_net.ipv4?.ip
  if (!host) throw new Error(`Server ${server.name} has no public IPv4 address for verification.`)
  const remote = {
    host,
    user: driverState?.sshUser ?? settings.sshUser,
    identityFile: settings.sshPrivateKeyPath,
    connectTimeoutSec: 15,
    sshTimeoutMs: 10 * 60_000,
    routeTimeoutMs: 20_000,
  }
  const existing = await readResizeCheckpoint(stackName)
  const now = new Date().toISOString()
  let checkpoint: HetznerResizeCheckpoint = {
    schemaVersion: 1,
    operationId:
      existing?.targetType === targetType && existing.serverId === server.id
        ? existing.operationId
        : crypto.randomUUID(),
    stackName,
    serverId: server.id,
    serverName: server.name,
    sourceType: initialPlan.currentType.name,
    targetType,
    upgradeDisk,
    phase: 'planning',
    status: 'running',
    attempts: existing?.targetType === targetType ? existing.attempts : 0,
    startedAt: existing?.targetType === targetType ? existing.startedAt : now,
    updatedAt: now,
    manifest: existing?.targetType === targetType ? existing.manifest : undefined,
  }
  await writeResizeCheckpoint(checkpoint)

  const pollMs = positiveInteger(options.pollSeconds, 900) * 1000
  const maxWaitMs = positiveInteger(options.maxWaitMinutes, 0) * 60_000
  const waitStarted = Date.now()
  for (;; ) {
    const plan = await planHetznerServerResize(client, server.id, targetType, upgradeDisk)
    if (!plan.capacityAvailable && !plan.alreadyComplete) {
      checkpoint = {
        ...checkpoint,
        phase: 'waiting-capacity',
        status: 'waiting-capacity',
        updatedAt: new Date().toISOString(),
      }
      await writeResizeCheckpoint(checkpoint)
      if (!options.wait) {
        if (!options.json)
          cli.info(
            `${targetType} has no capacity in ${plan.location}. The server remains running and unchanged. Use --wait to poll safely.`,
          )
        return
      }
      if (maxWaitMs > 0 && Date.now() - waitStarted >= maxWaitMs) {
        throw new Error(`Timed out waiting for ${targetType} capacity in ${plan.location}.`)
      }
      if (!options.json) cli.info(`Waiting ${Math.round(pollMs / 1000)} seconds for ${targetType} capacity...`)
      await Bun.sleep(pollMs)
      continue
    }

    const releaseLock = await acquireResizeLock(stackName)
    try {
      const result = await (async () => {
        try {
          checkpoint = {
            ...checkpoint,
            status: 'running',
            attempts: checkpoint.attempts + 1,
            updatedAt: new Date().toISOString(),
          }
          await writeResizeCheckpoint(checkpoint)
          return await executeHetznerServerResize({
            client,
            serverId: server.id,
            targetType,
            upgradeDisk,
            resumeFromOff:
              checkpoint.phase === 'shutting-down' ||
              checkpoint.phase === 'resizing' ||
              checkpoint.phase === 'powering-on' ||
              checkpoint.phase === 'verifying',
            manifest: checkpoint.manifest,
            hooks: {
              preflight: async () => {
                const manifest = await prepareHetznerResize(remote)
                checkpoint = { ...checkpoint, manifest, updatedAt: new Date().toISOString() }
                await writeResizeCheckpoint(checkpoint)
                return manifest
              },
              afterBoot: async (_server, target, manifest, context) =>
                verifyHetznerResize(remote, target, manifest, context),
              onPhase: async (phase, detail) => {
                checkpoint = {
                  ...checkpoint,
                  phase,
                  status:
                    phase === 'waiting-capacity' ? 'waiting-capacity' : phase === 'complete' ? 'completed' : 'running',
                  updatedAt: new Date().toISOString(),
                }
                await writeResizeCheckpoint(checkpoint)
                if (!options.json) cli.info(`${phase}${detail ? ` ${JSON.stringify(detail)}` : ''}`)
              },
            },
          })
        } finally {
          await releaseLock()
        }
      })()
      checkpoint = {
        ...checkpoint,
        status:
          result.status === 'completed' || result.status === 'already-complete'
            ? 'completed'
            : result.status === 'recovered'
              ? 'recovered'
              : 'waiting-capacity',
        lastError: result.status === 'recovered' ? result.error : undefined,
        updatedAt: new Date().toISOString(),
      }
      await writeResizeCheckpoint(checkpoint)
      if (options.json) console.log(JSON.stringify({ schemaVersion: 1, result }, null, 2))
      else if (result.status === 'completed' || result.status === 'already-complete')
        cli.success(`${server.name} is on ${targetType} and passed full post-boot verification.`)
      else if (result.status === 'recovered' && result.retryable && options.wait) {
        cli.info(`Capacity race recovered safely. Waiting ${Math.round(pollMs / 1000)} seconds before retry.`)
        await Bun.sleep(pollMs)
        continue
      } else if (result.status === 'recovered') {
        throw new Error(`Resize did not complete and the original server was recovered: ${result.error}`)
      }
      return
    } catch (error) {
      checkpoint = {
        ...checkpoint,
        status: 'failed',
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      }
      await writeResizeCheckpoint(checkpoint)
      throw error
    }
  }
}

async function runHetznerHostOptimization(name: string, options: OptimizeCommandOptions): Promise<void> {
  const config = await loadValidatedConfig()
  if (config.cloud?.provider !== 'hetzner') throw new Error('server:optimize currently requires the Hetzner provider.')

  const environment = (options.env ?? process.env.CLOUD_ENV ?? 'production') as EnvironmentType
  const stackName = resolveProjectStackName(config, environment)
  const driverState = await readDriverState(stackName)
  if (!driverState?.serverId) throw new Error(`No pinned Hetzner server was found for ${stackName}.`)
  if (![driverState.serverName, String(driverState.serverId), driverState.stackName].includes(name))
    throw new Error(`Refusing to optimize ${name}: project state is pinned to ${driverState.serverName}.`)

  const settings = resolveHetznerSettings(config)
  const client = new HetznerClient({ apiToken: resolveHetznerApiToken(settings.apiToken, config) })
  const server = await client.getServer(driverState.serverId)
  const host = driverState.publicIp ?? server.public_net.ipv4?.ip
  if (!host) throw new Error(`Server ${server.name} has no public IPv4 address.`)

  const plan = resolveHetznerHostOptimizationPlan(config)
  if (options.json) console.log(JSON.stringify({ schemaVersion: 1, server: server.name, plan }, null, 2))
  else
    cli.table(
      ['Server', 'Firewall ports', 'Monitoring', 'Auto updates', 'Swap', 'SSH passwords'],
      [[server.name, plan.firewallPorts.join(','), plan.monitoring ? 'on' : 'off', plan.autoUpdates ? 'on' : 'off', `${plan.swapGb} GB`, 'disabled']],
    )

  if (!options.apply) {
    if (!options.json) cli.info(`Preview only. Re-run with --apply --confirm ${server.name} to execute.`)
    return
  }
  if (options.confirm !== server.name) throw new Error(`Optimization requires --confirm ${server.name}.`)

  const remote = {
    host,
    user: driverState.sshUser ?? settings.sshUser,
    identityFile: settings.sshPrivateKeyPath,
    connectTimeoutSec: 15,
  }
  const before = await collectHetznerResizeManifest(remote)
  const unhealthyBefore = before.routeProbes.filter(probe => !probe.ok)
  const compute = config.infrastructure?.compute
  const retiredProxyUnits = usesRpxProxy(compute)
    ? new Set(['nginx.service', 'bun-gateway.service', 'ts-cloud-nginx.service'])
    : new Set<string>()
  const blockingFailedUnits = before.failedUnits.filter(unit => !retiredProxyUnits.has(unit))
  if (blockingFailedUnits.length > 0)
    throw new Error(`Preflight found failed services: ${blockingFailedUnits.join(', ')}`)
  if (unhealthyBefore.length > 0)
    throw new Error(`Preflight found unhealthy routes: ${unhealthyBefore.map(probe => probe.domain).join(', ')}`)

  const sitePorts = usesRpxProxy(compute)
    ? []
    : Object.values(config.sites ?? {}).flatMap(site =>
        typeof site?.port === 'number' && ![80, 443].includes(site.port) ? [site.port] : [],
      )
  const desiredFirewall = buildHetznerFirewallRules({
    allowSsh: compute?.allowSsh !== false,
    sitePorts,
    allowedPorts: compute?.firewall?.allowedPorts,
  })
  const firewall =
    (driverState.firewallId
      ? (await client.listFirewalls()).find(item => item.id === driverState.firewallId)
      : undefined) ??
    (await client.listFirewalls()).find(item => item.name === `${config.project.slug}-${environment}-app-fw`)
  if (!firewall) throw new Error(`Managed firewall for ${server.name} was not found.`)
  const firewallActions = await client.setFirewallRules(firewall.id, desiredFirewall)
  await Promise.all(firewallActions.map(action => client.waitForAction(action.id)))

  await applyHetznerHostOptimization(config, remote)
  const [after, report] = await Promise.all([
    collectHetznerResizeManifest(remote),
    collectHetznerHostOptimizationReport(remote),
  ])
  const failures = verifyHetznerHostOptimization(plan, report)
  const continuity = verifyHetznerHostContinuity(before, after)
  const unhealthyAfter = after.routeProbes.filter(probe => !probe.ok)
  if (continuity.stoppedServices.length > 0)
    failures.push(`services stopped: ${continuity.stoppedServices.join(', ')}`)
  if (continuity.changedRouteFragments.length > 0)
    failures.push(`route fragments changed: ${continuity.changedRouteFragments.join(', ')}`)
  if (continuity.missingRouteIds.length > 0)
    failures.push(`routes disappeared: ${continuity.missingRouteIds.join(', ')}`)
  if (continuity.changedReleaseLinks.length > 0)
    failures.push(`release links changed: ${continuity.changedReleaseLinks.join(', ')}`)
  if (continuity.missingData.length > 0)
    failures.push(`databases or volumes disappeared: ${continuity.missingData.join(', ')}`)
  if (unhealthyAfter.length > 0)
    failures.push(`unhealthy routes: ${unhealthyAfter.map(probe => probe.domain).join(', ')}`)
  if (failures.length > 0) throw new Error(`Host optimization verification failed: ${failures.join('; ')}`)

  const result = {
    serverId: server.id,
    serverName: server.name,
    services: after.runningServices.length,
    routes: after.routeIds.length,
    healthyDomains: after.routeProbes.length,
    releaseLinks: after.releaseLinks.length,
    databasesAndVolumes: after.dataCatalog.length,
    report,
  }
  if (options.json) console.log(JSON.stringify({ schemaVersion: 1, result }, null, 2))
  else cli.success(`${server.name} passed full host, rpx route, service, release, and data verification.`)
}

export function registerServerCommands(app: CLI): void {
  app
    .command('capabilities [server]', 'Show provider and target operation support')
    .option('--json', 'Print structured JSON')
    .action(async (name: string | undefined, options: { json?: boolean }) => {
      try {
        await use(async (value) => {
          const targets = name ? [find(value, name)] : value.store.list(value.controlPlane.project.id),
            rows = targets.flatMap((server) =>
              Object.entries(server.capabilities).map(([action, capability]) => ({
                server: server.name,
                provider: server.provider,
                action,
                ...capability,
              })),
            )
          if (options.json) console.log(JSON.stringify({ schemaVersion: 1, targets: rows }, null, 2))
          else
            cli.table(
              ['Server', 'Provider', 'Action', 'Support', 'Explanation'],
              rows.map((item) => [
                item.server,
                item.provider,
                item.action,
                item.supported ? 'supported' : 'unsupported',
                item.reason ?? '—',
              ]),
            )
        })
      } catch (error) {
        fail(error)
      }
    })
  app
    .command('server:resize <name> <type>', 'Safely resize Hetzner compute with full host verification')
    .option('--env <environment>', 'Deployment environment', { default: 'production' })
    .option('--apply', 'Execute the reviewed resize plan')
    .option('--confirm <name>', 'Exact server name required for mutation')
    .option('--upgrade-disk', 'Permanently expand the root disk to the target size', { default: true })
    .option('--wait', 'Poll capacity without taking the server offline until placement is available')
    .option('--poll-seconds <seconds>', 'Capacity retry interval', { default: '900' })
    .option('--max-wait-minutes <minutes>', 'Stop waiting after this many minutes; 0 waits indefinitely', {
      default: '0',
    })
    .option('--json', 'Print structured JSON')
    .action(async (name: string, type: string, options: ResizeCommandOptions) => {
      try {
        await runHetznerResize(name, type, options)
      } catch (error) {
        fail(error)
      }
    })
  app
    .command('server:optimize <name>', 'Reconcile and verify a production Hetzner host')
    .option('--env <environment>', 'Deployment environment', { default: 'production' })
    .option('--apply', 'Apply the reviewed host optimization plan')
    .option('--confirm <name>', 'Exact server name required for mutation')
    .option('--json', 'Print structured JSON')
    .action(async (name: string, options: OptimizeCommandOptions) => {
      try {
        await runHetznerHostOptimization(name, options)
      } catch (error) {
        fail(error)
      }
    })
  app
    .command('server:monitoring <name>', 'Read historical Hetzner CPU, RAM, swap, disk, and network metrics')
    .option('--env <environment>', 'Deployment environment', { default: 'production' })
    .option('--range <duration>', 'Historical window from 5m to 24h', { default: '3h' })
    .option('--step <seconds>', 'Hetzner provider sample interval', { default: '60' })
    .option('--json', 'Print structured JSON')
    .action(async (name: string, options: MonitoringCommandOptions) => {
      try {
        await runHetznerMonitoring(name, options)
      } catch (error) {
        fail(error)
      }
    })
  app
    .command('server:list', 'List fleet servers')
    .option('--json', 'Print structured JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        await use(async (value) => {
          const servers = value.store.list(value.controlPlane.project.id)
          if (options.json) console.log(JSON.stringify(servers, null, 2))
          else
            cli.table(
              ['Name', 'Provider ID', 'Provider / region', 'Status / trust', 'Roles', 'CPU / memory', 'Heartbeat'],
              servers.map((item) => [
                item.name,
                item.providerId ?? '—',
                `${item.provider} / ${item.region ?? 'external'}`,
                `${item.status} / ${item.trustState}`,
                item.roles.join(','),
                `${item.capacity.cpu ?? 0} / ${item.capacity.memoryBytes ?? 0}`,
                item.heartbeatAt ?? 'never',
              ]),
            )
        })
      } catch (error) {
        fail(error)
      }
    })
  app
    .command('server:create <name>', 'Enroll a provisioned or existing server')
    .option('--provider <provider>', 'aws, hetzner, or ssh', { default: 'ssh' })
    .option('--provider-id <id>', 'Stable provider identity')
    .option('--endpoint <host>', 'SSH hostname or IP')
    .option('--user <user>', 'Non-root SSH user', { default: 'deploy' })
    .option('--credential-ref <ref>', 'Secret reference', { default: 'secret://fleet/agent' })
    .option('--region <region>', 'Provider region')
    .option('--roles <roles>', 'Comma-separated roles', { default: 'application' })
    .option('--labels <labels>', 'Comma-separated key=value labels')
    .action(async (name: string, options: any) => {
      try {
        await use(async (value) => {
          const provider = options.provider as ServerProvider
          if (!['aws', 'hetzner', 'ssh'].includes(provider) || !options.endpoint)
            throw new Error(
              'A supported --provider and --endpoint are required; provisioning and enrollment are separate operations.',
            )
          const server = value.service.enroll({
            organizationId: value.controlPlane.organization.id,
            projectId: value.controlPlane.project.id,
            name,
            provider,
            providerId: options.providerId,
            endpoint: options.endpoint,
            sshUser: options.user ?? 'deploy',
            credentialRef: options.credentialRef ?? 'secret://fleet/agent',
            region: options.region,
            roles: String(options.roles ?? 'application').split(',') as ServerRole[],
            labels: Object.fromEntries(
              String(options.labels ?? '')
                .split(',')
                .map((v) => v.split('='))
                .filter((v) => v[0] && v[1]),
            ),
          })
          cli.success(`Enrolled ${server.name} as ${server.id}; no remote mutation was performed.`)
        })
      } catch (error) {
        fail(error)
      }
    })
  app
    .command('server:validate <name>', 'Pin trust and validate a server')
    .option('--accept-host-key <fingerprint>', 'Accept reviewed rotation')
    .option('--json', 'Print JSON')
    .action(async (name: string, options: any) => {
      try {
        await use(async (value) => {
          let server = find(value, name)
          server = await value.service.test(server.id)
          if (server.trustState === 'rotation_pending') {
            if (!options.acceptHostKey)
              throw new Error(`Host key changed to ${server.pendingHostKey}; review it first.`)
            server = value.service.reviewHostKey(server.id, options.acceptHostKey)
          }
          const result = await value.service.validate(server.id)
          if (options.json) console.log(JSON.stringify(result.validation, null, 2))
          else
            cli.table(
              ['Severity', 'Code', 'Finding', 'Remediation'],
              (result.validation?.findings ?? []).map((v) => [v.severity, v.code, v.message, v.remediation ?? '—']),
            )
          if (!result.validation?.valid) process.exitCode = 1
        })
      } catch (error) {
        fail(error)
      }
    })
  app
    .command('server:bootstrap <name>', 'Preview or queue bootstrap')
    .option('--apply', 'Apply reviewed plan')
    .action(async (name: string, options: any) => {
      try {
        await use(async (value) => {
          const result = value.service.bootstrap(find(value, name).id, !!options.apply)
          if (result.preview)
            cli.table(
              ['Step'],
              result.steps.map((v) => [v]),
            )
          else cli.success(`Bootstrap queued: ${result.operation?.id}`)
        })
      } catch (error) {
        fail(error)
      }
    })
  app
    .command('server:drain <name>', 'Drain without terminating')
    .option('--complete', 'Mark movement complete')
    .action(async (name: string, options: any) => {
      try {
        await use(async (value) => cli.success(value.service.drain(find(value, name).id, !!options.complete).status))
      } catch (error) {
        fail(error)
      }
    })
  app.command('server:uncordon <name>', 'Return a server to scheduling').action(async (name: string) => {
    try {
      await use(async (value) => {
        value.service.uncordon(find(value, name).id)
        cli.success(`Uncordoned ${name}.`)
      })
    } catch (error) {
      fail(error)
    }
  })
  app
    .command('server:archive <name>', 'Archive inventory without termination')
    .option('--confirm <name>', 'Exact name')
    .action(async (name: string, options: any) => {
      try {
        await use(async (value) => {
          value.service.archive(find(value, name).id, options.confirm ?? '')
          cli.success(`Archived ${name}; provider infrastructure was not terminated.`)
        })
      } catch (error) {
        fail(error)
      }
    })
  app.command('server:ssh <name>', 'Open strict SSH using the enrolled endpoint').action(async (name: string) => {
    try {
      await use(async (value) => {
        const server = find(value, name)
        if (server.trustState !== 'pinned') throw new Error('Validate and pin the server host key first.')
        const child = Bun.spawn(
            [
              'ssh',
              '-p',
              String(server.sshPort),
              '-o',
              'StrictHostKeyChecking=yes',
              `${server.sshUser}@${server.endpoint}`,
            ],
            { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
          ),
          code = await child.exited
        if (code) process.exitCode = code
      })
    } catch (error) {
      fail(error)
    }
  })
  for (const [name, description] of [
    ['server:logs <name>', 'Use the runtime log service'],
    ['server:deploy <name>', 'Use immutable release deployment'],
    ['server:reboot <name>', 'Reboot provider compute'],
    ['server:destroy <name>', 'Terminate provider compute'],
    ['server:recipe <name> <recipe>', 'Apply a server recipe'],
    ['server:firewall:add <name> <rule>', 'Add firewall rule'],
    ['server:firewall:list <name>', 'List firewall rules'],
    ['server:firewall:remove <name> <rule>', 'Remove firewall rule'],
    ['server:ssl:install <domain>', 'Install TLS'],
    ['server:ssl:renew <domain>', 'Renew TLS'],
    ['server:snapshot <name>', 'Create provider snapshot'],
    ['server:snapshot:restore <name> <snapshot-id>', 'Restore provider snapshot'],
    ['server:update <name>', 'Update OS packages'],
    ['server:secure <name>', 'Apply OS hardening'],
  ] as const)
    app.command(name, description).action(async (...args: any[]) =>
      unsupportedCommand(name.split(' ')[0]!, {
        target: String(args[0] ?? ''),
        nextAction:
          'Use the dashboard capability view or the corresponding runtime, release, firewall, backup, or maintenance service.',
      }),
    )
}
