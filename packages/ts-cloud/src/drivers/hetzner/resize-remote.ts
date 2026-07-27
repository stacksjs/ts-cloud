import type { RemoteExecOptions } from '../shared/remote-exec'
import type { HetznerServerType } from './client'
import type { HetznerResizeVerification } from './resize'
import { sshExecOrThrow, waitForSsh } from '../shared/remote-exec'

export interface HetznerRouteProbe {
  domain: string
  ok: boolean
  status?: number
  error?: string
}

export interface HetznerResizeManifest {
  capturedAt: string
  hostname: string
  cpuCores: number
  memoryBytes: number
  rootSource: string
  rootFsType: string
  rootDiskBytes: number
  rootFilesystemBytes: number
  failedUnits: string[]
  runningServices: string[]
  releaseLinks: string[]
  routeFragments: string[]
  routeIds: string[]
  routeDomains: string[]
  persistentData: string[]
  dataCatalog: string[]
  routeProbes: HetznerRouteProbe[]
}

export interface HetznerRemoteResizeOptions extends RemoteExecOptions {
  host: string
  sshTimeoutMs?: number
  routeTimeoutMs?: number
}

const INVENTORY_SCRIPT = String.raw`
const { readdir, readFile, readlink, stat } = await import('node:fs/promises')

const text = (command) => {
  const result = Bun.spawnSync(['bash', '-lc', command], { stdout: 'pipe', stderr: 'pipe' })
  return result.exitCode === 0 ? result.stdout.toString().trim() : ''
}
const lines = (command) => text(command).split('\n').map(value => value.trim()).filter(Boolean).sort()
const number = (value) => Number.parseInt(value || '0', 10) || 0

const root = text('findmnt -n -o SOURCE,FSTYPE /').split(/\s+/)
const rootSource = root[0] || ''
const rootFsType = root[1] || ''
const rootParent = text('lsblk -n -o PKNAME ' + rootSource + ' | head -1')
const rootDiskBytes = number(text('lsblk -b -n -o SIZE /dev/' + rootParent + ' | head -1'))
const rootFilesystemBytes = number(text("df -B1 --output=size / | tail -1"))
const memoryBytes = number(text("awk '/MemTotal/{print $2 * 1024}' /proc/meminfo"))
const allRunningServices = lines("systemctl list-units --type=service --state=running --no-legend --plain | awk '{print $1}'")
const runningServices = allRunningServices.filter((unit) => {
  if (/^(containerd|docker|localtunnel|mail|mysql|mariadb|meilisearch|postgresql|redis|rpx-gateway)\b/.test(unit)) return true
  const source = text('systemctl cat ' + unit + ' 2>/dev/null')
  return /\/var\/www|\/usr\/local\/bin\/rpx|\/opt\/ts-cloud/.test(source)
})
const failedUnits = lines("systemctl --failed --type=service --no-legend --plain | awk '{print $1}'")
const releaseLinks = []
for (const path of lines("find /var/www -mindepth 2 -maxdepth 2 -type l -name current -print 2>/dev/null")) {
  try {
    releaseLinks.push(path + '=' + await readlink(path))
  } catch {}
}
releaseLinks.sort()

const routeFragments = []
const routeIds = []
const routeDomains = new Set()
for (const path of lines("find /etc/rpx/sites.d -maxdepth 1 -type f -name '*.json' -print 2>/dev/null")) {
  try {
    const source = await readFile(path, 'utf8')
    const digest = new Bun.CryptoHasher('sha256').update(source).digest('hex')
    routeFragments.push(path + '=' + digest)
    const value = JSON.parse(source)
    for (const route of value.proxies || []) {
      if (typeof route.to === 'string' && route.to) {
        routeDomains.add(route.to)
        routeIds.push(path + ':' + (route.id || route.to) + ':' + (route.path || '/'))
      }
    }
  } catch {}
}
routeFragments.sort()
routeIds.sort()

const persistentData = []
for (const path of ['/var/lib/postgresql', '/var/lib/mysql', '/var/lib/redis', '/var/lib/docker', '/var/mail', '/var/vmail']) {
  try {
    const value = await stat(path)
    if (value.isDirectory()) {
      const bytes = number(text('du -sx --block-size=1 ' + path + " 2>/dev/null | awk '{print $1}'"))
      persistentData.push(path + '=' + bytes)
    }
  } catch {}
}

const dataCatalog = []
for (const database of lines("command -v psql >/dev/null && sudo -u postgres psql -Atqc 'select datname from pg_database where datistemplate = false order by datname' 2>/dev/null || true")) {
  dataCatalog.push('postgres:' + database)
}
for (const database of lines("command -v mysql >/dev/null && mysql -NBe 'show databases' 2>/dev/null || true")) {
  dataCatalog.push('mysql:' + database)
}
for (const volume of lines("command -v docker >/dev/null && docker volume ls --format '{{.Name}}' 2>/dev/null || true")) {
  dataCatalog.push('docker-volume:' + volume)
}

console.log(JSON.stringify({
  capturedAt: new Date().toISOString(),
  hostname: text('hostname'),
  cpuCores: number(text('nproc')),
  memoryBytes,
  rootSource,
  rootFsType,
  rootDiskBytes,
  rootFilesystemBytes,
  failedUnits,
  runningServices,
  releaseLinks,
  routeFragments,
  routeIds,
  routeDomains: [...routeDomains].sort(),
  persistentData: persistentData.sort(),
  dataCatalog: dataCatalog.sort(),
}))
`

function remoteBunCommand(script: string): string {
  return `printf %s ${Buffer.from(script).toString('base64')} | base64 -d | bun -`
}

async function collectHostManifest(
  options: HetznerRemoteResizeOptions,
): Promise<Omit<HetznerResizeManifest, 'routeProbes'>> {
  const raw = await sshExecOrThrow(options.host, remoteBunCommand(INVENTORY_SCRIPT), options)
  return JSON.parse(raw) as Omit<HetznerResizeManifest, 'routeProbes'>
}

async function probeRoute(domain: string, timeoutMs: number): Promise<HetznerRouteProbe> {
  let lastError = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    const process = Bun.spawn(
      [
        'curl',
        '--location',
        '--silent',
        '--show-error',
        '--output',
        '/dev/null',
        '--max-time',
        String(Math.max(1, Math.ceil(timeoutMs / 1000))),
        '--write-out',
        '%{http_code}',
        `https://${domain}/`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    const status = Number.parseInt(stdout.trim(), 10)
    if (exitCode === 0 && status > 0) return { domain, ok: status < 500, status }
    lastError = stderr.trim() || `curl exited ${exitCode}`
    if (attempt < 3) await Bun.sleep(500 * attempt)
  }
  return { domain, ok: false, error: lastError }
}

async function probeRoutes(domains: string[], timeoutMs: number): Promise<HetznerRouteProbe[]> {
  const probes: HetznerRouteProbe[] = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(4, domains.length) }, async () => {
    for (;; ) {
      const index = cursor++
      const domain = domains[index]
      if (!domain) return
      probes[index] = await probeRoute(domain, timeoutMs)
    }
  })
  await Promise.all(workers)
  return probes
}

export async function collectHetznerResizeManifest(
  options: HetznerRemoteResizeOptions,
): Promise<HetznerResizeManifest> {
  const host = await collectHostManifest(options)
  const routeProbes = await probeRoutes(host.routeDomains, options.routeTimeoutMs ?? 15_000)
  return { ...host, routeProbes }
}

export async function prepareHetznerResize(
  options: HetznerRemoteResizeOptions,
): Promise<HetznerResizeManifest> {
  const before = await collectHetznerResizeManifest(options)
  const unhealthy = before.routeProbes.filter((probe) => !probe.ok)
  if (before.failedUnits.length > 0) {
    throw new Error(`Preflight found failed services: ${before.failedUnits.join(', ')}`)
  }
  if (unhealthy.length > 0) {
    throw new Error(`Preflight found unhealthy routes: ${unhealthy.map((probe) => probe.domain).join(', ')}`)
  }

  await sshExecOrThrow(
    options.host,
    String.raw`systemctl list-units --type=service --state=running --no-legend --plain | awk '{print $1}' | while read -r unit; do if systemctl cat "$unit" 2>/dev/null | grep -Eq '/var/www|/usr/local/bin/rpx|/opt/ts-cloud'; then systemctl enable "$unit" >/dev/null 2>&1 || true; fi; done; systemctl daemon-reload; sync`,
    options,
  )
  return before
}

function missing(expected: string[], actual: string[]): string[] {
  const values = new Set(actual)
  return expected.filter((value) => !values.has(value))
}

function targetMemoryBytes(target: HetznerServerType): number {
  return Math.floor((target.memory ?? 0) * 1024 * 1024 * 1024)
}

async function expandRootFilesystem(options: HetznerRemoteResizeOptions): Promise<void> {
  await sshExecOrThrow(
    options.host,
    String.raw`set -e
root_source="$(findmnt -n -o SOURCE /)"
root_fs="$(findmnt -n -o FSTYPE /)"
parent="$(lsblk -n -o PKNAME "$root_source" | head -1)"
partition="$(lsblk -n -o PARTN "$root_source" | head -1)"
if [ -n "$parent" ] && [ -n "$partition" ]; then
  growpart "/dev/$parent" "$partition" || true
fi
case "$root_fs" in
  ext2|ext3|ext4) resize2fs "$root_source" ;;
  xfs) xfs_growfs / ;;
  *) echo "Unsupported root filesystem: $root_fs" >&2; exit 1 ;;
esac`,
    options,
  )
}

async function restoreExpectedServices(
  options: HetznerRemoteResizeOptions,
  expected: string[],
): Promise<void> {
  const encoded = Buffer.from(expected.join('\n')).toString('base64')
  await sshExecOrThrow(
    options.host,
    `printf %s ${encoded} | base64 -d | while read -r unit; do [ -z "$unit" ] || systemctl is-active --quiet "$unit" || systemctl start "$unit"; done`,
    options,
  )
}

export async function verifyHetznerResize(
  options: HetznerRemoteResizeOptions,
  target: HetznerServerType,
  before?: HetznerResizeManifest,
  context: { recovered: boolean } = { recovered: false },
): Promise<HetznerResizeVerification> {
  await waitForSsh(options.host, {
    ...options,
    timeoutMs: options.sshTimeoutMs ?? 10 * 60_000,
  })
  if (!context.recovered) await expandRootFilesystem(options)
  if (before) await restoreExpectedServices(options, before.runningServices)

  const after = await collectHetznerResizeManifest(options)
  const failures: string[] = []
  const missingServices = before ? missing(before.runningServices, after.runningServices) : []
  const missingReleases = before ? missing(before.releaseLinks, after.releaseLinks) : []
  const changedRoutes = before ? missing(before.routeFragments, after.routeFragments) : []
  const missingRouteIds = before ? missing(before.routeIds, after.routeIds) : []
  const beforeDataPaths = before?.persistentData.map((value) => value.split('=')[0]!) ?? []
  const afterDataPaths = after.persistentData.map((value) => value.split('=')[0]!)
  const missingDataPaths = missing(beforeDataPaths, afterDataPaths)
  const missingDataCatalog = before ? missing(before.dataCatalog, after.dataCatalog) : []
  const unhealthyRoutes = after.routeProbes.filter((probe) => !probe.ok)
  const expectedCores = context.recovered && before ? before.cpuCores : (target.cores ?? 0)
  const expectedMemory = context.recovered && before ? before.memoryBytes : targetMemoryBytes(target)
  const cpuOk = after.cpuCores >= expectedCores
  const memoryOk = after.memoryBytes >= expectedMemory * 0.9
  const diskOk = context.recovered || after.rootDiskBytes >= (target.disk ?? 0) * 1_000_000_000 * 0.95

  if (after.failedUnits.length > 0) failures.push(`Failed services: ${after.failedUnits.join(', ')}`)
  if (missingServices.length > 0) failures.push(`Services did not return: ${missingServices.join(', ')}`)
  if (missingReleases.length > 0) failures.push(`Release links changed: ${missingReleases.join(', ')}`)
  if (changedRoutes.length > 0) failures.push(`Route manifests changed: ${changedRoutes.join(', ')}`)
  if (missingRouteIds.length > 0) failures.push(`Routes disappeared: ${missingRouteIds.join(', ')}`)
  if (missingDataPaths.length > 0) failures.push(`Persistent data paths disappeared: ${missingDataPaths.join(', ')}`)
  if (missingDataCatalog.length > 0) failures.push(`Databases or volumes disappeared: ${missingDataCatalog.join(', ')}`)
  if (unhealthyRoutes.length > 0)
    failures.push(`Unhealthy routes: ${unhealthyRoutes.map((probe) => probe.domain).join(', ')}`)
  if (!cpuOk) failures.push(`Expected at least ${expectedCores} CPU cores, found ${after.cpuCores}`)
  if (!memoryOk) failures.push(`Expected at least ${expectedMemory} bytes of RAM`)
  if (!diskOk) failures.push(`Expected approximately ${target.disk ?? 0} GB root disk`)

  return {
    ok: failures.length === 0,
    checks: {
      cpuCores: after.cpuCores,
      memoryBytes: after.memoryBytes,
      rootDiskBytes: after.rootDiskBytes,
      rootFilesystemBytes: after.rootFilesystemBytes,
      runningServices: after.runningServices.length,
      releaseLinks: after.releaseLinks.length,
      routeFragments: after.routeFragments.length,
      routes: after.routeIds.length,
      healthyRoutes: after.routeProbes.filter((probe) => probe.ok).length,
      persistentDataPaths: after.persistentData.length,
      databasesAndVolumes: after.dataCatalog.length,
      failedUnits: after.failedUnits.length,
    },
    failures,
  }
}
