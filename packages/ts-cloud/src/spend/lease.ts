/**
 * A lease, so only one process runs the spend loop at a time.
 *
 * The loop is started in more than one place by design - the dashboard server
 * runs it, and `cloud spend:work` runs it standalone - so two of them
 * overlapping is a configuration people will actually reach.
 *
 * Most of the damage is already prevented downstream: the gate is idempotent on
 * (budget, action), enforcement records have a unique index on live rows, and
 * notification deliveries dedupe on their idempotency key. What a lease adds is
 * avoiding the *work*: two processes evaluating every budget every minute
 * doubles the database traffic and the provider calls that enforcement makes,
 * and provider calls are rate-limited and occasionally billed.
 *
 * It is an advisory lease with a TTL, not a distributed lock. A process that
 * dies holding one blocks the loop for at most `ttlSeconds`, which is the right
 * trade: a stalled cap for a minute is better than a lock nobody can clear.
 */
import type { ControlPlaneStore, JsonValue } from '../control-plane'

export const SPEND_LEASE_SETTING = 'spend.loop.lease'

export interface SpendLeaseState {
  owner: string
  acquiredAt: string
  expiresAt: string
}

export interface SpendLeaseOptions {
  /** Identifies the holder in the record. A hostname and pid is ideal. */
  owner?: string
  /** How long a held lease stays valid without renewal. */
  ttlSeconds?: number
  now?: () => Date
}

function defaultOwner(): string {
  const pid = typeof process === 'undefined' ? 'unknown' : String(process.pid)
  return `${pid}:${crypto.randomUUID().slice(0, 8)}`
}

export class SpendLoopLease {
  readonly owner: string
  private readonly ttlMs: number

  constructor(
    private readonly controlPlane: ControlPlaneStore,
    options: SpendLeaseOptions = {},
  ) {
    this.owner = options.owner ?? defaultOwner()
    this.ttlMs = Math.max(5_000, (options.ttlSeconds ?? 120) * 1000)
    this.nowFn = options.now ?? (() => new Date())
  }

  private readonly nowFn: () => Date

  private read(): SpendLeaseState | undefined {
    const raw = this.controlPlane.getSetting(SPEND_LEASE_SETTING)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const record = raw as Record<string, unknown>
    if (typeof record.owner !== 'string' || typeof record.expiresAt !== 'string') return undefined
    return record as unknown as SpendLeaseState
  }

  /** The current holder, or undefined when the lease is free or expired. */
  current(): SpendLeaseState | undefined {
    const state = this.read()
    if (!state) return undefined
    return new Date(state.expiresAt).getTime() > this.nowFn().getTime() ? state : undefined
  }

  /**
   * Take or renew the lease.
   *
   * Read and write happen inside one transaction, because two processes doing
   * read-then-write outside one would both see it free and both take it -
   * which is the exact race the lease exists to prevent.
   */
  acquire(): boolean {
    const now = this.nowFn()
    const claim = this.controlPlane.database.transaction((): boolean => {
      const state = this.read()
      const held = state && new Date(state.expiresAt).getTime() > now.getTime()
      if (held && state!.owner !== this.owner) return false
      const next: SpendLeaseState = {
        owner: this.owner,
        acquiredAt: held ? state!.acquiredAt : now.toISOString(),
        expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      }
      this.controlPlane.setSetting(SPEND_LEASE_SETTING, next as unknown as JsonValue)
      return true
    })
    return claim()
  }

  /** Give the lease up. Only the holder may, so a late release cannot steal it. */
  release(): boolean {
    const drop = this.controlPlane.database.transaction((): boolean => {
      const state = this.read()
      if (!state || state.owner !== this.owner) return false
      this.controlPlane.setSetting(SPEND_LEASE_SETTING, null as unknown as JsonValue)
      return true
    })
    return drop()
  }

  /** True when this process currently holds it. */
  held(): boolean {
    return this.current()?.owner === this.owner
  }
}
