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
import { buildPantryInstallScript, buildPantryServiceScript, PANTRY_PROJECT_DIR, pantryEnvActivation } from './package-manager'

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
  /**
   * Apply production OPcache + php.ini tuning (Forge's "Optimize for
   * Production"). @default true
   */
  optimizeForProduction?: boolean
  /** Extra `php.ini` directives merged on top of (or instead of) the tuning. */
  ini?: Record<string, string>
}

/**
 * The production OPcache + runtime tuning Forge applies via "Optimize for
 * Production". Timestamp validation is off because every deploy restarts
 * php-fpm (so a fresh release is always recompiled); the larger buffers and
 * realpath cache cut per-request overhead.
 */
export const PRODUCTION_PHP_INI: Readonly<Record<string, string>> = {
  'opcache.enable': '1',
  'opcache.enable_cli': '1',
  'opcache.memory_consumption': '256',
  'opcache.interned_strings_buffer': '16',
  'opcache.max_accelerated_files': '20000',
  'opcache.validate_timestamps': '0',
  'opcache.revalidate_freq': '0',
  'opcache.save_comments': '1',
  'opcache.fast_shutdown': '1',
  'realpath_cache_size': '4096K',
  'realpath_cache_ttl': '600',
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

/** Resolve the effective php.ini directives for the given options. */
export function resolvePhpIni(options: PhpProvisionOptions = {}): Record<string, string> {
  const base = options.optimizeForProduction === false ? {} : { ...PRODUCTION_PHP_INI }
  return { ...base, ...(options.ini || {}) }
}

/**
 * Write a ts-cloud-managed `php.ini` drop-in with the resolved directives and
 * restart php-fpm so it takes effect. PHP's ini layout is discovered at runtime
 * via `php -i` (works regardless of pantry's compiled paths): the additional-ini
 * scan dir is used when present, otherwise a managed marker block is merged into
 * the loaded `php.ini`. Returns `[]` when there's nothing to set.
 */
export function buildPhpTuningScript(options: PhpProvisionOptions = {}): string[] {
  const ini = resolvePhpIni(options)
  const keys = Object.keys(ini)
  if (keys.length === 0)
    return []
  // The directive body, shared by both the drop-in file and the marker block.
  const body = keys.map(k => `${k}=${ini[k]}`)
  const marker = 'ts-cloud-managed'
  return [
    pantryEnvActivation(),
    // Discover where this PHP reads extra .ini files (authoritative on the box).
    'TS_CLOUD_SCAN_DIR=$(php -i 2>/dev/null | awk -F\' => \' \'/^Scan this dir for additional .ini files/{print $2}\' | head -1)',
    'TS_CLOUD_LOADED_INI=$(php -r \'echo php_ini_loaded_file() ?: "";\' 2>/dev/null)',
    'if [ -n "$TS_CLOUD_SCAN_DIR" ] && [ "$TS_CLOUD_SCAN_DIR" != "(none)" ]; then',
    '  mkdir -p "$TS_CLOUD_SCAN_DIR"',
    '  TS_CLOUD_PHP_INI="$TS_CLOUD_SCAN_DIR/zz-ts-cloud.ini"',
    `  cat > "$TS_CLOUD_PHP_INI" <<'TS_CLOUD_PHPINI_EOF'`,
    `; ${marker} — production PHP tuning`,
    ...body,
    'TS_CLOUD_PHPINI_EOF',
    'else',
    // No scan dir: target the loaded php.ini, creating one in the configured
    // path dir if PHP isn't loading any ini yet.
    '  if [ -z "$TS_CLOUD_LOADED_INI" ]; then',
    '    TS_CLOUD_INI_DIR=$(php -i 2>/dev/null | awk -F\' => \' \'/^Configuration File \\(php.ini\\) Path/{print $2}\' | head -1)',
    '    TS_CLOUD_LOADED_INI="$TS_CLOUD_INI_DIR/php.ini"',
    '    mkdir -p "$TS_CLOUD_INI_DIR"',
    '    touch "$TS_CLOUD_LOADED_INI"',
    '  fi',
    // Idempotent: strip any prior managed block, then append a fresh one.
    `  sed -i '/; ${marker} BEGIN/,/; ${marker} END/d' "$TS_CLOUD_LOADED_INI"`,
    `  cat >> "$TS_CLOUD_LOADED_INI" <<'TS_CLOUD_PHPINI_EOF'`,
    `; ${marker} BEGIN`,
    ...body,
    `; ${marker} END`,
    'TS_CLOUD_PHPINI_EOF',
    'fi',
    // Apply: restart php-fpm if it's running (no-op pre-service-start at boot).
    `(cd ${PANTRY_PROJECT_DIR} && pantry restart php-fpm) 2>/dev/null || true`,
  ]
}

/**
 * Build the shell command lines that install PHP-FPM + Composer (+ the nginx
 * binary) via pantry, start php-fpm as a system service, and apply production
 * php.ini tuning. Assumes the pantry CLI is already bootstrapped (see
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
    // Production OPcache + runtime tuning (Forge's "Optimize for Production").
    ...buildPhpTuningScript(options),
  ]
}
