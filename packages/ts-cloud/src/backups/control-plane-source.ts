import type { JsonValue } from '../control-plane'
import type { QueueExecutionContext } from '../queue'
import type { BackupPolicy, RecoveryPoint } from './model'
import type { BackupSourceAdapter, BackupSourceResult } from './service'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'
import { Database } from 'bun:sqlite'
import { ControlPlaneStore } from '../control-plane'
import { compressBackup, decompressBackup } from './filesystem-source'

interface ControlPlaneArchive {
  format: 'ts-cloud-control-plane-v1'
  createdAt: string
  database: string
  config: Array<{ name: string; body: string }>
}

function restoreName(target: Record<string, unknown>): string {
  const value = String(target.targetId ?? target.path ?? '')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/.test(value))
    throw new Error('Control-plane restores require a safe target name.')
  return value
}

function parseArchive(body: Uint8Array): ControlPlaneArchive {
  const parsed = JSON.parse(Buffer.from(body).toString()) as ControlPlaneArchive
  if (parsed.format !== 'ts-cloud-control-plane-v1' || !parsed.database)
    throw new Error('Control-plane backup archive is invalid.')
  if (!Array.isArray(parsed.config) || parsed.config.some((item) => basename(item.name) !== item.name))
    throw new Error('Control-plane backup contains an unsafe config path.')
  return parsed
}

function databaseIntegrity(body: Uint8Array): { integrity: string; tables: number } {
  const database = Database.deserialize(Uint8Array.from(body))
  try {
    const integrity =
        database.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check ?? 'unknown',
      tables =
        database.query<{ count: number }, []>("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get()
          ?.count ?? 0
    if (integrity !== 'ok') throw new Error(`Restored control-plane integrity check failed: ${integrity}.`)
    return { integrity, tables }
  } finally {
    database.close()
  }
}

export class ControlPlaneBackupSource implements BackupSourceAdapter {
  private readonly root: string
  private readonly restoreRoot: string

  constructor(
    private readonly controlPlane: ControlPlaneStore,
    root: string,
    restoreRoot: string = resolve(root, '.ts-cloud', 'restores', 'control-plane'),
  ) {
    this.root = resolve(root)
    this.restoreRoot = resolve(restoreRoot)
  }

  async create(policy: BackupPolicy, context: QueueExecutionContext): Promise<BackupSourceResult> {
    const configured = policy.includePatterns.length ? policy.includePatterns : ['cloud.config.ts'],
      config: ControlPlaneArchive['config'] = []
    for (const value of configured) {
      const name = basename(value),
        path = resolve(this.root, name)
      if (name !== value && value !== `./${name}`)
        throw new Error('Control-plane config paths must be project-root files.')
      if (existsSync(path)) config.push({ name, body: (await readFile(path)).toString('base64') })
    }
    const archive: ControlPlaneArchive = {
        format: 'ts-cloud-control-plane-v1',
        createdAt: new Date().toISOString(),
        database: Buffer.from(this.controlPlane.database.serialize()).toString('base64'),
        config,
      },
      compression = policy.compression ?? 'none',
      body = compressBackup(Buffer.from(JSON.stringify(archive)), compression),
      token = String(context.operation?.id ?? archive.createdAt)
        .replace(/[^A-Za-z0-9]/g, '')
        .slice(0, 32)
    return {
      mode: 'object',
      key: `${policy.projectId}/control-plane/${token}.json${compression === 'none' ? '' : compression === 'gzip' ? '.gz' : '.zst'}`,
      body,
      contentType:
        compression === 'gzip'
          ? 'application/gzip'
          : compression === 'zstd'
            ? 'application/zstd'
            : 'application/vnd.ts-cloud.control-plane+json',
      manifest: {
        format: archive.format,
        configFiles: config.map((item) => item.name),
        sensitive: true,
        compression,
      },
      toolVersion: 'bun-sqlite-serialize',
    }
  }

  async restore(
    point: RecoveryPoint,
    body: Uint8Array | undefined,
    target: Record<string, unknown>,
    _context: QueueExecutionContext,
  ): Promise<Record<string, JsonValue>> {
    if (!body) throw new Error('Control-plane restore requires an archive payload.')
    if (target.restoreMode === 'in_place')
      throw new Error('A live control plane can only be restored into an isolated recovery target.')
    const archive = parseArchive(
        decompressBackup(body, String(point.manifest.compression ?? 'none') as BackupPolicy['compression']),
      ),
      destination = resolve(this.restoreRoot, restoreName(target))
    if (existsSync(destination)) throw new Error('The isolated control-plane restore target already exists.')
    await mkdir(destination, { recursive: true, mode: 0o700 })
    await writeFile(resolve(destination, 'control-plane.sqlite'), Buffer.from(archive.database, 'base64'), {
      mode: 0o600,
    })
    for (const file of archive.config)
      await writeFile(resolve(destination, file.name), Buffer.from(file.body, 'base64'), { mode: 0o600 })
    return { path: destination, isolated: true, configFiles: archive.config.length }
  }

  async verify(
    point: RecoveryPoint,
    body: Uint8Array,
    _context: QueueExecutionContext,
  ): Promise<Record<string, JsonValue>> {
    const archive = parseArchive(
        decompressBackup(body, String(point.manifest.compression ?? 'none') as BackupPolicy['compression']),
      ),
      integrity = databaseIntegrity(Buffer.from(archive.database, 'base64'))
    return { ...integrity, configFiles: archive.config.length }
  }

  async validateHealth(
    target: Record<string, unknown>,
    _context: QueueExecutionContext,
  ): Promise<Record<string, JsonValue>> {
    const path = String(target.path ?? ''),
      databasePath = resolve(path, 'control-plane.sqlite')
    if (!path.startsWith(`${this.restoreRoot}${sep}`) || !existsSync(databasePath))
      throw new Error('Isolated control-plane database was not found.')
    const result = databaseIntegrity(await readFile(databasePath))
    return { healthy: true, ...result }
  }

  async cleanup(target: Record<string, unknown>, _context: QueueExecutionContext): Promise<void> {
    const path = resolve(this.restoreRoot, restoreName(target))
    if (!path.startsWith(`${this.restoreRoot}${sep}`))
      throw new Error('Refusing to clean a control-plane restore outside the restore root.')
    await rm(path, { recursive: true, force: true })
  }
}
