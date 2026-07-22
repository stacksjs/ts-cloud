/**
 * Deploy lifecycle hooks (`config.hooks`): `beforeBuild` / `afterBuild` /
 * `beforeDeploy` / `afterDeploy`. Each hook is either a shell command (string,
 * run on the deploying machine) or an async function called with the config.
 * Mirrors Forge/Envoyer-style deploy hooks, but they run locally around the
 * `cloud deploy` lifecycle (server-side steps belong in `site.deployScript`).
 */
import type { CloudConfig } from '@ts-cloud/core'
import { execSync } from 'node:child_process'

export type LifecycleHook = string | ((config: CloudConfig) => void | Promise<void>) | undefined

export type HookName = 'beforeBuild' | 'afterBuild' | 'beforeDeploy' | 'afterDeploy'

export interface HookLogger {
  step?: (message: string) => void
  error?: (message: string) => void
}

/**
 * Run a single lifecycle hook. A string is executed as a shell command (inherits
 * stdio, runs in `cwd`); a function is awaited. Throws if a string hook exits
 * non-zero so the caller can abort the deploy. No-op when the hook is unset.
 */
export async function runHook(
  hook: LifecycleHook,
  config: CloudConfig,
  name: HookName,
  logger: HookLogger = {},
  cwd: string = process.cwd(),
): Promise<void> {
  if (!hook) return
  logger.step?.(`Running ${name} hook`)
  if (typeof hook === 'string') {
    execSync(hook, { stdio: 'inherit', cwd })
    return
  }
  await hook(config)
}

/**
 * Run a named hook from `config.hooks`, returning false if a string hook fails
 * (so the deploy command can stop). Logs the failure via `logger.error`.
 */
export async function runConfigHook(
  config: CloudConfig,
  name: HookName,
  logger: HookLogger = {},
  cwd?: string,
): Promise<boolean> {
  try {
    await runHook(config.hooks?.[name], config, name, logger, cwd)
    return true
  } catch (err: any) {
    logger.error?.(`${name} hook failed: ${err?.message || err}`)
    return false
  }
}
