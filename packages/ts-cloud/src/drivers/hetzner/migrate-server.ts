/**
 * Moving a workload from one server onto another.
 *
 * This is the half of a role swap that {@link ./role-swap} deliberately refuses
 * to pretend it does. Exchanging two servers' primary IPs points each address
 * at the other's disk; unless the workloads moved first, every address now
 * serves the wrong application.
 *
 * There are two ways to move a workload, and which one is available is not a
 * matter of taste:
 *
 *   - **Snapshot and rebuild.** Hetzner images a server's disk and writes it
 *     over another server's. It carries everything - every service, every unit
 *     file, the certificates, the databases, the things nobody remembered were
 *     installed. For a box that accumulated twenty services over a year, this
 *     is the only honest option, because a reinstall reproduces what you
 *     documented rather than what you have.
 *
 *   - **Redeploy and restore.** Deploy the application onto the target, then
 *     restore its data. Reproducible and auditable, but it only moves what the
 *     deployment knows about.
 *
 * The choice is forced by one asymmetry: **an image carries the disk size of
 * the server it came from**, and a rebuild is refused unless the target's disk
 * is at least that large. So a small server images onto a large one, and a
 * large server does not image onto a small one - regardless of how little data
 * it actually holds. An 11GB workload on a 160GB disk cannot be rebuilt onto an
 * 80GB disk. That is the rule {@link planServerMigration} exists to apply
 * before anything is destroyed, rather than after.
 *
 * Two further facts, learned the expensive way, are encoded here:
 *
 *   - A rebuild is **irreversible the instant it succeeds**. The target's disk
 *     is gone. Anything on it that has not been captured elsewhere is gone with
 *     it, so the plan refuses to sequence a rebuild before its target's backup.
 *   - Rebuilding onto a **larger** disk does not grow the filesystem. The
 *     partition still reports the old size and the extra space is unreachable
 *     until `growpart` and the filesystem's own resize have run.
 */

export type MigrationMethod = 'snapshot-rebuild' | 'redeploy-restore'

export interface AttachedVolume {
  id: number
  name: string
  sizeGb?: number
}

export interface MigrateServer {
  id: number
  name: string
  serverType: string
  /** The server type's disk, in GB. An image taken here carries this size. */
  diskSizeGb: number
  /** Bytes actually in use, so a move onto a smaller disk is refused early. */
  usedGb: number
  architecture?: string
  /**
   * Block-storage volumes attached to this server.
   *
   * These do NOT travel with a snapshot. A volume is a separate device that
   * happens to be attached, so imaging the machine copies the system disk and
   * silently leaves the volume behind on the old server - along with whatever
   * lived on it. The migrated box then boots with an fstab entry for a device
   * that is not there, and whatever depended on that mount stays down while
   * every other check looks healthy.
   */
  attachedVolumes?: AttachedVolume[]
}

export type MigrationStepKind =
  | 'back-up'
  | 'snapshot'
  | 'stop'
  | 'rebuild'
  | 'power-on'
  | 'grow-filesystem'
  | 'move-volume'
  | 'deploy'
  | 'restore'
  | 'verify'

export interface MigrationStep {
  kind: MigrationStepKind
  /** The server the step acts on. */
  serverId: number
  description: string
  /** True for steps that destroy data if the preceding ones were skipped. */
  destructive?: boolean
}

export interface MigrationPlan {
  ok: boolean
  method: MigrationMethod | null
  blockers: string[]
  /** Why this method rather than the other, for the operator to sanity-check. */
  rationale: string
  steps: MigrationStep[]
}

/**
 * Whether an image of `source` can be written onto `target`.
 *
 * Compares disk *sizes*, not disk *usage*. This is the constraint people get
 * wrong, because it is counter-intuitive: a nearly empty 160GB server cannot be
 * rebuilt onto an 80GB one. Hetzner is comparing the geometry the image was
 * captured with, and it has no idea how much of it you were using.
 */
export function canRebuildFrom(source: Pick<MigrateServer, 'diskSizeGb'>, target: Pick<MigrateServer, 'diskSizeGb'>): boolean {
  return source.diskSizeGb <= target.diskSizeGb
}

/**
 * Whether the workload's actual bytes fit the target, with room to restore.
 *
 * A disk that is exactly full fails on the next write, and a restore needs room
 * for the archive as well as its expansion.
 */
export function dataFits(usedGb: number, targetDiskGb: number, marginRatio = 1.3): boolean {
  return usedGb * marginRatio <= targetDiskGb
}

/** Whether a rebuild onto this target leaves unclaimed disk behind. */
export function needsFilesystemGrowth(source: Pick<MigrateServer, 'diskSizeGb'>, target: Pick<MigrateServer, 'diskSizeGb'>): boolean {
  return target.diskSizeGb > source.diskSizeGb
}

/**
 * The ordered steps to move `source`'s workload onto `target`.
 *
 * `preferredMethod` is a request, not an instruction: asking for a snapshot
 * rebuild that the disk geometry forbids returns the redeploy path with the
 * reason attached, rather than a plan that fails partway.
 */
export function planServerMigration(
  source: MigrateServer,
  target: MigrateServer,
  options: { preferredMethod?: MigrationMethod } = {},
): MigrationPlan {
  const blockers: string[] = []

  if (source.id === target.id)
    blockers.push('A server cannot be migrated onto itself')

  if (source.architecture && target.architecture && source.architecture !== target.architecture) {
    blockers.push(
      `An image cannot cross architectures: ${source.name} is ${source.architecture} and ${target.name} is ${target.architecture}`,
    )
  }

  if (!dataFits(source.usedGb, target.diskSizeGb)) {
    blockers.push(
      `${source.name} uses ${source.usedGb}GB, which does not fit ${target.name}'s ${target.diskSizeGb}GB disk with room to restore`,
    )
  }

  if (blockers.length > 0)
    return { ok: false, method: null, blockers, rationale: '', steps: [] }

  const rebuildable = canRebuildFrom(source, target)
  const wantsRedeploy = options.preferredMethod === 'redeploy-restore'
  const method: MigrationMethod = rebuildable && !wantsRedeploy ? 'snapshot-rebuild' : 'redeploy-restore'

  const rationale = method === 'snapshot-rebuild'
    ? `${source.name}'s ${source.diskSizeGb}GB image fits ${target.name}'s ${target.diskSizeGb}GB disk, so the whole machine moves as-is.`
    : rebuildable
      ? 'A redeploy was requested explicitly, so only what the deployment knows about moves.'
      : `${source.name}'s image carries a ${source.diskSizeGb}GB disk, which cannot be written onto ${target.name}'s `
        + `${target.diskSizeGb}GB one even though only ${source.usedGb}GB is in use. The workload has to be redeployed and its data restored.`

  const steps: MigrationStep[] = [
    // The target's disk is about to be destroyed, so it gets captured before
    // anything else happens, not after the operator is satisfied.
    { kind: 'back-up', serverId: target.id, description: `Back up ${target.name} before its disk is replaced` },
    { kind: 'back-up', serverId: source.id, description: `Back up ${source.name}'s data` },
  ]

  if (method === 'snapshot-rebuild') {
    steps.push(
      // Stopping first is what makes the image consistent rather than merely
      // crash-consistent: a database captured mid-write restores mid-write.
      { kind: 'stop', serverId: source.id, description: `Stop ${source.name} so its snapshot is consistent` },
      { kind: 'snapshot', serverId: source.id, description: `Snapshot ${source.name}` },
      { kind: 'stop', serverId: target.id, description: `Stop ${target.name}` },
      { kind: 'rebuild', serverId: target.id, destructive: true, description: `Rebuild ${target.name} from ${source.name}'s snapshot` },
      { kind: 'power-on', serverId: target.id, description: `Power on ${target.name}` },
    )

    if (needsFilesystemGrowth(source, target)) {
      steps.push({
        kind: 'grow-filesystem',
        serverId: target.id,
        description: `Grow the filesystem from ${source.diskSizeGb}GB to ${target.diskSizeGb}GB, which a rebuild does not do`,
      })
    }
  }
  else {
    steps.push(
      { kind: 'stop', serverId: target.id, description: `Stop ${target.name}` },
      { kind: 'rebuild', serverId: target.id, destructive: true, description: `Rebuild ${target.name} onto a clean base image` },
      { kind: 'power-on', serverId: target.id, description: `Power on ${target.name}` },
      { kind: 'deploy', serverId: target.id, description: `Deploy ${source.name}'s applications onto ${target.name}` },
      { kind: 'restore', serverId: target.id, description: `Restore ${source.name}'s data onto ${target.name}` },
    )
  }

  // Volumes move after the target is up and before anything is verified. They
  // are the step people forget, because nothing about the migration fails
  // without them: the machine boots, the services that need no volume come up
  // healthy, and only the one thing living on the volume stays down.
  for (const volume of source.attachedVolumes ?? []) {
    steps.push({
      kind: 'move-volume',
      serverId: target.id,
      description: `Detach volume ${volume.name} from ${source.name} and attach it to ${target.name}, then mount it`,
    })
  }

  steps.push({ kind: 'verify', serverId: target.id, description: `Verify ${target.name} serves what ${source.name} did` })

  return { ok: true, method, blockers: [], rationale, steps }
}

/**
 * The commands that claim disk a rebuild left unreachable.
 *
 * Split out because the order is load-bearing and easy to get backwards:
 * `growpart` enlarges the partition, and only then can the filesystem be told
 * to fill it. Running the filesystem resize first appears to succeed and
 * changes nothing.
 */
export function growFilesystemCommands(options: { device?: string, partition?: number, filesystem?: 'ext4' | 'xfs' } = {}): string[] {
  const device = options.device ?? '/dev/sda'
  const partition = options.partition ?? 1
  const target = `${device}${partition}`

  return [
    `growpart ${device} ${partition} || true`,
    options.filesystem === 'xfs' ? 'xfs_growfs /' : `resize2fs ${target}`,
  ]
}
