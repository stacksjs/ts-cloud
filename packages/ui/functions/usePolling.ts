export type Signal<T> = (() => T) & { set: (value: T) => void }
declare function state<T>(_value: T): Signal<T>
declare function derived<T>(_value: () => T): Signal<T>
declare function onMount(_callback: () => void | (() => void)): void
declare function useInterval(
  _interval: number,
  _options?: { immediate?: boolean },
): { subscribe: (callback: () => void) => () => void; pause: () => void }

/**
 * `snapshot` means the cockpit was exported without its control plane — the
 * static + htpasswd deploy (`TS_CLOUD_UI_STATIC`). The data baked into the page
 * is real, it just cannot be refreshed, which is a different thing from a
 * refresh that failed and must not be reported as an error.
 */
export type PollingState = 'loading' | 'live' | 'stale' | 'snapshot'

export interface PollingController {
  pollingState: Signal<PollingState>
  pollingError: Signal<string>
  pollingLabel: Signal<PollingState>
  lastUpdatedAt: Signal<Date | null>
  /** True once the deployment has told us it serves no API. */
  isSnapshot: Signal<boolean>
  refresh: () => Promise<void>
}

export interface PollingOptions {
  /**
   * Treat a missing API route as "this build has no control plane" instead of
   * as an error.
   *
   * Opt in only from a page whose data is fully baked in at build time, so
   * there is genuinely nothing lost by not polling — the infrastructure map,
   * for instance. A page that manages live resources must NOT set this: its
   * buttons post to that same missing API, so a 404 there is a real fault and
   * calling it a snapshot would hide it. Off by default for that reason.
   */
  snapshotWhenApiMissing?: boolean
}

/**
 * A build served without its control plane answers the API route itself rather
 * than failing in transit: a static host 404s the path, and a proxy that knows
 * the route but not the method answers 405/501. Anything else — a 500, a
 * dropped connection, malformed JSON — is a real failure and stays one.
 *
 * Only errors carrying an HTTP status qualify, so the caller must be using
 * `requestJson` (which raises `DashboardRequestError`); a bare `fetch` that
 * throws a plain `Error` keeps the stale-with-error behaviour.
 */
function servedWithoutApi(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status
  return status === 404 || status === 405 || status === 501
}

/** Poll immediately and on a lifecycle-owned interval, retaining stale data on failure. */
export function usePolling(
  task: () => Promise<void>,
  intervalMs: number,
  options: PollingOptions = {},
): PollingController {
  const pollingState = state<PollingState>('loading')
  const pollingError = state('')
  const lastUpdatedAt = state<Date | null>(null)
  const isSnapshot = state(false)
  const pollingLabel = derived<PollingState>(() => pollingState())

  const interval = useInterval(intervalMs)

  async function refresh() {
    try {
      await task()
      pollingState.set('live')
      pollingError.set('')
      isSnapshot.set(false)
      lastUpdatedAt.set(new Date())
    } catch (error) {
      if (options.snapshotWhenApiMissing && servedWithoutApi(error)) {
        // Nothing here will ever answer, so stop asking. The page keeps the
        // data it was built with and says it is a snapshot, not an outage.
        isSnapshot.set(true)
        pollingState.set('snapshot')
        pollingError.set('')
        interval.pause()
        return
      }
      pollingState.set('stale')
      pollingError.set(error instanceof Error ? error.message : String(error))
    }
  }

  interval.subscribe(refresh)
  onMount(() => {
    refresh()
  })
  return { pollingState, pollingError, pollingLabel, lastUpdatedAt, isSnapshot, refresh }
}
