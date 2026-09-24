import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

process.env.APP_ENV ||= 'production'
process.env.NODE_ENV ||= 'production'

/**
 * A Stacks app's queue worker, for a systemd unit.
 *
 * Workers used to start `storage/framework/core/buddy/src/cli.ts queue:work`,
 * a path only the framework's own monorepo has. An app installs the framework
 * from npm, so every worker unit failed with "Module not found" and restarted
 * every five seconds, and nothing on the queue ever ran (commshq's
 * confirmation emails, for one). Like stacks-scheduler, this goes straight to
 * the action in the active release. The action reads `--queue`, `--sleep`,
 * `--tries` and `--timeout` from argv itself, so the flags pass through as is.
 */
async function main(): Promise<void> {
  const candidates = [
    'storage/framework/core/actions/src/queue/work.ts',
    'node_modules/@stacksjs/actions/src/queue/work.ts',
    'node_modules/@stacksjs/actions/dist/queue/work.js',
    'node_modules/@stacksjs/actions/dist/src/queue/work.js',
  ]

  const entry = candidates.map(candidate => resolve(process.cwd(), candidate)).find(existsSync)

  if (!entry)
    throw new Error('Stacks queue worker action was not found in the active release')

  await import(pathToFileURL(entry).href)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
