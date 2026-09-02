/**
 * Where ts-cloud keeps its machine-local state.
 *
 * Everything ts-cloud persists on the machine running a deploy — the dashboard
 * credentials and session secret, the auth encryption key, the control-plane
 * database, the staged dashboard release, cached templates, restore scratch
 * space — lives under one directory. It defaults to a hidden `.ts-cloud/` in
 * the project root, which is the right shape for a standalone project.
 *
 * Projects that already have a home for machine-local state can point it
 * somewhere else instead of ending up with a second state directory in their
 * root. A Stacks application, for example, keeps every runtime-owned directory
 * under `storage/`, so it sets `stateDir: 'storage/cloud'`.
 *
 * Resolution order, highest priority first:
 *
 *  1. `TS_CLOUD_STATE_DIR` — an escape hatch that also survives the process
 *     boundary, so a CLI that shells out keeps every child in agreement.
 *  2. `stateDir` in `cloud.config.ts`, applied by {@link setStateDir} when the
 *     config is loaded.
 *  3. {@link DEFAULT_STATE_DIR}.
 *
 * A relative value is resolved against the project root at the point of use
 * (every state helper takes a `cwd`); an absolute value is used as-is.
 */
import { isAbsolute, join, relative } from 'node:path'

/** The directory used when nothing configures one. */
export const DEFAULT_STATE_DIR = '.ts-cloud'

/** Environment variable that overrides both the config and the default. */
export const STATE_DIR_ENV_VAR = 'TS_CLOUD_STATE_DIR'

let configuredStateDir: string | null = null

/**
 * Records the `stateDir` coming from `cloud.config.ts`.
 *
 * Called by the config loader. Passing a nullish or blank value clears it,
 * which is what a config without `stateDir` should do — otherwise a stale value
 * from a previously loaded config would leak into the next one (tests, and the
 * dashboard server loading configs for several projects).
 */
export function setStateDir(dir?: string | null): void {
  const trimmed = dir?.trim()
  configuredStateDir = trimmed || null
}

/**
 * Whether anything configured the state directory (config or environment).
 *
 * The driver state files predate the configurable directory and have their
 * own legacy home (`storage/cloud/state`, meant to be committed). They only
 * move under the state directory when a project actually chose one, so a
 * standalone project keeps its committed state where it always was.
 */
export function isStateDirConfigured(): boolean {
  return Boolean(process.env[STATE_DIR_ENV_VAR]?.trim() || configuredStateDir)
}

/**
 * The configured state directory, as written — relative or absolute.
 */
export function stateDir(): string {
  const fromEnv = process.env[STATE_DIR_ENV_VAR]?.trim()
  return fromEnv || configuredStateDir || DEFAULT_STATE_DIR
}

/**
 * Joins segments onto the state directory without resolving it against a root.
 *
 * Use this for the exported "where does X live" helpers, whose value is a
 * project-relative path that callers then resolve against their own `cwd`.
 */
export function statePath(...segments: string[]): string {
  return join(stateDir(), ...segments)
}

/**
 * Absolute path to a file or directory inside the state directory.
 *
 * An absolute {@link stateDir} wins over `cwd`, so a project can pin its state
 * to a fixed location regardless of where a command is run from.
 */
export function resolveStatePath(cwd: string, ...segments: string[]): string {
  const dir = stateDir()
  return isAbsolute(dir) ? join(dir, ...segments) : join(cwd, dir, ...segments)
}

/**
 * Whether `path` is the state directory or something inside it.
 *
 * Everything that walks a project to package, hash, or ship it has to skip the
 * state directory: it holds the dashboard credentials and the session key, and
 * a deploy artifact that carries them is a credential leak. A hardcoded
 * `.ts-cloud` check stops being enough the moment the directory is configurable,
 * so ask this instead of comparing names.
 *
 * `path` may be absolute or relative to `root` (the project root, defaulting to
 * the working directory).
 */
export function isStatePath(path: string, root: string = process.cwd()): boolean {
  const inside = (parent: string, child: string): boolean => {
    const rel = relative(parent, child)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
  const absolute = isAbsolute(path) ? path : join(root, path)
  return inside(resolveStatePath(root), absolute)
}
