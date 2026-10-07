import type { CloudConfig } from '@ts-cloud/core'
import type { FlyCertificate, FlyClient, FlyIpAssignment, FlyMachine, FlyMachineConfig, FlyVolume } from './client'
import { flyIpType } from './client'

/**
 * Deploy an app to Fly.io Machines (stacksjs/stacks#1044).
 *
 * A Fly app runs a container image on Machines: there is no box to provision
 * and nothing to reach over SSH. A deploy converges the app on the config:
 *
 *   1. the app exists in the organization
 *   2. the app's secrets are set, and their version noted, so every Machine
 *      started or updated after this sees them
 *   3. it has a dedicated IPv6 and a shared IPv4, so `<app>.fly.dev` answers
 *   4. each configured region runs `count` Machines on the new image: an
 *      existing one is updated in place under its lease and waited on before
 *      the next, so a rollout that fails stops with the rest still serving; a
 *      missing one is created, with its own volume when one is configured
 *   5. each custom hostname has a certificate requested
 *
 * It never destroys anything. Machines beyond the configured count, or in a
 * region no longer configured, are reported, not removed: a Machine can hold
 * the only copy of a volume's data.
 */

export interface FlyDeployOptions {
  app: string
  org: string
  /** The image to run, already pushed: `registry.fly.io/<app>:<tag>`. */
  image: string
  regions: string[]
  count: number
  internalPort: number
  healthPath: string
  vm: { cpuKind: 'shared' | 'performance', cpus: number, memoryMb: number }
  volume?: { name: string, sizeGb: number, path: string }
  autoStop: boolean
  /** Plain environment, visible in the Machine config. */
  env: Record<string, string>
  /** Set as Fly secrets: encrypted at rest and never in the Machine config. */
  secrets: Record<string, string>
  hostnames: string[]
  /** The release this deploy is of (a commit sha), recorded on each Machine. */
  release: string
}

export interface FlyDeployResult {
  app: string
  url: string
  createdApp: boolean
  created: string[]
  updated: string[]
  /** Machines the config no longer accounts for, left running. */
  untouched: string[]
  ips: FlyIpAssignment[]
  certificates: FlyCertificate[]
}

const ROLE = 'ts-cloud-role'

/** The deploy options a `cloud.provider: 'fly'` config describes, defaults filled in. */
export function flyDeployOptions(
  config: CloudConfig,
  input: { environment: string, image: string, release: string, env?: Record<string, string>, secrets?: Record<string, string> },
): FlyDeployOptions {
  const fly = config.fly ?? {}
  const app = fly.app ?? `${config.project.slug}-${input.environment}`
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(app))
    throw new Error(`"${app}" is not a valid Fly app name: lowercase letters, digits and dashes, 3 to 63 characters.`)
  const internalPort = fly.internalPort ?? 3000
  const count = fly.count ?? 1
  if (!Number.isInteger(count) || count < 1)
    throw new Error(`fly.count must be a whole number of at least 1, got ${count}.`)
  return {
    app,
    org: fly.org ?? 'personal',
    image: input.image,
    regions: fly.regions?.length ? fly.regions : ['iad'],
    count,
    internalPort,
    healthPath: fly.healthPath ?? '/',
    vm: { cpuKind: fly.vm?.cpuKind ?? 'shared', cpus: fly.vm?.cpus ?? 1, memoryMb: fly.vm?.memoryMb ?? 512 },
    ...(fly.volume ? { volume: { name: fly.volume.name ?? 'data', sizeGb: fly.volume.sizeGb, path: fly.volume.path } } : {}),
    autoStop: fly.autoStop ?? false,
    env: { ...input.env, PORT: String(internalPort) },
    secrets: input.secrets ?? {},
    hostnames: fly.hostnames ?? [],
    release: input.release,
  }
}

/** The Machine config a deploy runs, before any volume is attached. */
export function flyMachineConfig(options: FlyDeployOptions): FlyMachineConfig {
  return {
    image: options.image,
    env: options.env,
    guest: { cpu_kind: options.vm.cpuKind, cpus: options.vm.cpus, memory_mb: options.vm.memoryMb },
    services: [{
      protocol: 'tcp',
      internal_port: options.internalPort,
      ports: [
        { port: 80, handlers: ['http'], force_https: true },
        { port: 443, handlers: ['tls', 'http'] },
      ],
      autostop: options.autoStop ? 'stop' : 'off',
      autostart: true,
      ...(options.autoStop ? { min_machines_running: 0 } : {}),
      checks: [{ type: 'http', method: 'GET', path: options.healthPath, interval: '15s', timeout: '5s', grace_period: '10s' }],
    }],
    restart: { policy: 'on-failure', max_retries: 10 },
    metadata: { [ROLE]: 'app', 'ts-cloud-release': options.release },
  }
}

export async function deployToFly(client: FlyClient, options: FlyDeployOptions, log: (line: string) => void = () => {}): Promise<FlyDeployResult> {
  let createdApp = false
  if (!(await client.getApp(options.app))) {
    log(`Creating Fly app ${options.app} in ${options.org}`)
    await client.createApp(options.app, options.org)
    createdApp = true
  }

  let secretsVersion: number | undefined
  if (Object.keys(options.secrets).length > 0) {
    secretsVersion = await client.setSecrets(options.app, options.secrets)
    log(`Set ${Object.keys(options.secrets).length} secret(s) (version ${secretsVersion})`)
  }

  const ips = await client.listIpAssignments(options.app)
  const types = new Set(ips.map(flyIpType))
  if (!types.has('v6')) {
    ips.push(await client.assignIp(options.app, 'v6'))
    log('Assigned a dedicated IPv6')
  }
  if (!types.has('v4') && !types.has('shared_v4')) {
    ips.push(await client.assignIp(options.app, 'shared_v4'))
    log('Assigned a shared IPv4')
  }

  const config = flyMachineConfig(options)
  // The app's web Machines: ours, or ones flyctl made in its `app` process
  // group. A worker or database Machine in another group is not ours to roll.
  const machines = (await client.listMachines(options.app)).filter((machine) => {
    const metadata = machine.config?.metadata ?? {}
    if (metadata[ROLE])
      return metadata[ROLE] === 'app'
    return !metadata.fly_process_group || metadata.fly_process_group === 'app'
  })
  const volumes = options.volume ? await client.listVolumes(options.app) : []
  const created: string[] = []
  const updated: string[] = []
  const accounted = new Set<string>()

  for (const region of options.regions) {
    const inRegion = machines.filter(machine => machine.region === region).sort((a, b) => a.id.localeCompare(b.id))
    for (let index = 0; index < options.count; index++) {
      const existing = inRegion[index]
      if (existing) {
        accounted.add(existing.id)
        await updateInPlace(client, options.app, existing, config, secretsVersion)
        updated.push(existing.id)
        log(`Updated ${existing.id} (${region}) to ${options.image}`)
        continue
      }

      const mounts = options.volume ? [{ volume: (await volumeFor(client, options, region, volumes)).id, path: options.volume.path }] : undefined
      const machine = await client.createMachine(options.app, {
        region,
        name: `${options.app}-${region}-${index + 1}`,
        config: { ...config, ...(mounts ? { mounts } : {}) },
        ...(secretsVersion !== undefined ? { min_secrets_version: secretsVersion } : {}),
      })
      await client.waitForState(options.app, machine.id, 'started', { instanceId: machine.instance_id })
      created.push(machine.id)
      log(`Created ${machine.id} in ${region}`)
    }
  }

  const certificates: FlyCertificate[] = []
  for (const hostname of options.hostnames)
    certificates.push(await client.requestCertificate(options.app, hostname))

  return {
    app: options.app,
    url: `https://${options.app}.fly.dev`,
    createdApp,
    created,
    updated,
    untouched: machines.filter(machine => !accounted.has(machine.id)).map(machine => machine.id),
    ips,
    certificates,
  }
}

/**
 * Update one Machine under its lease and wait for it to start on the new
 * config, so no other deploy changes it meanwhile and the next Machine is
 * only touched once this one is serving. It keeps the volume it has.
 */
async function updateInPlace(client: FlyClient, app: string, machine: FlyMachine, config: FlyMachineConfig, secretsVersion: number | undefined): Promise<void> {
  const nonce = await client.acquireLease(app, machine.id)
  try {
    const next = await client.updateMachine(app, machine.id, {
      config: { ...config, ...(machine.config?.mounts?.length ? { mounts: machine.config.mounts } : {}) },
      ...(secretsVersion !== undefined ? { min_secrets_version: secretsVersion } : {}),
    }, nonce)
    await client.waitForState(app, machine.id, 'started', { instanceId: next.instance_id })
  }
  finally {
    await client.releaseLease(app, machine.id, nonce)
  }
}

/** An unattached volume of the configured name in the region, or a new one. */
async function volumeFor(client: FlyClient, options: FlyDeployOptions, region: string, volumes: FlyVolume[]): Promise<FlyVolume> {
  const free = volumes.find(volume => volume.region === region && volume.name === options.volume!.name && !volume.attached_machine_id)
  if (free) {
    // Claimed now, so a second Machine in the same region does not take it too.
    free.attached_machine_id = 'pending'
    return free
  }
  const volume = await client.createVolume(options.app, { name: options.volume!.name, region, size_gb: options.volume!.sizeGb })
  volumes.push({ ...volume, attached_machine_id: 'pending' })
  return volume
}
