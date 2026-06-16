/**
 * Assemble the remote deploy script for a Forge-style PHP/Laravel site: a
 * git-clone-on-server, zero-downtime atomic-release deploy.
 *
 * The deploy script is a list of steps run in order on the box. Three Forge
 * macros expand to the release machinery:
 *   $CREATE_RELEASE   — clone the repo into a new release dir, link shared
 *                       paths, and `cd` into it (subsequent steps run there).
 *   $ACTIVATE_RELEASE — flip the `current` symlink atomically, prune old
 *                       releases, and reload php-fpm so opcache sees new code.
 *   $RESTART_QUEUES   — gracefully restart Laravel queue workers / Horizon.
 *
 * Everything between $CREATE_RELEASE and $ACTIVATE_RELEASE runs inside the new
 * (not-yet-live) release, so a failure leaves the previous release serving —
 * the Envoyer zero-downtime guarantee.
 */
import type { SiteConfig } from '@ts-cloud/core'
import { buildGitCheckoutScript } from './git-deploy'
import { formatEnvFile } from './env-file'
import { PANTRY_PROJECT_DIR, pantryEnvActivation } from './package-manager'
import {
  buildActivateRelease,
  buildEnsureReleaseLayout,
  buildLinkSharedPaths,
  buildPruneReleases,
  DEFAULT_KEEP_RELEASES,
  DEFAULT_SHARED_PATHS,
  releasePaths,
} from './releases'

export const MACRO_CREATE_RELEASE = '$CREATE_RELEASE'
export const MACRO_ACTIVATE_RELEASE = '$ACTIVATE_RELEASE'
export const MACRO_RESTART_QUEUES = '$RESTART_QUEUES'

/** Composer steps shared by Laravel-family deploys. */
const COMPOSER_INSTALL = 'composer install --no-interaction --prefer-dist --optimize-autoloader --no-dev'

/** Laravel post-install artisan steps (cache config/routes/views/events). */
const LARAVEL_ARTISAN_STEPS = [
  'php artisan migrate --force',
  'php artisan config:cache',
  'php artisan route:cache',
  'php artisan view:cache',
  'php artisan event:cache',
  'php artisan storage:link',
]

/**
 * Default deploy script (with macros) for a site type. Overridden by
 * {@link SiteConfig.deployScript}.
 */
export function defaultDeployScriptFor(type: NonNullable<SiteConfig['type']>): string[] {
  switch (type) {
    case 'laravel':
    case 'statamic':
      return [
        MACRO_CREATE_RELEASE,
        COMPOSER_INSTALL,
        ...LARAVEL_ARTISAN_STEPS,
        MACRO_ACTIVATE_RELEASE,
        MACRO_RESTART_QUEUES,
      ]
    case 'php':
      return [
        MACRO_CREATE_RELEASE,
        `${COMPOSER_INSTALL} || true`,
        MACRO_ACTIVATE_RELEASE,
      ]
    case 'wordpress':
    case 'static':
    case 'spa':
      return [
        MACRO_CREATE_RELEASE,
        MACRO_ACTIVATE_RELEASE,
      ]
  }
}

export interface LaravelDeployOptions {
  siteName: string
  site: SiteConfig
  /** Unique release identifier (timestamp or sha) → `releases/<id>`. */
  releaseId: string
  /** Site base dir. @default `/var/www/<siteName>` */
  appBase?: string
  /** Exact commit to deploy (else the branch tip). */
  commit?: string
  /** PHP version selecting the `phpX.Y` binary. @default `site.phpVersion` ?? '8.3' */
  defaultPhpVersion?: string
}

/** Rewrite a deploy-step's leading `php`/`composer` to the versioned binaries. */
function substituteBins(line: string, phpBin: string): string {
  return line
    .replace(/^php\s+/, `${phpBin} `)
    .replace(/(\s)php\s+artisan\s+/g, `$1${phpBin} artisan `)
}

/** Write `site.env` to the shared `.env` (heredoc), `chmod 600`. */
function writeSharedEnv(sharedEnvPath: string, env: Record<string, string>): string[] {
  const body = formatEnvFile(env)
  return [
    `cat > ${sharedEnvPath} <<'TS_CLOUD_ENV_EOF'`,
    body,
    'TS_CLOUD_ENV_EOF',
    `chmod 600 ${sharedEnvPath}`,
  ]
}

/**
 * Build the full remote shell script for a PHP/Laravel git deploy, expanding the
 * release macros. Requires `site.repository` to be set.
 */
export function buildLaravelDeployScript(options: LaravelDeployOptions): string[] {
  const { siteName, site, releaseId, commit } = options
  if (!site.repository?.url)
    throw new Error(`Site '${siteName}' is a PHP/git site but has no repository.url to clone`)

  const base = options.appBase ?? `/var/www/${siteName}`
  // pantry exposes a single `php` on PATH (via `pantry env`); there are no
  // versioned `phpX.Y` binaries as with apt/ondrej. The requested version is
  // pinned at install time (php.net@<version>), not in the deploy command.
  const phpBin = 'php'
  const paths = releasePaths(base, releaseId)
  const sharedPaths = site.sharedPaths ?? DEFAULT_SHARED_PATHS
  const keepReleases = site.keepReleases ?? DEFAULT_KEEP_RELEASES
  const template = site.deployScript?.length
    ? site.deployScript
    : defaultDeployScriptFor(site.type ?? 'laravel')

  const out: string[] = [
    'set -euo pipefail',
    // SSM/cloud-init shells have no HOME; Composer + git need it set.
    'export HOME="${HOME:-/root}"',
    'export COMPOSER_HOME="${COMPOSER_HOME:-/root/.composer}"',
    // Deploys run as root; without this Composer disables plugins, breaking
    // Laravel package discovery.
    'export COMPOSER_ALLOW_SUPERUSER=1',
    // Put pantry-installed php/composer (+ their shared libs) on PATH.
    pantryEnvActivation(),
  ]

  // Ensure the releases/shared skeleton exists, then write the shared .env so
  // it's in place before the new release symlinks it in.
  out.push(...buildEnsureReleaseLayout(paths, sharedPaths))
  if (site.env && Object.keys(site.env).length > 0)
    out.push(...writeSharedEnv(`${paths.shared}/.env`, site.env))

  for (const raw of template) {
    const line = raw.trim()
    if (line === MACRO_CREATE_RELEASE) {
      out.push(...buildGitCheckoutScript({ repository: site.repository, releaseDir: paths.release, commit }))
      out.push(...buildLinkSharedPaths(paths, sharedPaths))
      out.push(`cd ${paths.release}`)
      // php-fpm runs as www-data; make the writable Laravel paths owned by it
      // so the app can write logs/cache/sessions (Forge/Envoyer do the same).
      out.push(
        `chown -R www-data:www-data ${paths.shared}/storage 2>/dev/null || true`,
        `[ -d ${paths.release}/bootstrap/cache ] && chown -R www-data:www-data ${paths.release}/bootstrap/cache 2>/dev/null || true`,
        `chmod -R ug+rwX ${paths.shared}/storage 2>/dev/null || true`,
      )
    }
    else if (line === MACRO_ACTIVATE_RELEASE) {
      out.push(...buildActivateRelease(paths))
      out.push(...buildPruneReleases(paths, keepReleases))
      out.push(`(cd ${PANTRY_PROJECT_DIR} && pantry restart php-fpm) 2>/dev/null || true`)
    }
    else if (line === MACRO_RESTART_QUEUES) {
      // Laravel-native: signals all workers (queue:work + Horizon) to restart.
      out.push(`${phpBin} artisan queue:restart || true`)
    }
    else {
      out.push(substituteBins(raw, phpBin))
    }
  }

  return out
}
