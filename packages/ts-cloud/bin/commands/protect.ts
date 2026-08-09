/**
 * `cloud protect:*` - the levers an operator reaches for during an incident.
 *
 * Everything here is deliberately blunt and fast to type, because it gets used
 * at 2am. Every state-changing command prints what it did, when it expires, and
 * what the consequence is, so the person running it does not have to remember.
 */
import type { CLI } from '@stacksjs/clapp'
import type { EnvironmentType } from '@ts-cloud/core'
import * as output from '../../src/utils/cli'
import { initializeDashboardControlPlane } from '../../src/deploy/dashboard-control-plane'
import {
  applyControlsToDdos,
  DEFAULT_ATTACK_MODE_HOURS,
  describePosture,
  MAX_CONTROL_HOURS,
  ProtectionControlStore,
  renderDdosInstallScript,
  renderWafConfig,
} from '../../src/protection'
import { loadValidatedConfig } from './shared'

async function context(environment?: string) {
  const config = await loadValidatedConfig()
  const env = (environment ?? Object.keys(config.environments ?? {})[0] ?? 'production') as EnvironmentType
  if (!Object.hasOwn(config.environments ?? {}, env)) throw new Error(`Environment ${env} was not found`)
  const controlPlane = initializeDashboardControlPlane(process.cwd(), config)
  return { config, env, controlPlane, controls: new ProtectionControlStore(controlPlane.store) }
}

function fail(error: unknown): void {
  output.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

function computeProtection(config: any) {
  const compute = config?.infrastructure?.compute ?? {}
  return {
    ddos: compute.ddos === false ? undefined : typeof compute.ddos === 'object' ? compute.ddos : { ports: [80, 443] },
    waf: compute.waf === false ? undefined : typeof compute.waf === 'object' ? compute.waf : { mode: 'detection' as const },
  }
}

export function registerProtectCommands(app: CLI): void {
  app
    .command('protect:status', 'Show the current edge-protection posture')
    .option('--env <environment>', 'Target environment')
    .option('--json', 'Print structured JSON')
    .action(async (options: { env?: string; json?: boolean }) => {
      try {
        const value = await context(options.env)
        const current = value.controls.current()
        const posture = describePosture(current)
        if (options.json) {
          output.info(JSON.stringify({ posture, controls: value.controls.raw() }, null, 2))
          return
        }
        output.header('Edge protection')
        if (posture.mitigationPaused || posture.attackMode) output.warn(posture.summary)
        else output.success(posture.summary)

        const protection = computeProtection(value.config)
        output.info(`L3/L4 mitigation: ${protection.ddos ? 'enabled' : 'disabled in config'}`)
        output.info(`WAF: ${protection.waf ? `enabled (${protection.waf.mode ?? 'detection'})` : 'disabled in config'}`)
        output.info(`Allowlist: ${current.ipRules.allow.length} entry(s)`)
        output.info(`Blocklist: ${current.ipRules.block.length} entry(s)`)
        if (current.ipRules.allow.length > 0 || current.ipRules.block.length > 0)
          output.table(
            ['List', 'CIDR'],
            [
              ...current.ipRules.allow.map((cidr) => ['allow', cidr]),
              ...current.ipRules.block.map((cidr) => ['block', cidr]),
            ],
          )
      } catch (error) {
        fail(error)
      }
    })

  app
    .command('protect:attack-mode <state>', 'Challenge every visitor for a bounded window (on|off)')
    .option('--hours <hours>', `How long before it lifts itself (default ${DEFAULT_ATTACK_MODE_HOURS}, max ${MAX_CONTROL_HOURS})`)
    .option('--reason <reason>', 'Why, for the record')
    .option('--env <environment>', 'Target environment')
    .action(async (state: string, options: { hours?: string; reason?: string; env?: string }) => {
      try {
        const value = await context(options.env)
        if (state === 'off') {
          output.success(
            value.controls.disableAttackMode() ? 'Attack mode is off.' : 'Attack mode was not on.',
          )
          return
        }
        if (state !== 'on') throw new Error("State must be 'on' or 'off'.")
        const control = value.controls.enableAttackMode({
          hours: options.hours == null ? undefined : Number(options.hours),
          reason: options.reason ?? 'Enabled from the CLI.',
        })
        output.warn('Attack mode is ON. Every visitor is challenged, including legitimate ones.')
        output.info(`It lifts itself at ${control.expiresAt} — you do not need to remember.`)
      } catch (error) {
        fail(error)
      }
    })

  app
    .command('protect:pause <state>', 'Pause or resume automatic mitigation (on|off)')
    .option('--hours <hours>', `How long (max ${MAX_CONTROL_HOURS})`)
    .option('--reason <reason>', 'Why — required when pausing')
    .option('--env <environment>', 'Target environment')
    .action(async (state: string, options: { hours?: string; reason?: string; env?: string }) => {
      try {
        const value = await context(options.env)
        if (state === 'off') {
          output.success(
            value.controls.resumeMitigations() ? 'Automatic mitigation resumed.' : 'Mitigation was not paused.',
          )
          return
        }
        if (state !== 'on') throw new Error("State must be 'on' or 'off'.")
        if (!options.reason) throw new Error('--reason is required: you are liable for the traffic this admits.')
        const control = value.controls.pauseMitigations({
          hours: options.hours == null ? undefined : Number(options.hours),
          reason: options.reason,
        })
        output.warn('Automatic mitigation is PAUSED. All traffic is served, and billed, including attacks.')
        output.info(`It resumes automatically at ${control.expiresAt}.`)
      } catch (error) {
        fail(error)
      }
    })

  app
    .command('protect:allow <cidr>', 'Never rate-limit or block this IP or CIDR')
    .option('--remove', 'Remove the entry instead')
    .option('--env <environment>', 'Target environment')
    .action(async (cidr: string, options: { remove?: boolean; env?: string }) => {
      try {
        const value = await context(options.env)
        const rules = options.remove
          ? value.controls.removeIpRule('allow', cidr)
          : value.controls.addIpRule('allow', cidr)
        output.success(`Allowlist now has ${rules.allow.length} entry(s).`)
        output.info('It reaches the boxes on the next deploy. `cloud protect:apply` shows exactly what will land.')
      } catch (error) {
        fail(error)
      }
    })

  app
    .command('protect:block <cidr>', 'Drop traffic from this IP or CIDR at the kernel')
    .option('--remove', 'Remove the entry instead')
    .option('--env <environment>', 'Target environment')
    .action(async (cidr: string, options: { remove?: boolean; env?: string }) => {
      try {
        const value = await context(options.env)
        const rules = options.remove
          ? value.controls.removeIpRule('block', cidr)
          : value.controls.addIpRule('block', cidr)
        output.success(`Blocklist now has ${rules.block.length} entry(s).`)
        output.info('It reaches the boxes on the next deploy. `cloud protect:apply` shows exactly what will land.')
      } catch (error) {
        fail(error)
      }
    })

  app
    .command('protect:apply', 'Print the ruleset the current controls produce')
    .option('--env <environment>', 'Target environment')
    .option('--waf', 'Print the WAF configuration instead of the firewall script')
    .action(async (options: { env?: string; waf?: boolean }) => {
      try {
        const value = await context(options.env)
        const protection = computeProtection(value.config)
        if (options.waf) {
          if (!protection.waf) throw new Error('The WAF is disabled in this configuration.')
          const rendered = renderWafConfig(protection.waf)
          for (const warning of rendered.warnings) output.warn(warning)
          output.info(rendered.config)
          return
        }
        if (!protection.ddos) throw new Error('L3/L4 mitigation is disabled in this configuration.')
        // Rendering rather than executing: the operator sees exactly what would
        // land on the box, and the deploy is what actually applies it.
        output.info(renderDdosInstallScript(applyControlsToDdos(protection.ddos, value.controls.current())))
      } catch (error) {
        fail(error)
      }
    })
}
