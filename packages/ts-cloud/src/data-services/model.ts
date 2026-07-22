import type { JsonValue } from '../control-plane'

export type DataEngine =
  | 'postgres'
  | 'mysql'
  | 'mariadb'
  | 'redis'
  | 'mongodb'
  | 'libsql'
export type DataProvider =
  | 'aws_rds'
  | 'aws_aurora'
  | 'aws_elasticache'
  | 'server'
  | 'container'
  | 'external'
export type DataAction =
  | 'create'
  | 'observe'
  | 'connect'
  | 'backup'
  | 'restore'
  | 'restart'
  | 'resize'
  | 'version'
  | 'rotate'
  | 'expose'
  | 'delete'
  | 'logs'
  | 'slow_queries'
  | 'users'
  | 'databases'
export interface DataActionCapability {
  supported: boolean
  downtime: 'none' | 'possible' | 'required'
  destructive: boolean
  explanation: string
}
export interface DataServiceCapabilities {
  actions: Record<DataAction, DataActionCapability>
  endpointTypes: Array<'internal' | 'external' | 'tunnel'>
  metrics: string[]
}
export interface DataEndpoint {
  type: 'internal' | 'external' | 'tunnel'
  host: string
  port: number
  database?: string
  tls: boolean
}
export interface DataService {
  id: string
  organizationId: string
  projectId: string
  environmentId?: string
  resourceId?: string
  name: string
  engine: DataEngine
  provider: DataProvider
  placement: string
  engineVersion?: string
  plan: string
  storageGb?: number
  highAvailability: boolean
  publicExposure: boolean
  allowedCidrs: string[]
  desiredState: Record<string, JsonValue>
  observedState: Record<string, JsonValue>
  capabilities: DataServiceCapabilities
  credentialRef?: string
  status:
    | 'draft'
    | 'planning'
    | 'provisioning'
    | 'available'
    | 'modifying'
    | 'degraded'
    | 'failed'
    | 'deleting'
    | 'retained'
    | 'adopted'
  origin: 'managed' | 'config' | 'adopted'
  managementEnabled: boolean
  ownerActorId?: string
  version: number
  createdAt: string
  updatedAt: string
}
export interface DataCredential {
  id: string
  serviceId: string
  username: string
  secretRef: string
  version: number
  createdAt: string
  rotatedAt?: string
}
export interface DataDependency {
  serviceId: string
  resourceId: string
  secretRef: string
  requiresRedeploy: boolean
  createdAt: string
}
export interface DataServicePlan {
  service: DataService
  action: DataAction
  capability: DataActionCapability
  changes: Record<string, JsonValue>
  preflight: {
    backupRequired: boolean
    compatibilityRequired: boolean
    typedConfirmation?: string
    retentionChoiceRequired: boolean
  }
  warnings: string[]
}
