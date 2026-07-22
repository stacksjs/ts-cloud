export type ControlPlaneId = string

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type OperationState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out'
export type TerminalOperationState = Extract<OperationState, 'succeeded' | 'failed' | 'cancelled' | 'timed_out'>

export interface ControlPlaneProject {
  id: ControlPlaneId
  slug: string
  name: string
  description?: string
  organizationId?: ControlPlaneId
  desiredConfigHash?: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface ControlPlaneEnvironment {
  id: ControlPlaneId
  projectId: ControlPlaneId
  slug: string
  name: string
  kind: string
  region?: string
  desiredState: JsonValue
  discoveredState: JsonValue
  version: number
  createdAt: string
  updatedAt: string
}

export interface ControlPlaneResource {
  id: ControlPlaneId
  projectId: ControlPlaneId
  environmentId?: ControlPlaneId
  kind: string
  slug: string
  name: string
  provider?: string
  providerId?: string
  desiredState: JsonValue
  discoveredState: JsonValue
  metadata: JsonValue
  version: number
  createdAt: string
  updatedAt: string
}

export interface ControlPlaneActor {
  id: ControlPlaneId
  kind: 'user' | 'service_account' | 'system'
  externalId?: string
  displayName: string
  metadata: JsonValue
  disabledAt?: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface ControlPlaneOperation {
  id: ControlPlaneId
  projectId?: ControlPlaneId
  environmentId?: ControlPlaneId
  resourceId?: ControlPlaneId
  actorId?: ControlPlaneId
  kind: string
  state: OperationState
  correlationId: string
  idempotencyKey?: string
  input: JsonValue
  output: JsonValue
  error?: string
  attempt: number
  priority: number
  leaseOwner?: string
  leaseExpiresAt?: string
  cancelRequestedAt?: string
  startedAt?: string
  finishedAt?: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface ControlPlaneEvent {
  id: ControlPlaneId
  sequence: number
  projectId?: ControlPlaneId
  operationId?: ControlPlaneId
  resourceId?: ControlPlaneId
  actorId?: ControlPlaneId
  correlationId: string
  type: string
  level: 'debug' | 'info' | 'warning' | 'error'
  payload: JsonValue
  createdAt: string
}

export interface CreateProjectInput {
  id?: ControlPlaneId
  slug: string
  name: string
  description?: string
  organizationId?: ControlPlaneId
  desiredConfigHash?: string
}

export interface UpdateProjectInput {
  name?: string
  description?: string | null
  organizationId?: ControlPlaneId | null
  desiredConfigHash?: string | null
}

export interface CreateEnvironmentInput {
  id?: ControlPlaneId
  projectId: ControlPlaneId
  slug: string
  name: string
  kind: string
  region?: string
  desiredState?: JsonValue
  discoveredState?: JsonValue
}

export interface CreateResourceInput {
  id?: ControlPlaneId
  projectId: ControlPlaneId
  environmentId?: ControlPlaneId
  kind: string
  slug: string
  name: string
  provider?: string
  providerId?: string
  desiredState?: JsonValue
  discoveredState?: JsonValue
  metadata?: JsonValue
}

export interface UpdateResourceInput {
  name?: string
  provider?: string | null
  providerId?: string | null
  desiredState?: JsonValue
  discoveredState?: JsonValue
  metadata?: JsonValue
}

export interface CreateActorInput {
  id?: ControlPlaneId
  kind: ControlPlaneActor['kind']
  externalId?: string
  displayName: string
  metadata?: JsonValue
}

export interface CreateOperationInput {
  id?: ControlPlaneId
  projectId?: ControlPlaneId
  environmentId?: ControlPlaneId
  resourceId?: ControlPlaneId
  actorId?: ControlPlaneId
  kind: string
  correlationId?: string
  idempotencyKey?: string
  input?: JsonValue
  priority?: number
}

export interface TransitionOperationInput {
  to: OperationState
  expectedVersion?: number
  output?: JsonValue
  error?: string
  leaseOwner?: string
  leaseExpiresAt?: string
}

export interface AppendEventInput {
  id?: ControlPlaneId
  projectId?: ControlPlaneId
  operationId?: ControlPlaneId
  resourceId?: ControlPlaneId
  actorId?: ControlPlaneId
  correlationId?: string
  type: string
  level?: ControlPlaneEvent['level']
  payload?: JsonValue
}

export interface OperationListOptions {
  projectId?: ControlPlaneId
  state?: OperationState
  kind?: string
  limit?: number
  before?: string
}

export interface EventListOptions {
  projectId?: ControlPlaneId
  operationId?: ControlPlaneId
  resourceId?: ControlPlaneId
  correlationId?: string
  afterSequence?: number
  limit?: number
}

export interface ReconcileResult {
  requeued: number
  failed: number
}

export interface CompactResult {
  deletedEvents: number
  deletedOperations: number
  vacuumed: boolean
}

export interface ControlPlaneHealth {
  path: string
  schemaVersion: number
  supportedSchemaVersion: number
  integrity: 'ok' | 'corrupt'
  journalMode: string
  databaseBytes: number
  lastBackupAt?: string
  operations: Record<OperationState, number>
  pendingRetryableOperations: number
}

export interface ControlPlaneSnapshot {
  format: 'ts-cloud-control-plane'
  schemaVersion: number
  exportedAt: string
  projects: ControlPlaneProject[]
  environments: ControlPlaneEnvironment[]
  resources: ControlPlaneResource[]
  actors: ControlPlaneActor[]
  operations: ControlPlaneOperation[]
  events: ControlPlaneEvent[]
  settings: Record<string, JsonValue>
  tags: ControlPlaneTag[]
  resourceTags: Array<{ resourceId: ControlPlaneId, tagId: ControlPlaneId, createdAt: string }>
  savedFilters: SavedFilter[]
  navigationItems: NavigationPreference[]
}

export interface ControlPlaneTag {
  id: ControlPlaneId
  projectId: ControlPlaneId
  name: string
  normalizedName: string
  color: string
  createdAt: string
  updatedAt: string
}

export interface SavedFilter {
  id: ControlPlaneId
  actorKey: string
  name: string
  routeId: string
  query: Record<string, JsonValue>
  createdAt: string
  updatedAt: string
}

export interface NavigationPreference {
  actorKey: string
  entityType: string
  entityId: string
  favorite: boolean
  lastVisitedAt: string
  visitCount: number
}

export interface ControlPlaneStoreOptions {
  cwd?: string
  path?: string
  busyTimeoutMs?: number
  now?: () => Date
  id?: () => string
}

export interface ImportSnapshotOptions {
  replace?: boolean
}

export class OptimisticConcurrencyError extends Error {
  constructor(entity: string, id: string, expectedVersion: number) {
    super(`${entity} ${id} changed since version ${expectedVersion}`)
    this.name = 'OptimisticConcurrencyError'
  }
}

export class InvalidOperationTransitionError extends Error {
  constructor(from: OperationState, to: OperationState) {
    super(`Operation cannot transition from ${from} to ${to}`)
    this.name = 'InvalidOperationTransitionError'
  }
}

export class UnsupportedSchemaVersionError extends Error {
  constructor(actual: number, supported: number) {
    super(`Control-plane schema version ${actual} is newer than supported version ${supported}`)
    this.name = 'UnsupportedSchemaVersionError'
  }
}
