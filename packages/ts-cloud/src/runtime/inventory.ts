import type { RuntimeDiscoveryAdapter, RuntimeDiscoveryContext, RuntimeInventory, RuntimeSourceStatus, RuntimeWorkload } from './model'

export interface DiscoverInventoryOptions {
  timeoutMs?: number
  staleAfterSeconds?: number
}

function errorStatus(error: unknown): RuntimeSourceStatus['status'] {
  const message = String((error as any)?.message ?? error)
  if (/(?:unauthorized|accessdenied|forbidden|credentials)/i.test(message)) return 'unauthorized'
  if (/(?:timeout|unreachable|econnrefused|enotfound|network)/i.test(message)) return 'unreachable'
  return 'error'
}

export async function discoverRuntimeInventory(
  adapters: RuntimeDiscoveryAdapter[],
  context: RuntimeDiscoveryContext = {},
  options: DiscoverInventoryOptions = {},
): Promise<RuntimeInventory> {
  const now = context.now ?? new Date()
  const timeoutMs = Math.max(100, options.timeoutMs ?? 10_000)
  const staleAfterSeconds = Math.max(1, options.staleAfterSeconds ?? 60)
  const settled = await Promise.all(
    adapters.map(async (adapter): Promise<{ workloads: RuntimeWorkload[]; source: RuntimeSourceStatus }> => {
      try {
        const workloads = await Promise.race([
          adapter.discover({ ...context, now }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Runtime source ${adapter.id} timed out after ${timeoutMs}ms`)),
              timeoutMs,
            ),
          ),
        ])
        return {
          workloads,
          source: {
            id: adapter.id,
            provider: adapter.provider,
            status: 'fresh',
            discoveredAt: now.toISOString(),
            staleAfterSeconds,
            itemCount: workloads.length,
          },
        }
      } catch (error: any) {
        return {
          workloads: [],
          source: {
            id: adapter.id,
            provider: adapter.provider,
            status: errorStatus(error),
            discoveredAt: now.toISOString(),
            staleAfterSeconds,
            itemCount: 0,
            message: String(error?.message ?? error).slice(0, 500),
          },
        }
      }
    }),
  )
  const sources = settled.map((result) => result.source)
  return {
    generatedAt: now.toISOString(),
    workloads: settled
      .flatMap((result) => result.workloads)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    sources,
    degraded: sources.some((source) => source.status !== 'fresh'),
  }
}
