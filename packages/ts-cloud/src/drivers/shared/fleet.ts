/**
 * Resolve a Forge-style fleet topology from a compute config, and wire app
 * servers at a dedicated services box.
 *
 * Roles:
 *  - `app`      — runs nginx + php-fpm, the app is deployed to every app server.
 *  - `services` — a dedicated box running the database/cache/search.
 *  - `lb`       — the load balancer fronting the app servers.
 *
 * Single-server (the common case) resolves to one `app` box with services
 * co-located. A multi-app fleet (`appServers > 1`) gets a load balancer, a
 * private network, and (required) a dedicated services box so every app server
 * shares one database/cache.
 */
import type { CloudConfig, ComputeConfig, DatabaseConfig } from '@ts-cloud/core'
import { buildBackupProvisionScript } from './backups'
import { buildDatabaseSetupScript, buildServicesProvisionScript } from './db-provision'
import { buildAutoUpdatesScript } from './maintenance'
import { buildMonitoringScript } from './monitoring'
import { buildNotifierScript } from './notifications'
import { buildAuthorizedKeysScript } from './ssh-keys'

export type FleetRole = 'app' | 'services' | 'lb'

export interface FleetTopology {
  /** Number of application servers. */
  appServers: number
  /** Provision a load balancer in front of the app servers. */
  loadBalancer: boolean
  /** Provision a dedicated services box (DB/cache/search off the app servers). */
  dedicatedServices: boolean
  /** Whether the app servers should install services locally (single-box only). */
  servicesOnApp: boolean
}

/** Resolve the fleet topology from the compute config. */
export function resolveFleetTopology(compute: ComputeConfig = {}): FleetTopology {
  const appServers = Math.max(1, compute.appServers ?? compute.instances ?? 1)
  const dedicatedServices = !!compute.servicesServer || appServers > 1
  const loadBalancer = appServers > 1 || !!compute.server?.loadBalancer
  return {
    appServers,
    loadBalancer,
    dedicatedServices,
    // Co-locate services on the app box only for a true single-server setup.
    servicesOnApp: !dedicatedServices,
  }
}

/**
 * Build the `.env` overrides that point a PHP app at a dedicated services box
 * over the private network (DB + Redis + Meilisearch all live there). Merge
 * under `site.env` (explicit values win).
 */
export function buildFleetServicesEnv(servicesPrivateIp: string, database?: DatabaseConfig): Record<string, string> {
  const env: Record<string, string> = {
    REDIS_HOST: servicesPrivateIp,
    MEILISEARCH_HOST: `http://${servicesPrivateIp}:7700`,
  }
  if (database?.name) {
    env.DB_CONNECTION = database.engine === 'postgres' ? 'pgsql' : 'mysql'
    env.DB_HOST = servicesPrivateIp
    env.DB_PORT = String(database.port ?? (database.engine === 'postgres' ? 5432 : 3306))
    env.DB_DATABASE = database.name
    if (database.username)
      env.DB_USERNAME = database.username
    if (database.password)
      env.DB_PASSWORD = database.password
  }
  return env
}

/**
 * Build the provision commands for a fleet's dedicated services box (DB /
 * cache / search only — no app runtime, no gateway). Shared by the PHP fleet
 * and the bun/node/deno fleet so the two paths can never drift: engine
 * installs bound to the private network, the app database + user, box
 * maintenance, the on-box notifier (so the monitoring cron can report — a
 * no-op unless notifications are configured), and — when `compute.backups`
 * is enabled — the nightly DB backup, which MUST run here (where the
 * database lives), never on an app box.
 */
export function buildFleetServicesBoxProvision(config: CloudConfig): string[] {
  const compute = config.infrastructure?.compute ?? {}
  return [
    ...buildServicesProvisionScript(compute.managedServices ?? { mysql: true, redis: true }, { bindPrivate: true }),
    ...buildDatabaseSetupScript(config.infrastructure?.appDatabase, compute.managedServices ?? { mysql: true }),
    ...buildAutoUpdatesScript(true),
    ...buildMonitoringScript(true),
    ...buildAuthorizedKeysScript(compute.sshKeys),
    ...buildNotifierScript(config.notifications),
    ...(compute.backups?.enabled
      ? [...buildBackupProvisionScript({ database: config.infrastructure?.appDatabase, backups: compute.backups })]
      : []),
  ]
}
