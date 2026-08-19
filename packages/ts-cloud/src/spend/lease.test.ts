import { afterEach, describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { SpendLoopLease } from './lease'
import { SpendRunner, startSpendLoop } from './runner'
import { SpendStore } from './store'

const stores: ControlPlaneStore[] = []

function controlPlane() {
  const store = new ControlPlaneStore({ path: ':memory:' })
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('spend loop lease', () => {
  it('lets the first process take it and refuses the second', () => {
    const store = controlPlane()
    const first = new SpendLoopLease(store, { owner: 'a' })
    const second = new SpendLoopLease(store, { owner: 'b' })
    expect(first.acquire()).toBe(true)
    expect(second.acquire()).toBe(false)
    expect(first.held()).toBe(true)
    expect(second.held()).toBe(false)
  })

  it('lets the holder renew without losing it', () => {
    const store = controlPlane()
    let now = new Date('2026-07-16T12:00:00Z')
    const lease = new SpendLoopLease(store, { owner: 'a', ttlSeconds: 60, now: () => now })
    expect(lease.acquire()).toBe(true)
    const acquiredAt = lease.current()!.acquiredAt
    now = new Date('2026-07-16T12:00:30Z')
    expect(lease.acquire()).toBe(true)
    // Renewal extends the expiry but keeps the original acquisition time, so
    // "how long has this process been driving the loop" stays answerable.
    expect(lease.current()!.acquiredAt).toBe(acquiredAt)
    expect(lease.current()!.expiresAt).toBe('2026-07-16T12:01:30.000Z')
  })

  it('becomes available once it expires, so a dead process cannot block forever', () => {
    const store = controlPlane()
    let now = new Date('2026-07-16T12:00:00Z')
    const dead = new SpendLoopLease(store, { owner: 'dead', ttlSeconds: 60, now: () => now })
    const live = new SpendLoopLease(store, { owner: 'live', ttlSeconds: 60, now: () => now })
    expect(dead.acquire()).toBe(true)
    expect(live.acquire()).toBe(false)
    now = new Date('2026-07-16T12:01:30Z')
    expect(live.acquire()).toBe(true)
    expect(dead.held()).toBe(false)
  })

  it('enforces a floor on the TTL, so a zero cannot make the lease meaningless', () => {
    const store = controlPlane()
    const now = new Date('2026-07-16T12:00:00Z')
    const lease = new SpendLoopLease(store, { owner: 'a', ttlSeconds: 0, now: () => now })
    lease.acquire()
    expect(new Date(lease.current()!.expiresAt).getTime()).toBeGreaterThan(now.getTime())
  })

  it('only lets the holder release it', () => {
    const store = controlPlane()
    const holder = new SpendLoopLease(store, { owner: 'a' })
    const other = new SpendLoopLease(store, { owner: 'b' })
    holder.acquire()
    expect(other.release()).toBe(false)
    expect(holder.held()).toBe(true)
    expect(holder.release()).toBe(true)
    expect(other.acquire()).toBe(true)
  })

  it('reports no holder when nothing has taken it', () => {
    expect(new SpendLoopLease(controlPlane(), { owner: 'a' }).current()).toBeUndefined()
  })

  it('ignores a malformed record rather than trusting it', () => {
    const store = controlPlane()
    store.setSetting('spend.loop.lease', 'not-a-lease')
    const lease = new SpendLoopLease(store, { owner: 'a' })
    expect(lease.current()).toBeUndefined()
    expect(lease.acquire()).toBe(true)
  })

  it('survives a restart: a fresh instance sees the same record', () => {
    const store = controlPlane()
    new SpendLoopLease(store, { owner: 'a' }).acquire()
    expect(new SpendLoopLease(store, { owner: 'b' }).acquire()).toBe(false)
  })
})

describe('spend loop with a lease', () => {
  function runner(store: ControlPlaneStore) {
    return new SpendRunner({ controlPlane: store, store: new SpendStore(store) })
  }

  it('skips a cycle when another process holds the lease', async () => {
    const store = controlPlane()
    new SpendLoopLease(store, { owner: 'someone-else' }).acquire()
    const skipped: string[] = []
    const stop = startSpendLoop(runner(store), {
      lease: new SpendLoopLease(store, { owner: 'me' }),
      immediate: true,
      onSkip: (holder) => skipped.push(holder),
    })
    await Bun.sleep(20)
    stop()
    expect(skipped).toEqual(['someone-else'])
  })

  it('runs when the lease is free', async () => {
    const store = controlPlane()
    let results = 0
    const stop = startSpendLoop(runner(store), {
      lease: new SpendLoopLease(store, { owner: 'me' }),
      immediate: true,
      onResult: () => results++,
    })
    await Bun.sleep(20)
    stop()
    expect(results).toBe(1)
  })

  it('releases on stop, so the next process starts without waiting out the TTL', async () => {
    const store = controlPlane()
    const lease = new SpendLoopLease(store, { owner: 'me', ttlSeconds: 3600 })
    const stop = startSpendLoop(runner(store), { lease, immediate: true })
    await Bun.sleep(20)
    stop()
    expect(new SpendLoopLease(store, { owner: 'next' }).acquire()).toBe(true)
  })

  it('does not run at all without immediate, until the interval elapses', async () => {
    const store = controlPlane()
    let results = 0
    const stop = startSpendLoop(runner(store), { intervalSeconds: 3600, onResult: () => results++ })
    await Bun.sleep(20)
    stop()
    expect(results).toBe(0)
  })
})
