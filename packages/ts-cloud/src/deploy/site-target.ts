import type { CloudConfig, SiteConfig, SiteDeployTarget } from '@ts-cloud/core'
import { deploymentCoexistenceError, resolveDeploymentMode } from '@ts-cloud/core'

/**
 * The resolved deployment kinds for a site:
 *  - `'bucket'`        — upload built `root` to object storage + CDN.
 *  - `'server-app'`    — `server` + `start`: dynamic app as a systemd service.
 *  - `'server-static'` — `server` + no `start` (has static `root`): a static
 *                        site built and shipped to `/var/www/<site>` on the box
 *                        (served by the operator's own proxy, e.g. rpx + tlsx).
 *  - `'redirect'`      — gateway-only: `redirect` is set. Nothing is shipped;
 *                        the gateway answers `domain` with an HTTP redirect.
 *  - `'proxy'`         — gateway-only: `proxyTo` is set. Nothing is shipped and
 *                        no unit is managed; the gateway forwards `domain` to an
 *                        upstream somebody else runs. The domain still joins the
 *                        gateway's TLS set, which is the point.
 */
export type SiteDeployKind = 'bucket' | 'server-app' | 'server-static' | 'server-php' | 'redirect' | 'proxy'

/**
 * On-disk base directory for a site's atomic release tree
 * (`<base>/releases/<sha>` + `<base>/current`).
 *
 * Namespaced by the project **slug** so that on a shared / multi-tenant box
 * (`cloud.attachTo`) two projects — or a tenant and the box owner — can never
 * collide on the same `/var/www/<name>` path. A bare `/var/www/<siteName>`
 * meant that e.g. every project with a `main` site fought over `/var/www/main`,
 * silently overwriting each other's releases and round-robining stale responses
 * on the shared port. This mirrors the systemd unit naming (`<slug>-<siteName>`)
 * so a release directory and the service that runs it share one identity.
 *
 * MUST be the single source of truth for the install path — deploy, rpx routing
 * (server-static), rollback/ops, and dashboard data all derive from it, so they
 * can never diverge.
 */
export function siteInstallBase(slug: string, siteName: string): string {
  return `/var/www/${slug}-${siteName}`
}

/** Site `type` values that deploy as a PHP/Laravel git-release site. */
const PHP_SITE_TYPES: ReadonlySet<NonNullable<SiteConfig['type']>> = new Set([
  'laravel',
  'php',
  'statamic',
  'wordpress',
])

/**
 * A PHP/Laravel site: deployed to the compute box via git clone into atomic
 * release directories and served by nginx + php-fpm. Identified by a PHP
 * `type` (laravel/php/statamic/wordpress).
 */
export function isPhpSite(site: SiteConfig): boolean {
  return site.type != null && PHP_SITE_TYPES.has(site.type)
}

/**
 * Normalize a proxy-only site's `proxyTo` into the upstream list the gateway
 * routes to, dropping blanks so a stray empty string cannot produce a route
 * pointing at nothing.
 *
 * Returns `[]` when the site declares no usable upstream, which is what
 * {@link hasProxyUpstream} keys off.
 */
export function resolveProxyUpstreams(site: SiteConfig): string[] {
  const raw = site.proxyTo
  if (raw == null) return []
  const list = Array.isArray(raw) ? raw : [raw]
  return list.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
}

/** Does this site forward to an upstream ts-cloud does not manage? */
export function hasProxyUpstream(site: SiteConfig): boolean {
  return resolveProxyUpstreams(site).length > 0
}

/**
 * Resolve the explicit-or-inferred {@link SiteDeployTarget} for a site.
 *
 * Inference (backward compatible):
 *  1. an explicit `site.deploy` always wins;
 *  2. else if `start` is present → `'server'`;
 *  3. else → `'bucket'`.
 */
export function resolveSiteDeployTarget(site: SiteConfig): SiteDeployTarget {
  if (site.deploy) return site.deploy
  // PHP/Laravel sites are always server-deployed (nginx + php-fpm on the box).
  if (isPhpSite(site)) return 'server'
  if (site.start) return 'server'
  return 'bucket'
}

/**
 * Resolve the fine-grained {@link SiteDeployKind} for a site, combining the
 * {@link resolveSiteDeployTarget} target with the presence of `start`.
 *
 * - `bucket`                       → `'bucket'`
 * - `server` + `start`            → `'server-app'`
 * - `server` + no `start`         → `'server-static'`
 */
export function resolveSiteKind(site: SiteConfig): SiteDeployKind {
  // A redirect-only site ships nothing — the gateway answers `domain` with a
  // redirect. Wins over every other kind (`root`/`start`/`type` are ignored).
  if (site.redirect) return 'redirect'
  // A proxy-only site ships nothing either, and ts-cloud manages no unit for it:
  // the gateway just forwards `domain` to an upstream somebody else runs. Also
  // wins over `root`/`start`/`type`, so a stale `root` left on the site cannot
  // turn it back into a release that would overwrite the running service.
  if (hasProxyUpstream(site)) return 'proxy'
  // PHP/Laravel sites always deploy to the box via git + atomic releases,
  // regardless of `deploy`/`start`.
  if (isPhpSite(site)) return 'server-php'
  const target = resolveSiteDeployTarget(site)
  if (target === 'bucket') return 'bucket'
  return site.start ? 'server-app' : 'server-static'
}

/** Does this project own a compute server or attach to an owner's server? */
export function hasComputeConfigured(config: CloudConfig): boolean {
  return config.infrastructure?.compute != null || Boolean(config.cloud?.attachTo?.trim())
}

export interface DeploymentValidationResult {
  errors: string[]
  warnings: string[]
}

export interface ValidateDeploymentOptions {
  /**
   * Ports this box already serves for OTHER projects, as port -> owning slug.
   *
   * Validation is otherwise blind to co-tenants: it only ever sees one project's
   * `sites`, so two apps attached to the same server can both declare the
   * template's default port and both pass. The box does not reject the second
   * one either - ts-cloud's units do not set exclusive binding, so both bind and
   * the kernel load-balances, leaving each domain serving the other project's
   * site about half the time with nothing logged as an error. Supplying this
   * turns that into a plan-time error naming the project holding the port.
   *
   * Build it with `occupiedHostPorts()` from `./site-ports`, passing the
   * deploying project's own slug as `ignoreSlug` - its fragment is already on the
   * box from the last deploy, and counting it would make every redeploy conflict
   * with itself.
   *
   * Omitted means "no co-tenant information", which validates exactly as before.
   *
   * @see https://github.com/stacksjs/ts-cloud/issues/168
   */
  occupiedPorts?: ReadonlyMap<number, string>
}

/**
 * Validate the per-site deployment configuration up front, turning what used to
 * be silent runtime failures (e.g. a `start` site with no compute server) into
 * an explicit, actionable contract.
 *
 * Never throws — returns structured `{ errors, warnings }`. Callers should abort
 * on any error and print warnings while continuing.
 */
export function validateDeploymentConfig(
  config: CloudConfig,
  options: ValidateDeploymentOptions = {},
): DeploymentValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const sites = config.sites || {}
  const computeConfigured = hasComputeConfigured(config)

  // Server and serverless deployments are mutually exclusive: a project cannot
  // declare both `infrastructure.compute` (server) and `environments.<env>.app`
  // (serverless Lambda). Surface it up front as a hard error.
  const coexistence = deploymentCoexistenceError(config)
  if (coexistence) errors.push(coexistence)

  // Track ports across server-app sites to catch collisions on a shared box.
  const portOwners = new Map<number, string>()

  for (const [name, site] of Object.entries(sites)) {
    if (!site) {
      continue
    }

    const target = resolveSiteDeployTarget(site)
    const kind = resolveSiteKind(site)

    // A redirect-only site is gateway-only: it needs a `domain` to answer and a
    // redirect target, but ships nothing (no `root`/`start`).
    if (kind === 'redirect') {
      if (!site.domain) errors.push(`Site '${name}' is a redirect site but has no \`domain\` to redirect from.`)
      const to = typeof site.redirect === 'string' ? site.redirect : site.redirect?.to
      if (!to)
        errors.push(`Site '${name}' is a redirect site but has no redirect target (\`redirect\` / \`redirect.to\`).`)
      if (!computeConfigured) {
        errors.push(
          `Site '${name}' is a redirect site but no \`infrastructure.compute\` is configured to host the gateway that serves the redirect.`,
        )
      }
      const serverOnly: string[] = []
      if (site.start) serverOnly.push('start')
      if (site.root) serverOnly.push('root')
      if (site.proxyTo) serverOnly.push('proxyTo')
      if (serverOnly.length > 0)
        warnings.push(`Site '${name}' is a redirect site but also sets ${serverOnly.join(', ')}. These are ignored.`)
      continue
    }

    // A proxy-only site is gateway-only too: it needs a `domain` to answer on
    // and an upstream to forward to, and it needs the gateway to exist. It
    // deliberately does NOT need a port of its own — the upstream carries it,
    // and the service behind it is not ts-cloud's to supervise, so it is also
    // exempt from the server-app port-collision check below.
    if (kind === 'proxy') {
      if (!site.domain) errors.push(`Site '${name}' is a proxy site but has no \`domain\` to route from.`)
      if (!computeConfigured) {
        errors.push(
          `Site '${name}' is a proxy site but no \`infrastructure.compute\` is configured to host the gateway that forwards it.`,
        )
      }
      const ignored: string[] = []
      if (site.start) ignored.push('start')
      if (site.root) ignored.push('root')
      if (typeof site.port === 'number') ignored.push('port')
      if (site.build) ignored.push('build')
      if (site.preStart && site.preStart.length > 0) ignored.push('preStart')
      if (ignored.length > 0) {
        warnings.push(
          `Site '${name}' sets \`proxyTo\`, so ts-cloud ships and supervises nothing for it. ${ignored.join(', ')} ${ignored.length === 1 ? 'is' : 'are'} ignored — remove ${ignored.length === 1 ? 'it' : 'them'}, or drop \`proxyTo\` to let ts-cloud own the service.`,
        )
      }
      continue
    }

    // `deploy: 'server'` with neither `start` nor `root` is meaningless.
    if (target === 'server' && !site.start && !site.root) {
      errors.push(
        `Site '${name}' sets deploy:'server' but declares neither \`start\` (dynamic app) nor \`root\` (static site to serve). Add one.`,
      )
      continue
    }

    if (kind === 'server-php') {
      // PHP/Laravel sites clone from git onto the compute box.
      if (!computeConfigured) {
        errors.push(
          `Site '${name}' is a PHP site (type:'${site.type}') but no \`infrastructure.compute\` is configured. Add a server (infrastructure.compute) with PHP provisioning.`,
        )
      }
      if (!site.repository?.url) {
        errors.push(
          `Site '${name}' is a PHP site (type:'${site.type}') but has no \`repository.url\` to clone. PHP sites deploy via git.`,
        )
      }
    } else if (kind === 'server-app') {
      // A server-app needs a place to run. Without a compute server this is the
      // old silent runtime failure — surface it now.
      if (!computeConfigured) {
        errors.push(
          `Site '${name}' deploys to a server (deploy:'server'${site.deploy ? '' : ' inferred from \`start\`'}) but no \`infrastructure.compute\` is configured. Set deploy:'bucket' or add a server (infrastructure.compute).`,
        )
      }

      if (typeof site.port === 'number') {
        // A co-tenant on the same box holds this port. Reported separately from
        // the same-config clash below because the fix is different: the operator
        // cannot see the other project's config from here, so the message has to
        // name the owning project rather than a sibling site.
        const coTenant = options.occupiedPorts?.get(site.port)
        if (coTenant) {
          errors.push(
            `Site '${name}' wants port ${site.port}, which project '${coTenant}' already serves on this box. `
            + `Attached projects share one port namespace. Give '${name}' a free port, or let the attach allocate one.`,
          )
        }

        const existing = portOwners.get(site.port)
        if (existing) {
          errors.push(
            `Sites '${existing}' and '${name}' both use port ${site.port}. Server apps sharing a box must use distinct ports.`,
          )
        } else {
          portOwners.set(site.port, name)
        }
      }
    } else if (kind === 'server-static') {
      if (!site.root) {
        errors.push(
          `Site '${name}' is a server static site (deploy:'server', no \`start\`) but has no \`root\` directory to serve.`,
        )
      }
      // A static site served on the box still needs the box to exist.
      if (!computeConfigured) {
        errors.push(
          `Site '${name}' deploys to a server (deploy:'server') but no \`infrastructure.compute\` is configured. Set deploy:'bucket' or add a server (infrastructure.compute).`,
        )
      }
    } else {
      // bucket
      if (!site.root) {
        errors.push(`Site '${name}' deploys to a bucket but has no \`root\` directory to upload.`)
      }
      // Server-only fields on a bucket site are ignored — warn so they're not
      // mistaken for active configuration.
      const serverOnly: string[] = []
      if (site.start) serverOnly.push('start')
      if (typeof site.port === 'number') serverOnly.push('port')
      if (site.preStart && site.preStart.length > 0) serverOnly.push('preStart')
      if (serverOnly.length > 0) {
        warnings.push(
          `Site '${name}' deploys to a bucket but sets server-only field(s): ${serverOnly.join(', ')}. These are ignored. Set deploy:'server' to use them.`,
        )
      }
    }
  }

  return { errors, warnings }
}

/**
 * Does this site produce a release the compute deploy has to build, package and
 * ship?
 *
 * `false` for the kinds that ship nothing:
 *  - `bucket`   — handled by the S3/CloudFront static-site path instead;
 *  - `proxy`    — the gateway forwards the domain to a service ts-cloud does not
 *    manage, so there is nothing to build, package or restart;
 *  - `redirect` — the gateway answers the domain with a Location header, so
 *    there is no `root` to package. Filtering these BEFORE the packaging loop
 *    matters: that loop reads `site.root` to build a tarball, and a redirect
 *    site has none, which failed the whole deploy with
 *    "Build output not found at undefined".
 *
 * Excluding a site here never drops its routes — the rpx gateway is
 * regenerated from the full `sites` model, not from this list.
 */
export function shipsARelease(site: SiteConfig): boolean {
  const kind = resolveSiteKind(site)
  return kind !== 'bucket' && kind !== 'redirect' && kind !== 'proxy'
}

/** Does the static object-storage pipeline own this site? */
export function shipsToBucket(site: SiteConfig): boolean {
  return resolveSiteKind(site) === 'bucket'
}

/**
 * Does this deploy put any file from the working tree onto a server or into a
 * bucket?
 *
 * `false` only when every site in scope is a pure route — a `redirect` the
 * gateway answers, or a `proxyTo` it forwards to something ts-cloud does not
 * manage. Those ship no `root`, write no release `.env`, and run no `preStart`,
 * so nothing in this directory can reach a box through them, and the
 * pre-deployment secret scan has no artifact to look at.
 *
 * Deliberately conservative. A `bucket` site uploads its built `root`, so it
 * counts as shipping even though {@link shipsARelease} is false for it, and a
 * serverless project packages a Lambda artifact regardless of `sites`. Both
 * keep the full scan.
 */
export function deployShipsFiles(config: CloudConfig, onlySite?: string): boolean {
  if (resolveDeploymentMode(config) === 'serverless') return true

  const entries = Object.entries(config.sites ?? {}).filter(([, site]) => site != null)
  const inScope = onlySite ? entries.filter(([name]) => name === onlySite) : entries
  // No sites in scope is an infrastructure-only deploy (or a `--site` that
  // names nothing): say nothing about it and keep the existing behaviour.
  if (inScope.length === 0) return true

  return !inScope.every(([, site]) => {
    const kind = resolveSiteKind(site!)
    return kind === 'redirect' || kind === 'proxy'
  })
}
