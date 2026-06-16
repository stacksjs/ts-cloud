/**
 * Provision PHP + Composer for a Forge-style box using **pantry** (not apt).
 *
 * `pantry install php.net@<version> getcomposer.org` pulls the source-built PHP
 * (with the full Laravel extension matrix + pdo_mysql/pdo_pgsql) and Composer
 * from the pantry registry into the shared project at {@link PANTRY_PROJECT_DIR},
 * and `pantry enable/start php-fpm` runs PHP-FPM as a boot-time systemd service.
 *
 * PHP-FPM listens on TCP (pantry's service model), not a unix socket — nginx
 * `fastcgi_pass`es to {@link PHP_FPM_LISTEN}. php/composer are exposed to deploy
 * steps via {@link import('./package-manager').pantryEnvActivation}.
 *
 * Returns an array of shell command lines spliced into the Ubuntu bootstrap.
 */
import type { PantrySpec } from './package-manager'
import { buildPantryInstallScript, buildPantryServiceScript, PANTRY_PROJECT_DIR } from './package-manager'

/**
 * The baseline Laravel PHP extensions. pantry's `php.net` is a single source
 * build that already bundles these, so unlike apt there are no per-extension
 * packages to install — this list documents the expectation and is asserted
 * against `php -m` in tests.
 */
export const LARAVEL_PHP_EXTENSIONS: readonly string[] = [
  'mbstring',
  'xml',
  'curl',
  'pdo_mysql',
  'pdo_pgsql',
  'gd',
  'bcmath',
  'zip',
  'intl',
  'openssl',
  'tokenizer',
  'ctype',
  'fileinfo',
  'sodium',
]

export interface PhpProvisionOptions {
  /** PHP versions to install (first is the default). pantry runs one php-fpm. @default ['8.3'] */
  versions?: string[]
  /** Default PHP version. @default first of `versions` */
  default?: string
  /** Extra extensions — informational; pantry's php build is fixed. */
  extensions?: string[]
  /** Install the nginx binary (the vhost/service is wired separately). @default true */
  installNginx?: boolean
  /** Install Composer. @default true */
  installComposer?: boolean
}

/** PHP-FPM listen address for nginx `fastcgi_pass` (pantry's php-fpm is TCP). */
export const PHP_FPM_LISTEN = '127.0.0.1:9074'

/**
 * php-fpm `fastcgi_pass` target. The `version` arg is accepted for API
 * compatibility with the old per-version unix sockets; pantry runs a single
 * php-fpm on {@link PHP_FPM_LISTEN}.
 */
export function phpFpmSocketPath(_version?: string): string {
  return PHP_FPM_LISTEN
}

/** Resolve the default PHP version from the requested set. */
export function resolveDefaultPhpVersion(options: PhpProvisionOptions = {}): string {
  const versions = options.versions?.length ? options.versions : ['8.3']
  return options.default && versions.includes(options.default) ? options.default : versions[0]
}

/**
 * Build the shell command lines that install PHP-FPM + Composer (+ the nginx
 * binary) via pantry and start php-fpm as a system service. Assumes the pantry
 * CLI is already bootstrapped (see
 * {@link import('./package-manager').buildPantryBootstrapScript}).
 */
export function buildPhpProvisionScript(options: PhpProvisionOptions = {}): string[] {
  const defaultVersion = resolveDefaultPhpVersion(options)
  const installNginx = options.installNginx !== false
  const installComposer = options.installComposer !== false

  const specs: PantrySpec[] = [`php.net@${defaultVersion}`]
  if (installComposer)
    specs.push('getcomposer.org')
  if (installNginx)
    specs.push('nginx.org')

  return [
    ...buildPantryInstallScript(specs),
    // php-fpm runs as a boot-time system service (TCP 127.0.0.1:9074).
    ...buildPantryServiceScript(['php-fpm']),
  ]
}
