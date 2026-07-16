import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface HetznerDriverState {
  provider: 'hetzner'
  stackName: string
  /** Absent after teardown (destroyCompute clears it). */
  serverId?: number
  serverName?: string
  firewallId?: number
  publicIp?: string
  deployStoragePath?: string
  sshUser?: string
  /** Fleet: network/LB ids + the services box private IP, for deploy + teardown. */
  networkId?: number
  loadBalancerId?: number
  servicesServerId?: number
  servicesPrivateIp?: string
  /**
   * Bun+rpx fleet (see `HetznerDriver`'s bun-fleet path): the dedicated rpx
   * load-balancer box (role `lb`) and the N app boxes (role `app`) it fronts.
   * Distinct from {@link loadBalancerId} (a Hetzner-native Load Balancer
   * resource, used by the PHP fleet path) — this is a real server running rpx.
   */
  lbServerId?: number
  appServerIds?: number[]
}

// Deploy state lives under the project's `storage/` tree (the Stacks storage
// convention) rather than a hidden `.ts-cloud/` folder — and, unlike the
// gitignored `storage/framework/`, `storage/cloud/` is meant to be COMMITTED so
// CI (which never has a local .ts-cloud) can resolve the existing box by its
// recorded serverId instead of trying to provision a new one.
export const STATE_DIR = 'storage/cloud/state'

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
