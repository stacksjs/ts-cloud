/**
 * Generate the apt provisioning script for a Forge-style PHP box: nginx,
 * one or more PHP-FPM versions (via `ppa:ondrej/php`), the standard Laravel
 * extension set, and Composer.
 *
 * Returns an array of shell command lines (matching the convention of
 * {@link import('./rpx-gateway').buildRpxProvisionScript}) so it can be spliced
 * into the Ubuntu cloud-init bootstrap. Each requested PHP version installs its
 * own `phpX.Y-fpm` pool so different sites can pin different versions and nginx
 * can `fastcgi_pass` to the matching unix socket
 * (`/run/php/phpX.Y-fpm.sock`).
 */

/**
 * Baseline PHP extension package suffixes installed for every version
 * (`phpX.Y-<suffix>`). Covers Laravel's documented requirements plus the
 * common drivers (mysql/pgsql/sqlite/redis) and image/locale/number stack.
 */
export const LARAVEL_PHP_EXTENSIONS: readonly string[] = [
  'fpm',
  'cli',
  'common',
  'mbstring',
  'xml',
  'curl',
  'mysql',
  'pgsql',
  'sqlite3',
  'redis',
  'gd',
  'bcmath',
  'zip',
  'intl',
  'readline',
  'soap',
  'gmp',
  'opcache',
]

export interface PhpProvisionOptions {
  /** PHP versions to install (e.g. `['8.3', '8.2']`). @default ['8.3'] */
  versions?: string[]
  /** Default PHP version (sets the `php` CLI alternative). @default first of `versions` */
  default?: string
  /** Extra extension suffixes beyond {@link LARAVEL_PHP_EXTENSIONS} (e.g. `['imagick']`). */
  extensions?: string[]
  /** Install + enable nginx. @default true */
  installNginx?: boolean
  /** Install Composer to `/usr/local/bin/composer`. @default true */
  installComposer?: boolean
}

/** Per-version apt package names for the given extension suffixes. */
export function phpPackagesForVersion(version: string, extensions: readonly string[]): string[] {
  return extensions.map(suffix => `php${version}-${suffix}`)
}

/** Absolute php-fpm unix socket path for a version (matches ondrej's layout). */
export function phpFpmSocketPath(version: string): string {
  return `/run/php/php${version}-fpm.sock`
}

/**
 * Build the shell command lines that provision PHP-FPM, nginx, and Composer.
 */
export function buildPhpProvisionScript(options: PhpProvisionOptions = {}): string[] {
  const versions = options.versions?.length ? [...new Set(options.versions)] : ['8.3']
  const defaultVersion = options.default && versions.includes(options.default)
    ? options.default
    : versions[0]
  const installNginx = options.installNginx !== false
  const installComposer = options.installComposer !== false
  const extensions = [...new Set([...LARAVEL_PHP_EXTENSIONS, ...(options.extensions || [])])]

  const lines: string[] = [
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -y',
    // add-apt-repository lives in software-properties-common on Ubuntu.
    'apt-get install -y software-properties-common ca-certificates apt-transport-https lsb-release gnupg',
    // ppa:ondrej/php carries every modern PHP version + the -fpm pools.
    'add-apt-repository -y ppa:ondrej/php',
    'apt-get update -y',
  ]

  if (installNginx) {
    lines.push(
      'apt-get install -y nginx',
      'systemctl enable nginx',
    )
  }

  for (const version of versions) {
    const pkgs = phpPackagesForVersion(version, extensions)
    lines.push(
      `apt-get install -y ${pkgs.join(' ')}`,
      `systemctl enable php${version}-fpm`,
      `systemctl start php${version}-fpm`,
    )
  }

  // Make the default version the system `php` so `php artisan`/Composer scripts
  // that don't pin a version use it.
  lines.push(`update-alternatives --set php /usr/bin/php${defaultVersion}`)

  if (installComposer) {
    lines.push(
      'curl -fsSL https://getcomposer.org/installer -o /tmp/composer-setup.php',
      'php /tmp/composer-setup.php --install-dir=/usr/local/bin --filename=composer',
      'rm -f /tmp/composer-setup.php',
    )
  }

  return lines
}
