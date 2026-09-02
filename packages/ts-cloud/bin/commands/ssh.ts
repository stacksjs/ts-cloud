import type { CLI } from '@stacksjs/clapp'
import type { CloudConfig, EnvironmentType } from '@ts-cloud/core'
import type { FirstBootOs } from '../../src/drivers/ssh/first-boot'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as cli from '../../src/utils/cli'
import { expandHome } from '../../src/drivers/hetzner/config'
import { buildSshBootstrapScript } from '../../src/drivers/ssh/bootstrap'
import { resolveSshSettings } from '../../src/drivers/ssh/config'
import { SshDriver } from '../../src/drivers/ssh/driver'
import { BOOT_PARTITION_LABEL, buildCloudInitFirstBoot } from '../../src/drivers/ssh/first-boot'
import { formatPreflightFindings, preflightFailed } from '../../src/drivers/ssh/preflight'
import { loadValidatedConfig } from './shared'

const fail = (error: unknown): void => {
  cli.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

/** The config when there is one; the preflight can run against a bare host without it. */
async function optionalConfig(): Promise<CloudConfig | undefined> {
  try {
    return await loadValidatedConfig()
  } catch {
    return undefined
  }
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port must be a port number, not '${value}'.`)
  return port
}

interface PreflightOptions {
  user?: string
  port?: string
  key?: string
  profile?: string
  json?: boolean
}

interface BootstrapOptions {
  env?: string
  dryRun?: boolean
}

interface FirstBootCommandOptions {
  os?: string
  out?: string
  hostname?: string
  user?: string
  key?: string
  wifiSsid?: string
  wifiPassphraseEnv?: string
  wifiCountry?: string
  timezone?: string
  locale?: string
  env?: string
  force?: boolean
}

/** A driver for `host` (or the configured host), with CLI overrides applied. */
function driverFor(config: CloudConfig | undefined, host: string | undefined, options: PreflightOptions): SshDriver {
  const configured = config?.ssh?.hosts?.find((entry) => entry.host === host)
  return new SshDriver({
    hosts: host ? [configured ?? { host }] : config?.ssh?.hosts,
    user: options.user,
    port: parsePort(options.port),
    privateKeyPath: options.key,
    hostKey: config?.ssh?.hostKey,
    sudo: config?.ssh?.sudo,
    profile: options.profile ?? config?.ssh?.profile,
    publicIp: config?.ssh?.publicIp,
    lan: config?.ssh?.lan,
  })
}

const GIB = 1024 ** 3

export function registerSshCommands(app: CLI): void {
  app
    .command('ssh:preflight [host]', 'Check a bring-your-own Linux host before adopting it')
    .option('--user <user>', 'SSH user (default: ssh.hosts[].user, then root)')
    .option('--port <port>', 'SSH port (default: ssh.hosts[].port, then 22)')
    .option('--key <path>', 'SSH private key (default: ssh.hosts[].privateKeyPath, then ~/.ssh/id_ed25519)')
    .option('--profile <profile>', 'raspberry-pi or generic (default: ssh.profile, then generic)')
    .option('--json', 'Print the facts and findings as JSON')
    .action(async (host: string | undefined, options: PreflightOptions) => {
      try {
        const config = await optionalConfig()
        const driver = driverFor(config, host, options)
        const target = host ?? driver.targetHost()
        const trust = await driver.ensureHostKey(target)
        const { facts, findings } = await driver.preflight(target)
        if (options.json) {
          console.log(JSON.stringify({ schemaVersion: 1, host: target, hostKeyFingerprint: trust.fingerprint, facts, findings }, null, 2))
        } else {
          cli.header(`Preflight ${target}`)
          if (trust.pinnedNow) cli.info(`Pinned host key ${trust.fingerprint}`)
          cli.info(`${facts.os} on ${facts.arch}, ${facts.cpuCores} cores, ${(facts.memoryBytes / GIB).toFixed(1)} GiB memory, ${(facts.diskFreeBytes / GIB).toFixed(1)} GiB free`)
          if (facts.piModel) cli.info(facts.piModel)
          if (facts.lanIp) cli.info(`LAN address ${facts.lanIp}`)
          console.log(formatPreflightFindings(findings))
          if (preflightFailed(findings)) cli.error('The host is not ready; fix the errors above and run the preflight again.')
          else cli.success('The host is ready to adopt.')
        }
        if (preflightFailed(findings)) process.exitCode = 1
      } catch (error) {
        fail(error)
      }
    })

  app
    .command('ssh:bootstrap', 'Adopt the configured host: pin its key, run the preflight, then bootstrap it')
    .option('--env <environment>', 'Deployment environment', { default: 'production' })
    .option('--dry-run', 'Print the bootstrap script instead of running it')
    .action(async (options: BootstrapOptions) => {
      try {
        const config = await loadValidatedConfig()
        const environment = (options.env ?? 'production') as EnvironmentType
        if (options.dryRun) {
          const settings = resolveSshSettings(config)
          const [host] = settings.hosts
          console.log(
            buildSshBootstrapScript({
              config,
              environment,
              profile: settings.profile,
              sudoUser: host.user !== 'root' ? host.user : undefined,
              lan: settings.lan,
            }),
          )
          return
        }
        const driver = driverFor(config, undefined, {})
        cli.header(`Adopt ${driver.targetHost()}`)
        const outputs = await driver.provisionComputeInfrastructure({ config, environment })
        cli.success(`${outputs.appPublicIp} is bootstrapped; deploy with: cloud deploy --env ${environment}`)
      } catch (error) {
        fail(error)
      }
    })

  app
    .command('ssh:first-boot', 'Write cloud-init first-boot files for a freshly flashed Raspberry Pi OS or Ubuntu image')
    .option('--os <os>', 'raspberry-pi-os or ubuntu', { default: 'raspberry-pi-os' })
    .option('--out <dir>', 'Directory to write user-data, network-config and meta-data into (never a mounted card; copy them yourself)')
    .option('--hostname <name>', 'Hostname of the new host')
    .option('--user <user>', 'Deploy user created on first boot (default: ssh.hosts[].user, then pi)')
    .option('--key <path>', 'Public key authorized for the user', { default: '~/.ssh/id_ed25519.pub' })
    .option('--wifi-ssid <ssid>', 'Join this Wi-Fi network on first boot')
    .option('--wifi-passphrase-env <name>', 'Environment variable holding the Wi-Fi passphrase', { default: 'WIFI_PASSWORD' })
    .option('--wifi-country <cc>', 'Wi-Fi regulatory domain, e.g. DE')
    .option('--timezone <tz>', 'IANA timezone, e.g. Europe/Berlin')
    .option('--locale <locale>', 'System locale, e.g. en_US.UTF-8')
    .option('--env <environment>', 'Deployment environment the embedded bootstrap is built for', { default: 'production' })
    .option('--force', 'Overwrite files already in --out')
    .action(async (options: FirstBootCommandOptions) => {
      try {
        if (!options.out) throw new Error('--out <dir> is required.')
        if (!options.hostname) throw new Error('--hostname <name> is required.')
        const os = (options.os ?? 'raspberry-pi-os') as FirstBootOs
        if (!(os in BOOT_PARTITION_LABEL)) throw new Error(`--os must be raspberry-pi-os or ubuntu, not '${os}'.`)

        const config = await loadValidatedConfig()
        const environment = (options.env ?? 'production') as EnvironmentType
        // The profile is the board's when the OS is the board's; otherwise the config decides.
        const settings = resolveSshSettings(config, {
          hosts: config.ssh?.hosts?.length ? undefined : [{ host: options.hostname }],
          profile: os === 'raspberry-pi-os' ? 'raspberry-pi' : undefined,
        })
        const user = options.user ?? (config.ssh?.hosts?.[0]?.user ?? 'pi')

        const keyPath = expandHome(options.key ?? '~/.ssh/id_ed25519.pub')
        if (!existsSync(keyPath)) throw new Error(`Public key not found at ${keyPath}; pass --key <path to a .pub file>.`)
        const publicKey = readFileSync(keyPath, 'utf8').trim()

        let wifi
        if (options.wifiSsid) {
          const envName = options.wifiPassphraseEnv ?? 'WIFI_PASSWORD'
          const passphrase = process.env[envName]
          if (!passphrase) throw new Error(`--wifi-ssid needs the passphrase in $${envName} (set it in the environment, not on the command line).`)
          if (!options.wifiCountry) throw new Error('--wifi-country <cc> is required with --wifi-ssid.')
          wifi = { ssid: options.wifiSsid, passphrase, country: options.wifiCountry }
        }

        const bootstrap = buildSshBootstrapScript({
          config,
          environment,
          profile: settings.profile,
          sudoUser: user !== 'root' ? user : undefined,
          lan: settings.lan,
        })
        const bundle = buildCloudInitFirstBoot(
          { hostname: options.hostname, user, publicKey, timezone: options.timezone, locale: options.locale, wifi },
          bootstrap,
          { os },
        )

        const out = resolve(options.out)
        mkdirSync(out, { recursive: true })
        const existing = Object.keys(bundle.files).filter((name) => existsSync(join(out, name)))
        if (existing.length > 0 && !options.force)
          throw new Error(`${existing.join(', ')} already exist in ${out}; pass --force to overwrite.`)
        for (const [name, content] of Object.entries(bundle.files)) {
          // network-config may carry the Wi-Fi passphrase: owner-readable only.
          writeFileSync(join(out, name), content, { mode: 0o600 })
        }

        cli.header(`First boot for ${options.hostname}`)
        cli.success(`Wrote ${Object.keys(bundle.files).join(', ')} to ${out}`)
        console.log(bundle.instructions)
      } catch (error) {
        fail(error)
      }
    })
}
