/**
 * First-boot files for a freshly flashed image.
 *
 * Raspberry Pi OS (Trixie and later) and Ubuntu Server for the Pi both read
 * cloud-init's `user-data`, `network-config` and `meta-data` from the boot
 * partition. Writing them there before the first boot means the board comes
 * up with the deploy user, the operator's key, no password login, Wi-Fi if
 * it needs it, and the ts-cloud bootstrap already run: the first time anyone
 * touches it over SSH it is ready for `cloud deploy`.
 *
 * The bootstrap script is the same one the adopt flow runs over SSH, so a
 * host prepared at image time and a host adopted later end up identical, and
 * its version marker means the adopt that follows does not run it twice.
 *
 * A Wi-Fi passphrase goes into `network-config` and nowhere else: `user-data`
 * is the file people paste into issues.
 */
import type { CloudInitUserDataExtras } from '../hetzner/cloud-init'
import { wrapCloudInitUserData } from '../hetzner/cloud-init'

export type FirstBootOs = 'raspberry-pi-os' | 'ubuntu'

export interface FirstBootWifi {
  ssid: string
  passphrase: string
  /** ISO 3166-1 alpha-2 regulatory domain, e.g. `DE`. Required: without it the radio stays off. */
  country: string
}

export interface FirstBootIdentity {
  /** The hostname; also the mDNS name (`<hostname>.local`) the instructions point at. */
  hostname: string
  /** The deploy user cloud-init creates, with passwordless sudo and the key below. */
  user: string
  /** One public key line (`ssh-ed25519 AAAA... comment`). */
  publicKey: string
  /** IANA timezone, e.g. `Europe/Berlin`. */
  timezone?: string
  /** System locale, e.g. `en_US.UTF-8`. */
  locale?: string
  wifi?: FirstBootWifi
}

export interface FirstBootBundle {
  /** File name (as it must appear on the boot partition) to content. */
  files: Record<string, string>
  /** What to do with the files, for the terminal. */
  instructions: string
}

export interface FirstBootOptions {
  os: FirstBootOs
}

/** Where the bootstrap is written on the host; the same place the adopt flow's marker lives beside. */
export const FIRST_BOOT_SCRIPT_PATH = '/var/lib/ts-cloud/bootstrap.sh'

/** The boot partition label each OS uses, so the instructions can name the volume. */
export const BOOT_PARTITION_LABEL: Record<FirstBootOs, string> = {
  'raspberry-pi-os': 'bootfs',
  'ubuntu': 'system-boot',
}

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const USERNAME = /^[a-z_][a-z0-9_-]{0,31}$/
const COUNTRY = /^[A-Z]{2}$/

/** A YAML double-quoted scalar. JSON string syntax is valid YAML, so this is exact. */
function yamlString(value: string): string {
  return JSON.stringify(value)
}

function validateIdentity(identity: FirstBootIdentity): void {
  if (!HOSTNAME.test(identity.hostname))
    throw new Error(`Invalid hostname '${identity.hostname}': use lowercase letters, digits and hyphens.`)
  if (!USERNAME.test(identity.user))
    throw new Error(`Invalid user '${identity.user}': use a lowercase Unix user name.`)
  const key = identity.publicKey.trim()
  if (!key || key.includes('\n') || !/^(?:ssh|ecdsa|sk)-/.test(key))
    throw new Error('publicKey must be one public key line, e.g. the contents of ~/.ssh/id_ed25519.pub.')
  if (identity.wifi) {
    if (!identity.wifi.ssid) throw new Error('wifi.ssid is required.')
    if (!identity.wifi.passphrase) throw new Error('wifi.passphrase is required.')
    if (!COUNTRY.test(identity.wifi.country))
      throw new Error(`wifi.country must be a two-letter regulatory domain such as DE or US, not '${identity.wifi.country}'.`)
  }
}

function userDataHead(identity: FirstBootIdentity, os: FirstBootOs): string {
  const lines = [
    `hostname: ${yamlString(identity.hostname)}`,
    'manage_etc_hosts: true',
    'users:',
    `  - name: ${yamlString(identity.user)}`,
    '    ssh_authorized_keys:',
    `      - ${yamlString(identity.publicKey.trim())}`,
    `    sudo: ${yamlString('ALL=(ALL) NOPASSWD:ALL')}`,
    '    shell: /bin/bash',
    '    lock_passwd: true',
    'ssh_pwauth: false',
  ]
  if (identity.timezone) lines.push(`timezone: ${yamlString(identity.timezone)}`)
  if (identity.locale) lines.push(`locale: ${yamlString(identity.locale)}`)
  lines.push('package_update: true')
  if (os === 'raspberry-pi-os') {
    // Raspberry Pi OS ships a cloud-init module of its own for the board's
    // peripherals. SSH on; every bus a headless server has no use for off.
    lines.push(
      'rpi:',
      '  enable_ssh: true',
      '  interfaces:',
      '    spi: false',
      '    i2c: false',
      '    onewire: false',
      '    remote_gpio: false',
      '    serial:',
      '      console: false',
      '      hardware: false',
    )
  }
  return `${lines.join('\n')}\n`
}

function networkConfig(identity: FirstBootIdentity): string {
  const lines = [
    'version: 2',
    'ethernets:',
    '  eth0:',
    '    match:',
    `      name: ${yamlString('e*')}`,
    '    dhcp4: true',
    '    dhcp6: true',
    '    optional: true',
  ]
  if (identity.wifi) {
    lines.push(
      'wifis:',
      '  wlan0:',
      '    dhcp4: true',
      '    dhcp6: true',
      '    optional: true',
      `    regulatory-domain: ${yamlString(identity.wifi.country)}`,
      '    access-points:',
      `      ${yamlString(identity.wifi.ssid)}:`,
      `        password: ${yamlString(identity.wifi.passphrase)}`,
    )
  }
  return `${lines.join('\n')}\n`
}

function metaData(identity: FirstBootIdentity): string {
  return [`instance-id: ${yamlString(`ts-cloud-${identity.hostname}`)}`, `local-hostname: ${yamlString(identity.hostname)}`].join('\n') + '\n'
}

function instructions(identity: FirstBootIdentity, os: FirstBootOs): string {
  const label = BOOT_PARTITION_LABEL[os]
  return [
    `Copy user-data, network-config and meta-data onto the boot partition of the flashed card (the volume named '${label}'), replacing the files already there.`,
    'Eject the card, put it in the board and power it on.',
    'The first boot takes a few minutes: cloud-init creates the user, waits for the clock to sync, then runs the ts-cloud bootstrap (packages, runtime, gateway).',
    `Then, from this machine: cloud ssh:preflight ${identity.hostname}.local --user ${identity.user}`,
    'When the preflight is clean, cloud deploy adopts the host and ships the sites.',
  ].join('\n')
}

/**
 * Build the three cloud-init files for `identity`, embedding `bootstrapScript`
 * (from `buildSshBootstrapScript`) so it runs at the end of the first boot.
 */
export function buildCloudInitFirstBoot(
  identity: FirstBootIdentity,
  bootstrapScript: string,
  options: FirstBootOptions,
): FirstBootBundle {
  validateIdentity(identity)
  const extras: CloudInitUserDataExtras = {
    scriptPath: FIRST_BOOT_SCRIPT_PATH,
    permissions: '0700',
    before: userDataHead(identity, options.os),
  }
  return {
    files: {
      'user-data': wrapCloudInitUserData(bootstrapScript, extras),
      'network-config': networkConfig(identity),
      'meta-data': metaData(identity),
    },
    instructions: instructions(identity, options.os),
  }
}
