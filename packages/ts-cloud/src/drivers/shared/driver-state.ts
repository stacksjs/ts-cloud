/**
 * The per-stack state a compute driver records on the machine running deploys.
 *
 * Every SSH-style driver has to remember which box a stack lives on: Hetzner
 * pins a server id so CI can find the existing box instead of provisioning a
 * duplicate, and the ssh driver pins the host it adopted plus what it did to
 * it. One file per stack, one reader and one writer, so a driver, the
 * dashboard and the CLI cannot disagree about where that file is.
 *
 * ## Where the file lives
 *
 * Driver state predates the configurable state directory and has a legacy
 * home of its own, `storage/cloud/state/` (the Stacks storage convention),
 * which is meant to be COMMITTED: unlike dashboard credentials it holds
 * nothing secret, and a checkout without it re-provisions. A project that
 * configured `stateDir` (or set `TS_CLOUD_STATE_DIR`) keeps driver state
 * under it instead, in `<stateDir>/state/`. A Stacks application sets
 * `stateDir: 'storage/cloud'`, so for it the two spellings name the same
 * directory and nothing moves.
 */
import type { HetznerDriverState } from '../hetzner/state'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isStateDirConfigured, resolveStatePath } from '@ts-cloud/core'

/** The committed driver-state directory used when no state directory is configured. */
export const LEGACY_DRIVER_STATE_DIR = 'storage/cloud/state'

/** What the ssh driver remembers about a host it adopted. */
export interface SshDriverState {
  provider: 'ssh'
  stackName: string
  /** The hostname or address deploys connect to, exactly as configured. */
  host: string
  sshUser: string
  sshPort: number
  /** `SHA256:...` of the pinned host key, when the host-key policy pins. */
  hostKeyFingerprint?: string
  /** The address DNS should point at, when known (configured, or detected). */
  publicIp?: string
  /** The host's first LAN address, as reported by the preflight. */
  lanIp?: string
  deployStoragePath?: string
  profile?: 'raspberry-pi' | 'generic'
  /** The bootstrap recipe version last applied to the host. */
  bootstrapVersion?: number
  /** When that bootstrap ran, ISO 8601. */
  bootstrappedAt?: string
}

export type DriverState = HetznerDriverState | SshDriverState

/**
 * The directory driver state files live in, absolute.
 *
 * `<stateDir>/state` when a state directory is configured, the legacy
 * `storage/cloud/state` otherwise. See the module comment for why the legacy
 * path is not simply `.ts-cloud/state`.
 */
export function driverStateDir(cwd: string = process.cwd()): string {
  return isStateDirConfigured() ? resolveStatePath(cwd, 'state') : join(cwd, LEGACY_DRIVER_STATE_DIR)
}

/** Absolute path of the state file for `stackName`. */
export function driverStatePath(stackName: string, cwd: string = process.cwd()): string {
  return join(driverStateDir(cwd), `${stackName}.json`)
}

/**
 * Read the state file for `stackName`, or null when there is none (or it is
 * unreadable: a corrupt file is treated as absent, and the atomic write below
 * is what keeps that from ever losing a pin).
 */
export async function readDriverState<T extends DriverState = DriverState>(
  stackName: string,
  cwd: string = process.cwd(),
): Promise<T | null> {
  try {
    const raw = await readFile(driverStatePath(stackName, cwd), 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/**
 * Replace the state file for `stackName` atomically: a crash mid-write would
 * corrupt the JSON, and the reader's catch-all would then lose the pinned box
 * (silently re-provisioning a duplicate). Temp file + rename on the same
 * filesystem is atomic.
 */
export async function writeDriverState(stackName: string, state: DriverState, cwd: string = process.cwd()): Promise<void> {
  const path = driverStatePath(stackName, cwd)
  await mkdir(driverStateDir(cwd), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}
