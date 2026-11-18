/**
 * systemd `MemorySwapMax` for every unit ts-cloud writes with memory limits.
 *
 * `MemoryHigh` / `MemoryMax` bound a cgroup's RAM, not its swap. With
 * `MemorySwapMax` left at systemd's default of `infinity`, a unit that reaches
 * `MemoryHigh` is reclaimed into swap instead of being held back, so the
 * ceiling never binds and `MemoryMax` is never reached. On a shared box that
 * is a host-wide failure: two leaking services (768M and 1.5G caps) paged
 * ~3.5G each into swap within 18 minutes of a restart, filled the host's 20G
 * of swap, and the kernel's global OOM killer then repeatedly took clamd —
 * the registry's malware scanner — mid-scan, failing every large upload.
 *
 * A bounded allowance keeps swap useful as headroom for a brief spike while
 * leaving the cgroup's own limits in charge. `'infinity'` opts a unit out;
 * `'0'` forbids swap entirely.
 */
export const DEFAULT_MEMORY_SWAP_MAX = '512M'

export function memorySwapMaxDirective(value?: string): string {
  return `MemorySwapMax=${value ?? DEFAULT_MEMORY_SWAP_MAX}`
}
