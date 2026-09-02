/**
 * The bootstrap for a bring-your-own host.
 *
 * The recipe is the Hetzner driver's, composed the same way from the same
 * builders (the rpx gateway, the machine provisioning, the Ubuntu bootstrap),
 * so an adopted Pi and a cloud box end up running the same stack from the
 * same code. What differs is the machine it lands on:
 *
 * - It may run MORE than once. cloud-init on a Pi has an upstream bug that
 *   reruns modules on every boot, an operator may `cloud ssh:bootstrap` twice,
 *   and a deploy calls the adopt on every run. So the whole script is guarded
 *   by a version marker: once `/var/lib/ts-cloud/bootstrap.v<N>` exists, only
 *   the gateway fragment is refreshed. Bumping {@link SSH_BOOTSTRAP_VERSION}
 *   is how a changed recipe gets applied to hosts bootstrapped by an older one.
 * - It may run before the clock is right. A Pi 5 has no battery-backed RTC,
 *   and apt refuses Release files "from the future" while ACME refuses a
 *   skewed clock outright. Time sync is awaited before anything touches apt.
 * - It may run as a user that is not root. The scripts arrive through the
 *   sudo runner, so they ARE root, but the deploy user still has to be able
 *   to scp into the artifact and staging directories, and the operator keys
 *   belong in that user's `authorized_keys`, not root's.
 * - It may run on a small SD card. The raspberry-pi profile halves the
 *   swapfile and bounds the journal.
 */
import type { CloudConfig, EnvironmentType } from '@ts-cloud/core'
import type { RpxLanOptions } from '../shared/rpx-gateway'
import type { SshLanConfig, SshProfile } from './config'
import type { SshPreflightFacts } from './preflight'
import { isIP } from 'node:net'
import { buildComputeProvisionScripts } from '../shared/compute-provision'
import { buildRpxConfig, buildRpxFragmentRefreshScript, buildRpxProvisionScript, localCaCertPath, RPX_SITES_DIR } from '../shared/rpx-gateway'
import { buildUbuntuBootstrapScript } from '../shared/ubuntu-bootstrap'
import { enabled as vitessEnabled } from '../shared/vitess-provision'

/** Bump when the recipe changes in a way an already-bootstrapped host must pick up. */
export const SSH_BOOTSTRAP_VERSION = 1

/** Where the bootstrap records that it ran. */
export const SSH_BOOTSTRAP_MARKER_DIR = '/var/lib/ts-cloud'

export function sshBootstrapMarkerPath(version: number = SSH_BOOTSTRAP_VERSION): string {
  return `${SSH_BOOTSTRAP_MARKER_DIR}/bootstrap.v${version}`
}

/** Swap the raspberry-pi profile provisions when `compute.swapGb` is unset. */
export const RASPBERRY_PI_DEFAULT_SWAP_GB = 1

export interface SshBootstrapOptions {
  config: CloudConfig
  environment: EnvironmentType
  profile: SshProfile
  /**
   * Preflight facts, when the host has been probed. `arch` gates x86_64-only
   * services; `lanIp` becomes the LAN certificate's iPAddress SAN.
   */
  facts?: Pick<SshPreflightFacts, 'arch'> & Partial<Pick<SshPreflightFacts, 'lanIp'>>
  /**
   * The non-root deploy user, when there is one. Makes the artifact and
   * staging directories group-writable for it and manages its
   * `authorized_keys` rather than root's.
   */
  sudoUser?: string
  /** LAN settings; recorded in the script header and wired into the gateway's local CA. */
  lan?: SshLanConfig
  /**
   * The box's LAN address, when the caller knows one that is not in `facts`
   * (the configured ssh host, when that host is an IP literal). Wins over
   * `facts.lanIp`. Never guessed: an address absent here is simply left off
   * the certificate.
   */
  lanIp?: string
}

function isArm64(arch: string | undefined): boolean {
  return arch === 'aarch64' || arch === 'arm64'
}

/**
 * The box's LAN address, or `undefined`. An explicit `lanIp` (the driver's
 * IP-literal ssh host) beats the preflight's `hostname -I`, and anything that
 * is not an address at all is dropped rather than put on a certificate.
 */
function lanIpFor(options: SshBootstrapOptions): string | undefined {
  const candidate = options.lanIp?.trim() || options.facts?.lanIp?.trim()
  return candidate && isIP(candidate) !== 0 ? candidate : undefined
}

/**
 * Refuse a config that asks for something this host's architecture cannot
 * run. Vitess publishes x86_64 release tarballs only, so on an arm64 host the
 * provision would fail minutes in on a download URL; say so before contact.
 * The raspberry-pi profile is arm64 by definition, so it needs no facts.
 */
export function assertArchSupported(config: CloudConfig, profile: SshProfile, arch?: string): void {
  const vitess = vitessEnabled(config.infrastructure?.compute?.managedServices?.vitess)
  if (!vitess) return
  const arm = profile === 'raspberry-pi' || isArm64(arch)
  if (arm) {
    throw new Error(
      `managedServices.vitess is enabled, but Vitess publishes only x86_64 release tarballs and this host is ${
        arch ?? 'a Raspberry Pi (arm64)'
      }. Drop managedServices.vitess or deploy it to an x86_64 host.`,
    )
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/** Wait for NTP sync, bounded, so apt and ACME see a sane clock. */
function timeSyncPrelude(): string {
  return `
# A Pi 5 has no battery-backed RTC and boots in 1970 until NTP answers. apt
# rejects Release files "from the future" and ACME rejects a skewed clock, so
# wait (bounded) for systemd-timesyncd before anything touches the network
# for packages. A host without timedatectl skips this.
if command -v timedatectl >/dev/null 2>&1; then
  ts_cloud_synced=no
  for _ in $(seq 1 60); do
    if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]; then ts_cloud_synced=yes; break; fi
    sleep 2
  done
  if [ "$ts_cloud_synced" != yes ]; then
    echo "[ts-cloud] clock still unsynchronised after 120s; continuing after a last attempt"
    systemctl start systemd-time-wait-sync >/dev/null 2>&1 || true
  fi
fi
`
}

/** Bound the journal on an SD card: 128M, a week, compressed. */
function raspberryPiJournal(): string {
  return `
# SD cards wear; a journal allowed to grow to the default 10% of the disk is
# the single biggest writer on an idle Pi. Bound it.
install -d -m 0755 /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/99-ts-cloud-sd.conf <<'TS_CLOUD_JOURNAL_EOF'
[Journal]
SystemMaxUse=128M
MaxRetentionSec=7day
Compress=yes
TS_CLOUD_JOURNAL_EOF
systemctl restart systemd-journald
`
}

/** Directories the non-root deploy user scps into, group-writable for it. */
function sudoUserDirectories(user: string): string {
  const quoted = shellSingleQuote(user)
  return `
# The deploy user uploads releases as itself (scp), while the scripts run as
# root through sudo. setgid group-writable directories let both write.
install -d -m 2775 -g "$(id -gn ${quoted})" /var/ts-cloud/artifacts /var/ts-cloud/staging
`
}

/** The keys block is written by root; give the file back to its user or sshd ignores it. */
function sudoUserAuthorizedKeysOwnership(user: string): string[] {
  const quoted = shellSingleQuote(user)
  const home = `/home/${user}`
  return [
    `chown -R ${quoted}:"$(id -gn ${quoted})" ${shellSingleQuote(`${home}/.ssh`)}`,
    `chmod 700 ${shellSingleQuote(`${home}/.ssh`)}`,
  ]
}

/**
 * Build the bootstrap script for an adopted host. See the module comment for
 * what makes it different from the cloud drivers' first-boot script.
 */
export function buildSshBootstrapScript(options: SshBootstrapOptions): string {
  const { config, environment, profile, sudoUser } = options
  assertArchSupported(config, profile, options.facts?.arch)

  const compute = config.infrastructure?.compute ?? {}
  const sites = config.sites ?? {}
  const slug = config.project.slug

  // Opt-in rpx gateway, exactly as the Hetzner driver composes it: the
  // fragment lands in the same `/etc/rpx/sites.d/<slug>.json`. What the cloud
  // drivers never pass is `lan`: a host with no public DNS gets its TLS from a
  // certificate authority the box keeps itself, and the fragment is where that
  // setting lives (see buildRpxConfig's note on the seam).
  const lan: RpxLanOptions | undefined = options.lan
    ? {
        ...(options.lan.hostname ? { hostname: options.lan.hostname } : {}),
        tls: options.lan.tls ?? 'local-ca',
        ...(lanIpFor(options) ? { ip: lanIpFor(options) } : {}),
      }
    : undefined
  const rpxConfig =
    compute.proxy?.engine === 'rpx' ? buildRpxConfig(sites, { proxy: compute.proxy, slug, lan }) : undefined
  const rpxProvision =
    compute.proxy?.engine === 'rpx' && rpxConfig
      ? buildRpxProvisionScript({
          proxy: compute.proxy,
          config: rpxConfig,
          slug,
          profile,
          bunBin: compute.runtime === 'node' || compute.runtime === 'deno' ? undefined : '/usr/local/bin/bun',
        })
      : undefined
  const rpxRefresh =
    compute.proxy?.engine === 'rpx' && rpxConfig
      ? buildRpxFragmentRefreshScript({ config: rpxConfig, slug })
      : undefined

  const authorizedKeysPath = sudoUser ? `/home/${sudoUser}/.ssh/authorized_keys` : undefined
  const provision = buildComputeProvisionScripts(config, { environment, authorizedKeysPath })
  const servicesProvision = sudoUser
    ? [...(provision.servicesProvision ?? []), ...sudoUserAuthorizedKeysOwnership(sudoUser)]
    : provision.servicesProvision

  // `fuser` (psmisc) frees :80/:443 before the gateway starts; the Hetzner
  // image has it, a minimal Debian does not. ca-certificates is what makes
  // every https download below trust anything.
  const systemPackages = [...new Set([...(compute.systemPackages ?? []), 'psmisc', 'ca-certificates'])]

  const swapGb = compute.swapGb ?? (profile === 'raspberry-pi' ? RASPBERRY_PI_DEFAULT_SWAP_GB : undefined)

  const body = buildUbuntuBootstrapScript({
    runtime: provision.runtime,
    runtimeVersion: provision.runtimeVersion,
    systemPackages,
    database: config.infrastructure?.database,
    phpProvision: provision.phpProvision,
    servicesProvision,
    rpxProvision,
    swapGb,
  })
    // The shared recipe carries its own shebang and `set -euo pipefail`; this
    // script has already established both.
    .replace(/^#!\/bin\/bash\nset -euo pipefail\n/, '')

  const marker = sshBootstrapMarkerPath()
  // The header is now a description of what the script actually does, not a
  // claim about it: the same `lan` object above is what configures the gateway.
  const lanHeader = rpxConfig?.localCa
    ? ` lan=${rpxConfig.localCa.hosts.join(',')} tls=local-ca`
    : lan
      ? ` lan=${lan.hostname ?? `${slug}.local`} tls=${lan.tls ?? 'local-ca'}`
      : ''

  let script = `#!/bin/bash
set -euo pipefail
# ts-cloud ssh bootstrap v${SSH_BOOTSTRAP_VERSION} profile=${profile}${lanHeader}

# Idempotence guard. This script may run again (a cloud-init rerun, a repeated
# adopt, a deploy): once this version has been applied, only the gateway's
# route fragment is refreshed, so a rerun cannot re-download the runtime or
# re-create swap on every boot.
if [ -e ${shellSingleQuote(marker)} ]; then
  echo "[ts-cloud] bootstrap v${SSH_BOOTSTRAP_VERSION} already applied; refreshing the gateway fragment only"
`
  if (rpxRefresh) {
    const refreshBody = rpxRefresh[0] === 'set -euo pipefail' ? rpxRefresh.slice(1) : rpxRefresh
    script += `${refreshBody.join('\n')}\n`
  }
  script += `  exit 0
fi
`
  script += timeSyncPrelude()
  if (profile === 'raspberry-pi') script += raspberryPiJournal()
  if (sudoUser) script += sudoUserDirectories(sudoUser)
  script += `\n${body}`
  script += `
install -d -m 0755 ${shellSingleQuote(SSH_BOOTSTRAP_MARKER_DIR)}
date -u +%Y-%m-%dT%H:%M:%SZ > ${shellSingleQuote(marker)}
echo "[ts-cloud] bootstrap v${SSH_BOOTSTRAP_VERSION} applied (${profile}); gateway fragment at ${RPX_SITES_DIR}/${slug}.json"
`
  if (rpxConfig?.localCa) {
    // The CA certificate is the one file a laptop or a phone needs, and it is
    // created by the gateway on its first start rather than by this script, so
    // say where it will be instead of trying to print it.
    script += `echo "[ts-cloud] LAN certificate authority for ${rpxConfig.localCa.hosts.join(', ')} at ${localCaCertPath(
      rpxConfig.localCa.dir,
    )} (copy it to a client to trust this box)"\n`
  }
  return script
}
