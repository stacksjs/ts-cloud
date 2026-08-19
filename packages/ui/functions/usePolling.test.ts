import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { DashboardRequestError } from './requestJson'
import { usePolling } from './usePolling'

// usePolling reaches for stx's runtime globals. Stub the smallest honest
// versions of them so the classification logic can be exercised directly.
const globals = globalThis as unknown as Record<string, unknown>
const saved: Record<string, unknown> = {}
let mounts: Array<() => void> = []
let ticks: Array<() => void> = []
let paused = 0

beforeEach(() => {
  mounts = []
  ticks = []
  paused = 0
  for (const key of ['state', 'derived', 'onMount', 'useInterval']) saved[key] = globals[key]

  globals.state = (value: unknown) => {
    let current = value
    const signal = () => current
    signal.set = (next: unknown) => {
      current = next
    }
    return signal
  }
  globals.derived = (compute: () => unknown) => compute
  globals.onMount = (callback: () => void) => mounts.push(callback)
  globals.useInterval = () => ({
    subscribe: (callback: () => void) => {
      ticks.push(callback)
      return () => {}
    },
    pause: () => {
      paused++
    },
  })
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) globals[key] = value
})

/** Run the mount pass the way stx would. */
async function mount(): Promise<void> {
  for (const callback of mounts) callback()
  await Promise.resolve()
  await Promise.resolve()
}

describe('polling state', () => {
  it('reports live after a successful refresh', async () => {
    const polling = usePolling(async () => {}, 30_000)
    await mount()
    expect(polling.pollingState()).toBe('live')
    expect(polling.pollingError()).toBe('')
    expect(polling.isSnapshot()).toBe(false)
    expect(polling.lastUpdatedAt()).toBeInstanceOf(Date)
  })

  it('keeps a failed refresh as a stale error and keeps polling', async () => {
    const polling = usePolling(async () => {
      throw new DashboardRequestError('Bad gateway', 502)
    }, 30_000)
    await mount()
    expect(polling.pollingState()).toBe('stale')
    expect(polling.pollingError()).toBe('Bad gateway')
    expect(polling.isSnapshot()).toBe(false)
    expect(paused).toBe(0)
  })

  it('treats a missing API as a snapshot rather than an outage, and stops asking', async () => {
    const polling = usePolling(
      async () => {
        throw new DashboardRequestError('Request failed with HTTP 404.', 404)
      },
      30_000,
      { snapshotWhenApiMissing: true },
    )
    await mount()
    expect(polling.pollingState()).toBe('snapshot')
    expect(polling.isSnapshot()).toBe(true)
    // The banner stays empty: the baked data is real, it just cannot refresh.
    expect(polling.pollingError()).toBe('')
    expect(paused).toBe(1)
  })

  it('accepts the other answers a route-less deploy gives', async () => {
    for (const status of [405, 501]) {
      const polling = usePolling(
        async () => {
          throw new DashboardRequestError('nope', status)
        },
        30_000,
        { snapshotWhenApiMissing: true },
      )
      await mount()
      expect(polling.pollingState()).toBe('snapshot')
      mounts = []
    }
  })

  it('still reports a missing route as an error for a page that manages live resources', async () => {
    // The default. A management page's buttons post to that same API, so
    // calling a 404 a "snapshot" would hide a genuinely broken deployment.
    const polling = usePolling(async () => {
      throw new DashboardRequestError('Request failed with HTTP 404.', 404)
    }, 30_000)
    await mount()
    expect(polling.pollingState()).toBe('stale')
    expect(polling.pollingError()).toBe('Request failed with HTTP 404.')
    expect(polling.isSnapshot()).toBe(false)
    expect(paused).toBe(0)
  })

  it('does not mistake a plain thrown error for a snapshot', async () => {
    const polling = usePolling(async () => {
      throw new Error('This deployment reported no topology to draw.')
    }, 30_000)
    await mount()
    expect(polling.pollingState()).toBe('stale')
    expect(polling.pollingError()).toBe('This deployment reported no topology to draw.')
    expect(paused).toBe(0)
  })

  it('recovers to live if the API comes back on a later tick', async () => {
    let fail = true
    const polling = usePolling(async () => {
      if (fail) throw new DashboardRequestError('Bad gateway', 502)
    }, 30_000)
    await mount()
    expect(polling.pollingState()).toBe('stale')
    fail = false
    for (const tick of ticks) tick()
    await Promise.resolve()
    await Promise.resolve()
    expect(polling.pollingState()).toBe('live')
    expect(polling.pollingError()).toBe('')
  })

  it('labels the state it is in', async () => {
    const polling = usePolling(async () => {}, 30_000)
    expect(polling.pollingLabel()).toBe('loading')
    await mount()
    expect(polling.pollingLabel()).toBe('live')
  })
})
