import type { SiteConfig } from '../types'

/**
 * The ts-cloud management dashboard (`@ts-cloud/ui`) as a deployable site —
 * a static stx app served on the box by nginx, behind HTTP Basic auth whose
 * password comes from an env value.
 *
 * Add it to your config's `sites` so `cloud deploy` builds + publishes it:
 *
 * ```ts
 * sites: {
 *   dashboard: createDashboardSite({ domain: 'dashboard.acme.com', password: process.env.TS_CLOUD_UI_PASSWORD }),
 * }
 * ```
 */
export function createDashboardSite(options: {
  /** Domain the dashboard is served on (required for nginx vhost + SSL). */
  domain: string
  /** Basic-auth password — typically `process.env.TS_CLOUD_UI_PASSWORD`. */
  password?: string
  /** Basic-auth username. @default 'admin' */
  username?: string
  /** Built UI output directory shipped to the box. @default 'ui/dist' */
  root?: string
  /** Build command producing {@link root}. @default builds @ts-cloud/ui */
  build?: string
}): SiteConfig {
  return {
    root: options.root ?? 'ui/dist',
    deploy: 'server',
    type: 'static',
    domain: options.domain,
    build: options.build ?? 'cd ui && bun install && bun run build',
    ssl: { provider: 'letsencrypt' },
    auth: {
      username: options.username ?? 'admin',
      password: options.password,
    },
  }
}
