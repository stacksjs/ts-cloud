/**
 * Check that a box actually runs the on-box services a project declares.
 *
 * This exists for attach mode (`cloud.attachTo`). A project that attaches rides
 * a box its OWNER provisioned, and attach mode deliberately provisions nothing:
 * installing engines on someone else's server is not a tenant's business. But
 * the tenant's config still carries `managedServices`, and ts-cloud used to act
 * on it regardless — creating a role and database against an engine that was
 * never there. The result was a deploy that shipped every release and then
 * failed at the database step, with no statement anywhere that the two settings
 * are structurally incompatible.
 *
 * A declared service is considered present when its binary is on PATH (pantry
 * puts the engines there) OR something is listening on its port. Either alone
 * is enough on purpose: a stopped service and an engine installed outside
 * pantry are both "the owner has this", and a preflight that fails on those
 * would block deploys it has no business blocking. The case worth catching is
 * the unambiguous one — no binary, no listener, no engine.
 */
import type { ComputeServicesConfig } from '@ts-cloud/core'
import { pantryEnvActivation } from './package-manager'

/** How to recognize each on-box service the config can declare. */
const SERVICE_PROBES: Record<string, { port: number; binaries: string[] }> = {
  // `mysqld`/`mariadbd` are the servers; the clients are listed too because a
  // box pointing at its own engine always has one.
  mysql: { port: 3306, binaries: ['mysqld', 'mysql'] },
  mariadb: { port: 3306, binaries: ['mariadbd', 'mariadb', 'mysqld'] },
  postgres: { port: 5432, binaries: ['postgres', 'psql'] },
  redis: { port: 6379, binaries: ['redis-server', 'redis-cli'] },
  memcached: { port: 11211, binaries: ['memcached'] },
  meilisearch: { port: 7700, binaries: ['meilisearch'] },
  // Apps reach Vitess through vtgate, never the tablet's mysqld.
  vitess: { port: 15306, binaries: ['vtgate'] },
}

/** Marker prefix the probe prints, one line per service. */
const MARKER = 'ts-cloud-service:'

function isEnabled(spec: boolean | { version?: string } | object | undefined): boolean {
  return spec === true || (typeof spec === 'object' && spec != null)
}

/**
 * The service names a config declares, in a stable order. Unknown keys are
 * skipped rather than guessed at: a service this module cannot recognize is one
 * it cannot honestly report as missing.
 */
export function declaredManagedServices(services: ComputeServicesConfig | undefined): string[] {
  if (!services) return []
  return Object.keys(SERVICE_PROBES).filter(name => isEnabled((services as Record<string, unknown>)[name] as never))
}

/**
 * Shell that reports which of `names` the box provides, one `ts-cloud-service:`
 * line each. Always exits 0 — a missing service is a finding to report, not a
 * remote command failure to guess at.
 */
export function buildManagedServicesProbeScript(names: readonly string[]): string[] {
  if (names.length === 0) return []
  return [
    // Engines installed by ts-cloud live in the pantry project, not on the
    // default PATH.
    pantryEnvActivation(),
    'ts_cloud_port_open() {',
    '  if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | grep -qE "[:.]$1[[:space:]]" && return 0; fi',
    '  if command -v netstat >/dev/null 2>&1; then netstat -ltn 2>/dev/null | grep -qE "[:.]$1[[:space:]]" && return 0; fi',
    // Last resort on a box with neither tool: bash can open the socket itself.
    '  (exec 3<>/dev/tcp/127.0.0.1/$1) 2>/dev/null && { exec 3<&- 3>&-; return 0; }',
    '  return 1',
    '}',
    'ts_cloud_probe() {',
    '  TS_CLOUD_SVC="$1"; TS_CLOUD_PORT="$2"; shift 2',
    '  for TS_CLOUD_BIN in "$@"; do',
    `    if command -v "$TS_CLOUD_BIN" >/dev/null 2>&1; then echo "${MARKER}$TS_CLOUD_SVC:present"; return 0; fi`,
    '  done',
    `  if ts_cloud_port_open "$TS_CLOUD_PORT"; then echo "${MARKER}$TS_CLOUD_SVC:present"; return 0; fi`,
    `  echo "${MARKER}$TS_CLOUD_SVC:missing"`,
    '  return 0',
    '}',
    ...names
      .filter(name => SERVICE_PROBES[name])
      .map(name => `ts_cloud_probe ${name} ${SERVICE_PROBES[name].port} ${SERVICE_PROBES[name].binaries.join(' ')}`),
    'exit 0',
  ]
}

/**
 * The declared services the box reported as missing.
 *
 * A service the probe said nothing about is NOT reported missing: silence means
 * the probe did not run (an older box, a truncated capture), and inventing a
 * failure from missing evidence would block deploys that are perfectly fine.
 */
export function parseMissingManagedServices(output: string | undefined, declared: readonly string[]): string[] {
  if (!output) return []
  const status = new Map<string, string>()
  for (const line of output.split('\n')) {
    const marker = line.indexOf(MARKER)
    if (marker === -1) continue
    const [name, state] = line.slice(marker + MARKER.length).trim().split(':')
    if (name) status.set(name, state)
  }
  return declared.filter(name => status.get(name) === 'missing')
}

/**
 * The message an operator gets when the host does not provide what the tenant
 * declared. Names the setting, the owner, the host, and the two ways out —
 * because the one thing that is NOT an option is waiting for ts-cloud to
 * install it.
 */
export function formatMissingManagedServicesError(
  missing: readonly string[],
  ownerSlug: string,
  host: string | undefined,
): string {
  const where = host ? ` on ${host}` : ''
  const list = missing.map(name => `managedServices.${name}`).join(', ')
  const subject = missing.length === 1 ? `no ${missing[0]}` : `none of ${missing.join(', ')}`
  return (
    `This project declares ${list}, but '${ownerSlug}' has ${subject}${where}. `
    + `Attach mode does not provision services on the owner's box, so nothing will install ${missing.length === 1 ? 'it' : 'them'}. `
    + `Point the app at an external service, or ask the owner of '${ownerSlug}' to add ${missing.length === 1 ? 'it' : 'them'} to their own config and re-provision.`
  )
}
