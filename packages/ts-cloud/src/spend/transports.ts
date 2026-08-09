/**
 * Making an enforcement action affect real traffic.
 *
 * `appliers.ts` writes the gate; this is the part that talks to a provider. The
 * split matters: the gate is what makes a cap true, and a transport is a
 * best-effort effect on top of it, so a provider outage leaves the cap in force
 * rather than silently open.
 *
 * Two rules every method here obeys:
 *
 *   1. **Return what it takes to undo.** A cap that cannot be lifted is an
 *      outage, so each method returns the prior state rather than assuming a
 *      default to restore to. "There was no reserved concurrency" and "reserved
 *      concurrency was 50" need different restores.
 *   2. **Never widen the blast radius.** On a shared box, stopping the gateway
 *      would take down every other tenant on it to save one project money. The
 *      compute transport stops the project's own units and says so.
 */
import type { CloudFrontClient } from '../aws/cloudfront'
import type { LambdaClient } from '../aws/lambda'
import type { JsonValue } from '../control-plane'
import type { SpendEnforcementTransport } from './appliers'
import type { DdosConfig } from '../protection/ddos'
import { applyMitigationFactor } from '../protection/ddos'

/** Shell access to one box. Matches `sshExec` so a driver can pass it straight in. */
export type RemoteExec = (
  host: string,
  command: string,
) => Promise<{ code: number; stdout: string; stderr: string }>

function fail(label: string, result: { code: number; stderr: string }): void {
  if (result.code !== 0) throw new Error(`${label} failed (exit ${result.code}): ${result.stderr.trim().slice(0, 400)}`)
}

// ------------------------------------------------------------------- AWS

export interface AwsSpendTransportOptions {
  lambda: LambdaClient
  cloudfront?: CloudFrontClient
  /**
   * Resolve the Lambda functions in scope. A project usually has more than one
   * (http, queue, scheduler) and a cap should stop all of them, not just the
   * one that happens to be named first.
   */
  functions: (scope: { projectId?: string; environmentId?: string }) => Promise<string[]> | string[]
  /** Publish + alias flip after an env change, for provisioned-concurrency stacks. */
  republish?: (functionName: string) => Promise<void>
}

/**
 * AWS serverless enforcement.
 *
 * `suspend_functions` sets reserved concurrency to zero: triggers still fire,
 * Lambda rejects the invocation, nothing runs, and one call reverses it. The
 * alternatives are worse — deleting the function loses its triggers, and
 * detaching the event source mapping is a multi-step change that is easy to
 * half-restore.
 *
 * `throttle_requests` is deliberately absent. Rate limiting in front of
 * CloudFront needs AWS WAF, which ts-cloud does not provision, and pretending
 * otherwise would report a cap as applied when nothing changed. The applier
 * marks it `unsupported: true` instead.
 */
export class AwsSpendTransport implements SpendEnforcementTransport {
  constructor(private readonly options: AwsSpendTransportOptions) {}

  private async targets(scope: { projectId?: string; environmentId?: string }): Promise<string[]> {
    const names = await this.options.functions(scope)
    if (names.length === 0) throw new Error('No Lambda functions were resolved for this scope.')
    return names
  }

  async suspendFunctions(scope: { projectId?: string; environmentId?: string }): Promise<Record<string, JsonValue>> {
    const names = await this.targets(scope)
    const previous: Record<string, JsonValue> = {}
    for (const name of names) {
      // Read before writing: restoring to "no limit" when there was a limit
      // would quietly raise the account's exposure after a cap lifts.
      previous[name] = await this.options.lambda.getFunctionConcurrency(name)
      await this.options.lambda.putFunctionConcurrency(name, 0)
    }
    return { kind: 'lambda_reserved_concurrency', previous }
  }

  async resumeFunctions(restore: Record<string, JsonValue>): Promise<void> {
    const previous = (restore.previous ?? {}) as Record<string, JsonValue>
    for (const [name, value] of Object.entries(previous)) {
      if (typeof value === 'number') await this.options.lambda.putFunctionConcurrency(name, value)
      else await this.options.lambda.deleteFunctionConcurrency(name)
    }
  }

  /**
   * Serve only what is already static.
   *
   * On AWS that is the same lever as suspending functions: the origin stops
   * rendering and CloudFront keeps serving S3 objects and cached responses.
   * Two ladder rungs mapping to one mechanism is honest here — the rungs differ
   * on other providers, and the restore payload records which one applied it.
   */
  async serveStatic(scope: { projectId?: string; environmentId?: string }): Promise<Record<string, JsonValue>> {
    return { ...(await this.suspendFunctions(scope)), via: 'serve_static' }
  }

  async restoreDynamic(restore: Record<string, JsonValue>): Promise<void> {
    await this.resumeFunctions(restore)
  }

  /**
   * Park all traffic behind a 503.
   *
   * `MAINTENANCE_MODE` is read by the serverless runtime adapter, so the
   * function still runs and answers 503 rather than erroring — which keeps the
   * bypass header working for whoever is fixing the problem.
   */
  async suspendProject(scope: { projectId?: string; environmentId?: string }): Promise<Record<string, JsonValue>> {
    const names = await this.targets(scope)
    const previous: Record<string, JsonValue> = {}
    for (const name of names) {
      const fn = await this.options.lambda.getFunction(name)
      const env = { ...(fn.Configuration?.Environment?.Variables ?? {}) } as Record<string, string>
      previous[name] = env.MAINTENANCE_MODE ?? null
      await this.options.lambda.updateFunctionConfiguration({
        FunctionName: name,
        Environment: { Variables: { ...env, MAINTENANCE_MODE: '1' } },
      })
      await this.options.republish?.(name)
    }
    return { kind: 'lambda_maintenance_mode', previous }
  }

  async resumeProject(restore: Record<string, JsonValue>): Promise<void> {
    const previous = (restore.previous ?? {}) as Record<string, JsonValue>
    for (const name of Object.keys(previous)) {
      const fn = await this.options.lambda.getFunction(name)
      const env = { ...(fn.Configuration?.Environment?.Variables ?? {}) } as Record<string, string>
      env.MAINTENANCE_MODE = typeof previous[name] === 'string' ? (previous[name] as string) : '0'
      await this.options.lambda.updateFunctionConfiguration({
        FunctionName: name,
        Environment: { Variables: env },
      })
      await this.options.republish?.(name)
    }
  }
}

// --------------------------------------------------------------- compute

export interface ComputeSpendTransportOptions {
  host: string
  exec: RemoteExec
  /**
   * Systemd unit bases for this scope, e.g. `acme-web`. The deploy runs each
   * release as `<base>@<releaseId>.service`, so the wildcard is what stops
   * whichever release is currently live.
   */
  units: (scope: { projectId?: string; environmentId?: string }) => Promise<string[]> | string[]
  /** Current L3/L4 config, so a throttle can re-render it with tighter limits. */
  ddos?: DdosConfig
  /** Renders the install script. Injected so the transport stays testable. */
  renderDdos?: (config: DdosConfig) => string
}

/**
 * Enforcement on a box we control over SSH.
 *
 * **What this deliberately does not do:** stop `rpx-gateway.service`. On a
 * shared box that gateway fronts every tenant, and taking it down to cap one
 * project's spend would be an outage for everyone else. Suspension here stops
 * the project's own units; requests then get whatever the gateway returns for
 * an origin that is down. That is a real, bounded effect, and the restore
 * payload records exactly which units were stopped.
 */
export class ComputeSpendTransport implements SpendEnforcementTransport {
  constructor(private readonly options: ComputeSpendTransportOptions) {}

  private async unitsFor(scope: { projectId?: string; environmentId?: string }): Promise<string[]> {
    const units = await this.options.units(scope)
    if (units.length === 0) throw new Error('No systemd units were resolved for this scope.')
    for (const unit of units)
      if (!/^[A-Za-z0-9@._-]+$/.test(unit)) throw new Error(`Refusing to act on an unsafe unit name: ${unit}`)
    return units
  }

  /** Stop the app units, recording the instances that were actually running. */
  private async stopUnits(scope: { projectId?: string; environmentId?: string }, via: string): Promise<Record<string, JsonValue>> {
    const bases = await this.unitsFor(scope)
    const stopped: string[] = []
    for (const base of bases) {
      // Record before stopping: a template unit has one live instance per
      // release, and restarting the wrong one would serve the wrong code.
      const listed = await this.options.exec(
        this.options.host,
        `systemctl list-units --plain --no-legend --state=active --type=service '${base}@*.service' '${base}.service' 2>/dev/null | awk '{print $1}'`,
      )
      fail(`listing units for ${base}`, listed)
      const active = listed.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^[A-Za-z0-9@._-]+\.service$/.test(line))
      for (const unit of active) {
        const result = await this.options.exec(this.options.host, `systemctl stop '${unit}'`)
        fail(`stopping ${unit}`, result)
        stopped.push(unit)
      }
    }
    return { kind: 'systemd_units', via, stopped }
  }

  private async startUnits(restore: Record<string, JsonValue>): Promise<void> {
    const stopped = Array.isArray(restore.stopped) ? (restore.stopped as unknown as string[]) : []
    for (const unit of stopped) {
      if (!/^[A-Za-z0-9@._-]+$/.test(unit)) continue
      const result = await this.options.exec(this.options.host, `systemctl start '${unit}'`)
      fail(`starting ${unit}`, result)
    }
  }

  async suspendFunctions(scope: { projectId?: string; environmentId?: string }): Promise<Record<string, JsonValue>> {
    return this.stopUnits(scope, 'suspend_functions')
  }

  async resumeFunctions(restore: Record<string, JsonValue>): Promise<void> {
    await this.startUnits(restore)
  }

  async serveStatic(scope: { projectId?: string; environmentId?: string }): Promise<Record<string, JsonValue>> {
    // The gateway keeps serving the site's built files; only the dynamic
    // process stops. Same lever as suspend_functions, different intent.
    return this.stopUnits(scope, 'serve_static')
  }

  async restoreDynamic(restore: Record<string, JsonValue>): Promise<void> {
    await this.startUnits(restore)
  }

  async suspendProject(scope: { projectId?: string; environmentId?: string }): Promise<Record<string, JsonValue>> {
    return this.stopUnits(scope, 'suspend_project')
  }

  async resumeProject(restore: Record<string, JsonValue>): Promise<void> {
    await this.startUnits(restore)
  }

  /**
   * Tighten the kernel's per-source connection limits.
   *
   * Reuses the same generator the deploy uses, so a throttle is the ordinary
   * ruleset with scaled thresholds rather than a second, divergent one. The
   * restore payload carries the original thresholds so lifting it re-renders
   * exactly what was there before.
   */
  async throttleRequests(input: {
    projectId?: string
    environmentId?: string
    factor: number
  }): Promise<Record<string, JsonValue>> {
    const render = this.options.renderDdos
    const base = this.options.ddos
    if (!render || !base) throw new Error('Request throttling needs a DDoS config and renderer on this transport.')
    const plan = { rateLimitFactor: input.factor } as Parameters<typeof applyMitigationFactor>[1]
    const thresholds = {
      ...base.thresholds,
      newConnectionsPerSecond: applyMitigationFactor(base.thresholds?.newConnectionsPerSecond ?? 50, plan),
      concurrentPerSource: applyMitigationFactor(base.thresholds?.concurrentPerSource ?? 100, plan),
    }
    const script = render({ ...base, thresholds })
    const result = await this.options.exec(this.options.host, `bash -s <<'TS_CLOUD_THROTTLE_EOF'\n${script}\nTS_CLOUD_THROTTLE_EOF`)
    fail('applying the throttled firewall ruleset', result)
    return {
      kind: 'nftables_throttle',
      factor: input.factor,
      previousThresholds: (base.thresholds ?? {}) as unknown as JsonValue,
    }
  }

  async restoreRequests(restore: Record<string, JsonValue>): Promise<void> {
    const render = this.options.renderDdos
    const base = this.options.ddos
    if (!render || !base) return
    const previous = (restore.previousThresholds ?? {}) as DdosConfig['thresholds']
    const script = render({ ...base, thresholds: previous })
    const result = await this.options.exec(this.options.host, `bash -s <<'TS_CLOUD_THROTTLE_EOF'\n${script}\nTS_CLOUD_THROTTLE_EOF`)
    fail('restoring the firewall ruleset', result)
  }
}

// ------------------------------------------------------------- composite

/**
 * Fan one action out to several transports.
 *
 * A project that serves static assets from CloudFront and dynamic routes from a
 * box needs both capped, and capping one is worse than capping neither: traffic
 * shifts to whichever half is still up and the bill moves rather than stops.
 *
 * Every leg runs even if an earlier one throws, and the first error is rethrown
 * once all have been attempted. Stopping at the first failure would leave the
 * others uncapped with no record of it.
 */
export function compositeSpendTransport(
  transports: readonly SpendEnforcementTransport[],
): SpendEnforcementTransport {
  type Applier = 'throttleRequests' | 'suspendFunctions' | 'serveStatic' | 'suspendProject'
  type Releaser = 'restoreRequests' | 'resumeFunctions' | 'restoreDynamic' | 'resumeProject'

  const applyAll = async (method: Applier, input: any): Promise<Record<string, JsonValue>> => {
    const legs: Record<string, JsonValue> = {}
    let firstError: unknown
    let supported = 0
    for (const [index, transport] of transports.entries()) {
      const handler = transport[method]
      if (!handler) continue
      supported++
      try {
        legs[String(index)] = (await handler.call(transport, input)) as JsonValue
      } catch (error) {
        legs[String(index)] = { error: error instanceof Error ? error.message : String(error) }
        firstError ??= error
      }
    }
    if (supported === 0) throw new Error(`No transport implements ${method}.`)
    if (firstError) throw firstError
    return { kind: 'composite', legs }
  }

  const releaseAll = async (method: Releaser, restore: Record<string, JsonValue>): Promise<void> => {
    const legs = (restore.legs ?? {}) as Record<string, JsonValue>
    let firstError: unknown
    for (const [index, transport] of transports.entries()) {
      const handler = transport[method]
      if (!handler) continue
      const leg = legs[String(index)]
      // A leg that failed to apply has nothing to undo; trying anyway would
      // report a restore failure for a cap that was never in force.
      if (!leg || typeof leg !== 'object' || Array.isArray(leg) || 'error' in leg) continue
      try {
        await handler.call(transport, leg as Record<string, JsonValue>)
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError) throw firstError
  }

  return {
    throttleRequests: (input) => applyAll('throttleRequests', input),
    restoreRequests: (restore) => releaseAll('restoreRequests', restore),
    suspendFunctions: (input) => applyAll('suspendFunctions', input),
    resumeFunctions: (restore) => releaseAll('resumeFunctions', restore),
    serveStatic: (input) => applyAll('serveStatic', input),
    restoreDynamic: (restore) => releaseAll('restoreDynamic', restore),
    suspendProject: (input) => applyAll('suspendProject', input),
    resumeProject: (restore) => releaseAll('resumeProject', restore),
  }
}
