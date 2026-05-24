import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface HetznerDriverState {
  provider: 'hetzner'
  stackName: string
  serverId: number
  serverName: string
  firewallId?: number
  publicIp?: string
  deployStoragePath?: string
  sshUser?: string
}

const STATE_DIR = '.ts-cloud/state'

export function driverStatePath(stackName: string): string {
  return join(process.cwd(), STATE_DIR, `${stackName}.json`)
}

export async function readDriverState(stackName: string): Promise<HetznerDriverState | null> {
  try {
    const raw = await readFile(driverStatePath(stackName), 'utf8')
    return JSON.parse(raw) as HetznerDriverState
  }
  catch {
    return null
  }
}

export async function writeDriverState(stackName: string, state: HetznerDriverState): Promise<void> {
  const path = driverStatePath(stackName)
  await mkdir(join(process.cwd(), STATE_DIR), { recursive: true })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}
