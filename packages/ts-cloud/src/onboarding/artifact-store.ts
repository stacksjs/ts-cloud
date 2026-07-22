import type { ControlPlaneStore } from '../control-plane'
import type { ApplicationArtifactRecord } from './types'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { inspectApplicationArchive } from './archive'

type Row = Record<string, unknown>
function map(row: Row): ApplicationArtifactRecord { return { id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id), filename: String(row.filename), sha256: String(row.sha256), size: Number(row.size), format: String(row.format) as 'zip' | 'tar', entryCount: Number(row.entry_count), expandedBytes: Number(row.expanded_bytes), createdByActorId: row.created_by_actor_id ? String(row.created_by_actor_id) : undefined, createdAt: String(row.created_at) } }

export class ApplicationArtifactStore {
  private readonly root: string; private readonly idFn: () => string; private readonly nowFn: () => Date
  constructor(private readonly controlPlane: ControlPlaneStore, options: { cwd: string, id?: () => string, now?: () => Date }) { this.root = resolve(options.cwd, '.ts-cloud', 'artifacts'); this.idFn = options.id ?? (() => crypto.randomUUID()); this.nowFn = options.now ?? (() => new Date()) }
  create(input: { organizationId: string, projectId: string, filename: string, bytes: Uint8Array, actorId?: string }): ApplicationArtifactRecord {
    const project = this.controlPlane.getProject(input.projectId); if (!project || project.organizationId !== input.organizationId) throw new Error('Artifact project was not found')
    const filename = basename(input.filename).slice(0, 200); if (!filename || filename !== input.filename) throw new Error('Artifact filename must not contain a path')
    const inspected = inspectApplicationArchive(input.bytes, filename); const sha256 = createHash('sha256').update(input.bytes).digest('hex')
    const existing = this.controlPlane.database.query<Row, [string, string]>('SELECT * FROM application_artifacts WHERE project_id=? AND sha256=?').get(input.projectId, sha256); if (existing) return map(existing)
    const id = this.idFn(); mkdirSync(this.root, { recursive: true, mode: 0o700 }); chmodSync(this.root, 0o700); const path = join(this.root, `${id}.archive`); const temporary = `${path}.partial`
    try { writeFileSync(temporary, input.bytes, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); chmodSync(path, 0o600); this.controlPlane.database.run('INSERT INTO application_artifacts (id, organization_id, project_id, filename, storage_path, sha256, size, format, entry_count, expanded_bytes, created_by_actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, input.organizationId, input.projectId, filename, path, sha256, input.bytes.byteLength, inspected.format, inspected.entries, inspected.expandedBytes, input.actorId ?? null, this.nowFn().toISOString()]) }
    catch (error) { if (existsSync(temporary)) unlinkSync(temporary); if (existsSync(path)) unlinkSync(path); throw error }
    this.controlPlane.appendEvent({ organizationId: input.organizationId, projectId: input.projectId, actorId: input.actorId, type: 'application.artifact.created', payload: { artifactId: id, filename, sha256, size: input.bytes.byteLength, entries: inspected.entries } })
    return this.get(id)!
  }
  get(id: string): ApplicationArtifactRecord | undefined { const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM application_artifacts WHERE id=?').get(id); return row ? map(row) : undefined }
  list(projectId: string): ApplicationArtifactRecord[] { return this.controlPlane.database.query<Row, [string]>('SELECT * FROM application_artifacts WHERE project_id=? ORDER BY created_at DESC').all(projectId).map(map) }
}
