import { describe, expect, it } from 'bun:test'
import type { ComputeDeployLogger } from '../../src/drivers/shared/compute-deploy'
import { deploySitesInWaves, prefixedLogger, resolveDeployConcurrency } from '../../src/drivers/shared/compute-deploy'

/**
 * Sites of one project on one box used to deploy strictly one after another,
 * which for a five-role app meant five full cutovers in a row. With
 * `compute.deployConcurrency` above 1 the first site (the schema owner) still
 * goes alone, then the rest go together.
 */

function recorder() {
  const lines: string[] = []
  const logger: ComputeDeployLogger = {
    info: m => lines.push(`info ${m}`),
    warn: m => lines.push(`warn ${m}`),
    error: m => lines.push(`error ${m}`),
    step: m => lines.push(`step ${m}`),
    success: m => lines.push(`success ${m}`),
  }
  return { lines, logger }
}

const sites = ['main', 'api', 'scheduler', 'worker', 'watcher'].map(name => [name, { name }] as const)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('deploySitesInWaves', () => {
  it('runs the first site alone, then the rest concurrently', async () => {
    const events: string[] = []
    let inFlight = 0
    let peak = 0
    const ok = await deploySitesInWaves(sites, 4, async (name) => {
      events.push(`start ${name}`)
      inFlight++
      peak = Math.max(peak, inFlight)
      await sleep(10)
      inFlight--
      events.push(`end ${name}`)
      return true
    }, recorder().logger)

    expect(ok).toBe(true)
    expect(events.slice(0, 2)).toEqual(['start main', 'end main'])
    expect(peak).toBe(4)
    expect(events.filter(e => e.startsWith('end')).length).toBe(5)
  })

  it('never exceeds the concurrency asked for', async () => {
    let inFlight = 0
    let peak = 0
    await deploySitesInWaves(sites, 2, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await sleep(5)
      inFlight--
      return true
    }, recorder().logger)
    expect(peak).toBe(2)
  })

  it('stops before the rest when the first site fails', async () => {
    const started: string[] = []
    const ok = await deploySitesInWaves(sites, 4, async (name) => {
      started.push(name)
      return name !== 'main'
    }, recorder().logger)
    expect(ok).toBe(false)
    expect(started).toEqual(['main'])
  })

  it('lets in-flight sites finish when one fails, and starts no new ones', async () => {
    const finished: string[] = []
    const ok = await deploySitesInWaves(sites, 2, async (name) => {
      await sleep(name === 'api' ? 1 : 15)
      finished.push(name)
      return name !== 'api'
    }, recorder().logger)
    expect(ok).toBe(false)
    // main alone, then api (fails fast) and scheduler together; scheduler
    // still finishes, worker and watcher never start.
    expect(finished).toEqual(['main', 'api', 'scheduler'])
  })

  it('keeps the old sequential behaviour at concurrency 1', async () => {
    const order: string[] = []
    const { lines, logger } = recorder()
    await deploySitesInWaves(sites, 1, async (name, _site, log) => {
      order.push(name)
      log.info(name)
      return true
    }, logger)
    expect(order).toEqual(['main', 'api', 'scheduler', 'worker', 'watcher'])
    expect(lines).toEqual(['info main', 'info api', 'info scheduler', 'info worker', 'info watcher'])
  })

  it('tags concurrent sites\' log lines with their name', async () => {
    const { lines, logger } = recorder()
    await deploySitesInWaves(sites.slice(0, 3), 4, async (name, _site, log) => {
      log.step(`Deploying site: ${name}`)
      return true
    }, logger)
    expect(lines).toContain('step Deploying site: main')
    expect(lines).toContain('step [api] Deploying site: api')
    expect(lines).toContain('step [scheduler] Deploying site: scheduler')
  })
})

describe('resolveDeployConcurrency', () => {
  const config = (deployConcurrency?: unknown) => ({ infrastructure: { compute: { deployConcurrency } } }) as any
  it('defaults to one at a time', () => {
    expect(resolveDeployConcurrency({} as any)).toBe(1)
    expect(resolveDeployConcurrency(config(undefined))).toBe(1)
  })
  it('accepts a whole number of at least one', () => {
    expect(resolveDeployConcurrency(config(4))).toBe(4)
    expect(resolveDeployConcurrency(config(2.7))).toBe(2)
    expect(resolveDeployConcurrency(config(0))).toBe(1)
    expect(resolveDeployConcurrency(config('lots'))).toBe(1)
  })
})

describe('prefixedLogger', () => {
  it('prefixes every level', () => {
    const { lines, logger } = recorder()
    const log = prefixedLogger(logger, 'api')
    log.info('a')
    log.warn('b')
    log.error('c')
    log.step('d')
    log.success('e')
    expect(lines).toEqual(['info [api] a', 'warn [api] b', 'error [api] c', 'step [api] d', 'success [api] e'])
  })
})
