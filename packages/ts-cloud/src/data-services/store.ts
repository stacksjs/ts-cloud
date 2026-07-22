import type { SQLQueryBindings } from 'bun:sqlite'
import type { ControlPlaneStore, JsonValue } from '../control-plane'
import type { DataCredential, DataDependency, DataService } from './model'
import { dataServiceCapabilities } from './capabilities'

type Row = Record<string, unknown>
const optional = (v: unknown) => (v == null ? undefined : String(v)),
  bool = (v: unknown) => Number(v) === 1,
  json = (v: unknown): any => {
    try {
      return JSON.parse(String(v))
    } catch {
      return {}
    }
  }
function service(row: Row): DataService {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    environmentId: optional(row.environment_id),
    resourceId: optional(row.resource_id),
    name: String(row.name),
    engine: String(row.engine) as DataService['engine'],
    provider: String(row.provider) as DataService['provider'],
    placement: String(row.placement),
    engineVersion: optional(row.engine_version),
    plan: String(row.plan),
    storageGb: row.storage_gb == null ? undefined : Number(row.storage_gb),
    highAvailability: bool(row.high_availability),
    publicExposure: bool(row.public_exposure),
    allowedCidrs: json(row.allowed_cidrs),
    desiredState: json(row.desired_state),
    observedState: json(row.observed_state),
    capabilities: json(row.capabilities),
    credentialRef: optional(row.credential_ref),
    status: String(row.status) as DataService['status'],
    origin: String(row.origin) as DataService['origin'],
    managementEnabled: bool(row.management_enabled),
    ownerActorId: optional(row.owner_actor_id),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}
export class DataServiceStore {
  constructor(
    readonly controlPlane: ControlPlaneStore,
    private readonly now: () => Date = () => new Date(),
  ) {}
  create(
    input: Omit<
      DataService,
      'id' | 'capabilities' | 'version' | 'createdAt' | 'updatedAt'
    >,
  ): DataService {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.name))
      throw new Error(
        'Data service names must be 2-63 lowercase letters, numbers, or dashes.',
      )
    if (
      input.publicExposure &&
      (!input.allowedCidrs.length || input.allowedCidrs.includes('0.0.0.0/0'))
    )
      throw new Error(
        'Public exposure requires explicit narrow CIDRs; 0.0.0.0/0 is refused.',
      )
    const id = crypto.randomUUID(),
      now = this.now().toISOString(),
      capabilities = dataServiceCapabilities(input.engine, input.provider)
    this.controlPlane.database.run(
      'INSERT INTO data_services (id,organization_id,project_id,environment_id,resource_id,name,engine,provider,placement,engine_version,plan,storage_gb,high_availability,public_exposure,allowed_cidrs,desired_state,observed_state,capabilities,credential_ref,status,origin,management_enabled,owner_actor_id,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.organizationId,
        input.projectId,
        input.environmentId ?? null,
        input.resourceId ?? null,
        input.name,
        input.engine,
        input.provider,
        input.placement,
        input.engineVersion ?? null,
        input.plan,
        input.storageGb ?? null,
        input.highAvailability ? 1 : 0,
        input.publicExposure ? 1 : 0,
        JSON.stringify(input.allowedCidrs),
        JSON.stringify(input.desiredState),
        JSON.stringify(input.observedState),
        JSON.stringify(capabilities),
        input.credentialRef ?? null,
        input.status,
        input.origin,
        input.managementEnabled ? 1 : 0,
        input.ownerActorId ?? null,
        1,
        now,
        now,
      ],
    )
    return this.get(id)!
  }
  get(id: string): DataService | undefined {
    const row = this.controlPlane.database
      .query<Row, [string]>('SELECT * FROM data_services WHERE id=?')
      .get(id)
    return row ? service(row) : undefined
  }
  list(projectId: string, environmentId?: string): DataService[] {
    return this.controlPlane.database
      .query<Row, SQLQueryBindings[]>(
        `SELECT * FROM data_services WHERE project_id=?${environmentId ? ' AND environment_id=?' : ''} ORDER BY name`,
      )
      .all(projectId, ...(environmentId ? [environmentId] : []))
      .map(service)
  }
  update(
    id: string,
    expectedVersion: number,
    patch: Partial<
      Pick<
        DataService,
        | 'plan'
        | 'storageGb'
        | 'engineVersion'
        | 'highAvailability'
        | 'publicExposure'
        | 'allowedCidrs'
        | 'desiredState'
        | 'observedState'
        | 'status'
        | 'managementEnabled'
        | 'credentialRef'
      >
    >,
  ): DataService {
    const current = this.get(id)
    if (!current) throw new Error('Data service was not found.')
    if (current.version !== expectedVersion)
      throw new Error('Data service changed; refresh before retrying.')
    const next = { ...current, ...patch }
    if (
      next.publicExposure &&
      (!next.allowedCidrs.length || next.allowedCidrs.includes('0.0.0.0/0'))
    )
      throw new Error(
        'Public exposure requires explicit narrow CIDRs; 0.0.0.0/0 is refused.',
      )
    const result = this.controlPlane.database.run(
      'UPDATE data_services SET plan=?,storage_gb=?,engine_version=?,high_availability=?,public_exposure=?,allowed_cidrs=?,desired_state=?,observed_state=?,status=?,management_enabled=?,credential_ref=?,version=version+1,updated_at=? WHERE id=? AND version=?',
      [
        next.plan,
        next.storageGb ?? null,
        next.engineVersion ?? null,
        next.highAvailability ? 1 : 0,
        next.publicExposure ? 1 : 0,
        JSON.stringify(next.allowedCidrs),
        JSON.stringify(next.desiredState),
        JSON.stringify(next.observedState),
        next.status,
        next.managementEnabled ? 1 : 0,
        next.credentialRef ?? null,
        this.now().toISOString(),
        id,
        expectedVersion,
      ],
    )
    if (result.changes !== 1)
      throw new Error('Data service changed; refresh before retrying.')
    return this.get(id)!
  }
  credential(serviceId: string): DataCredential | undefined {
    const row = this.controlPlane.database
      .query<Row, [string]>(
        'SELECT * FROM data_service_credentials WHERE service_id=? ORDER BY version DESC LIMIT 1',
      )
      .get(serviceId)
    return row
      ? {
          id: String(row.id),
          serviceId: String(row.service_id),
          username: String(row.username),
          secretRef: String(row.secret_ref),
          version: Number(row.version),
          createdAt: String(row.created_at),
          rotatedAt: optional(row.rotated_at),
        }
      : undefined
  }
  saveCredential(
    serviceId: string,
    username: string,
    secretRef: string,
  ): DataCredential {
    const current = this.credential(serviceId),
      id = current?.id ?? crypto.randomUUID(),
      now = this.now().toISOString()
    this.controlPlane.database.run(
      'INSERT INTO data_service_credentials (id,service_id,username,secret_ref,version,created_at,rotated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(service_id,username) DO UPDATE SET secret_ref=excluded.secret_ref,version=data_service_credentials.version+1,rotated_at=excluded.rotated_at',
      [
        id,
        serviceId,
        username,
        secretRef,
        current?.version ?? 1,
        current?.createdAt ?? now,
        current ? now : null,
      ],
    )
    return this.credential(serviceId)!
  }
  addDependency(input: Omit<DataDependency, 'createdAt'>): DataDependency {
    const now = this.now().toISOString()
    this.controlPlane.database.run(
      'INSERT INTO data_service_dependencies (service_id,resource_id,secret_ref,requires_redeploy,created_at) VALUES (?,?,?,?,?) ON CONFLICT(service_id,resource_id) DO UPDATE SET secret_ref=excluded.secret_ref,requires_redeploy=excluded.requires_redeploy',
      [
        input.serviceId,
        input.resourceId,
        input.secretRef,
        input.requiresRedeploy ? 1 : 0,
        now,
      ],
    )
    return { ...input, createdAt: now }
  }
  dependencies(serviceId: string): DataDependency[] {
    return this.controlPlane.database
      .query<Row, [string]>(
        'SELECT * FROM data_service_dependencies WHERE service_id=? ORDER BY resource_id',
      )
      .all(serviceId)
      .map((row) => ({
        serviceId: String(row.service_id),
        resourceId: String(row.resource_id),
        secretRef: String(row.secret_ref),
        requiresRedeploy: bool(row.requires_redeploy),
        createdAt: String(row.created_at),
      }))
  }
  removeDependency(serviceId: string, resourceId: string): boolean {
    return (
      this.controlPlane.database.run(
        'DELETE FROM data_service_dependencies WHERE service_id=? AND resource_id=?',
        [serviceId, resourceId],
      ).changes === 1
    )
  }
  remove(id: string): void {
    this.controlPlane.database.run('DELETE FROM data_services WHERE id=?', [id])
  }
}
