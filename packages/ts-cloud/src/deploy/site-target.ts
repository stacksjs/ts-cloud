import type { CloudConfig, SiteConfig, SiteDeployTarget } from '@ts-cloud/core'
import { deploymentCoexistenceError } from '@ts-cloud/core'

/**
 * The three resolved deployment kinds for a site:
 *  - `'bucket'`        — upload built `root` to object storage + CDN.
 *  - `'server-app'`    — `server` + `start`: dynamic app as a systemd service.
 *  - `'server-static'` — `server` + no `start` (has static `root`): a static
 *                        site built and shipped to `/var/www/<site>` on the box
 *                        (served by the operator's own proxy, e.g. rpx + tlsx).
 *  - `'redirect'`      — gateway-only: `redirect` is set. Nothing is shipped;
 *                        the gateway answers `domain` with an HTTP redirect.
 */
export type SiteDeployKind = 'bucket' | 'server-app' | 'server-static' | 'server-php' | 'redirect'

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
  // PHP/Laravel sites always deploy to the box via git + atomic releases,
  // regardless of `deploy`/`start`.
  if (isPhpSite(site)) return 'server-php'
  const target = resolveSiteDeployTarget(site)
  if (target === 'bucket') return 'bucket'
  return site.start ? 'server-app' : 'server-static'
}

/** Does this environment have a compute server configured to deploy onto? */
function hasComputeConfigured(config: CloudConfig): boolean {
  return config.infrastructure?.compute != null
}

export interface DeploymentValidationResult {
  errors: string[]
  warnings: string[]
}

/**
 * Validate the per-site deployment configuration up front, turning what used to
 * be silent runtime failures (e.g. a `start` site with no compute server) into
 * an explicit, actionable contract.
 *
 * Never throws — returns structured `{ errors, warnings }`. Callers should abort
 * on any error and print warnings while continuing.
 */
export function validateDeploymentConfig(config: CloudConfig): DeploymentValidationResult {
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
      if (serverOnly.length > 0)
        warnings.push(`Site '${name}' is a redirect site but also sets ${serverOnly.join(', ')}. These are ignored.`)
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
