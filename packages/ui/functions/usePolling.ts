export type Signal<T> = (() => T) & { set: (value: T) => void }
declare function state<T>(_value: T): Signal<T>
declare function derived<T>(_value: () => T): Signal<T>
declare function onMount(_callback: () => void | (() => void)): void
declare function useInterval(
  _interval: number,
  _options?: { immediate?: boolean },
): { subscribe: (callback: () => void) => () => void; pause: () => void }

export type PollingState = 'loading' | 'live' | 'stale'

export interface PollingController {
  pollingState: Signal<PollingState>
  pollingError: Signal<string>
  pollingLabel: Signal<PollingState>
  lastUpdatedAt: Signal<Date | null>
  refresh: () => Promise<void>
}

/** Poll immediately and on a lifecycle-owned interval, retaining stale data on failure. */
export function usePolling(task: () => Promise<void>, intervalMs: number): PollingController {
  const pollingState = state<PollingState>('loading')
  const pollingError = state('')
  const lastUpdatedAt = state<Date | null>(null)
  const pollingLabel = derived(() =>
    pollingState() === 'live' ? 'live' : pollingState() === 'stale' ? 'stale' : 'loading',
  )

  async function refresh() {
    try {
      await task()
      pollingState.set('live')
      pollingError.set('')
      lastUpdatedAt.set(new Date())
    } catch (error) {
      pollingState.set('stale')
      pollingError.set(error instanceof Error ? error.message : String(error))
    }
  }

  const interval = useInterval(intervalMs)
  interval.subscribe(refresh)
  onMount(() => {
    refresh()
  })
  return { pollingState, pollingError, pollingLabel, lastUpdatedAt, refresh }
}
