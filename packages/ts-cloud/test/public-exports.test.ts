/**
 * The package root must re-export everything its subpath entry points do.
 *
 * Consumers import from `@stacksjs/ts-cloud`; the subpaths (`/dns`, `/cdn`, …)
 * exist for tree-shaking, not as the place a symbol is only reachable from. A
 * symbol that lands in a subpath and never gets added to `src/index.ts` reads to
 * the consumer as an undefined import with no error — the module resolves, the
 * name is just `undefined` — which is why this has already been fixed twice by
 * hand (`gatewayHostnames`, then `CloudflareProvider`, the latter while its own
 * options type exported fine and made the omission look like a caller mistake).
 *
 * Comparing whole namespaces rather than listing names keeps the check honest
 * as the surface grows: a new export in a subpath fails here until it is
 * surfaced, instead of being discovered by whoever tries to use it.
 */
import { describe, expect, it } from 'bun:test'
import * as cdn from '../src/cdn'
import * as dns from '../src/dns'
import * as root from '../src/index'

/** Names a subpath exports that the root does not. */
function missingFromRoot(subpath: Record<string, unknown>): string[] {
  return Object.keys(subpath)
    .filter(name => !(name in root))
    .sort()
}

describe('package root re-exports its subpaths', () => {
  it('surfaces every runtime value from ./dns', () => {
    expect(missingFromRoot(dns)).toEqual([])
  })

  it('surfaces every runtime value from ./cdn', () => {
    expect(missingFromRoot(cdn)).toEqual([])
  })

  it('surfaces every DNS provider class, not just some', () => {
    // The specific regression: three of the four providers were exported from
    // the root and Cloudflare was not, so `reconcileCloudflareCdn` — which
    // takes a CloudflareProvider instance — could not be called with one
    // obtained from the same import.
    for (const provider of ['CloudflareProvider', 'PorkbunProvider', 'GoDaddyProvider', 'Route53Provider']) {
      expect(typeof (root as Record<string, unknown>)[provider]).toBe('function')
    }
  })

  it('exports the Cloudflare CDN entry points a deploy needs', () => {
    expect(typeof root.reconcileCloudflareCdn).toBe('function')
    expect(typeof root.resolveCloudflareCdnPlan).toBe('function')
  })
})
