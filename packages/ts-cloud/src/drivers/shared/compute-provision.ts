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
import { mailFirewallPorts, resolveAppDatabase, resolveCloudProvider, resolveMailService } from '@ts-cloud/core'
import { buildBackupProvisionScript } from './backups'
import { buildDatabaseSetupScript, buildServicesProvisionScript } from './db-provision'
import { buildAppUpdatesScript } from './app-updates'
import { buildAutoUpdatesScript } from './maintenance'
import { buildMonitoringScript } from './monitoring'
import { buildNginxServiceScript } from './nginx-vhost'
import { buildNotifierScript } from './notifications'
import { buildPantryBootstrapScript } from './package-manager'
import { buildPhpProvisionScript } from './php-provision'
import { usesRpxProxy } from './rpx-gateway'
import { buildAuthorizedKeysScript } from './ssh-keys'
import { buildProtectionScript } from './protection'
import { assertSftpSupported, buildSftpProvisionScript } from './sftp-provision'
import { buildUfwScript } from './ufw'

export interface ComputeProvisionScripts {
  /** Effective runtime to install (bun/node/deno/php). */
  runtime: 'bun' | 'node' | 'deno' | 'php'
  /** Pinned runtime version (or 'latest'). */
  runtimeVersion: string
  /** Whether this box runs PHP (drives UFW/auto-updates/monitoring defaults). */
  phpBox: boolean
  /** nginx + php-fpm + Composer install commands (undefined for non-PHP boxes). */
  phpProvision?: string[]
  /** services + db + mail + firewall + updates + monitoring + ssh + notifier + backups. */
  servicesProvision?: string[]
}

/** Which environment the box is being provisioned for. See {@link buildComputeProvisionScripts}. */
export interface ComputeProvisionOptions {
  /**
   * The environment name, e.g. `'production'`.
   *
   * Only mail reads it today, and it reads it for a reason worth stating: an
   * omitted environment resolves to a mail **catcher**, never a server. The
   * caller that forgets to pass it gets a box that traps its own mail rather
   * than one that offers SMTP to the internet.
   */
  environment?: string
}

/**
 * Build the machine provisioning scripts from a CloudConfig. Returns the
 * pieces the Ubuntu bootstrap (and the image bake) splice in.
 */
export function buildComputeProvisionScripts(config: CloudConfig, options?: ComputeProvisionOptions): ComputeProvisionScripts {
  const compute = config.infrastructure?.compute ?? {}
  const phpBox = compute.runtime === 'php' || !!compute.php
  // Resolved once, because four things downstream have to agree about it: the
  // provisioner, the firewall, the flood-mitigation port list, and the `.env`
  // the deploy writes.
  const mail = resolveMailService(config, { environment: options?.environment })

  // Bootstrap the pantry CLI (system service scope) before any package install.
  // Prepended to the php provision on a PHP box, or to the services block when
  // the box only runs managed services.
  const needsPantry = phpBox || !!compute.managedServices
  const pantryBootstrap = needsPantry ? buildPantryBootstrapScript() : []

  const useNginx = !usesRpxProxy(compute)
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
  const appDatabase = resolveAppDatabase(config)
  // pantry bootstrap for a services-only (non-PHP) box.
  if (!phpBox && needsPantry) extras.push(...pantryBootstrap)
  // On-box notifier first, so cron-driven jobs (backups) can call it.
  extras.push(...buildNotifierScript(config.notifications))
  if (compute.managedServices) {
    extras.push(
      ...buildServicesProvisionScript(compute.managedServices, { mail: mail.enabled ? mail : undefined }),
      ...buildDatabaseSetupScript(appDatabase, compute.managedServices),
    )
  }
  // An `infrastructure.sftp` block on a box provider is served by ts-sftp; the
  // AWS path builds Transfer Family from the same config instead.
  const sftp = config.infrastructure?.sftp
  if (sftp) {
    assertSftpSupported(sftp, resolveCloudProvider(config))
    extras.push(
      ...buildSftpProvisionScript({ slug: config.project.slug, sftp }),
    )
  }
  // The mail ports join the firewall's allow list, and only when mail is
  // exposed. Merged here rather than written into `firewall.allowedPorts` by
  // hand, because the two would drift and the drift is silent in the dangerous
  // direction: a server whose 25 was never opened simply receives no mail, and
  // looks like a DNS problem for a week. `mailFirewallPorts` returns `[]` for a
  // catcher, which must stay loopback-only.
  const firewall = compute.firewall ?? (phpBox ? { enabled: true } : { enabled: false })
  const mailPorts = mailFirewallPorts(mail)
  extras.push(...buildUfwScript(
    mailPorts.length > 0
      ? { ...firewall, allowedPorts: [...(firewall.allowedPorts ?? []), ...mailPorts] }
      : firewall,
  ))
  // Flood mitigation and the WAF run for every box, not only PHP ones: the
  // ports UFW opens are the ports an attacker reaches, whatever is behind them.
  // Both are opt-out rather than opt-in, and the WAF starts detection-only.
  extras.push(...buildProtectionScript({ ddos: compute.ddos, waf: compute.waf }, [...(compute.firewall?.allowedPorts ?? []), ...mailPorts]))
  extras.push(...buildAutoUpdatesScript(compute.autoUpdates ?? phpBox))
  // OS updates above; the tools we deploy below. Both are opt-in config,
  // neither is hand-written shell in a project's userData any more.
  extras.push(...buildAppUpdatesScript(compute.appUpdates))
  extras.push(...buildMonitoringScript(compute.monitoring ?? phpBox))
  extras.push(...buildAuthorizedKeysScript(compute.sshKeys))
  if (compute.backups?.enabled) {
    extras.push(
      ...buildBackupProvisionScript({
        database: appDatabase,
        backups: compute.backups,
      }),
    )
  }

  return {
    runtime: compute.runtime || 'bun',
    runtimeVersion: compute.runtimeVersion || 'latest',
    phpBox,
    phpProvision,
    servicesProvision: extras.length > 0 ? extras : undefined,
  }
}
