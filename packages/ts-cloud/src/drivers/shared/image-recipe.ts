/**
 * Golden-image bake recipe.
 *
 * Produces the bash script Packer (or a manual snapshot run) executes on a base
 * Ubuntu box to pre-install the full ts-cloud stack (nginx, php-fpm, Composer,
 * services, hardening). The box is then snapshotted into a Hetzner snapshot /
 * AWS AMI and referenced via `compute.image` + `compute.bakedImage: true`, so
 * production boots are near-instant.
 *
 * Because it reuses {@link buildComputeProvisionScripts} + the shared
 * {@link buildUbuntuBootstrapScript}, a baked image and a cold boot install the
 * exact same stack — there is no separate, drift-prone image definition.
 */
import type { CloudConfig } from '@ts-cloud/core'
import { buildComputeProvisionScripts } from './compute-provision'
import { buildUbuntuBootstrapScript } from './ubuntu-bootstrap'

export interface ImageRecipeOptions {
  /**
   * Exclude per-app/per-deploy state from the image so it stays generic and
   * reusable across projects: SSH keys, the app database creation, and
   * scheduled backups are applied at boot/deploy instead of baked in.
   * @default true
   */
  generic?: boolean
  /**
   * Append an image-minimization pass (clear apt/composer caches, logs, tmp;
   * reset machine-id + cloud-init so clones boot fresh; trim free space). Keeps
   * the published snapshot/AMI as small as possible. @default true
   */
  optimize?: boolean
}

/**
 * Image-minimization commands appended after provisioning so the published
 * snapshot/AMI is as small as possible. Safe to run at the end of a bake (the
 * box is snapshotted immediately after).
 */
export function buildImageCleanupScript(): string[] {
  return [
    '# --- ts-cloud image size optimization ---',
    'export DEBIAN_FRONTEND=noninteractive',
    // Drop packages pulled in only as build deps, then purge apt caches.
    'apt-get autoremove -y --purge || true',
    'apt-get clean',
    'rm -rf /var/lib/apt/lists/*',
    // Tool caches that bloat the image but are rebuilt on demand.
    'rm -rf /root/.composer/cache /root/.cache /root/.npm /root/.bun/install/cache || true',
    'rm -rf /tmp/* /var/tmp/* || true',
    // Truncate logs so the snapshot carries no build-time noise.
    'find /var/log -type f -exec truncate -s 0 {} + 2>/dev/null || true',
    'rm -f /root/.bash_history',
    // Reset per-machine identity so every clone gets a fresh id + re-runs cloud-init.
    'truncate -s 0 /etc/machine-id || true',
    'rm -f /var/lib/dbus/machine-id || true',
    'cloud-init clean --logs 2>/dev/null || true',
    'rm -f /var/lib/cloud/ts-cloud-bootstrap.sh || true',
    // Zero free space so the compressed image is smaller (best-effort).
    'fstrim -av 2>/dev/null || true',
    'echo "ts-cloud image optimized"',
  ]
}

/**
 * Build the bake recipe (a bash script) for a config. Runs the full
 * provisioning with `baked: false` so everything is installed into the image.
 */
export function buildImageRecipe(config: CloudConfig, options: ImageRecipeOptions = {}): string {
  const generic = options.generic !== false

  // For a generic golden image, bake the stack (runtime, php, nginx, services,
  // firewall, auto-updates, monitoring) but NOT project-specific state (ssh
  // keys, app DB, backups) — those are applied per-box at boot/deploy. We do
  // that by stripping the project-specific config before composing.
  const recipeConfig: CloudConfig = generic
    ? {
        ...config,
        notifications: undefined,
        infrastructure: {
          ...config.infrastructure,
          appDatabase: undefined,
          compute: {
            ...config.infrastructure?.compute,
            sshKeys: undefined,
            backups: undefined,
          },
        },
      }
    : config

  const provision = buildComputeProvisionScripts(recipeConfig)

  const bootstrap = buildUbuntuBootstrapScript({
    runtime: provision.runtime,
    runtimeVersion: provision.runtimeVersion,
    systemPackages: recipeConfig.infrastructure?.compute?.systemPackages,
    database: recipeConfig.infrastructure?.database,
    phpProvision: provision.phpProvision,
    servicesProvision: provision.servicesProvision,
    baked: false,
  })

  if (options.optimize === false)
    return bootstrap

  // Append the size-minimization pass so the published snapshot/AMI is lean.
  return `${bootstrap}\n${buildImageCleanupScript().join('\n')}\n`
}
