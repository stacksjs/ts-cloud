import { describe, expect, it } from 'bun:test'
import {
  canRebuildFrom,
  dataFits,
  growFilesystemCommands,
  type MigrateServer,
  needsFilesystemGrowth,
  planServerMigration,
} from './migrate-server'

/**
 * Moving a workload between two servers, where the direction that is possible
 * is decided by disk geometry rather than by how much data there is.
 */
function small(overrides: Partial<MigrateServer> = {}): MigrateServer {
  return { id: 1, name: 'small', serverType: 'cx33', diskSizeGb: 80, usedGb: 27, architecture: 'x86', ...overrides }
}

function large(overrides: Partial<MigrateServer> = {}): MigrateServer {
  return { id: 2, name: 'large', serverType: 'cx43', diskSizeGb: 160, usedGb: 11, architecture: 'x86', ...overrides }
}

describe('canRebuildFrom', () => {
  it('allows a small disk image onto a large disk', () => {
    expect(canRebuildFrom(small(), large())).toBe(true)
  })

  it('refuses a large disk image onto a small disk even when nearly empty', () => {
    // The counter-intuitive rule: 11GB in use, but the image carries 160GB of
    // geometry and Hetzner compares that.
    expect(canRebuildFrom(large(), small())).toBe(false)
  })

  it('allows equal disks', () => {
    expect(canRebuildFrom(small(), small({ id: 3 }))).toBe(true)
  })
})

describe('dataFits', () => {
  it('accepts a workload with room to restore', () => {
    expect(dataFits(27, 160)).toBe(true)
  })

  it('refuses a workload that only just fits', () => {
    expect(dataFits(70, 80)).toBe(false)
  })
})

describe('planServerMigration', () => {
  it('images the small server onto the large one', () => {
    const plan = planServerMigration(small(), large())

    expect(plan.ok).toBe(true)
    expect(plan.method).toBe('snapshot-rebuild')
  })

  it('falls back to redeploy when the image cannot fit the target disk', () => {
    const plan = planServerMigration(large(), small())

    expect(plan.ok).toBe(true)
    expect(plan.method).toBe('redeploy-restore')
    expect(plan.rationale).toContain('cannot be written onto')
  })

  it('explains that usage was not the obstacle', () => {
    // Somebody reading "does not fit" will otherwise go delete files.
    const plan = planServerMigration(large(), small())

    expect(plan.rationale).toContain('only 11GB is in use')
  })

  it('backs up the target before the rebuild that destroys it', () => {
    const plan = planServerMigration(small(), large())
    const backup = plan.steps.findIndex(s => s.kind === 'back-up' && s.serverId === large().id)
    const rebuild = plan.steps.findIndex(s => s.kind === 'rebuild')

    expect(backup).toBeGreaterThanOrEqual(0)
    expect(backup).toBeLessThan(rebuild)
  })

  it('marks the rebuild destructive', () => {
    const plan = planServerMigration(small(), large())

    expect(plan.steps.find(s => s.kind === 'rebuild')?.destructive).toBe(true)
  })

  it('stops the source before snapshotting it', () => {
    const plan = planServerMigration(small(), large())
    const stop = plan.steps.findIndex(s => s.kind === 'stop' && s.serverId === small().id)
    const snapshot = plan.steps.findIndex(s => s.kind === 'snapshot')

    expect(stop).toBeLessThan(snapshot)
  })

  it('grows the filesystem when the target disk is larger', () => {
    const plan = planServerMigration(small(), large())

    expect(plan.steps.some(s => s.kind === 'grow-filesystem')).toBe(true)
  })

  it('does not grow the filesystem when the disks match', () => {
    const plan = planServerMigration(small(), small({ id: 3, name: 'twin' }))

    expect(plan.steps.some(s => s.kind === 'grow-filesystem')).toBe(false)
  })

  it('includes deploy and restore on the redeploy path', () => {
    const kinds = planServerMigration(large(), small()).steps.map(s => s.kind)

    expect(kinds).toContain('deploy')
    expect(kinds).toContain('restore')
    expect(kinds).not.toContain('snapshot')
  })

  it('honours an explicit redeploy preference even when imaging would work', () => {
    const plan = planServerMigration(small(), large(), { preferredMethod: 'redeploy-restore' })

    expect(plan.method).toBe('redeploy-restore')
    expect(plan.rationale).toContain('requested explicitly')
  })

  it('refuses when the data would not fit regardless of method', () => {
    const plan = planServerMigration(small({ usedGb: 200 }), large())

    expect(plan.ok).toBe(false)
    expect(plan.blockers.join()).toContain('does not fit')
  })

  it('refuses to migrate a server onto itself', () => {
    expect(planServerMigration(small(), small()).ok).toBe(false)
  })

  it('refuses to cross architectures', () => {
    const plan = planServerMigration(small(), large({ architecture: 'arm' }))

    expect(plan.ok).toBe(false)
    expect(plan.blockers.join()).toContain('architectures')
  })

  it('emits no steps when blocked', () => {
    expect(planServerMigration(small({ usedGb: 500 }), large()).steps).toEqual([])
  })

  it('ends by verifying', () => {
    expect(planServerMigration(small(), large()).steps.at(-1)?.kind).toBe('verify')
  })
})

describe('needsFilesystemGrowth', () => {
  it('is true onto a larger disk', () => {
    expect(needsFilesystemGrowth(small(), large())).toBe(true)
  })

  it('is false onto an equal disk', () => {
    expect(needsFilesystemGrowth(small(), small())).toBe(false)
  })
})

describe('growFilesystemCommands', () => {
  it('grows the partition before the filesystem', () => {
    const [first, second] = growFilesystemCommands()

    // Backwards, the resize appears to succeed and claims nothing.
    expect(first).toContain('growpart')
    expect(second).toContain('resize2fs')
  })

  it('uses the xfs tool when asked', () => {
    expect(growFilesystemCommands({ filesystem: 'xfs' })[1]).toContain('xfs_growfs')
  })

  it('honours a custom device', () => {
    expect(growFilesystemCommands({ device: '/dev/vda' })[0]).toContain('/dev/vda 1')
  })
})
