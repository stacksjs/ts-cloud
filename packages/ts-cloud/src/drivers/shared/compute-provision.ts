/**
 * Compose the full machine-provisioning scripts for a compute box from a
 * CloudConfig — PHP/nginx/Composer, on-box services + app database, host
 * firewall, auto-updates, monitoring, SSH keys, notifier, and scheduled
 * backups.
 *
 * Single source of truth shared by:
 *  - the **driver cold-boot** path (Hetzner cloud-init / AWS UserData), and
 *  - the **golden-image bake** (which runs the same provisioning then snapshots),
 * so a baked image and a cold boot install exactly the same stack.
 */
import type { CloudConfig } from '@ts-cloud/core'
import { buildServicesProvisionScript, buildDatabaseSetupScript } from './db-provision'
import { buildPhpProvisionScript } from './php-provision'
import { buildNginxServiceScript } from './nginx-vhost'
import { buildPantryBootstrapScript } from './package-manager'
import { buildUfwScript } from './ufw'
import { buildAutoUpdatesScript } from './maintenance'
import { buildMonitoringScript } from './monitoring'
import { buildAuthorizedKeysScript } from './ssh-keys'
import { buildNotifierScript } from './notifications'
import { buildBackupProvisionScript } from './backups'

export interface ComputeProvisionScripts {
  /** Effective runtime to install (bun/node/deno/php). */
  runtime: 'bun' | 'node' | 'deno' | 'php'
  /** Pinned runtime version (or 'latest'). */
  runtimeVersion: string
  /** Whether this box runs PHP (drives UFW/auto-updates/monitoring defaults). */
  phpBox: boolean
  /** nginx + php-fpm + Composer install commands (undefined for non-PHP boxes). */
  phpProvision?: string[]
  /** services + db + firewall + updates + monitoring + ssh + notifier + backups. */
  servicesProvision?: string[]
}

/**
 * Build the machine provisioning scripts from a CloudConfig. Returns the
 * pieces the Ubuntu bootstrap (and the image bake) splice in.
 */
export function buildComputeProvisionScripts(config: CloudConfig): ComputeProvisionScripts {
  const compute = config.infrastructure?.compute ?? {}
  const phpBox = compute.runtime === 'php' || !!compute.php

  // Bootstrap the pantry CLI (system service scope) before any package install.
  // Prepended to the php provision on a PHP box, or to the services block when
  // the box only runs managed services.
  const needsPantry = phpBox || !!compute.managedServices
  const pantryBootstrap = needsPantry ? buildPantryBootstrapScript() : []

  const useNginx = compute.webServer !== 'rpx'
  const phpProvision = phpBox
    ? [
        ...pantryBootstrap,
        ...buildPhpProvisionScript({
          versions: compute.php?.versions,
          default: compute.php?.default,
          extensions: compute.php?.extensions,
          installNginx: useNginx,
          optimizeForProduction: compute.php?.optimizeForProduction,
          ini: compute.php?.ini,
        }),
        // Set up ts-cloud-managed nginx (config + systemd unit) on the
        // pantry-installed nginx binary, ready for per-site vhosts.
        ...(useNginx ? buildNginxServiceScript() : []),
      ]
    : undefined

  const extras: string[] = []
  // pantry bootstrap for a services-only (non-PHP) box.
  if (!phpBox && needsPantry)
    extras.push(...pantryBootstrap)
  // On-box notifier first, so cron-driven jobs (backups) can call it.
  extras.push(...buildNotifierScript(config.notifications))
  if (compute.managedServices) {
    extras.push(
      ...buildServicesProvisionScript(compute.managedServices),
      ...buildDatabaseSetupScript(config.infrastructure?.appDatabase, compute.managedServices),
    )
  }
  extras.push(...buildUfwScript(compute.firewall ?? (phpBox ? { enabled: true } : { enabled: false })))
  extras.push(...buildAutoUpdatesScript(compute.autoUpdates ?? phpBox))
  extras.push(...buildMonitoringScript(compute.monitoring ?? phpBox))
  extras.push(...buildAuthorizedKeysScript(compute.sshKeys))
  if (compute.backups?.enabled) {
    extras.push(...buildBackupProvisionScript({
      database: config.infrastructure?.appDatabase,
      backups: compute.backups,
    }))
  }

  return {
    runtime: compute.runtime || 'bun',
    runtimeVersion: compute.runtimeVersion || 'latest',
    phpBox,
    phpProvision,
    servicesProvision: extras.length > 0 ? extras : undefined,
  }
}
