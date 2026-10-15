import type { CloudConfig, ComputeConfig, ComputeVolumeConfig, EnvironmentType } from '@ts-cloud/core'
import { computeStorageAgent } from './compute-storage-agent'

export interface ResolvedComputeVolume extends ComputeVolumeConfig {
  key: string
  name: string
}

export interface MountedComputeVolume extends ResolvedComputeVolume {
  id: number
  device: string
  allowFormat: boolean
}

export interface ComputeStoragePolicy {
  volumes: MountedComputeVolume[]
  deploymentStorage?: ComputeConfig['deploymentStorage']
  webRoot: string
}

export const COMPUTE_STORAGE_CONFIG = '/etc/ts-cloud/compute-storage.json'
export const COMPUTE_STORAGE_AGENT = '/usr/local/lib/ts-cloud/compute-storage.mjs'

export function resolveComputeVolumes(config: CloudConfig, environment: EnvironmentType): ResolvedComputeVolume[] {
  const volumes = Object.entries(config.infrastructure?.compute?.volumes ?? {}).map(([key, volume]) => {
    if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new Error(`Invalid compute volume key: ${key}`)
    if (!Number.isInteger(volume.size) || volume.size < 10 || volume.size > 10240)
      throw new Error(`compute.volumes.${key}.size must be a whole number from 10 to 10240 GB`)
    if (!volume.mountPath.startsWith('/') || !volume.mountPath.slice(1).split('/').every(part => /^[\w-]+$/.test(part))
      || volume.mountPath === '/var' || volume.mountPath === '/var/lib'
      || ['/etc', '/usr', '/var/www', '/root', '/boot', '/dev', '/proc', '/sys', '/run', '/bin', '/sbin', '/lib'].some(path => volume.mountPath === path || volume.mountPath.startsWith(`${path}/`)))
      throw new Error(`Unsafe compute volume mount path: ${volume.mountPath}`)
    const name = volume.name ?? `${config.project.slug}-${environment}-${key}`
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new Error(`Invalid compute volume name: ${name}`)
    return { ...volume, key, name, mountPath: volume.mountPath.replace(/\/+$/, '') }
  })
  for (const volume of volumes) {
    if (volumes.some(other => other !== volume && (other.name === volume.name || other.mountPath === volume.mountPath
      || other.mountPath.startsWith(`${volume.mountPath}/`))))
      throw new Error('Compute volumes must have distinct names and non-overlapping mount paths')
  }
  const placement = config.infrastructure?.compute?.deploymentStorage
  if (placement && !volumes.some(volume => volume.key === placement.volume))
    throw new Error(`deploymentStorage.volume references an undeclared compute volume: ${placement.volume}`)
  return volumes
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function buildComputeStorageInstallScript(policy: ComputeStoragePolicy): string[] {
  // Serializing a self-contained typed agent keeps the source testable and
  // ships one Bun program, without runtime Python, package installs or eval of
  // configuration strings. Both source and published bundles use the same body.
  const candidate = `${COMPUTE_STORAGE_CONFIG}.candidate`
  const agent = `#!/usr/bin/env bun\nawait (${computeStorageAgent.toString()})(JSON.parse(await Bun.file(process.env.TS_CLOUD_STORAGE_POLICY || ${JSON.stringify(COMPUTE_STORAGE_CONFIG)}).text()), process.argv.slice(2));\n`
  return [
    'command -v bun >/dev/null 2>&1 || { echo "Configured compute storage requires Bun on the host" >&2; exit 1; }',
    'install -d -m 0755 /etc/ts-cloud /usr/local/lib/ts-cloud /var/lib/ts-cloud',
    `printf %s ${quote(Buffer.from(agent).toString('base64'))} | base64 -d > ${COMPUTE_STORAGE_AGENT}.new`,
    `chmod 0755 ${COMPUTE_STORAGE_AGENT}.new && mv ${COMPUTE_STORAGE_AGENT}.new ${COMPUTE_STORAGE_AGENT}`,
    `printf %s ${quote(JSON.stringify(policy))} > ${candidate}`,
    `chmod 0644 ${candidate}`,
    `TS_CLOUD_STORAGE_POLICY=${candidate} bun ${COMPUTE_STORAGE_AGENT} apply 2>&1 | tee /var/log/ts-cloud-compute-storage.log`,
    `rm -f ${candidate}`,
    `cat > /etc/systemd/system/ts-cloud-storage-check.service <<'TS_CLOUD_STORAGE_SERVICE'`,
    '[Unit]',
    'Description=Check configured compute storage and deployment mounts',
    '[Service]',
    'Type=oneshot',
    `ExecStart=/usr/local/bin/bun ${COMPUTE_STORAGE_AGENT} check`,
    'TS_CLOUD_STORAGE_SERVICE',
    `cat > /etc/systemd/system/ts-cloud-storage-check.timer <<'TS_CLOUD_STORAGE_TIMER'`,
    '[Unit]',
    'Description=Check compute storage every minute',
    '[Timer]',
    'OnBootSec=2min',
    'OnUnitActiveSec=1min',
    '[Install]',
    'WantedBy=timers.target',
    'TS_CLOUD_STORAGE_TIMER',
    'systemctl daemon-reload',
    'systemctl enable --now ts-cloud-storage-check.timer',
    `cat > /etc/systemd/system/ts-cloud-storage-reclaim.service <<'TS_CLOUD_RECLAIM_SERVICE'`,
    '[Unit]',
    'Description=Reclaim inactive root copies of volume-backed deployments',
    '[Service]',
    'Type=oneshot',
    `ExecStart=/usr/local/bin/bun ${COMPUTE_STORAGE_AGENT} reclaim`,
    'Nice=19',
    'IOSchedulingClass=idle',
    'TS_CLOUD_RECLAIM_SERVICE',
    `cat > /etc/systemd/system/ts-cloud-storage-reclaim.timer <<'TS_CLOUD_RECLAIM_TIMER'`,
    '[Unit]',
    'Description=Reclaim retired deployment copies hourly',
    '[Timer]',
    'OnCalendar=hourly',
    'RandomizedDelaySec=5min',
    'Persistent=true',
    '[Install]',
    'WantedBy=timers.target',
    'TS_CLOUD_RECLAIM_TIMER',
    'systemctl daemon-reload',
    'systemctl enable --now ts-cloud-storage-reclaim.timer',
  ]
}

/** Every tenant inherits the owner's policy; omission never overwrites it. */
export function buildComputeStorageSiteScript(appBase: string, slug: string): string[] {
  return [`if [ -f ${COMPUTE_STORAGE_CONFIG} ]; then bun ${COMPUTE_STORAGE_AGENT} ensure-site ${quote(appBase)} ${quote(slug)}; fi`]
}
