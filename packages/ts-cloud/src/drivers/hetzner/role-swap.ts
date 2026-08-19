/**
 * Swapping the roles of two servers.
 *
 * The situation this exists for: a server type is no longer obtainable. Hetzner
 * retires older lines, and `available_for_migration` goes false everywhere, so
 * a `change_type` onto that type can never succeed again. If you already own an
 * instance of it, that instance is the only one you will ever have — and the
 * right move is to put your heaviest workload on it rather than to keep trying
 * to buy another.
 *
 * A resize cannot do this. What can is exchanging the two servers' primary IPs,
 * so each address keeps pointing at the workload that answers on it, with no
 * DNS change and no waiting on propagation.
 *
 * Two constraints decide whether it is possible at all, and both are cheap to
 * check before anything is powered off:
 *
 *   - A primary IP belongs to a datacenter. Two servers in different
 *     datacenters cannot exchange addresses, and finding that out halfway
 *     through leaves both boxes down with their addresses detached.
 *   - Data has to fit. Moving a workload onto a smaller disk fails at restore
 *     time, which is the worst moment to discover it.
 *
 * The planning is pure so those rules can be tested without an account.
 *
 * IMPORTANT, and not yet handled here: exchanging addresses does not move the
 * workload. Each disk keeps the software and data it already had, so a swap on
 * its own points every address at the wrong application. A complete role swap
 * is three phases - deploy each workload onto its new host, restore its data,
 * and only then exchange the addresses - and this module plans the third.
 * `planRoleSwap` deliberately refuses to look like the whole job.
 */

export interface SwapServer {
  id: number
  name: string
  /**
   * Where the server sits, for the purpose of deciding whether an address can
   * move to it. Derive it with {@link placementOf} rather than reading a field
   * off the API response, and see that function for why. Null when unknown,
   * which is a blocker rather than a pass.
   */
  placement: string | null
  serverType: string
  diskSizeGb: number
  /** Bytes actually in use, so a move onto a smaller disk can be refused early. */
  usedGb: number
  primaryIpId: number | null
  primaryIp: string | null
}

export type SwapStepKind =
  | 'power-off'
  | 'unassign-ip'
  | 'assign-ip'
  | 'power-on'
  | 'rename'

export interface SwapStep {
  kind: SwapStepKind
  serverId: number
  /** For an IP step, the address being moved. */
  ipId?: number
  /** For a rename, the name to take. */
  name?: string
  description: string
}

export interface SwapPlan {
  ok: boolean
  /** Why the swap cannot proceed. Empty when it can. */
  blockers: string[]
  steps: SwapStep[]
}

/**
 * Whether a workload fits on the other server's disk.
 *
 * A margin is kept rather than comparing raw numbers: a disk that is exactly
 * full is a disk that fails on the next write, and a restore needs room for
 * both the archive and its expansion.
 */
export function fits(usedGb: number, targetDiskGb: number, marginRatio = 1.3): boolean {
  return usedGb * marginRatio <= targetDiskGb
}

/**
 * Where a server sits, from whichever field the API still reports.
 *
 * Primary IPs are bound at datacenter granularity, so `datacenter` is the
 * field this wants. The API has stopped returning it — `datacenter` is now
 * null on both the server and the primary IP, leaving only `location`.
 *
 * Reading the missing field directly is worse than useless: two servers in
 * different datacenters both report `undefined`, `undefined === undefined`,
 * and the guard that exists to stop a cross-datacenter swap waves it through.
 * The failure then lands halfway, with both boxes off and their addresses
 * detached, which is the exact outcome the check was written to prevent.
 *
 * So: prefer the datacenter when present, fall back to the location, and
 * return null when neither is known so the caller can refuse. Location is a
 * sound proxy today because every Hetzner location contains exactly one
 * datacenter; if that ever stops being true, this returns the coarser answer
 * and the assign call is the backstop.
 */
export function placementOf(server: {
  datacenter?: { name?: string } | null
  location?: { name?: string } | null
}): string | null {
  return server.datacenter?.name ?? server.location?.name ?? null
}

/**
 * The parking name one server wears while the other takes its name.
 *
 * Hetzner rejects a duplicate server name, so the two cannot cross directly.
 */
export function swapTempName(name: string): string {
  return `${name}-swap-tmp`
}

/**
 * The ordered steps to exchange two servers' addresses and names.
 *
 * Both are powered off before either address moves. Hetzner refuses to detach a
 * primary IP from a running server, and doing them one at a time would leave
 * the first server up with no address — reachable by nobody and, worse, still
 * accepting work it can no longer be reached about.
 */
export function planRoleSwap(a: SwapServer, b: SwapServer): SwapPlan {
  const blockers: string[] = []

  if (a.id === b.id)
    blockers.push('A server cannot swap roles with itself')

  // Fail closed on an unknown placement. Treating "we could not tell" as
  // "they match" is how a cross-datacenter swap gets attempted.
  if (a.placement === null || b.placement === null) {
    const unknown = [a, b].filter(s => s.placement === null).map(s => s.name).join(' and ')
    blockers.push(
      `Cannot tell which datacenter ${unknown} is in, and a primary IP cannot move between datacenters. `
      + 'Confirm both are in the same one before swapping.',
    )
  }
  else if (a.placement !== b.placement) {
    blockers.push(
      `A primary IP cannot move between datacenters: ${a.name} is in ${a.placement} and ${b.name} is in ${b.placement}. `
      + 'Rebuild one of them in the other datacenter first.',
    )
  }

  if (a.primaryIpId === null || b.primaryIpId === null)
    blockers.push('Both servers need a primary IP to exchange')

  // Each workload has to fit where it is going.
  if (!fits(a.usedGb, b.diskSizeGb))
    blockers.push(`${a.name} uses ${a.usedGb}GB, which does not fit ${b.name}'s ${b.diskSizeGb}GB disk with room to restore`)

  if (!fits(b.usedGb, a.diskSizeGb))
    blockers.push(`${b.name} uses ${b.usedGb}GB, which does not fit ${a.name}'s ${a.diskSizeGb}GB disk with room to restore`)

  if (blockers.length > 0)
    return { ok: false, blockers, steps: [] }

  const steps: SwapStep[] = [
    { kind: 'power-off', serverId: a.id, description: `Power off ${a.name}` },
    { kind: 'power-off', serverId: b.id, description: `Power off ${b.name}` },
    { kind: 'unassign-ip', serverId: a.id, ipId: a.primaryIpId!, description: `Detach ${a.primaryIp} from ${a.name}` },
    { kind: 'unassign-ip', serverId: b.id, ipId: b.primaryIpId!, description: `Detach ${b.primaryIp} from ${b.name}` },
    { kind: 'assign-ip', serverId: b.id, ipId: a.primaryIpId!, description: `Attach ${a.primaryIp} to ${b.name}` },
    { kind: 'assign-ip', serverId: a.id, ipId: b.primaryIpId!, description: `Attach ${b.primaryIp} to ${a.name}` },
    // Names follow the addresses, so the console stops lying about which box
    // serves what. A wrong name here is how the next person powers off the
    // wrong server.
    //
    // Three steps, not two: server names are unique per account, so renaming a
    // to b's name while b still holds it is rejected outright. Swapping two
    // names needs a temporary exactly as swapping two variables does.
    { kind: 'rename', serverId: a.id, name: swapTempName(a.name), description: `Rename ${a.name} to ${swapTempName(a.name)} to free the name` },
    { kind: 'rename', serverId: b.id, name: a.name, description: `Rename ${b.name} to ${a.name}` },
    { kind: 'rename', serverId: a.id, name: b.name, description: `Rename ${swapTempName(a.name)} to ${b.name}` },
    { kind: 'power-on', serverId: a.id, description: `Power on ${a.name} (now ${b.name})` },
    { kind: 'power-on', serverId: b.id, description: `Power on ${b.name} (now ${a.name})` },
  ]

  return { ok: true, blockers: [], steps }
}

/**
 * Whether a type can still be migrated onto in a datacenter.
 *
 * `available` answers a different question — whether a NEW server of that type
 * can be created — and reading it instead is why a doomed `change_type` looks
 * like bad luck rather than a retired type. `available_for_migration` is the
 * one `change_type` consults.
 */
export function canMigrateTo(
  datacenter: { server_types?: { available_for_migration?: number[] } },
  serverTypeId: number,
): boolean {
  return (datacenter.server_types?.available_for_migration ?? []).includes(serverTypeId)
}

/**
 * The advice to print when a resize is impossible.
 *
 * A type that is unobtainable everywhere is not a capacity blip to retry
 * through; it is retired, and the instance you hold is the last one you get.
 */
export function resizeAdvice(input: {
  targetType: string
  migratableAnywhere: boolean
  ownedInstances: number
}): string {
  if (input.migratableAnywhere)
    return `${input.targetType} is unavailable here but migratable elsewhere; retry, or move the server to a datacenter that has it.`

  if (input.ownedInstances > 0) {
    return `${input.targetType} is not migratable in any datacenter, so no more can be obtained. `
      + `You already run ${input.ownedInstances}; swap roles so it carries the heavier workload instead.`
  }

  return `${input.targetType} is not migratable in any datacenter and you own none. Choose a type that is.`
}
