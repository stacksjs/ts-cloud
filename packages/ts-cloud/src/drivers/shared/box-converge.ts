/**
 * Declared boxes: a named machine, the pantry packages it needs, and its
 * long-running processes as systemd units of an unprivileged account.
 *
 * `buildBoxConvergeScript` renders one idempotent bash script from a
 * {@link BoxConfig}; `provisionBox` finds or creates the server, then runs it
 * over SSH. Re-running converges: a package already installed is not
 * reinstalled, a file that already has the declared content is not touched,
 * and a running service is left running unless it asked to be restarted -
 * a converge must never kill the CI job a runner is in the middle of.
 *
 * Packages go into pantry's fixed project ({@link PANTRY_PROJECT_DIR}) and are
 * exposed to services through `<project>/pantry/.bin` on their PATH. The
 * pantry CLI itself is installed off that PATH ({@link BOX_PANTRY_CLI_DIR}):
 * a service such as a CI runner may treat "pantry is on PATH" as a cue to
 * install a repository's own toolchain, and provisioning the box must not
 * change that behaviour.
 */
import type { BoxConfig, BoxServiceConfig } from '@ts-cloud/core'
import type { HetznerClient } from '../hetzner/client'
import { executeHetznerServerResize, type HetznerResizePlan, planHetznerServerResize } from '../hetzner/resize'
import { HetznerBoxProvisioner, type ProvisionedBox } from './box-provision'
import { buildPantryBootstrapScript, PANTRY_PROJECT_DIR } from './package-manager'
import { waitForSsh } from './remote-exec'
import { SystemSshTransport } from './ssh-transport'

/** Where a box's pantry CLI lives: deliberately not on any service's PATH. */
export const BOX_PANTRY_CLI_DIR = '/opt/pantry/cli'

/** The PATH entry exposing pantry-installed packages to services. */
export const BOX_PANTRY_BIN_DIR: string = `${PANTRY_PROJECT_DIR}/pantry/.bin`

/** Prefix of the lines a converge prints about what it changed. */
export const BOX_REPORT_PREFIX = 'ts-cloud:'

const SYSTEM_PATH = ['/usr/local/bin', '/usr/bin', '/bin']

function sh(value: string): string {
  return `'${value.split("'").join("'\\''")}'`
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

function assertName(kind: string, value: string): void {
  if (!/^[a-z_][a-z0-9_.-]*$/i.test(value))
    throw new Error(`Box ${kind} "${value}" may only contain letters, digits, '.', '_' and '-'`)
}

/** An env file systemd reads: one `KEY="value"` per line, quotes and backslashes escaped. */
export function renderEnvFile(environment: Record<string, string>): string {
  return Object.entries(environment)
    .map(([key, value]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) throw new Error(`Environment variable name "${key}" is not valid`)
      const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
      return `${key}="${escaped}"`
    })
    .join('\n')
    .concat('\n')
}

/** The systemd unit for one service. `%h` is the service user's home in a user unit. */
export function renderBoxUnit(name: string, service: BoxServiceConfig, options: { userUnit: boolean }): string {
  const home = options.userUnit ? '%h' : '/root'
  const lines = [
    '# Written by ts-cloud from the box declaration; edits here are overwritten.',
    '[Unit]',
    `Description=${service.description ?? name}`,
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${service.workingDirectory ?? home}`,
  ]
  if (service.environmentFile) lines.push(`EnvironmentFile=${service.environmentFile}`)
  if (service.environment && Object.keys(service.environment).length > 0)
    lines.push(`EnvironmentFile=${home}/.config/ts-cloud/${name}.env`)
  lines.push(`Environment=PATH=${[...(service.path ?? []), BOX_PANTRY_BIN_DIR, ...SYSTEM_PATH].join(':')}`)
  lines.push(`ExecStart=${service.exec}`)
  lines.push(`Restart=${service.restart ?? 'always'}`)
  lines.push(`RestartSec=${service.restartSec ?? 10}`)
  lines.push('', '[Install]', `WantedBy=${options.userUnit ? 'default.target' : 'multi-user.target'}`, '')
  return lines.join('\n')
}

/**
 * One idempotent bash script that converges a box to its declaration. Runs as
 * root. Prints a `ts-cloud:` line for each thing it changed or left for the
 * operator to do.
 */
export function buildBoxConvergeScript(box: BoxConfig): string {
  const user = box.user?.name
  if (user) assertName('user', user)
  for (const group of box.user?.groups ?? []) assertName('group', group)
  const services = Object.entries(box.services ?? {})
  for (const [name] of services) assertName('service', name)

  const pin = box.pantryVersion
  const lines: string[] = [
    'set -euo pipefail',
    'export DEBIAN_FRONTEND=noninteractive',
    `say() { echo "${BOX_REPORT_PREFIX} $*"; }`,
    // Write a file only when its content differs; returns 0 when it wrote.
    'write_if_changed() {',
    '  local path="$1" mode="$2" owner="$3" tmp',
    '  tmp=$(mktemp)',
    '  printf %s "$4" | base64 -d > "$tmp"',
    '  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then rm -f "$tmp"; return 1; fi',
    '  install -D -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$tmp" "$path"',
    '  rm -f "$tmp"',
    '}',
    // The pantry CLI, off every service's PATH.
    `PANTRY="${BOX_PANTRY_CLI_DIR}/pantry"`,
    pin
      ? `if [ ! -x "$PANTRY" ] || ! "$PANTRY" --version 2>/dev/null | grep -q "pantry ${pin.replace(/[^0-9A-Za-z.+-]/g, '')}\\b"; then`
      : 'if [ ! -x "$PANTRY" ]; then',
    '  (',
    ...buildPantryBootstrapScript({ version: pin, installDir: BOX_PANTRY_CLI_DIR }).map((line) => `    ${line}`),
    '  )',
    '  say "pantry $("$PANTRY" --version 2>/dev/null | head -1)"',
    'fi',
    `mkdir -p ${PANTRY_PROJECT_DIR}`,
  ]

  const packages = [...new Set(box.packages ?? [])]
  if (packages.length > 0) {
    const floorKb = Math.round((box.minFreeDiskGb ?? 10) * 1024 * 1024)
    lines.push(
      // Packages already present cost nothing; a missing tree can be gigabytes.
      `FREE_KB=$(df -Pk / | awk 'NR==2 {print $4}')`,
      `if [ "$FREE_KB" -lt ${floorKb} ]; then`,
      `  say "not installing packages: $((FREE_KB / 1048576)) GB free, the box declares at least ${box.minFreeDiskGb ?? 10} GB"`,
      `  exit 3`,
      'fi',
    )
    lines.push(
      `PANTRY_SERVICE_SCOPE=system PATH="${BOX_PANTRY_CLI_DIR}:$PATH" sh -c ${sh(`cd ${PANTRY_PROJECT_DIR} && pantry install ${packages.map(sh).join(' ')}`)}`,
      // Readable by the service user: pantry installs as root.
      `chmod -R a+rX ${PANTRY_PROJECT_DIR}/pantry 2>/dev/null || true`,
      `say "packages ${packages.join(' ')}"`,
    )
  }

  if (user) {
    lines.push(
      `if ! id -u ${user} >/dev/null 2>&1; then useradd --create-home --shell /bin/bash ${user}; say "created user ${user}"; fi`,
      ...(box.user?.groups ?? []).map(
        (group) => `if getent group ${group} >/dev/null && ! id -nG ${user} | tr ' ' '\\n' | grep -qx ${group}; then usermod -aG ${group} ${user}; say "added ${user} to ${group}"; fi`,
      ),
      // Linger: the user's units start at boot and outlive any login session.
      `if [ "$(loginctl show-user ${user} -p Linger --value 2>/dev/null)" != yes ]; then loginctl enable-linger ${user}; say "enabled linger for ${user}"; fi`,
    )
  }
  lines.push(...serviceManagerLines(box))

  const owner = user ? `${user}:${user}` : 'root:root'
  const unitDir = user ? '$SVC_HOME/.config/systemd/user' : '/etc/systemd/system'
  if (services.length > 0) lines.push('RELOAD=0')
  for (const [name, service] of services) {
    const unit = renderBoxUnit(name, service, { userUnit: Boolean(user) })
    lines.push(`CHANGED_${name.replace(/[^A-Za-z0-9_]/g, '_')}=0`)
    const changed = `CHANGED_${name.replace(/[^A-Za-z0-9_]/g, '_')}`
    if (service.environment && Object.keys(service.environment).length > 0) {
      lines.push(
        `if write_if_changed "$SVC_HOME/.config/ts-cloud/${name}.env" 600 ${owner} ${sh(b64(renderEnvFile(service.environment)))}; then ${changed}=1; fi`,
      )
    }
    lines.push(
      `if write_if_changed "${unitDir}/${name}.service" 644 ${owner} ${sh(b64(unit))}; then ${changed}=1; RELOAD=1; fi`,
    )
  }
  if (services.length > 0) lines.push('if [ "$RELOAD" = 1 ]; then svc daemon-reload; fi')
  for (const [name, service] of services) {
    const changed = `CHANGED_${name.replace(/[^A-Za-z0-9_]/g, '_')}`
    lines.push(
      `svc enable ${name}.service >/dev/null 2>&1 || svc enable ${name}.service`,
      `if ! svc is-active --quiet ${name}.service; then svc start ${name}.service; say "started ${name}"`,
      service.restartOnChange
        ? `elif [ "$${changed}" = 1 ]; then svc restart ${name}.service; say "restarted ${name}"`
        : `elif [ "$${changed}" = 1 ]; then say "changed ${name}; restart it to apply"`,
      'fi',
    )
  }
  lines.push('say "converged"')
  return `${lines.join('\n')}\n`
}

/** `svc` (systemctl for the box's services) and `SVC_HOME`, as the service user when there is one. */
function serviceManagerLines(box: BoxConfig): string[] {
  const user = box.user?.name
  if (!user) return ['SVC_HOME=/root', 'svc() { systemctl "$@"; }']
  return [
    `SVC_UID=$(id -u ${user})`,
    `SVC_HOME=$(getent passwd ${user} | cut -d: -f6)`,
    `svc() { sudo -u ${user} XDG_RUNTIME_DIR="/run/user/$SVC_UID" systemctl --user "$@"; }`,
    'for _ in $(seq 1 30); do [ -S "/run/user/$SVC_UID/bus" ] && break; sleep 1; done',
  ]
}

/**
 * Drains a box before it is powered off. Runs as root.
 *
 * Each running service with a `drainSignal` is sent it, and the script waits
 * for its process to exit - a CI runner finishing the job it holds - then
 * stops the unit, inside the `RestartSec` window, so systemd does not start
 * it again to claim more work. Exits 4, with the box left running, when a
 * service outlives its `drainTimeoutSec`.
 */
export function buildBoxDrainScript(box: BoxConfig): string {
  if (box.user?.name) assertName('user', box.user.name)
  const draining = Object.entries(box.services ?? {}).filter(([, service]) => service.drainSignal)
  const lines: string[] = [
    'set -euo pipefail',
    `say() { echo "${BOX_REPORT_PREFIX} $*"; }`,
    ...serviceManagerLines(box),
  ]
  for (const [name, service] of draining) {
    assertName('service', name)
    const signal = String(service.drainSignal).replace(/^SIG/i, '').toUpperCase()
    if (!/^[A-Z0-9]+$/.test(signal)) throw new Error(`Box service "${name}" has an invalid drainSignal`)
    const timeout = service.drainTimeoutSec ?? 3600
    lines.push(
      `if svc is-active --quiet ${name}.service; then`,
      `  PID=$(svc show -p MainPID --value ${name}.service)`,
      `  svc kill -s SIG${signal} ${name}.service`,
      `  say "draining ${name} (SIG${signal})"`,
      `  WAITED=0`,
      `  while [ "$PID" != 0 ] && kill -0 "$PID" 2>/dev/null; do`,
      `    if [ "$WAITED" -ge ${timeout} ]; then say "${name} still busy after ${timeout}s; not powering off"; exit 4; fi`,
      `    sleep 5; WAITED=$((WAITED + 5))`,
      `  done`,
      // The process exited on its own; stop the unit before Restart= brings it back.
      `  svc stop ${name}.service`,
      `  say "drained ${name} after \${WAITED}s"`,
      'fi',
    )
  }
  lines.push('say "drained"')
  return `${lines.join('\n')}\n`
}

/**
 * What a box's `resize` asks of its server: nothing, a resize, or (out of
 * stock and allowed to wait) nothing yet. Throws when it may not wait.
 */
export function boxResizeDecision(box: BoxConfig, plan: HetznerResizePlan): 'none' | 'resize' | 'unavailable' {
  if (!box.resize || plan.alreadyComplete) return 'none'
  if (plan.capacityAvailable || box.resize.attemptUnavailable) return 'resize'
  if (box.resize.whenUnavailable === 'keep-current') return 'unavailable'
  throw new Error(`${plan.targetType.name} is out of stock in ${plan.location}; set resize.attemptUnavailable to ask anyway, or whenUnavailable: 'keep-current' to wait`)
}

/** The `ts-cloud:` lines a converge printed, without the prefix. */
export function parseBoxReport(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith(BOX_REPORT_PREFIX))
    .map((line) => line.slice(BOX_REPORT_PREFIX.length).trim())
}

export interface ProvisionBoxOptions {
  box: BoxConfig
  client: HetznerClient
  /** OpenSSH public key authorized for root (reused if already registered). */
  sshPublicKey: string
  /** The matching private key. */
  identityFile: string
  /** Pins the box's host key on first contact and refuses a different one after. */
  knownHostsFile: string
  /** Report what would change without resizing or converging. */
  dryRun?: boolean
  /** Progress through a resize (draining, shutting down, resizing, ...). */
  onPhase?: (phase: string) => void
}

export interface BoxProvisionResult {
  box: ProvisionedBox
  /** What the converge changed or left to do, one line each. */
  report: string[]
}

/** Find or create the box, then converge it over SSH. */
export async function provisionBox(options: ProvisionBoxOptions): Promise<BoxProvisionResult> {
  const { box: config } = options
  if (options.dryRun) return planBox(options)
  const box = await new HetznerBoxProvisioner(options.client).ensureBox({
    name: config.name,
    size: config.size,
    image: config.image,
    location: config.location,
    ports: config.ports,
    sshPublicKey: options.sshPublicKey,
    labels: { 'ts-cloud/role': 'box', 'ts-cloud/managed-by': 'ts-cloud', ...config.labels },
  })
  await waitForSsh(box.publicIp, { identityFile: options.identityFile })
  const transport = new SystemSshTransport({
    user: 'root',
    identityFile: options.identityFile,
    hostKey: { policy: 'pin', knownHostsFile: options.knownHostsFile },
  })
  const report: string[] = []

  if (config.resize && !box.created) {
    const plan = await planHetznerServerResize(options.client, Number(box.id), config.size, config.resize.upgradeDisk !== false)
    const decision = boxResizeDecision(config, plan)
    if (decision === 'unavailable')
      report.push(`${plan.targetType.name} is out of stock in ${plan.location}; keeping ${plan.currentType.name}`)
    if (decision === 'resize') {
      const result = await executeHetznerServerResize({
        client: options.client,
        serverId: Number(box.id),
        targetType: plan.targetType.name,
        upgradeDisk: plan.upgradeDisk,
        attemptUnavailable: config.resize.attemptUnavailable,
        hooks: {
          // Runs while the box is still up: nothing is powered off until
          // every draining service has finished what it held.
          preflight: async () => { report.push(...parseBoxReport(await transport.exec(box.publicIp, buildBoxDrainScript(config)))) },
          onPhase: phase => options.onPhase?.(phase),
        },
      })
      if (result.status === 'completed')
        report.push(`resized ${plan.currentType.name} to ${plan.targetType.name}`)
      else if (result.status === 'recovered')
        report.push(`could not resize to ${plan.targetType.name} (${result.error}); back on ${plan.currentType.name}`)
      else if (result.status === 'waiting-capacity')
        report.push(`${plan.targetType.name} is out of stock in ${plan.location}; keeping ${plan.currentType.name}`)
      // Powered off and on again: wait for it before converging, which starts the drained services.
      await waitForSsh(box.publicIp, { identityFile: options.identityFile })
    }
  }

  const stdout = await transport.exec(box.publicIp, buildBoxConvergeScript(config))
  return { box, report: [...report, ...parseBoxReport(stdout)] }
}

/** What {@link provisionBox} would do, read from the provider alone: nothing is created, resized or run. */
async function planBox(options: ProvisionBoxOptions): Promise<BoxProvisionResult> {
  const { box: config } = options
  const server = (await options.client.listServers()).find(s => s.name === config.name)
  if (!server)
    return { box: { provider: 'hetzner', id: '', name: config.name, publicIp: '', created: false }, report: [`would create ${config.name} (${config.size})`, 'would converge'] }
  const box: ProvisionedBox = { provider: 'hetzner', id: String(server.id), name: server.name, publicIp: server.public_net?.ipv4?.ip ?? '', created: false }
  const report: string[] = []
  if (config.resize) {
    const plan = await planHetznerServerResize(options.client, server.id, config.size, config.resize.upgradeDisk !== false)
    const decision = boxResizeDecision(config, plan)
    if (decision === 'resize')
      report.push(`would resize ${plan.currentType.name} to ${plan.targetType.name}${plan.capacityAvailable ? '' : ' (out of stock; asking placement anyway)'}, draining ${Object.entries(config.services ?? {}).filter(([, service]) => service.drainSignal).map(([name]) => name).join(', ') || 'nothing'} first`)
    else if (decision === 'unavailable')
      report.push(`${plan.targetType.name} is out of stock in ${plan.location}; would keep ${plan.currentType.name}`)
  }
  else if (server.server_type.name !== config.size) {
    report.push(`runs ${server.server_type.name}, declared ${config.size}; set resize to change it`)
  }
  report.push('would converge')
  return { box, report }
}
