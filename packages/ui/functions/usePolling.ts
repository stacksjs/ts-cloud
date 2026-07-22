type Signal<T> = (() => T) & { set: (value: T) => void }
declare function state<T>(value: T): Signal<T>
declare function derived<T>(value: () => T): Signal<T>
declare function onMount(callback: () => void | (() => void)): void
declare function useInterval(interval: number, options?: { immediate?: boolean }): { subscribe: (callback: () => void) => () => void, pause: () => void }

export type PollingState = 'loading' | 'live' | 'stale'

/** Poll immediately and on a lifecycle-owned interval, retaining stale data on failure. */
export function usePolling(task: () => Promise<void>, intervalMs: number) {
  const pollingState = state<PollingState>('loading')
  const pollingError = state('')
  const lastUpdatedAt = state<Date | null>(null)
  const pollingLabel = derived(() => pollingState() === 'live' ? 'live' : pollingState() === 'stale' ? 'stale' : 'loading')

  async function refresh() {
    try {
      await task()
      pollingState.set('live')
      pollingError.set('')
      lastUpdatedAt.set(new Date())
    }
    catch (error) {
      pollingState.set('stale')
      pollingError.set(error instanceof Error ? error.message : String(error))
    }
  }

  const interval = useInterval(intervalMs)
  interval.subscribe(refresh)
  onMount(() => { refresh() })
  return { pollingState, pollingError, pollingLabel, lastUpdatedAt, refresh }
}
