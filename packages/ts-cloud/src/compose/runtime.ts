import type { ComposeApplicationManifest } from './types'
import { exportCompose } from './parser'

const SAFE = /^[a-z0-9][a-z0-9_.-]{0,62}$/
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
export function composeProjectName(manifest: ComposeApplicationManifest): string {
  return `${manifest.metadata.slug}-${manifest.metadata.environmentId.slice(0, 8)}`
    .replace(/[^a-z0-9_-]/g, '-')
    .slice(0, 63)
}
export function buildComposeRuntimeCommand(
  manifest: ComposeApplicationManifest,
  action: 'deploy' | 'redeploy' | 'start' | 'stop' | 'delete' | 'status',
  input: { removeVolumes?: boolean; service?: string; replicas?: number } = {},
): string {
  const project = composeProjectName(manifest)
  const directory = `/opt/ts-cloud/compose/${project}`
  const file = `${directory}/compose.yaml`
  const compose = `docker compose --project-name ${quote(project)} --file ${quote(file)}`
  if (input.service && !SAFE.test(input.service)) throw new Error('Unsafe Compose service name')
  if (action === 'deploy' || action === 'redeploy') {
    const encoded = Buffer.from(exportCompose(manifest)).toString('base64')
    return `install -d -m 0750 ${quote(directory)} && printf %s ${quote(encoded)} | base64 --decode > ${quote(file)} && chmod 0640 ${quote(file)} && ${compose} config --quiet && ${compose} up --detach --remove-orphans --wait${action === 'redeploy' ? ' --force-recreate' : ''}`
  }
  if (action === 'start') return `${compose} start${input.service ? ` ${quote(input.service)}` : ''}`
  if (action === 'stop') return `${compose} stop${input.service ? ` ${quote(input.service)}` : ''}`
  if (action === 'status') return `${compose} ps --format json`
  return `${compose} down --remove-orphans${input.removeVolumes ? ' --volumes' : ''}`
}
export function buildComposeScaleCommand(
  manifest: ComposeApplicationManifest,
  service: string,
  replicas: number,
): string {
  if (!SAFE.test(service) || !Number.isInteger(replicas) || replicas < 0 || replicas > 100)
    throw new Error('Scale requires a safe service name and 0-100 replicas')
  const project = composeProjectName(manifest)
  return `docker compose --project-name ${quote(project)} --file ${quote(`/opt/ts-cloud/compose/${project}/compose.yaml`)} up --detach --wait --scale ${quote(`${service}=${replicas}`)}`
}
export function buildComposeLogsCommand(manifest: ComposeApplicationManifest, service: string, lines = 200): string {
  if (!SAFE.test(service)) throw new Error('Unsafe Compose service name')
  const project = composeProjectName(manifest)
  return `docker compose --project-name ${quote(project)} --file ${quote(`/opt/ts-cloud/compose/${project}/compose.yaml`)} logs --no-color --timestamps --tail ${Math.max(1, Math.min(2000, Math.floor(lines)))} ${quote(service)}`
}
export function buildComposeShellCommand(
  manifest: ComposeApplicationManifest,
  service: string,
  command: string[] = ['sh'],
): string {
  if (!SAFE.test(service) || !command.length || command.some((value) => value.includes('\0') || value.length > 1024))
    throw new Error('Unsafe Compose shell request')
  const project = composeProjectName(manifest)
  return `docker compose --project-name ${quote(project)} --file ${quote(`/opt/ts-cloud/compose/${project}/compose.yaml`)} exec ${quote(service)} ${command.map(quote).join(' ')}`
}
