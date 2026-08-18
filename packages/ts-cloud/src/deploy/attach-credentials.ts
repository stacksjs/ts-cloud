import { TS_CLOUD_LABEL_PREFIX } from '../drivers/hetzner/instance-sizes'

/**
 * What a provider credential can actually reach, so an attach can say so before
 * it is approved.
 *
 * Attaching resolves the owner's box by LISTING the provider's servers with the
 * attaching project's own token. That listing is the whole mechanism, and it has
 * a consequence the config never states: the owner's box must be visible to the
 * attacher's credential, so both projects share one provider project. On Hetzner
 * a Cloud API token is scoped to a project with Read or Read & Write and has no
 * per-resource scoping, and a deploy needs write. Attaching therefore hands this
 * project's CI write access over every server in that project.
 *
 * That is not a hypothetical. Three apps that each owned one box become three
 * pipelines that each reach all three. The trade may well be worth it, but it
 * should be a decision rather than a discovery, and the only honest place to
 * surface it is the plan, where the operator is already looking.
 *
 * Pure and provider-agnostic on purpose: it reads a list of names and labels, so
 * any driver that can enumerate what its credential sees can report a radius,
 * rather than the reporting being welded to one provider's client.
 *
 * @see https://github.com/stacksjs/ts-cloud/issues/169
 */

/** The label carrying a resource's owning project slug. */
const PROJECT_LABEL = `${TS_CLOUD_LABEL_PREFIX}/project`

/**
 * The minimum a driver has to produce for a server to be attributed.
 *
 * Structural rather than a provider type so a Hetzner server satisfies it as-is
 * and another driver can satisfy it without importing anything.
 */
export interface ReachableServer {
  name: string
  labels?: Record<string, string>
}

export interface CredentialReach {
  /** Every server the credential enumerated. */
  total: number
  /** Servers belonging to the project being attached TO. Expected reach. */
  owner: string[]
  /** Servers belonging to the attaching project itself, if it has any. */
  self: string[]
  /** Servers owned by unrelated ts-cloud projects, keyed by project slug. */
  others: Map<string, string[]>
  /**
   * Servers carrying no ts-cloud project label.
   *
   * Counted separately because they are the reach most likely to surprise: not
   * managed by ts-cloud at all, and so not visible in any ts-cloud config, yet
   * just as writable by the token.
   */
  unmanaged: string[]
}

/**
 * Attribute every server the credential can see to a project.
 *
 * `ownerSlug` is what `cloud.attachTo` names; `selfSlug` is the deploying
 * project. Splitting those two out of `others` is the point: reach over the owner
 * is the reach being asked for, reach over anything else is the reach nobody
 * asked for, and only the second number is an argument against attaching.
 */
export function describeCredentialReach(
  servers: ReachableServer[],
  options: { ownerSlug: string, selfSlug?: string },
): CredentialReach {
  const ownerSlug = options.ownerSlug.trim()
  const selfSlug = options.selfSlug?.trim()

  const reach: CredentialReach = { total: servers.length, owner: [], self: [], others: new Map(), unmanaged: [] }

  for (const server of servers) {
    const project = server.labels?.[PROJECT_LABEL]?.trim()

    if (!project) {
      reach.unmanaged.push(server.name)
      continue
    }
    if (project === ownerSlug) {
      reach.owner.push(server.name)
      continue
    }
    if (selfSlug && project === selfSlug) {
      reach.self.push(server.name)
      continue
    }

    const existing = reach.others.get(project)
    if (existing) existing.push(server.name)
    else reach.others.set(project, [server.name])
  }

  return reach
}

/** Servers the credential reaches that neither project being joined owns. */
export function unrelatedReachCount(reach: CredentialReach): number {
  let count = reach.unmanaged.length
  for (const names of reach.others.values()) count += names.length
  return count
}

/**
 * The credential radius as plan lines, ready to print.
 *
 * Returns lines rather than printing so the caller owns the output stream and
 * this stays testable. Sorted, because a plan that reorders itself between runs
 * is a plan nobody diffs.
 *
 * When the reach is exactly the owner's box and this project's own, there is
 * nothing to warn about and the summary says so in one line - a warning that
 * fires every time is a warning that gets skipped.
 */
export function formatCredentialReach(
  reach: CredentialReach,
  options: { ownerSlug: string, selfSlug?: string },
): string[] {
  const unrelated = unrelatedReachCount(reach)
  const lines: string[] = []

  lines.push(
    `Attaching to '${options.ownerSlug}' shares one provider project, so this deploy's credential can write to all ${reach.total} server(s) it can see.`,
  )

  if (unrelated === 0) {
    lines.push('Nothing outside the two projects being joined is reachable with it.')
    return lines
  }

  lines.push(`${unrelated} of them belong to neither project:`)

  for (const project of [...reach.others.keys()].sort())
    lines.push(`  ${project}: ${[...reach.others.get(project)!].sort().join(', ')}`)

  if (reach.unmanaged.length > 0)
    lines.push(`  not managed by ts-cloud: ${[...reach.unmanaged].sort().join(', ')}`)

  lines.push(
    'A compromised CI run or a mistargeted teardown in this project now reaches those. '
    + 'Keep the app in its own provider project instead if that is not acceptable, which rules out attaching.',
  )

  return lines
}
