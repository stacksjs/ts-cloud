/**
 * Pantry-based package manager for provisioned servers.
 *
 * Every server dependency ts-cloud installs — PHP, nginx, Composer, the
 * databases/caches/search engines, and the language runtimes — comes from the
 * pantry registry (`registry.pantry.dev`, Hetzner-backed object storage) via
 * the `pantry` CLI instead of apt/ppa/curl installers. Long-running services
 * are managed by pantry's own systemd integration, which runs in **system
 * scope** when provisioning as root (units under `/etc/systemd/system`, started
 * at boot) — see `PANTRY_SERVICE_SCOPE` in pantry's service controller.
 *
 * This module is the single chokepoint for "install package X" / "run service
 * Y" so the Hetzner and AWS bootstrap paths share one implementation. It only
 * emits shell command lines (the convention used across `drivers/shared`); the
 * caller splices them into the Ubuntu cloud-init / SSM bootstrap.
 */

/**
 * Pantry package domains for the dependencies ts-cloud provisions. Domains
 * (not aliases) are used because aliases aren't guaranteed in every released
 * pantry binary. The recipes live in pantry's `src/packages/*` (e.g. `php.net`
 * is a source build carrying the full Laravel extension matrix).
 */
export const PANTRY_PACKAGES = {
  php: 'php.net',
  nginx: 'nginx.org',
  composer: 'getcomposer.org',
  mysql: 'mysql.com',
  // The registry package that ships the mariadbd server + client for linux
  // (`mariadb.org` has no linux build).
  mariadb: 'mariadb.com/server',
  postgres: 'postgresql.org',
  redis: 'redis.io',
  memcached: 'memcached.org',
  meilisearch: 'meilisearch.com',
  git: 'git-scm.com',
  certbot: 'certbot.eff.org',
  bun: 'bun.sh',
  node: 'nodejs.org',
  deno: 'deno.land',
} as const

/** Logical package key (`'php'`, `'nginx'`, …). */
export type PantryPackageKey = keyof typeof PANTRY_PACKAGES

/** A fully-qualified pantry package domain (`'php.net'`, `'nginx.org'`, …). */
export type PantryPackageDomain = (typeof PANTRY_PACKAGES)[PantryPackageKey]

/** A package to install: a known domain, optionally pinned with `@<version>`. */
export type PantrySpec = PantryPackageDomain | `${PantryPackageDomain}@${string}`

/** Where the `pantry` binary itself is installed (on PATH for all later steps). */
export const PANTRY_INSTALL_DIR = '/usr/local/bin'

/**
 * Server-side pantry project root. `pantry install` is project-scoped — it
 * writes packages under `<root>/pantry/` and exposes their binaries via
 * `<root>/pantry/.bin`. Provisioning installs everything into this one fixed
 * project so the env (and thus PATH) is stable across deploy/systemd steps.
 */
export const PANTRY_PROJECT_DIR = '/opt/pantry'

/** Single-quote a value for safe embedding in the generated shell. */
function sh(value: string): string {
  return `'${value.split('\'').join('\'\\\'\'')}'`
}

export interface PantryBootstrapOptions {
  /** Pin the pantry CLI version (e.g. `'0.9.39'`). @default latest release */
  version?: string
}

/**
 * Bootstrap the `pantry` CLI on a fresh server (idempotent — skips when already
 * present). Installs to {@link PANTRY_INSTALL_DIR} and selects system-scope
 * service management so `pantry enable/start` provisions boot-time systemd
 * units rather than the per-user units that can't run headlessly.
 */
export function buildPantryBootstrapScript(options: PantryBootstrapOptions = {}): string[] {
  const versionLine = options.version
    ? `export PANTRY_VERSION=${sh(options.version)}`
    : 'export PANTRY_VERSION="${PANTRY_VERSION:-latest}"'
  return [
    'export DEBIAN_FRONTEND=noninteractive',
    // Manage services as system (boot-time) systemd units, not `--user` units.
    'export PANTRY_SERVICE_SCOPE=system',
    `export PANTRY_INSTALL_DIR=${PANTRY_INSTALL_DIR}`,
    versionLine,
    // The installer needs curl + unzip; everything else comes from pantry.
    'command -v curl >/dev/null 2>&1 || (apt-get update -y && apt-get install -y curl ca-certificates)',
    'command -v unzip >/dev/null 2>&1 || (apt-get update -y && apt-get install -y unzip)',
    'command -v pantry >/dev/null 2>&1 || curl -fsSL https://pantry.dev | bash',
    // The pantry CLI lives in PANTRY_INSTALL_DIR; put it on PATH for later steps.
    `export PATH="${PANTRY_INSTALL_DIR}:$PATH"`,
    `mkdir -p ${PANTRY_PROJECT_DIR}`,
  ]
}

/**
 * Shell snippet that puts the project's pantry-installed binaries (php,
 * composer, …) on PATH for a deploy step. `pantry env` is project-scoped, so it
 * is evaluated from {@link PANTRY_PROJECT_DIR}. Returns a single line to
 * `eval`/source before invoking those binaries.
 */
export function pantryEnvActivation(): string {
  return `eval "$(cd ${PANTRY_PROJECT_DIR} && pantry env 2>/dev/null)" || true`
}

/**
 * Install one or more pantry packages in a single resolve pass. Accepts known
 * domains (optionally `domain@version`). Returns `[]` for an empty list.
 */
export function buildPantryInstallScript(specs: readonly PantrySpec[]): string[] {
  if (specs.length === 0)
    return []
  const unique = [...new Set(specs)]
  // `pantry install` is project-scoped; install into the fixed project root.
  return [`(cd ${PANTRY_PROJECT_DIR} && pantry install ${unique.map(sh).join(' ')})`]
}

/**
 * Enable (start on boot) and start pantry-managed services now. Service names
 * are pantry's own (`'php-fpm'`, `'nginx'`, `'mysql'`, `'redis'`, …), not the
 * package domains.
 */
export function buildPantryServiceScript(services: readonly string[]): string[] {
  // Start before enable: `pantry start` writes the systemd unit (then runs it),
  // and `pantry enable` (boot persistence) needs that unit to already exist.
  return [...new Set(services)].flatMap(name => [
    `(cd ${PANTRY_PROJECT_DIR} && pantry start ${sh(name)})`,
    `(cd ${PANTRY_PROJECT_DIR} && pantry enable ${sh(name)})`,
  ])
}

/** Resolve a logical key (or an explicit domain) to its package domain. */
export function pantryDomain(pkg: PantryPackageKey | PantryPackageDomain): PantryPackageDomain {
  return (PANTRY_PACKAGES as Record<string, PantryPackageDomain>)[pkg] ?? (pkg as PantryPackageDomain)
}
