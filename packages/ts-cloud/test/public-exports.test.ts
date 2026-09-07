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
import * as operations from '../src/operations'
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

  it('surfaces every runtime value from ./operations', () => {
    expect(missingFromRoot(operations)).toEqual([])
  })

  /**
   * An operation's contract names the helpers a caller has to supply its effects
   * with, and those are as much a part of the surface as the planner is. Every
   * one of these WAS reachable except `isLocalDatabase`, which `site:move`'s
   * docs tell a caller to narrow `resolveAppDatabase` by so the plan can refuse
   * to move an app and leave its database behind. It lives in the drivers
   * barrel, which the root re-exports by an explicit list rather than wholesale,
   * so it resolved to `undefined` at the call site with no error - the caller's
   * choice was between guessing at the config shape and shipping the refusal
   * the operation exists to make.
   */
  it('exports the helpers an operation tells its caller to build effects from', () => {
    for (const helper of ['resolveAppDatabase', 'isLocalDatabase', 'siteInstallBase', 'reloadRpxGateway', 'gatewayHostnames', 'sshExec', 'scpUpload', 'readDriverState', 'writeDriverState']) {
      expect(typeof (root as Record<string, unknown>)[helper]).toBe('function')
    }
  })
})
