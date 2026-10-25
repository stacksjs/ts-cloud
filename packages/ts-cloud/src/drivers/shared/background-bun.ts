import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { basename, delimiter, isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'

/** The opt-in is a release-relative executable, never a command or shell fragment. */
function validateBackgroundBun(value: string): void {
  const segments = value.split('/')
  if (!/^[a-zA-Z0-9_./-]+$/.test(value) || value.startsWith('/')
    || segments.some(segment => !segment || segment === '.' || segment === '..') || segments.at(-1) !== 'bun')
    throw new Error('Stacks backgroundBun must select a safe release-relative Bun executable')
}

export function releaseLocalBunPath(directory: string, selected: string): string {
  validateBackgroundBun(selected)
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(directory) || directory.split('/').includes('..'))
    throw new Error('Stacks backgroundBun requires a safe absolute release directory')
  return `${directory}/${selected}`
}

/** Reject a missing, external or mismatched runtime before importing application work. */
export function validateBackgroundBunRuntime(): void {
  const selected = process.env.TS_CLOUD_BACKGROUND_BUN
  if (selected === undefined) return
  validateBackgroundBun(selected)
  const release = realpathSync(process.cwd())
  const executable = realpathSync(resolve(release, selected))
  const within = relative(release, executable)
  if (!within || isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)
    || basename(executable) !== 'bun' || !statSync(executable).isFile()
    || realpathSync(process.execPath) !== executable)
    throw new Error('The selected background Bun must be the running executable inside this release')
  accessSync(executable, constants.X_OK)
  const firstPath = process.env.PATH?.split(delimiter)[0]
  if (!firstPath || realpathSync(resolve(firstPath, 'bun')) !== executable)
    throw new Error('The selected background Bun must lead the service launch PATH')
}
