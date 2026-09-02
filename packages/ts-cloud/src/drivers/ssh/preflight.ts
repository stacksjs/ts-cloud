/**
 * What ts-cloud checks about a bring-your-own host before touching it.
 *
 * The cloud drivers never need this: they chose the image, the size and the
 * region, so they know what they are logging into. An adopted host is
 * whatever the operator installed, and the bootstrap's failure modes on the
 * wrong machine are slow and misleading (an apt run that never finishes on
 * an unsynced clock, a 404 from an x86_64-only download on an ARM board).
 * One probe, run as the deploy user, answers every question the bootstrap
 * would otherwise discover the hard way.
 */
import type { ValidationFinding } from '../../fleet'
import type { SshProfile } from './config'

/** The facts the preflight script reports, as JSON on its last line. */
export interface SshPreflightFacts {
  /** `PRETTY_NAME` from /etc/os-release. */
  os: string
  /** `ID` from /etc/os-release, e.g. `debian`, `ubuntu`, `raspbian`. */
  osId: string
  /** `ID_LIKE` from /etc/os-release, e.g. `debian` on Ubuntu. */
  osIdLike: string
  /** `VERSION_ID` from /etc/os-release, e.g. `13`, `24.04`. */
  osVersionId: string
  /** `uname -m`: `aarch64`, `x86_64`, `armv7l`, ... */
  arch: string
  cpuCores: number
  memoryBytes: number
  diskBytes: number
  diskFreeBytes: number
  dnsOk: boolean
  /** Whether the `cloud-init` binary exists on the host. */
  cloudInitPresent: boolean
  /** First line of `cloud-init status`, empty when absent. */
  cloudInitStatus: string
  /** `timedatectl` reports the clock as NTP-synchronised. */
  timeSynced: boolean
  /** An HTTPS request to github.com succeeded (downloads will work). */
  httpsOk: boolean
  /** `sudo -n true` succeeded for the deploy user. */
  sudoOk: boolean
  /** `getconf LONG_BIT`: 64 on every supported host. */
  kernelBits: number
  /** `/proc/device-tree/model`, e.g. `Raspberry Pi 5 Model B Rev 1.0`; empty elsewhere. */
  piModel: string
  /** First address from `hostname -I`. */
  lanIp: string
  tools: { curl: boolean; tar: boolean }
  privilege: 'sudo' | 'user'
}

/**
 * The probe. Runs as the deploy user WITHOUT sudo, on purpose: `sudoOk` is a
 * question, and a script that already needed sudo to run could not ask it.
 * Every command tolerates absence (a `false`, a `0`, an empty string) so the
 * JSON is always complete and the findings, not a shell error, say what is
 * missing. The last line of stdout is the JSON document.
 */
export const SSH_PREFLIGHT_SCRIPT: string = `set -u
. /etc/os-release 2>/dev/null || true
# Strings are stripped of quotes, backslashes and newlines rather than escaped:
# nothing reported here legitimately contains them, and a probe that cannot
# produce valid JSON is worse than one that drops a character.
json_str() { printf '%s' "$1" | tr -d '\\n\\r"\\\\'; }
bool() { if "$@" >/dev/null 2>&1; then printf true; else printf false; fi; }
num() { v=$("$@" 2>/dev/null | head -1 | tr -dc '0-9'); printf '%s' "\${v:-0}"; }
disk_total=$(df -B1 / 2>/dev/null | awk 'NR==2{print $2}' | tr -dc '0-9')
disk_free=$(df -B1 / 2>/dev/null | awk 'NR==2{print $4}' | tr -dc '0-9')
printf '{'
printf '"os":"%s",' "$(json_str "\${PRETTY_NAME:-Linux}")"
printf '"osId":"%s",' "$(json_str "\${ID:-}")"
printf '"osIdLike":"%s",' "$(json_str "\${ID_LIKE:-}")"
printf '"osVersionId":"%s",' "$(json_str "\${VERSION_ID:-}")"
printf '"arch":"%s",' "$(json_str "$(uname -m)")"
printf '"cpuCores":%s,' "$(num getconf _NPROCESSORS_ONLN)"
printf '"memoryBytes":%s,' "$(num awk '/MemTotal/{print $2*1024}' /proc/meminfo)"
printf '"diskBytes":%s,' "\${disk_total:-0}"
printf '"diskFreeBytes":%s,' "\${disk_free:-0}"
printf '"dnsOk":%s,' "$(bool getent hosts example.com)"
printf '"cloudInitPresent":%s,' "$(bool command -v cloud-init)"
printf '"cloudInitStatus":"%s",' "$(json_str "$(cloud-init status 2>/dev/null | head -1)")"
printf '"timeSynced":%s,' "$([ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ] && printf true || printf false)"
printf '"httpsOk":%s,' "$(bool curl -fsSI --max-time 8 https://github.com)"
printf '"sudoOk":%s,' "$(bool sudo -n true)"
printf '"kernelBits":%s,' "$(num getconf LONG_BIT)"
printf '"piModel":"%s",' "$(json_str "$(tr -d '\\0' 2>/dev/null </proc/device-tree/model)")"
printf '"lanIp":"%s",' "$(json_str "$(hostname -I 2>/dev/null | awk '{print $1}')")"
printf '"tools":{"curl":%s,"tar":%s},' "$(bool command -v curl)" "$(bool command -v tar)"
printf '"privilege":"%s"' "$(sudo -n true >/dev/null 2>&1 && printf sudo || printf user)"
printf '}\\n'
`

/** Parse the probe's stdout: the last non-empty line is the JSON document. */
export function parsePreflightFacts(output: string): SshPreflightFacts {
  const line = output
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
    .at(-1)
  if (!line || !line.startsWith('{')) throw new Error(`Preflight returned no facts:\n${output.trim().slice(-2000)}`)
  try {
    return JSON.parse(line) as SshPreflightFacts
  } catch (error) {
    throw new Error(`Preflight returned malformed facts: ${(error as Error).message}`)
  }
}

export interface PreflightContext {
  /** The deploy user; root needs no sudo. */
  user: string
  profile: SshProfile
}

const GIB = 1024 ** 3

function isArm64(arch: string): boolean {
  return arch === 'aarch64' || arch === 'arm64'
}

/**
 * Turn facts into findings. An `error` finding stops the adopt; a `warning`
 * is printed and the adopt continues; `info` is context worth showing.
 */
export function evaluatePreflight(facts: SshPreflightFacts, context: PreflightContext): ValidationFinding[] {
  const findings: ValidationFinding[] = []
  const arch = facts.arch ?? ''

  if (!isArm64(arch) && !(arch === 'x86_64' && context.profile === 'generic')) {
    findings.push({
      code: 'arch.not-aarch64',
      severity: 'error',
      message:
        context.profile === 'raspberry-pi'
          ? `The raspberry-pi profile expects a 64-bit ARM OS; this host reports ${arch || 'an unknown architecture'}.`
          : `Unsupported architecture ${arch || '(unknown)'}.`,
      remediation:
        context.profile === 'raspberry-pi'
          ? 'Flash the 64-bit Raspberry Pi OS or Ubuntu Server arm64 image.'
          : 'Use an x86_64 or arm64 Linux host.',
    })
  }

  const family = `${facts.osId ?? ''} ${facts.osIdLike ?? ''}`.toLowerCase()
  if (!/\b(?:debian|ubuntu|raspbian)\b/.test(family)) {
    findings.push({
      code: 'os.unsupported',
      severity: 'error',
      message: `The bootstrap targets Debian and Ubuntu (apt); this host reports ${facts.os || 'an unknown OS'}.`,
      remediation: 'Install Raspberry Pi OS, Debian or Ubuntu Server.',
    })
  }

  const memory = facts.memoryBytes ?? 0
  if (memory < GIB) {
    findings.push({
      code: 'memory.low',
      severity: 'error',
      message: `${(memory / GIB).toFixed(2)} GiB of memory; the runtime plus a gateway needs at least 1 GiB.`,
      remediation: 'Use a host with 2 GiB or more.',
    })
  } else if (memory < 2 * GIB) {
    findings.push({
      code: 'memory.low',
      severity: 'warning',
      message: `${(memory / GIB).toFixed(2)} GiB of memory; on-box builds and managed services will be tight.`,
      remediation: 'Build releases in CI rather than on the host, and keep managedServices small.',
    })
  }

  if ((facts.diskFreeBytes ?? 0) < 4 * GIB) {
    findings.push({
      code: 'disk.low',
      severity: 'error',
      message: `${((facts.diskFreeBytes ?? 0) / GIB).toFixed(1)} GiB free on /; releases, the artifact cache and swap need at least 4 GiB.`,
      remediation: 'Free space or use a larger card or disk.',
    })
  }

  if (context.user !== 'root' && !facts.sudoOk) {
    findings.push({
      code: 'sudo.missing',
      severity: 'error',
      message: `${context.user} cannot run sudo without a password, and the bootstrap needs root.`,
      remediation: `Add '${context.user} ALL=(ALL) NOPASSWD:ALL' to /etc/sudoers.d/ts-cloud, or deploy as root.`,
    })
  }

  if (!facts.timeSynced) {
    findings.push({
      code: 'time.unsynced',
      severity: 'warning',
      message: 'The clock is not NTP-synchronised yet; the bootstrap waits for it before running apt.',
      remediation: 'Nothing to do unless it never syncs: then check the network and systemd-timesyncd.',
    })
  }

  if (!facts.httpsOk) {
    findings.push({
      code: 'https.blocked',
      severity: 'error',
      message: 'The host cannot reach https://github.com, so it cannot download the runtime or packages.',
      remediation: 'Check DNS, the default route and any egress firewall from the host.',
    })
  }

  if (facts.cloudInitPresent && /running/i.test(facts.cloudInitStatus ?? '')) {
    findings.push({
      code: 'cloud-init.running',
      severity: 'info',
      message: 'cloud-init is still running its first boot; the adopt waits for it to finish.',
    })
  }

  if (facts.piModel) {
    findings.push({ code: 'pi.model', severity: 'info', message: facts.piModel })
  }

  if (facts.kernelBits === 32) {
    findings.push({
      code: 'bits.32',
      severity: 'error',
      message: 'This is a 32-bit userland; bun ships no 32-bit build.',
      remediation: 'Flash a 64-bit OS image.',
    })
  }

  return findings
}

/** True when any finding is an error. */
export function preflightFailed(findings: readonly ValidationFinding[]): boolean {
  return findings.some((finding) => finding.severity === 'error')
}

/** A plain-text table of findings, one per line, for a terminal or an error message. */
export function formatPreflightFindings(findings: readonly ValidationFinding[]): string {
  if (findings.length === 0) return 'No findings.'
  const width = Math.max(...findings.map((finding) => finding.code.length))
  return findings
    .map((finding) => {
      const head = `${finding.severity.padEnd(7)} ${finding.code.padEnd(width)}  ${finding.message}`
      return finding.remediation ? `${head}\n${' '.repeat(width + 10)}${finding.remediation}` : head
    })
    .join('\n')
}
