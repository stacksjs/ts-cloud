import type { JsonValue } from '../control-plane'
import type { SecretBackend } from '../data-services'
import type { QueueExecutionContext } from '../queue'
import type { BackupPolicy, RecoveryPoint } from './model'
import type { BackupSourceAdapter, BackupSourceResult } from './service'
import { DockerDataTransport } from '../data-services'
import { DataServiceStore } from '../data-services/store'

export class LogicalDatabaseBackupSource implements BackupSourceAdapter {
  constructor(
    private readonly services: DataServiceStore,
    private readonly secrets: SecretBackend,
    private readonly transport: DockerDataTransport = new DockerDataTransport(),
  ) {}

  async create(
    policy: BackupPolicy,
    _context: QueueExecutionContext,
  ): Promise<BackupSourceResult> {
    if (!policy.dataServiceId)
      throw new Error('Logical database backups require a data service.')
    const service = this.services.get(policy.dataServiceId)
    if (!service) throw new Error('Logical database service was not found.')
    if (!['container', 'server'].includes(service.provider))
      throw new Error('Logical database backups require an on-box data service.')
    const dump = await this.transport.exportLogicalBackup(service.id),
      timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
    return {
      mode: 'object',
      key: `${policy.projectId}/databases/${service.id}/${timestamp}.sql`,
      body: dump.body,
      contentType: 'application/sql',
      engineVersion: dump.engineVersion,
      toolVersion: 'engine-native',
      manifest: {
        format: 'logical-sql-v1',
        sourceDataServiceId: service.id,
        engine: dump.engine,
        database: dump.database,
        username: dump.username,
      },
    }
  }

  async restore(
    point: RecoveryPoint,
    body: Uint8Array | undefined,
    target: Record<string, JsonValue>,
    _context: QueueExecutionContext,
  ): Promise<Record<string, JsonValue>> {
    if (!body) throw new Error('Logical database backup body is unavailable.')
    const sourceId = String(
        point.dataServiceId ?? point.manifest.sourceDataServiceId ?? '',
      ),
      targetId = String(target.dataServiceId ?? target.targetId ?? ''),
      inPlace = target.inPlace === true
    if (!sourceId || !targetId)
      throw new Error('Logical database restore requires source and target identifiers.')
    if (inPlace && targetId !== sourceId)
      throw new Error('An in-place restore must target the source data service.')
    const source = this.services.get(sourceId)
    if (!source?.credentialRef)
      throw new Error('Logical database credential reference was not found.')
    const credential = await this.secrets.resolve(source.credentialRef)
    return this.transport.restoreLogicalBackup({
      sourceId,
      targetId,
      body,
      credential,
      inPlace,
    })
  }

  async cleanup(
    target: Record<string, JsonValue>,
    _context: QueueExecutionContext,
  ): Promise<void> {
    if (target.inPlace === true)
      throw new Error('In-place database restores cannot be cleaned as drills.')
    const targetId = String(target.dataServiceId ?? target.targetId ?? '')
    if (!targetId) throw new Error('Database cleanup requires a target identifier.')
    await this.transport.removeRestoredService(targetId)
  }
}
