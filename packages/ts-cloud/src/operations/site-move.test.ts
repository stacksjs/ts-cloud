import type { SiteMoveEffects } from './site-move'
import { describe, expect, it } from 'bun:test'
import { applyPlan, formatPlan, resolvePlan } from './plan'
import {
  buildDrainSourceScript,
  buildHealthGateScript,
  buildPauseWorkersScript,
  buildRestoreScript,
  buildSnapshotScript,
  buildSourceStateScript,
  buildWorkersStateScript,
  parseSourceDrained,
  parseTargetReady,
  parseWorkersPaused,
  planSiteMove,
  siteMoveArchivePath,

} from './site-move'

const options = {
  slug: 'hq',
  siteName: 'bughq',
  appBase: '/var/www/hq-bughq',
  from: 'bughq-box',
  to: 'statushq-box',
  targetAddress: '203.0.113.9',
  port: 3010,
}

/** A world where the move has not started: source serving, target empty. */
function world() {
  const state = {
    workersRunning: true,
    onTarget: false,
    targetRunning: false,
    staged: false,
    published: '203.0.113.1',
    routed: false,
    sourceRunning: true,
    ran: [] as string[],
  }
  const effects: SiteMoveEffects = {
    runOnSource: async (script) => {
      state.ran.push(`source:${script.slice(0, 24)}`)
      if (script === buildWorkersStateScript('hq', 'bughq'))
        return state.workersRunning ? 'active:hq-bughq-scheduler.service' : ''
      if (script === buildSourceStateScript('hq', 'bughq'))
        return state.sourceRunning ? 'active:hq-bughq.service' : ''
      if (script.startsWith('set -eu\nfor unit') && script.includes('systemctl stop')) state.workersRunning = false
      if (script.includes('disable --now')) { state.sourceRunning = false; state.workersRunning = false }
      if (script.includes('tar czf')) state.staged = false
      return ''
    },
    runOnTarget: async (script) => {
      state.ran.push(`target:${script.slice(0, 24)}`)
      if (script.startsWith('test -d'))
        return `${state.onTarget ? 'tree:present' : 'tree:absent'}\n${state.targetRunning ? 'unit:active' : 'unit:inactive'}`
      if (script.includes('tar xzf')) { state.onTarget = true; state.targetRunning = true }
      if (script.includes('curl')) {
        if (!state.targetRunning) throw new Error('no healthy response')
        return 'healthy'
      }
      return ''
    },
    transferArchive: async () => { state.staged = true },
    archiveStaged: async () => state.staged,
    cutoverDns: async () => { state.published = options.targetAddress; return [] },
    publishedAddress: async () => state.published,
    refreshTargetGateway: async () => { state.routed = true },
    targetRoutesSite: async () => state.routed,
  }
  return { state, effects }
}

describe('planSiteMove ordering', () => {
  /**
   * Every prefix of the plan has to be a working system — on the old box or the
   * new one. The source keeps serving until the target passes a health gate,
   * DNS moves only after that, and the source is drained last.
   */
  it('gates health before routing, routes before DNS, and drains last', async () => {
    const p = await planSiteMove(options, world().effects)
    expect(p.steps.map(step => step.id)).toEqual([
      'pause-workers',
      'snapshot',
      'transfer',
      'restore',
      'health',
      'gateway',
      'dns',
      'drain-source',
    ])
  })

  /** A worker or scheduler binds no port; gating on one would fail every move. */
  it('omits the health gate for a portless site', async () => {
    const p = await planSiteMove({ ...options, port: undefined }, world().effects)
    expect(p.steps.map(step => step.id)).not.toContain('health')
  })

  it('refuses a move to the box the site is already on', async () => {
    await expect(planSiteMove({ ...options, to: options.from }, world().effects)).rejects.toThrow('already on')
  })

  /**
   * Nothing here deletes: the source tree survives, so a bad cutover is undone
   * by starting the units again. Irreversibility begins at `server:destroy`.
   */
  it('declares no destructive step, because the source is drained and not deleted', async () => {
    const p = await planSiteMove(options, world().effects)
    expect(p.steps.some(step => step.destructive)).toBe(false)
  })
})

describe('planSiteMove execution', () => {
  it('moves the site end to end', async () => {
    const { state, effects } = world()
    const p = await planSiteMove(options, effects)
    const outcome = await applyPlan(p, await resolvePlan(p))
    expect(outcome.success).toBe(true)
    expect(state.onTarget).toBe(true)
    expect(state.targetRunning).toBe(true)
    expect(state.routed).toBe(true)
    expect(state.published).toBe('203.0.113.9')
    expect(state.sourceRunning).toBe(false)
  })

  /**
   * A cutover that reports success while editing nothing is the failure the
   * whole ordering exists to avoid — it must not reach the drain.
   */
  it('refuses to drain the source when DNS reported a warning', async () => {
    const { state, effects } = world()
    const p = await planSiteMove(options, {
      ...effects,
      cutoverDns: async () => ['bughq.example.com → 203.0.113.9 failed: zone not found'],
    })
    const outcome = await applyPlan(p, await resolvePlan(p))
    expect(outcome.success).toBe(false)
    expect(outcome.steps.at(-1)?.id).toBe('dns')
    expect(state.sourceRunning).toBe(true)
  })

  it('leaves the source serving when the target never becomes healthy', async () => {
    const { state, effects } = world()
    const p = await planSiteMove(options, {
      ...effects,
      runOnTarget: async (script) => {
        if (script.startsWith('test -d')) return 'tree:absent\nunit:inactive'
        if (script.includes('curl')) throw new Error('no healthy response from http://127.0.0.1:3010/')
        return ''
      },
    })
    const outcome = await applyPlan(p, await resolvePlan(p))
    expect(outcome.success).toBe(false)
    expect(outcome.steps.at(-1)?.id).toBe('health')
    expect(state.published).toBe('203.0.113.1')
    expect(state.sourceRunning).toBe(true)
  })

  /** The point of the scaffolding: a run that died is resumed, not restarted. */
  it('resumes after a failed cutover without re-transferring', async () => {
    const { state, effects } = world()
    let transfers = 0
    const counted = { ...effects, transferArchive: async () => { transfers++; await effects.transferArchive() } }
    let failDns = true
    const withFlakyDns = {
      ...counted,
      cutoverDns: async () => (failDns ? ['provider timed out'] : counted.cutoverDns()),
    }

    const first = await planSiteMove(options, withFlakyDns)
    expect((await applyPlan(first, await resolvePlan(first))).success).toBe(false)
    expect(transfers).toBe(1)

    failDns = false
    const second = await planSiteMove(options, withFlakyDns)
    const resolved = await resolvePlan(second)
    // Everything up to the cutover is already done and skips itself.
    expect(resolved.find(item => item.step.id === 'transfer')?.state).toBe('satisfied')
    expect(resolved.find(item => item.step.id === 'restore')?.state).toBe('satisfied')
    expect((await applyPlan(second, resolved)).success).toBe(true)
    expect(transfers).toBe(1)
    expect(state.sourceRunning).toBe(false)
  })

  /**
   * The health gate decides whether traffic may move. A gate that remembers a
   * previous pass is not a gate.
   */
  it('re-runs the health gate on every attempt', async () => {
    const p = await planSiteMove(options, world().effects)
    const resolved = await resolvePlan(p)
    expect(resolved.find(item => item.step.id === 'health')?.state).toBe('pending')
    expect(resolved.find(item => item.step.id === 'snapshot')?.state).toBe('pending')
  })

  it('prints a plan that names both boxes before touching anything', async () => {
    const { state, effects } = world()
    const p = await planSiteMove(options, effects)
    const lines = formatPlan(p, await resolvePlan(p)).join('\n')
    expect(lines).toContain('site:move bughq')
    expect(lines).toContain('bughq-box:/var/www/hq-bughq → /tmp/ts-cloud-move-hq-bughq.tar.gz')
    expect(lines).toContain('bughq-box → 203.0.113.9')
    // A plan changes nothing.
    expect(state.onTarget).toBe(false)
    expect(state.sourceRunning).toBe(true)
    expect(state.workersRunning).toBe(true)
  })
})

describe('remote scripts', () => {
  /**
   * Dereferencing symlinks would flatten `current` into a second copy of the
   * live release and turn every shared path back into a per-release file — the
   * exact failure `sharedPaths` exists to prevent.
   */
  it('archives the tree without dereferencing symlinks', () => {
    const script = buildSnapshotScript('hq', 'bughq', '/var/www/hq-bughq')
    expect(script).toContain('tar czf')
    expect(script).not.toContain('tar czhf')
    expect(script).not.toContain(' -h ')
    expect(script).toContain('hq-bughq*.service')
  })

  it('carries the unit files alongside the tree', () => {
    expect(buildRestoreScript('hq', 'bughq', '/var/www/hq-bughq')).toContain('-C /etc/systemd/system')
    expect(buildSnapshotScript('hq', 'bughq', '/var/www/hq-bughq')).toContain('-C /etc/systemd/system')
  })

  /** Two boxes running one scheduler against one dataset is the thing to avoid. */
  it('starts the app on the target but not its background units', () => {
    const script = buildRestoreScript('hq', 'bughq', '/var/www/hq-bughq')
    expect(script).toContain('systemctl restart hq-bughq.service')
    expect(script).not.toContain('scheduler')
    expect(script).not.toContain('queue')
  })

  /** The public name still points at the SOURCE at gate time. */
  it('polls loopback, never the public name', () => {
    const script = buildHealthGateScript(3010, '/health')
    expect(script).toContain('http://127.0.0.1:3010/health')
    expect(script).not.toContain('bughq')
  })

  it('normalizes a health path without a leading slash', () => {
    expect(buildHealthGateScript(3010, 'health')).toContain('http://127.0.0.1:3010/health')
  })

  it('pauses only background units, leaving the site serving', () => {
    const script = buildPauseWorkersScript('hq', 'bughq')
    expect(script).toContain('queue|daemon')
    expect(script).toContain('scheduler')
    expect(script).toContain('systemctl stop')
    expect(script).not.toContain('disable')
  })

  it('drains every unit on the source but deletes no files', () => {
    const script = buildDrainSourceScript('hq', 'bughq')
    expect(script).toContain('systemctl disable --now')
    expect(script).toContain('rm -f /etc/rpx/sites.d/hq.json')
    expect(script).not.toContain('/var/www')
    expect(script).not.toContain('rm -rf')
  })

  /** A dry run must not change the world — the checks only report. */
  it('checks state without mutating it', () => {
    for (const script of [buildWorkersStateScript('hq', 'bughq'), buildSourceStateScript('hq', 'bughq')]) {
      expect(script).not.toContain('systemctl stop')
      expect(script).not.toContain('systemctl disable')
      expect(script).not.toContain('rm ')
    }
  })

  it('parses unit and tree state', () => {
    expect(parseWorkersPaused('')).toBe(true)
    expect(parseWorkersPaused('active:hq-bughq-scheduler.service')).toBe(false)
    expect(parseSourceDrained('active:hq-bughq.service')).toBe(false)
    expect(parseTargetReady('tree:present\nunit:active')).toBe(true)
    expect(parseTargetReady('tree:present\nunit:inactive')).toBe(false)
    expect(parseTargetReady('tree:absent\nunit:active')).toBe(false)
  })

  it('stages the archive under a slug- and site-scoped name', () => {
    expect(siteMoveArchivePath('hq', 'bughq')).toBe('/tmp/ts-cloud-move-hq-bughq.tar.gz')
  })
})

/**
 * A SQLite database rides along in the tree — it lives under `shared/`, which is
 * the whole point of `sharedPaths`. A Postgres or MySQL database does not: it
 * lives in the engine's own data directory, which belongs to the box rather than
 * the site. Moving the tree alone would pass every check in the plan and then
 * serve production an empty database.
 */
describe('planSiteMove with an on-box database', () => {
  function dbWorld() {
    const base = world()
    const db = { dumped: false, staged: false, restored: false, targetData: false }
    const effects = {
      ...base.effects,
      database: {
        dump: async () => { db.dumped = true },
        transferDump: async () => { db.staged = true },
        dumpStaged: async () => db.staged,
        restore: async () => { db.restored = true },
        targetHasData: async () => db.targetData,
      },
    }
    return { state: base.state, db, effects }
  }

  const withDb = { ...options, database: { name: 'bughq' } }

  it('refuses the move when there is no way to carry the database', async () => {
    await expect(planSiteMove(withDb, world().effects)).rejects.toThrow('no way to carry it')
  })

  /** Loading a dump over data already there is the one destructive thing here. */
  it('refuses when the target already holds a database of that name', async () => {
    const { db, effects } = dbWorld()
    db.targetData = true
    await expect(planSiteMove(withDb, effects)).rejects.toThrow('already has a database')
  })

  it('carries the database, and loads it before the app starts', async () => {
    const p = await planSiteMove(withDb, dbWorld().effects)
    const ids = p.steps.map(step => step.id)
    expect(ids).toEqual([
      'pause-workers',
      'database-dump',
      'snapshot',
      'transfer',
      'database-transfer',
      'database-restore',
      'restore',
      'health',
      'gateway',
      'dns',
      'drain-source',
    ])
    // The dump is taken while background work is stopped, and loaded before the
    // app on the target can serve a request against it.
    expect(ids.indexOf('database-dump')).toBeGreaterThan(ids.indexOf('pause-workers'))
    expect(ids.indexOf('database-restore')).toBeLessThan(ids.indexOf('restore'))
  })

  it('moves the data end to end', async () => {
    const { state, db, effects } = dbWorld()
    const p = await planSiteMove(withDb, effects)
    expect((await applyPlan(p, await resolvePlan(p))).success).toBe(true)
    expect(db).toMatchObject({ dumped: true, staged: true, restored: true })
    expect(state.sourceRunning).toBe(false)
  })

  /** A dump from an earlier attempt predates what the source has committed since. */
  it('re-dumps on a resume rather than shipping stale rows', async () => {
    const { effects } = dbWorld()
    const p = await planSiteMove(withDb, effects)
    await applyPlan(p, await resolvePlan(p))
    const again = await resolvePlan(await planSiteMove(withDb, effects))
    expect(again.find(item => item.step.id === 'database-dump')?.state).toBe('pending')
    // The transfer, though, resumes — the dump is already staged.
    expect(again.find(item => item.step.id === 'database-transfer')?.state).toBe('satisfied')
  })

  /** An external database is reached at the same endpoint from either box. */
  it('adds no database steps when the project has no on-box database', async () => {
    const p = await planSiteMove(options, world().effects)
    expect(p.steps.map(step => step.id).some(id => id.startsWith('database-'))).toBe(false)
  })

  it('leaves the source serving when the restore fails', async () => {
    const { state, effects } = dbWorld()
    const p = await planSiteMove(withDb, {
      ...effects,
      database: { ...effects.database, restore: async () => { throw new Error('role does not exist') } },
    })
    const outcome = await applyPlan(p, await resolvePlan(p))
    expect(outcome.success).toBe(false)
    expect(outcome.steps.at(-1)?.id).toBe('database-restore')
    expect(state.published).toBe('203.0.113.1')
    expect(state.sourceRunning).toBe(true)
  })
})
