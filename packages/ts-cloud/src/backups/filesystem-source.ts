import type { QueueExecutionContext } from '../queue'
import type { JsonValue } from '../control-plane'
import type { BackupPolicy, RecoveryPoint } from './model'
import type { BackupSourceAdapter, BackupSourceResult } from './service'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

export interface FilesystemArchiveRuntime {
  create(root: string, paths: string[], excludes: string[]): Promise<Buffer>
  extract(body: Uint8Array, target: string): Promise<void>
  inspect(body: Uint8Array): Promise<{ entries: string[]; bytes: number }>
}

export function compressBackup(
  body: Uint8Array,
  compression: BackupPolicy['compression'],
): Buffer {
  if (compression === 'gzip') return Buffer.from(Bun.gzipSync(Uint8Array.from(body)))
  if (compression === 'zstd') return Buffer.from(Bun.zstdCompressSync(Uint8Array.from(body)))
  return Buffer.from(body)
}

export function decompressBackup(
  body: Uint8Array,
  compression: BackupPolicy['compression'],
): Buffer {
  if (compression === 'gzip') return Buffer.from(Bun.gunzipSync(Uint8Array.from(body)))
  if (compression === 'zstd') return Buffer.from(Bun.zstdDecompressSync(Uint8Array.from(body)))
  return Buffer.from(body)
}

async function tar(
  args: string[],
  input?: Uint8Array,
): Promise<{ stdout: Buffer; stderr: string }> {
  const process = Bun.spawn(['tar', ...args], {
    stdin: input ? Buffer.from(input) : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).text(),
  ])
  if (exitCode !== 0)
    throw new Error(stderr.trim() || `tar exited with status ${exitCode}.`)
  return { stdout: Buffer.from(stdout), stderr }
}

function safeArchiveEntry(value: string): boolean {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '')
  return !!normalized && !normalized.startsWith('/') && !normalized.split('/').includes('..')
}

export class BunFilesystemArchiveRuntime implements FilesystemArchiveRuntime {
  async create(root: string, paths: string[], excludes: string[]): Promise<Buffer> {
    const result = await tar([
      '-C',
      root,
      '-cf',
      '-',
      ...excludes.map((pattern) => `--exclude=${pattern}`),
      '--',
      ...paths,
    ])
    return result.stdout
  }

  async extract(body: Uint8Array, target: string): Promise<void> {
    await mkdir(target, { recursive: true, mode: 0o700 })
    await tar(['-C', target, '-xf', '-'], body)
  }

  async inspect(body: Uint8Array): Promise<{ entries: string[]; bytes: number }> {
    const result = await tar(['-tf', '-'], body),
      entries = result.stdout.toString().split('\n').filter(Boolean)
    if (entries.some((entry) => !safeArchiveEntry(entry)))
      throw new Error('Backup archive contains an unsafe path.')
    return { entries, bytes: body.byteLength }
  }
}

function scopedPath(root: string, value: string): string {
  if (!value.trim()) throw new Error('File backup paths cannot be empty.')
  const absolute = resolve(root, value),
    scoped = relative(root, absolute)
  if (scoped === '..' || scoped.startsWith(`..${sep}`) || scoped === '')
    throw new Error(`File backup path ${value} is outside the project root.`)
  return scoped
}

function targetName(target: Record<string, unknown>): string {
  const value = String(target.targetId ?? target.path ?? '')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/.test(value))
    throw new Error('File restores require a safe target name.')
  return value
}

export class FilesystemBackupSource implements BackupSourceAdapter {
  private readonly root: string
  private readonly restoreRoot: string

  constructor(
    root: string,
    private readonly runtime: FilesystemArchiveRuntime = new BunFilesystemArchiveRuntime(),
    restoreRoot: string = resolve(root, '.ts-cloud', 'restores', 'files'),
  ) {
    this.root = resolve(root)
    this.restoreRoot = resolve(restoreRoot)
  }

  private paths(policy: BackupPolicy): string[] {
    const paths = [...new Set(policy.includePatterns.map((item) => scopedPath(this.root, item)))]
    if (!paths.length) throw new Error('File backup policies require at least one project-relative path.')
    for (const path of paths) {
      if (!existsSync(resolve(this.root, path)))
        throw new Error(`File backup path ${path} was not found.`)
    }
    return paths.filter((path) => !paths.some((parent) => parent !== path && path.startsWith(`${parent}${sep}`)))
  }

  async create(
    policy: BackupPolicy,
    context: QueueExecutionContext,
  ): Promise<BackupSourceResult> {
    const paths = this.paths(policy),
      archive = await this.runtime.create(this.root, paths, policy.excludePatterns),
      inspected = await this.runtime.inspect(archive),
      compression = policy.compression ?? 'none',
      body = compressBackup(archive, compression),
      token = String(context.operation?.id ?? new Date().toISOString())
        .replace(/[^A-Za-z0-9]/g, '')
        .slice(0, 32)
    return {
      mode: 'object',
      key: `${policy.projectId}/files/${token}.tar${compression === 'none' ? '' : compression === 'gzip' ? '.gz' : '.zst'}`,
      body,
      contentType: compression === 'gzip' ? 'application/gzip' : compression === 'zstd' ? 'application/zstd' : 'application/x-tar',
      manifest: {
        archive: 'tar',
        compression,
        sourcePaths: paths,
        excluded: policy.excludePatterns,
        entries: inspected.entries.length,
      },
      toolVersion: 'system-tar',
    }
  }

  async restore(
    point: RecoveryPoint,
    body: Uint8Array | undefined,
    target: Record<string, JsonValue>,
    _context: QueueExecutionContext,
  ): Promise<Record<string, JsonValue>> {
    if (!body) throw new Error('File restore requires an archive payload.')
    const archive = decompressBackup(
      body,
      String(point.manifest.compression ?? 'none') as BackupPolicy['compression'],
    )
    await this.runtime.inspect(archive)
    if (target.restoreMode === 'in_place') {
      const staging = resolve(this.restoreRoot, `.staging-${targetName(target)}`),
        rollback = resolve(this.restoreRoot, `.rollback-${targetName(target)}`),
        paths = Array.isArray(point.manifest.sourcePaths)
          ? point.manifest.sourcePaths.map(String)
          : []
      if (!paths.length) throw new Error('File recovery point has no source path manifest.')
      await rm(staging, { recursive: true, force: true })
      await rm(rollback, { recursive: true, force: true })
      await this.runtime.extract(archive, staging)
      await mkdir(rollback, { recursive: true, mode: 0o700 })
      const replaced: string[] = []
      try {
        for (const path of paths) {
          const live = resolve(this.root, scopedPath(this.root, path)),
            staged = resolve(staging, path),
            previous = resolve(rollback, path)
          await mkdir(resolve(previous, '..'), { recursive: true })
          if (existsSync(live)) await rename(live, previous)
          await mkdir(resolve(live, '..'), { recursive: true })
          await rename(staged, live)
          replaced.push(path)
        }
      } catch (error) {
        for (const path of replaced.reverse()) {
          const live = resolve(this.root, path), previous = resolve(rollback, path)
          await rm(live, { recursive: true, force: true })
          if (existsSync(previous)) await rename(previous, live)
        }
        throw error
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
      await rm(rollback, { recursive: true, force: true })
      return { path: this.root, restoredPaths: paths, inPlace: true }
    }
    const destination = resolve(this.restoreRoot, targetName(target))
    if (existsSync(destination))
      throw new Error('The isolated file restore target already exists.')
    await this.runtime.extract(archive, destination)
    return { path: destination, isolated: true }
  }

  async verify(
    point: RecoveryPoint,
    body: Uint8Array,
    _context: QueueExecutionContext,
  ): Promise<Record<string, JsonValue>> {
    const archive = decompressBackup(
        body,
        String(point.manifest.compression ?? 'none') as BackupPolicy['compression'],
      ),
      inspected = await this.runtime.inspect(archive)
    return {
      archive: 'tar',
      entries: inspected.entries.length,
      uncompressedBytes: inspected.bytes,
    }
  }

  async validateHealth(
    target: Record<string, JsonValue>,
    _context: QueueExecutionContext,
  ): Promise<Record<string, JsonValue>> {
    const path = String(target.path ?? '')
    if (!path || !path.startsWith(`${this.restoreRoot}${sep}`) || !existsSync(path))
      throw new Error('Isolated file restore target was not found.')
    const entries = await readdir(path)
    return { healthy: true, path, topLevelEntries: entries.length }
  }

  async cleanup(
    target: Record<string, JsonValue>,
    _context: QueueExecutionContext,
  ): Promise<void> {
    const name = targetName(target)
    const path = resolve(this.restoreRoot, name)
    if (!path.startsWith(`${this.restoreRoot}${sep}`))
      throw new Error('Refusing to clean a file restore outside the restore root.')
    await rm(path, { recursive: true, force: true })
  }
}
