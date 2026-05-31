import type { CloudConfig, SiteConfig, SiteDeployTarget } from '@ts-cloud/core'

/**
 * The three resolved deployment kinds for a site:
 *  - `'bucket'`        — upload built `root` to object storage + CDN.
 *  - `'server-app'`    — `server` + `start`: dynamic app as a systemd service.
 *  - `'server-static'` — `server` + no `start` (has static `root`): a static
 *                        site built and shipped to `/var/www/<site>` on the box
 *                        (served by the operator's own proxy, e.g. rpx + tlsx).
 */
export type SiteDeployKind = 'bucket' | 'server-app' | 'server-static'

/**
 * Resolve the explicit-or-inferred {@link SiteDeployTarget} for a site.
 *
 * Inference (backward compatible):
 *  1. an explicit `site.deploy` always wins;
 *  2. else if `start` is present → `'server'`;
 *  3. else → `'bucket'`.
 */
export function resolveSiteDeployTarget(site: SiteConfig): SiteDeployTarget {
  if (site.deploy)
    return site.deploy
  if (site.start)
    return 'server'
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
  const target = resolveSiteDeployTarget(site)
  if (target === 'bucket')
    return 'bucket'
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

  // Track ports across server-app sites to catch collisions on a shared box.
  const portOwners = new Map<number, string>()

  for (const [name, site] of Object.entries(sites)) {
    if (!site) {
      continue
    }

    const target = resolveSiteDeployTarget(site)
    const kind = resolveSiteKind(site)

    // `deploy: 'server'` with neither `start` nor `root` is meaningless.
    if (target === 'server' && !site.start && !site.root) {
      errors.push(
        `Site '${name}' sets deploy:'server' but declares neither \`start\` (dynamic app) nor \`root\` (static site to serve). Add one.`,
      )
      continue
    }

    if (kind === 'server-app') {
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
        }
        else {
          portOwners.set(site.port, name)
        }
      }
    }
    else if (kind === 'server-static') {
      if (!site.root) {
        errors.push(`Site '${name}' is a server static site (deploy:'server', no \`start\`) but has no \`root\` directory to serve.`)
      }
      // A static site served on the box still needs the box to exist.
      if (!computeConfigured) {
        errors.push(
          `Site '${name}' deploys to a server (deploy:'server') but no \`infrastructure.compute\` is configured. Set deploy:'bucket' or add a server (infrastructure.compute).`,
        )
      }
    }
    else {
      // bucket
      if (!site.root) {
        errors.push(`Site '${name}' deploys to a bucket but has no \`root\` directory to upload.`)
      }
      // Server-only fields on a bucket site are ignored — warn so they're not
      // mistaken for active configuration.
      const serverOnly: string[] = []
      if (site.start)
        serverOnly.push('start')
      if (typeof site.port === 'number')
        serverOnly.push('port')
      if (site.preStart && site.preStart.length > 0)
        serverOnly.push('preStart')
      if (serverOnly.length > 0) {
        warnings.push(
          `Site '${name}' deploys to a bucket but sets server-only field(s): ${serverOnly.join(', ')}. These are ignored. Set deploy:'server' to use them.`,
        )
      }
    }
  }

  return { errors, warnings }
}
