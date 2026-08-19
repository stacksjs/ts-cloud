/**
 * Operator controls for edge protection.
 *
 * The generators in `ddos.ts` and `waf.ts` decide what a box does in the
 * ordinary case. This is the set of levers someone reaches for during an
 * incident, when the ordinary case is not what is happening:
 *
 *   - **Attack mode** challenges every visitor, not only the suspicious ones.
 *   - **IP rules** allow or block specific ranges outright.
 *   - **Pausing mitigations** turns automatic blocking off for a project whose
 *     legitimate traffic is being caught by it.
 *
 * Two of these are dangerous in opposite directions, and both are time-boxed
 * for that reason. Attack mode challenges real users, so leaving it on
 * indefinitely is a slow outage. Pausing mitigations means paying for whatever
 * arrives, so leaving *that* on indefinitely is a slow invoice. Neither
 * defaults to permanent, and both record who did it.
 */
import type { ControlPlaneStore, JsonValue } from '../control-plane'
import type { RateLimitRule } from './ratelimit'
import type { DdosConfig } from './ddos'
import { isValidCidr } from './ddos'

export const PROTECTION_SETTING = 'protection.controls'

/** The hardest ceiling on a temporary control, matching what operators expect. */
export const MAX_CONTROL_HOURS = 24
/** Attack mode defaults short: it challenges real users while it is on. */
export const DEFAULT_ATTACK_MODE_HOURS = 4

export interface TimeBoxedControl {
  enabled: boolean
  /** ISO timestamp. The control is inert past it, with no action needed. */
  expiresAt: string
  startedAt: string
  reason: string
  actorId?: string
}

export interface IpRules {
  /** CIDRs that bypass every limit. */
  allow: string[]
  /** CIDRs refused outright. */
  block: string[]
}

export interface ProtectionControls {
  attackMode?: TimeBoxedControl
  /** Automatic mitigation suspended. You pay for what arrives while it is on. */
  mitigationPause?: TimeBoxedControl
  ipRules: IpRules
  updatedAt?: string
}

const EMPTY: ProtectionControls = { ipRules: { allow: [], block: [] } }

function activeControl(control: TimeBoxedControl | undefined, now: Date): TimeBoxedControl | undefined {
  if (!control?.enabled) return undefined
  return new Date(control.expiresAt).getTime() > now.getTime() ? control : undefined
}

function clampHours(hours: number | undefined, fallback: number): number {
  const value = Number.isFinite(hours) ? Number(hours) : fallback
  return Math.min(MAX_CONTROL_HOURS, Math.max(0.25, value))
}

/** Bound the lists so one paste cannot make a ruleset the kernel refuses to load. */
const MAX_IP_RULES = 500

export class ProtectionControlStore {
  constructor(
    private readonly controlPlane: ControlPlaneStore,
    private readonly options: { now?: () => Date } = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  private read(): ProtectionControls {
    const raw = this.controlPlane.getSetting(PROTECTION_SETTING)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY, ipRules: { allow: [], block: [] } }
    const record = raw as unknown as ProtectionControls
    return {
      attackMode: record.attackMode,
      mitigationPause: record.mitigationPause,
      ipRules: {
        allow: Array.isArray(record.ipRules?.allow) ? record.ipRules.allow : [],
        block: Array.isArray(record.ipRules?.block) ? record.ipRules.block : [],
      },
      updatedAt: record.updatedAt,
    }
  }

  private write(next: ProtectionControls): ProtectionControls {
    const stored = { ...next, updatedAt: this.now().toISOString() }
    this.controlPlane.setSetting(PROTECTION_SETTING, stored as unknown as JsonValue)
    return stored
  }

  /** Everything as stored, expired controls included. For an audit view. */
  raw(): ProtectionControls {
    return this.read()
  }

  /** Only what is in force right now. What the enforcement path should read. */
  current(): { attackMode?: TimeBoxedControl; mitigationPause?: TimeBoxedControl; ipRules: IpRules } {
    const now = this.now()
    const stored = this.read()
    return {
      attackMode: activeControl(stored.attackMode, now),
      mitigationPause: activeControl(stored.mitigationPause, now),
      ipRules: stored.ipRules,
    }
  }

  /**
   * Challenge every visitor for a bounded window.
   *
   * The expiry is the point. An operator who enables this at 2am must not have
   * to remember to turn it off, because the failure mode of forgetting is that
   * every real user keeps getting challenged and nobody connects the two.
   */
  enableAttackMode(input: { hours?: number; reason: string; actorId?: string }): TimeBoxedControl {
    const now = this.now()
    const control: TimeBoxedControl = {
      enabled: true,
      startedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + clampHours(input.hours, DEFAULT_ATTACK_MODE_HOURS) * 3_600_000).toISOString(),
      reason: input.reason.trim() || 'Attack mode enabled by an operator.',
      actorId: input.actorId,
    }
    this.write({ ...this.read(), attackMode: control })
    return control
  }

  disableAttackMode(): boolean {
    const stored = this.read()
    if (!stored.attackMode?.enabled) return false
    this.write({ ...stored, attackMode: { ...stored.attackMode, enabled: false } })
    return true
  }

  /**
   * Suspend automatic mitigation for a project being caught by it.
   *
   * A reason is required, not optional. This is the control that costs money
   * while it is on, and "why is our bill up" should be answerable from the
   * record rather than from memory.
   */
  pauseMitigations(input: { hours?: number; reason: string; actorId?: string }): TimeBoxedControl {
    const reason = input.reason.trim()
    if (!reason) throw new Error('Pausing mitigations requires a reason: you are liable for the traffic it admits.')
    const now = this.now()
    const control: TimeBoxedControl = {
      enabled: true,
      startedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + clampHours(input.hours, MAX_CONTROL_HOURS) * 3_600_000).toISOString(),
      reason,
      actorId: input.actorId,
    }
    this.write({ ...this.read(), mitigationPause: control })
    return control
  }

  resumeMitigations(): boolean {
    const stored = this.read()
    if (!stored.mitigationPause?.enabled) return false
    this.write({ ...stored, mitigationPause: { ...stored.mitigationPause, enabled: false } })
    return true
  }

  /** Add a CIDR to the allow or block list. Validated before it is stored. */
  addIpRule(list: 'allow' | 'block', cidr: string): IpRules {
    const value = cidr.trim()
    if (!isValidCidr(value)) throw new Error(`Not a valid IP or CIDR: ${cidr}`)
    const stored = this.read()
    const next = { ...stored.ipRules, [list]: [...new Set([...stored.ipRules[list], value])] }
    if (next[list].length > MAX_IP_RULES) throw new Error(`At most ${MAX_IP_RULES} ${list} rules are supported.`)
    // A CIDR cannot be on both lists: the ruleset checks allow first, so the
    // block entry would be dead and the UI would imply protection it lacks.
    const other = list === 'allow' ? 'block' : 'allow'
    next[other] = next[other].filter((entry) => entry !== value)
    this.write({ ...stored, ipRules: next })
    return next
  }

  removeIpRule(list: 'allow' | 'block', cidr: string): IpRules {
    const stored = this.read()
    const next = { ...stored.ipRules, [list]: stored.ipRules[list].filter((entry) => entry !== cidr.trim()) }
    this.write({ ...stored, ipRules: next })
    return next
  }
}

export interface ProtectionPosture {
  attackMode: boolean
  mitigationPaused: boolean
  /** Human-readable, for a dashboard banner and a CLI line. */
  summary: string
  expiresAt?: string
}

export function describePosture(controls: ReturnType<ProtectionControlStore['current']>): ProtectionPosture {
  if (controls.mitigationPause)
    return {
      attackMode: !!controls.attackMode,
      mitigationPaused: true,
      summary: `Automatic mitigation is paused until ${controls.mitigationPause.expiresAt}. All traffic is being served and billed.`,
      expiresAt: controls.mitigationPause.expiresAt,
    }
  if (controls.attackMode)
    return {
      attackMode: true,
      mitigationPaused: false,
      summary: `Attack mode is on until ${controls.attackMode.expiresAt}. Every visitor is being challenged.`,
      expiresAt: controls.attackMode.expiresAt,
    }
  return { attackMode: false, mitigationPaused: false, summary: 'Protection is in its normal posture.' }
}

/**
 * Apply the controls to a rate-limit rule set.
 *
 * Attack mode does not tighten the numbers - it changes the *action*. A limit
 * low enough to stop an attack by counting would also stop a real user, whereas
 * a challenge lets a browser through and a script not. Pausing mitigations
 * disables the rules outright, which is the honest reading of "paused".
 */
export function applyControlsToRateLimits(
  rules: readonly RateLimitRule[],
  controls: ReturnType<ProtectionControlStore['current']>,
): RateLimitRule[] {
  if (controls.mitigationPause) return rules.map((rule) => ({ ...rule, enabled: false }))
  if (!controls.attackMode) return [...rules]
  return rules.map((rule) => ({
    ...rule,
    action: rule.action === 'deny' ? 'deny' : 'challenge',
    // A challenge on the very first request would break every API client, so
    // attack mode still allows a small burst before it starts asking.
    burst: Math.max(1, Math.min(rule.burst ?? rule.limit, 5)),
  }))
}

/** Apply the controls to a firewall config before it is rendered. */
export function applyControlsToDdos(
  config: DdosConfig,
  controls: ReturnType<ProtectionControlStore['current']>,
): DdosConfig {
  const allowlist = [...new Set([...(config.allowlist ?? []), ...controls.ipRules.allow])]
  const blocklist = [...new Set([...(config.blocklist ?? []), ...controls.ipRules.block])]
  if (controls.mitigationPause)
    // Monitor rather than disable: the counters stay useful for deciding
    // whether it is safe to resume, and the operator can see what they let in.
    return { ...config, allowlist, blocklist, monitorOnly: true }
  if (!controls.attackMode) return { ...config, allowlist, blocklist }
  const thresholds = config.thresholds ?? {}
  return {
    ...config,
    allowlist,
    blocklist,
    thresholds: {
      ...thresholds,
      newConnectionsPerSecond: Math.max(1, Math.floor((thresholds.newConnectionsPerSecond ?? 50) / 5)),
      concurrentPerSource: Math.max(1, Math.floor((thresholds.concurrentPerSource ?? 100) / 5)),
    },
  }
}

/**
 * Fold live operator controls into a cloud config before it reaches a driver.
 *
 * The provisioning path takes a `CloudConfig` and nothing else, deliberately:
 * it also builds golden images, and baking one operator's live blocklist into a
 * reusable image would be wrong. So the merge happens here, at the deploy call
 * site that has a control plane, rather than inside the builder.
 *
 * Without this, `cloud protect:block` writes a rule that the next deploy
 * silently renders without - the control appears to work and does nothing.
 *
 * Returns a shallow copy; the caller's config is not mutated.
 */
export function mergeControlsIntoConfig<T extends Record<string, any>>(
  config: T,
  controls: ReturnType<ProtectionControlStore['current']>,
): T {
  const compute = config?.infrastructure?.compute
  // Nothing to merge into: a serverless-only config has no box to protect.
  if (!compute || compute.ddos === false) return config
  const base = typeof compute.ddos === 'object' && compute.ddos !== null ? compute.ddos : {}
  return {
    ...config,
    infrastructure: {
      ...config.infrastructure,
      compute: { ...compute, ddos: applyControlsToDdos(base, controls) },
    },
  }
}
