/**
 * Per-site php-fpm pool generation for Forge-style **site isolation**.
 *
 * When a site sets `isolation: true`, it gets its own Linux user and a dedicated
 * php-fpm pool (its own worker processes, listening on a per-site TCP port, with
 * an `open_basedir` jail). A compromise or runaway in one site can no longer
 * read another site's files or exhaust the shared pool's workers.
 *
 * pantry's php-fpm master `include`s {@link PHP_FPM_POOL_DIR}`/*.conf`, so a pool
 * file dropped there is picked up on the next php-fpm restart. The site's nginx
 * vhost `fastcgi_pass`es to the pool's listen address (see
 * {@link phpFpmPoolListen}) instead of the shared `127.0.0.1:9074`.
 */
import { PANTRY_PROJECT_DIR } from './package-manager'

/** Directory pantry's php-fpm master scans for extra pool configs (`include`). */
export const PHP_FPM_POOL_DIR = '/var/lib/pantry/php-fpm/pool.d'

/** Per-site pool ports live above the shared php-fpm port (9074) to avoid clashes. */
const POOL_PORT_BASE = 9100
const POOL_PORT_SPAN = 400

/**
 * A safe pool/user token derived from a site name: lowercased, non-alphanumerics
 * collapsed to `_`, and capped so the derived Linux username stays within the
 * 32-char limit (the `web_` prefix takes 4).
 */
function siteToken(siteName: string): string {
  const base = siteName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return (base || 'site').slice(0, 28)
}

/** Dedicated Linux user (and group) the site's php-fpm pool runs as. */
export function siteUser(siteName: string): string {
  return `web_${siteToken(siteName)}`
}

/**
 * Deterministic per-site php-fpm listen port in `[9100, 9499]`. Stable for a
 * given site name (stateless generation), so redeploys reuse the same port.
 */
export function phpFpmPoolPort(siteName: string): number {
  // Hash the derived token (not the raw name) so two site names that sanitize
  // to the same user/conf also resolve to the same port — no dead fastcgi_pass.
  const token = siteToken(siteName)
  let h = 0
  for (let i = 0; i < token.length; i++)
    h = (h * 31 + token.charCodeAt(i)) >>> 0
  return POOL_PORT_BASE + (h % POOL_PORT_SPAN)
}

/** The `fastcgi_pass` target for an isolated site's dedicated pool. */
export function phpFpmPoolListen(siteName: string): string {
  return `127.0.0.1:${phpFpmPoolPort(siteName)}`
}

export interface PhpFpmPoolOptions {
  /** Site key — names the pool, user, and config file. */
  siteName: string
  /** Site root (`/var/www/<site>`) — owned by the site user and the open_basedir jail. */
  appBase: string
  /** Max worker processes for the pool. @default 10 */
  maxChildren?: number
}

/**
 * Render the php-fpm pool config for an isolated site: a named pool running as
 * the site's dedicated user, listening on its per-site port, jailed to its own
 * directory tree (`open_basedir`) plus `/tmp`.
 */
export function buildPhpFpmPoolConf(options: PhpFpmPoolOptions): string {
  const pool = siteToken(options.siteName)
  const user = siteUser(options.siteName)
  const maxChildren = options.maxChildren ?? 10
  return [
    `; ts-cloud-managed pool for ${options.siteName} (site isolation)`,
    `[${pool}]`,
    `user = ${user}`,
    `group = ${user}`,
    `listen = ${phpFpmPoolListen(options.siteName)}`,
    'pm = dynamic',
    `pm.max_children = ${maxChildren}`,
    'pm.start_servers = 2',
    'pm.min_spare_servers = 1',
    'pm.max_spare_servers = 3',
    'pm.max_requests = 500',
    'catch_workers_output = yes',
    // Confine the site's PHP to its own files + /tmp (the isolation guarantee).
    `php_admin_value[open_basedir] = ${options.appBase}:/tmp`,
    '',
  ].join('\n')
}

/**
 * Build the shell commands that set up an isolated site's php-fpm pool: create
 * the dedicated system user/group, give www-data (nginx) group access so it can
 * still read static files, take ownership of the site tree, write the pool conf
 * into pantry's pool include dir, and restart php-fpm so the pool comes up.
 *
 * Idempotent — re-runnable on every deploy.
 */
export function buildPhpFpmPoolScript(options: PhpFpmPoolOptions): string[] {
  const user = siteUser(options.siteName)
  const pool = siteToken(options.siteName)
  const conf = `${PHP_FPM_POOL_DIR}/${pool}.conf`
  return [
    // Dedicated system user + group for the site (no login, no home).
    `getent group ${user} >/dev/null || groupadd --system ${user}`,
    `id -u ${user} >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin -g ${user} ${user}`,
    // nginx (www-data) joins the site group so it can read the served files
    // (a vhost reload re-runs initgroups for the workers, so no restart needed).
    `usermod -aG ${user} www-data 2>/dev/null || true`,
    // The site user owns its tree; group-readable so nginx can serve assets.
    // `|| true`: these run under the deploy script's `set -e` AFTER the release
    // is already live — one odd file must not abort the rest of the deploy.
    `chown -R ${user}:${user} ${options.appBase} || true`,
    `chmod -R g+rX ${options.appBase} || true`,
    // Re-tighten the shared .env (the recursive chmod above would otherwise make
    // it group-readable) — secrets stay readable only by the pool user.
    `chmod 600 ${options.appBase}/shared/.env 2>/dev/null || true`,
    // Drop the pool config into pantry's php-fpm include dir + restart fpm.
    `mkdir -p ${PHP_FPM_POOL_DIR}`,
    `cat > ${conf} <<'TS_CLOUD_FPMPOOL_EOF'`,
    buildPhpFpmPoolConf(options).replace(/\n$/, ''),
    'TS_CLOUD_FPMPOOL_EOF',
    `(cd ${PANTRY_PROJECT_DIR} && pantry restart php-fpm) 2>/dev/null || true`,
  ]
}
