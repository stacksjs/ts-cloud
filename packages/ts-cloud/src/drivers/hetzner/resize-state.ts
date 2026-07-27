import type { HetznerResizePhase } from './resize'
import type { HetznerResizeManifest } from './resize-remote'
import { mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { STATE_DIR } from './state'

export interface HetznerResizeCheckpoint {
  schemaVersion: 1
  operationId: string
  stackName: string
  serverId: number
  serverName: string
  sourceType: string
  targetType: string
  upgradeDisk: boolean
  phase: HetznerResizePhase
  status: 'running' | 'waiting-capacity' | 'completed' | 'recovered' | 'failed'
  attempts: number
  startedAt: string
  updatedAt: string
  manifest?: HetznerResizeManifest
  lastError?: string
}

export function resizeCheckpointPath(stackName: string): string {
  return join(process.cwd(), STATE_DIR, `${stackName}-resize.json`)
}

export function resizeLockPath(stackName: string): string {
  return join(process.cwd(), STATE_DIR, `${stackName}-resize.lock`)
}

export async function readResizeCheckpoint(stackName: string): Promise<HetznerResizeCheckpoint | null> {
  try {
    return JSON.parse(await readFile(resizeCheckpointPath(stackName), 'utf8')) as HetznerResizeCheckpoint
  } catch {
    return null
  }
}

export async function writeResizeCheckpoint(checkpoint: HetznerResizeCheckpoint): Promise<void> {
  const path = resizeCheckpointPath(checkpoint.stackName)
  await mkdir(join(process.cwd(), STATE_DIR), { recursive: true })
  const tempPath = `${path}.${process.pid}.tmp`
  await writeFile(tempPath, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8')
  await rename(tempPath, path)
}

export async function acquireResizeLock(
  stackName: string,
  staleAfterMs: number = 30 * 60_000,
): Promise<() => Promise<void>> {
  const path = resizeLockPath(stackName)
  await mkdir(join(process.cwd(), STATE_DIR), { recursive: true })
  try {
    await mkdir(path)
  } catch (error) {
    const age = Date.now() - (await stat(path)).mtimeMs
    if (age <= staleAfterMs) {
      throw new Error(`Another resize process holds ${path}.`)
    }
    await rename(path, `${path}.stale-${Date.now()}`)
    await mkdir(path)
  }
  await writeFile(
    join(path, 'owner.json'),
    `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
  return async () => {
    await unlink(join(path, 'owner.json')).catch(() => {})
    await rmdir(path).catch(() => {})
  }
}
