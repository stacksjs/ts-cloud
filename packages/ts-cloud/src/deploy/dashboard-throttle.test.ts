import { describe, expect, it } from 'bun:test'
import { LOCKOUT_MS, LoginThrottle, MAX_ATTEMPTS, WINDOW_MS } from './dashboard-throttle'

const IP = '203.0.113.5'
const T0 = 1_000_000

function failTimes(throttle: LoginThrottle, n: number, username = 'admin', address = IP, at = T0): void {
  for (let i = 0; i < n; i++) throttle.recordFailure(username, address, at)
}

describe('LoginThrottle', () => {
  it('allows attempts below the threshold', () => {
    const throttle = new LoginThrottle()
    failTimes(throttle, MAX_ATTEMPTS - 1)
    expect(throttle.check('admin', IP, T0).allowed).toBe(true)
  })

  it('locks out once the threshold is reached', () => {
    const throttle = new LoginThrottle()
    failTimes(throttle, MAX_ATTEMPTS)
    const decision = throttle.check('admin', IP, T0)
    expect(decision.allowed).toBe(false)
    expect(decision.retryAfterSeconds).toBe(LOCKOUT_MS / 1000)
  })

  it('stays locked for the window, then allows again', () => {
    const throttle = new LoginThrottle()
    failTimes(throttle, MAX_ATTEMPTS)
    expect(throttle.check('admin', IP, T0 + LOCKOUT_MS - 1).allowed).toBe(false)
    expect(throttle.check('admin', IP, T0 + LOCKOUT_MS).allowed).toBe(true)
  })

  it('counts down the retry time', () => {
    const throttle = new LoginThrottle()
    failTimes(throttle, MAX_ATTEMPTS)
    expect(throttle.check('admin', IP, T0 + 60_000).retryAfterSeconds).toBe(LOCKOUT_MS / 1000 - 60)
  })

  it('clears the counter on success', () => {
    const throttle = new LoginThrottle()
    failTimes(throttle, MAX_ATTEMPTS - 1)
    throttle.recordSuccess('admin', IP)
    failTimes(throttle, MAX_ATTEMPTS - 1)
    expect(throttle.check('admin', IP, T0).allowed).toBe(true)
  })

  /**
   * Keying on username alone would let anyone lock the operator out of their
   * own box by failing logins against 'admin' — a denial of service wearing a
   * security control's clothes.
   */
  it('does not let one address lock out another', () => {
    const throttle = new LoginThrottle()
    failTimes(throttle, MAX_ATTEMPTS, 'admin', '198.51.100.9')
    expect(throttle.check('admin', '198.51.100.9', T0).allowed).toBe(false)
    expect(throttle.check('admin', IP, T0).allowed).toBe(true)
  })

  it('tracks usernames separately from the same address', () => {
    const throttle = new LoginThrottle()
    failTimes(throttle, MAX_ATTEMPTS, 'admin')
    expect(throttle.check('dana', IP, T0).allowed).toBe(true)
  })

  it('treats usernames case-insensitively, matching login', () => {
    const throttle = new LoginThrottle()
    failTimes(throttle, MAX_ATTEMPTS, 'ADMIN')
    expect(throttle.check('admin', IP, T0).allowed).toBe(false)
  })

  it('forgets stale failures, so occasional typos never accumulate', () => {
    const throttle = new LoginThrottle()
    failTimes(throttle, MAX_ATTEMPTS - 1)
    // One more failure, long after the window — starts over rather than locking.
    throttle.recordFailure('admin', IP, T0 + WINDOW_MS + 1)
    expect(throttle.check('admin', IP, T0 + WINDOW_MS + 1).allowed).toBe(true)
  })

  it('prunes expired entries so the map cannot grow without bound', () => {
    const throttle = new LoginThrottle()
    failTimes(throttle, 1, 'a')
    failTimes(throttle, 1, 'b')
    expect(throttle.size).toBe(2)
    throttle.prune(T0 + WINDOW_MS + 1)
    expect(throttle.size).toBe(0)
  })

  it('keeps live entries when pruning', () => {
    const throttle = new LoginThrottle()
    failTimes(throttle, MAX_ATTEMPTS, 'locked')
    throttle.prune(T0 + 1000)
    expect(throttle.size).toBe(1)
    expect(throttle.check('locked', IP, T0 + 1000).allowed).toBe(false)
  })

  it('honors custom limits', () => {
    const throttle = new LoginThrottle(2, 1000, 1000)
    failTimes(throttle, 2)
    expect(throttle.check('admin', IP, T0).allowed).toBe(false)
    expect(throttle.check('admin', IP, T0 + 1000).allowed).toBe(true)
  })
})
