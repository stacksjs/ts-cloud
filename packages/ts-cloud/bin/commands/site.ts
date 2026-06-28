import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import type { CLI } from '@stacksjs/clapp'
import { addSiteToCloudConfig } from '../../src/deploy/site-config-editor'
import * as cli from '../../src/utils/cli'

interface SiteAddOptions {
  config?: string
  root?: string
  domain?: string
  path?: string
  deploy?: 'bucket' | 'server'
  build?: string
  start?: string
  port?: string
  type?: string
  pathRewriteStyle?: 'directory' | 'flat'
  dryRun?: boolean
}

export function registerSiteCommands(app: CLI): void {
  app
    .command('site:add <name>', 'Add a site entry to cloud.config.ts')
    .option('--config <path>', 'Path to cloud config file')
    .option('--root <path>', 'Directory to deploy')
    .option('--domain <domain>', 'Domain for the site')
    .option('--path <path>', 'Path prefix for the site')
    .option('--deploy <target>', 'Deployment target: server or bucket')
    .option('--build <command>', 'Build command to run before deployment')
    .option('--start <command>', 'Start command for server apps')
    .option('--port <port>', 'Port for server apps')
    .option('--type <type>', 'Site type, e.g. static, laravel, php')
    .option('--path-rewrite-style <style>', 'Static rewrite style: directory or flat')
    .option('--dry-run', 'Print the updated config without writing')
    .action(async (name: string, options?: SiteAddOptions) => {
      const configPath = options?.config || 'cloud.config.ts'
      const root = options?.root

      if (!root) {
        cli.error('Missing --root <path>')
        return
      }

      if (!existsSync(configPath)) {
        cli.error(`Config file not found: ${configPath}`)
        return
      }

      try {
        const updated = addSiteToCloudConfig({
          configText: await readFile(configPath, 'utf8'),
          name,
          root,
          domain: options?.domain,
          path: options?.path,
          deploy: normalizeDeploy(options?.deploy),
          build: options?.build,
          start: options?.start,
          port: normalizePort(options?.port),
          type: options?.type,
          pathRewriteStyle: normalizePathRewriteStyle(options?.pathRewriteStyle),
        })

        if (options?.dryRun) {
          console.log(updated)
          return
        }

        await writeFile(configPath, updated)
        cli.success(`Added site '${name}' to ${configPath}`)
      }
      catch (error) {
        cli.error(error instanceof Error ? error.message : String(error))
      }
    })
}

function normalizeDeploy(value: string | undefined): 'bucket' | 'server' | undefined {
  if (!value) return undefined
  if (value === 'bucket' || value === 'server') return value
  throw new Error(`Invalid --deploy '${value}'. Expected 'server' or 'bucket'.`)
}

function normalizePathRewriteStyle(value: string | undefined): 'directory' | 'flat' | undefined {
  if (!value) return undefined
  if (value === 'directory' || value === 'flat') return value
  throw new Error(`Invalid --path-rewrite-style '${value}'. Expected 'directory' or 'flat'.`)
}

function normalizePort(value: string | undefined): number | undefined {
  if (!value) return undefined

  const port = Number.parseInt(value, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid --port '${value}'. Expected a TCP port between 1 and 65535.`)
  }

  return port
}
