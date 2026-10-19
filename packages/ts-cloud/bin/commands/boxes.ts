import type { CLI } from '@stacksjs/clapp'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'
import { HetznerClient } from '../../src/drivers/hetzner/client'
import { resolveHetznerSettings } from '../../src/drivers/hetzner/config'
import { provisionBox } from '../../src/drivers/shared/box-converge'
import { sshKnownHostsPath } from '../../src/drivers/shared/ssh-transport'
import * as cli from '../../src/utils/cli'
import { loadValidatedConfig } from './shared'

const expandHome = (path: string): string => path.replace(/^~(?=$|\/)/, homedir())

/**
 * Declared boxes (`infrastructure.boxes`): machines that are not app servers,
 * such as a CI runner. Each is found by name or created, resized when its
 * declaration asks (draining its services first), then converged over SSH.
 */
export function registerBoxCommands(app: CLI): void {
  app
    .command('boxes:apply [name]', 'Converge declared boxes: create, resize when asked, install packages and start services')
    .option('--dry-run', 'Show what would change without touching any box')
    .option('--yes', 'Apply without prompting')
    .action(async (name?: string, options?: { dryRun?: boolean, yes?: boolean }) => {
      try {
        const config = await loadValidatedConfig()
        const declared = Object.entries(config.infrastructure?.boxes ?? {})
        const boxes = name ? declared.filter(([key, box]) => key === name || box.name === name) : declared
        if (boxes.length === 0) throw new Error(name ? `No box named ${name} in infrastructure.boxes` : 'No boxes declared in infrastructure.boxes')

        const settings = resolveHetznerSettings(config)
        if (!settings.apiToken) throw new Error('Hetzner API token required: hetzner.apiToken, HCLOUD_TOKEN or HETZNER_API_TOKEN')
        const client = new HetznerClient({ apiToken: settings.apiToken })
        const ssh = {
          sshPublicKey: readFileSync(expandHome(settings.sshPublicKeyPath), 'utf8').trim(),
          identityFile: expandHome(settings.sshPrivateKeyPath),
          knownHostsFile: sshKnownHostsPath(),
        }

        for (const [key, box] of boxes) {
          const plan = await provisionBox({ box, client, ...ssh, dryRun: true })
          cli.info(`${key} (${box.name}):`)
          for (const line of plan.report) cli.info(`  ${line}`)
        }
        if (options?.dryRun) return
        if (!options?.yes && !await cli.confirm('Apply these box changes?', false)) return

        for (const [key, box] of boxes) {
          const result = await provisionBox({ box, client, ...ssh, onPhase: phase => cli.info(`  ${key}: ${phase}`) })
          for (const line of result.report) cli.info(`  ${key}: ${line}`)
          cli.success(`${key} converged (${result.box.publicIp})`)
        }
      }
      catch (error) {
        cli.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
      }
    })
}
