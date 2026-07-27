import type { HetznerAction, HetznerClient, HetznerServer, HetznerServerType } from './client'
import { HetznerActionError, HetznerApiError } from './client'

export type HetznerResizePhase =
  | 'planning'
  | 'waiting-capacity'
  | 'preflight'
  | 'shutting-down'
  | 'resizing'
  | 'powering-on'
  | 'verifying'
  | 'recovering'
  | 'complete'

export interface HetznerResizePlan {
  serverId: number
  serverName: string
  location: string
  currentType: HetznerServerType
  targetType: HetznerServerType
  capacityAvailable: boolean
  alreadyComplete: boolean
  upgradeDisk: boolean
}

export interface HetznerResizeVerification {
  ok: boolean
  checks?: Record<string, boolean | number | string>
  failures?: string[]
}

export interface HetznerResizeHooks<TManifest = unknown> {
  preflight?: (
    server: HetznerServer,
    target: HetznerServerType,
  ) => Promise<TManifest> | TManifest
  afterBoot?: (
    server: HetznerServer,
    target: HetznerServerType,
    manifest: TManifest | undefined,
    context: { recovered: boolean },
  ) => Promise<HetznerResizeVerification> | HetznerResizeVerification
  onPhase?: (
    phase: HetznerResizePhase,
    detail?: Record<string, unknown>,
  ) => Promise<void> | void
}

export interface HetznerResizeClient {
  getServer(id: number): Promise<HetznerServer>
  getServerType(name: string): Promise<HetznerServerType | null>
  shutdownServer(id: number): Promise<HetznerAction>
  powerOnServer(id: number): Promise<HetznerAction>
  changeServerType(id: number, serverType: string, upgradeDisk: boolean): Promise<HetznerAction>
  waitForAction(
    actionId: number,
    options?: { pollIntervalMs?: number; maxWaitMs?: number },
  ): Promise<HetznerAction>
  waitForServerRunning(
    serverId: number,
    options?: { pollIntervalMs?: number; maxWaitMs?: number },
  ): Promise<HetznerServer>
  waitForServerStatus(
    serverId: number,
    status: string,
    options?: { pollIntervalMs?: number; maxWaitMs?: number },
  ): Promise<HetznerServer>
}

export interface ExecuteHetznerResizeOptions<TManifest = unknown> {
  client: HetznerResizeClient
  serverId: number
  targetType: string
  upgradeDisk?: boolean
  /** Continue a recorded resize after the process stopped with the server off. */
  resumeFromOff?: boolean
  /** Manifest restored from a durable checkpoint when resuming. */
  manifest?: TManifest
  /** Ignore the best-effort stock flag and ask the placement API anyway. */
  attemptUnavailable?: boolean
  hooks?: HetznerResizeHooks<TManifest>
  actionPollIntervalMs?: number
  actionTimeoutMs?: number
  serverPollIntervalMs?: number
  serverTimeoutMs?: number
}

export type HetznerResizeResult<TManifest = unknown> =
  | {
      status: 'waiting-capacity'
      plan: HetznerResizePlan
    }
  | {
      status: 'already-complete'
      plan: HetznerResizePlan
      verification?: HetznerResizeVerification
    }
  | {
      status: 'completed'
      plan: HetznerResizePlan
      server: HetznerServer
      manifest?: TManifest
      verification?: HetznerResizeVerification
    }
  | {
      status: 'recovered'
      plan: HetznerResizePlan
      server: HetznerServer
      manifest?: TManifest
      verification?: HetznerResizeVerification
      retryable: boolean
      error: string
    }

function serverLocation(server: HetznerServer): string {
  return server.location?.name ?? server.datacenter?.location.name ?? 'unknown'
}

function positive(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function assertCompatibleUpgrade(current: HetznerServerType, target: HetznerServerType): void {
  if (current.architecture && target.architecture && current.architecture !== target.architecture) {
    throw new Error(
      `Cannot resize ${current.name} (${current.architecture}) to ${target.name} (${target.architecture}) in place.`,
    )
  }

  const regressions: string[] = []
  if (positive(target.cores) < positive(current.cores)) regressions.push('CPU')
  if (positive(target.memory) < positive(current.memory)) regressions.push('memory')
  if (positive(target.disk) < positive(current.disk)) regressions.push('disk')
  if (regressions.length > 0) {
    throw new Error(
      `Refusing an in-place downgrade from ${current.name} to ${target.name}: ${regressions.join(', ')} would shrink.`,
    )
  }
}

export async function planHetznerServerResize(
  client: Pick<HetznerResizeClient, 'getServer' | 'getServerType'>,
  serverId: number,
  targetTypeName: string,
  upgradeDisk: boolean = true,
): Promise<HetznerResizePlan> {
  const [server, targetType] = await Promise.all([
    client.getServer(serverId),
    client.getServerType(targetTypeName),
  ])
  if (!targetType) throw new Error(`Hetzner server type ${targetTypeName} was not found.`)

  const currentType = server.server_type
  const alreadyComplete = currentType.name === targetType.name
  if (!alreadyComplete) assertCompatibleUpgrade(currentType, targetType)

  const location = serverLocation(server)
  const locationState = targetType.locations?.find((item) => item.name === location)

  return {
    serverId,
    serverName: server.name,
    location,
    currentType,
    targetType,
    capacityAvailable: locationState?.available !== false,
    alreadyComplete,
    upgradeDisk,
  }
}

export function isHetznerCapacityError(error: unknown): boolean {
  if (error instanceof HetznerApiError && error.code === 'resource_unavailable') return true
  if (error instanceof HetznerActionError) {
    if (error.action.error?.code === 'resource_unavailable') return true
    if (/no fitting vhost|placement|free resources/i.test(error.action.error?.message ?? '')) return true
  }
  return /resource_unavailable|no fitting vhost|error during placement|free resources/i.test(
    error instanceof Error ? error.message : String(error),
  )
}

async function phase(
  hooks: HetznerResizeHooks<unknown> | undefined,
  value: HetznerResizePhase,
  detail?: Record<string, unknown>,
): Promise<void> {
  await hooks?.onPhase?.(value, detail)
}

async function waitForAction(
  client: HetznerResizeClient,
  action: HetznerAction,
  options: Pick<ExecuteHetznerResizeOptions, 'actionPollIntervalMs' | 'actionTimeoutMs'>,
): Promise<void> {
  await client.waitForAction(action.id, {
    pollIntervalMs: options.actionPollIntervalMs,
    maxWaitMs: options.actionTimeoutMs,
  })
}

const ensurePoweredOn = async <TManifest>(
  {
    client,
    hooks,
    actionPollIntervalMs,
    actionTimeoutMs,
    serverPollIntervalMs,
    serverTimeoutMs,
  }: ExecuteHetznerResizeOptions<TManifest>,
  plan: HetznerResizePlan,
  manifest: TManifest | undefined,
  recovered: boolean,
): Promise<{
  server: HetznerServer
  verification?: HetznerResizeVerification
}> => {
  let server = await client.getServer(plan.serverId)
  if (server.status !== 'running') {
    await phase(hooks as HetznerResizeHooks<unknown>, recovered ? 'recovering' : 'powering-on', {
      serverId: plan.serverId,
    })
    const action = await client.powerOnServer(plan.serverId)
    await waitForAction(client, action, { actionPollIntervalMs, actionTimeoutMs })
    server = await client.waitForServerRunning(plan.serverId, {
      pollIntervalMs: serverPollIntervalMs,
      maxWaitMs: serverTimeoutMs,
    })
  }

  await phase(hooks as HetznerResizeHooks<unknown>, 'verifying', {
    serverId: plan.serverId,
    recovered,
  })
  const verification = await hooks?.afterBoot?.(server, plan.targetType, manifest, { recovered })
  return { server, verification }
}

export async function executeHetznerServerResize<TManifest = unknown>(
  options: ExecuteHetznerResizeOptions<TManifest>,
): Promise<HetznerResizeResult<TManifest>> {
  const { client, hooks } = options
  const upgradeDisk = options.upgradeDisk ?? true

  await phase(hooks as HetznerResizeHooks<unknown>, 'planning', {
    serverId: options.serverId,
    targetType: options.targetType,
  })
  const plan = await planHetznerServerResize(client, options.serverId, options.targetType, upgradeDisk)
  let server = await client.getServer(plan.serverId)

  if (plan.alreadyComplete) {
    const boot = await ensurePoweredOn(options, plan, options.manifest, false)
    await phase(hooks as HetznerResizeHooks<unknown>, 'complete', { alreadyComplete: true })
    return { status: 'already-complete', plan, verification: boot.verification }
  }

  if (!plan.capacityAvailable && !options.attemptUnavailable) {
    await phase(hooks as HetznerResizeHooks<unknown>, 'waiting-capacity', {
      location: plan.location,
      targetType: plan.targetType.name,
    })
    return { status: 'waiting-capacity', plan }
  }

  let manifest: TManifest | undefined = options.manifest
  if (server.status === 'off' && !options.resumeFromOff) {
    const recovered = await ensurePoweredOn(options, plan, undefined, true)
    return {
      status: 'recovered',
      plan,
      server: recovered.server,
      verification: recovered.verification,
      retryable: true,
      error: 'Server was already off without a resumable resize checkpoint; powered it back on.',
    }
  }

  if (server.status === 'running') {
    await phase(hooks as HetznerResizeHooks<unknown>, 'preflight', { serverId: plan.serverId })
    manifest = await hooks?.preflight?.(server, plan.targetType)

    await phase(hooks as HetznerResizeHooks<unknown>, 'shutting-down', { serverId: plan.serverId })
    const shutdown = await client.shutdownServer(plan.serverId)
    await waitForAction(client, shutdown, options)
    server = await client.waitForServerStatus(plan.serverId, 'off', {
      pollIntervalMs: options.serverPollIntervalMs,
      maxWaitMs: options.serverTimeoutMs,
    })
  }

  try {
    await phase(hooks as HetznerResizeHooks<unknown>, 'resizing', {
      serverId: plan.serverId,
      from: plan.currentType.name,
      to: plan.targetType.name,
      upgradeDisk,
    })
    const change = await client.changeServerType(plan.serverId, plan.targetType.name, upgradeDisk)
    await waitForAction(client, change, options)
  } catch (error) {
    const recovered = await ensurePoweredOn(options, plan, manifest, true)
    return {
      status: 'recovered',
      plan,
      server: recovered.server,
      manifest,
      verification: recovered.verification,
      retryable: isHetznerCapacityError(error),
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const boot = await ensurePoweredOn(options, plan, manifest, false)
  if (boot.verification && !boot.verification.ok) {
    throw new Error(`Resize completed but verification failed: ${(boot.verification.failures ?? []).join('; ')}`)
  }

  await phase(hooks as HetznerResizeHooks<unknown>, 'complete', {
    serverId: plan.serverId,
    targetType: plan.targetType.name,
  })
  return {
    status: 'completed',
    plan,
    server: boot.server,
    manifest,
    verification: boot.verification,
  }
}

export type HetznerResizeClientInstance = Pick<
  HetznerClient,
  | 'getServer'
  | 'getServerType'
  | 'shutdownServer'
  | 'powerOnServer'
  | 'changeServerType'
  | 'waitForAction'
  | 'waitForServerRunning'
  | 'waitForServerStatus'
>
