import type { JsonValue } from '../control-plane'
import type { QueueExecutionContext } from '../queue'
import type { BackupPolicy, RecoveryPoint } from './model'
import type { BackupSourceAdapter, BackupSourceResult } from './service'

const validVolume = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/

async function docker(
  args: string[],
  stdin?: Uint8Array,
  allowFailure = false,
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  const process = Bun.spawn(['docker', ...args], {
      stdin: stdin ? 'pipe' : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    }),
    stdout = new Response(process.stdout).arrayBuffer(),
    stderr = new Response(process.stderr).text()
  if (stdin) {
    process.stdin!.write(stdin)
    process.stdin!.end()
  }
  const [code, output, error] = await Promise.all([process.exited, stdout, stderr])
  if (code !== 0 && !allowFailure)
    throw new Error(`Docker volume command failed (${code}): ${error.trim()}`)
  return { code, stdout: Buffer.from(output), stderr: error }
}

export interface DockerVolumeRuntime {
  exists(name: string): Promise<boolean>
  export(name: string): Promise<Uint8Array>
  import(name: string, archive: Uint8Array, replace?: boolean): Promise<void>
  remove(name: string): Promise<void>
  probe(name: string): Promise<{ entries: number; bytes: number }>
}

export class BunDockerVolumeRuntime implements DockerVolumeRuntime {
  async exists(name: string): Promise<boolean> {
    return (await docker(['volume', 'inspect', name], undefined, true)).code === 0
  }
  async export(name: string): Promise<Uint8Array> {
    return (
      await docker([
        'run',
        '--rm',
        '-v',
        `${name}:/source:ro`,
        'alpine:3.21',
        'tar',
        '-C',
        '/source',
        '-czf',
        '-',
        '.',
      ])
    ).stdout
  }
  async import(name: string, archive: Uint8Array, replace = false): Promise<void> {
    if (!(await this.exists(name))) await docker(['volume', 'create', name])
    try {
      if (replace)
        await docker([
          'run',
          '--rm',
          '-v',
          `${name}:/target`,
          'alpine:3.21',
          'sh',
          '-c',
          'find /target -mindepth 1 -delete',
        ])
      await docker(
        [
          'run',
          '--rm',
          '-i',
          '-v',
          `${name}:/target`,
          'alpine:3.21',
          'tar',
          '-C',
          '/target',
          '--no-same-owner',
          '-xzf',
          '-',
        ],
        archive,
      )
    } catch (error) {
      await this.remove(name)
      throw error
    }
  }
  async remove(name: string): Promise<void> {
    await docker(['volume', 'rm', name], undefined, true)
  }
  async probe(name: string): Promise<{ entries: number; bytes: number }> {
    const output = (
        await docker([
          'run',
          '--rm',
          '-v',
          `${name}:/target:ro`,
          'alpine:3.21',
          'sh',
          '-c',
          "find /target -mindepth 1 -printf '%s\\n' | awk '{n+=1;b+=$1} END {print n \":\" b}'",
        ])
      ).stdout.toString(),
      [entries, bytes] = output.trim().split(':').map(Number)
    if (!Number.isFinite(entries) || !Number.isFinite(bytes))
      throw new Error('Restored volume health probe returned invalid output.')
    return { entries, bytes }
  }
}

export class DockerVolumeBackupSource implements BackupSourceAdapter {
  constructor(
    private readonly runtime: DockerVolumeRuntime = new BunDockerVolumeRuntime(),
  ) {}
  async create(
    policy: BackupPolicy,
    _context: QueueExecutionContext,
  ): Promise<BackupSourceResult> {
    const volume = String(policy.resourceId ?? '')
    if (!validVolume.test(volume))
      throw new Error('Volume backups require a valid named-volume resource identifier.')
    if (!(await this.runtime.exists(volume)))
      throw new Error(`Volume ${volume} was not found.`)
    const body = await this.runtime.export(volume),
      timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
    return {
      mode: 'object',
      key: `${policy.projectId}/volumes/${volume}/${timestamp}.tar.gz`,
      body,
      contentType: 'application/gzip',
      toolVersion: 'alpine-tar',
      manifest: { format: 'docker-volume-tar-gzip-v1', sourceVolume: volume },
    }
  }
  async restore(
    point: RecoveryPoint,
    body: Uint8Array | undefined,
    target: Record<string, JsonValue>,
    _context: QueueExecutionContext,
  ): Promise<Record<string, JsonValue>> {
    if (!body) throw new Error('Volume backup body is unavailable.')
    const source = String(point.manifest.sourceVolume ?? point.resourceId ?? ''),
      targetVolume = String(target.volumeName ?? target.targetId ?? '')
    if (!validVolume.test(targetVolume))
      throw new Error('Volume restore requires a valid target volume name.')
    if (targetVolume === source && target.inPlace !== true)
      throw new Error('An isolated volume restore requires a distinct target.')
    const exists = await this.runtime.exists(targetVolume)
    if (!target.inPlace && exists)
      throw new Error(`Restore target volume ${targetVolume} already exists.`)
    if (target.inPlace === true && targetVolume !== source)
      throw new Error('An in-place volume restore must target the source volume.')
    if (target.inPlace === true && !exists)
      throw new Error('The in-place target volume was not found.')
    await this.runtime.import(targetVolume, body, target.inPlace === true)
    const health = await this.runtime.probe(targetVolume)
    return { volumeName: targetVolume, healthy: true, ...health }
  }
  async cleanup(
    target: Record<string, JsonValue>,
    _context: QueueExecutionContext,
  ): Promise<void> {
    if (target.inPlace === true)
      throw new Error('In-place volume restores cannot be cleaned as drills.')
    const targetVolume = String(target.volumeName ?? target.targetId ?? '')
    if (!validVolume.test(targetVolume))
      throw new Error('Volume cleanup requires a valid target volume name.')
    await this.runtime.remove(targetVolume)
  }
}
