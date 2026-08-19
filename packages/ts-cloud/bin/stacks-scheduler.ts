import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

process.env.APP_ENV ||= 'production'
process.env.NODE_ENV ||= 'production'

async function main(): Promise<void> {
  const candidates = [
    'storage/framework/core/actions/src/schedule/run.ts',
    'node_modules/@stacksjs/actions/src/schedule/run.ts',
    'node_modules/@stacksjs/actions/dist/schedule/run.js',
    'node_modules/@stacksjs/actions/dist/src/schedule/run.js',
  ]

  const entry = candidates.map(candidate => resolve(process.cwd(), candidate)).find(existsSync)

  if (!entry)
    throw new Error('Stacks scheduler action was not found in the active release')

  await import(pathToFileURL(entry).href)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
