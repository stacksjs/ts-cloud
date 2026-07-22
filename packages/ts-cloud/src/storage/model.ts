import type { JsonValue } from '../control-plane'

export type VolumeType = 'server_path' | 'docker' | 'ebs' | 'efs' | 'provider'
export type VolumeStatus = 'pending' | 'available' | 'attaching' | 'attached' | 'detaching' | 'resizing' | 'snapshotting' | 'orphaned' | 'deleting' | 'deleted' | 'error'
export type VolumeAction = 'create' | 'attach' | 'detach' | 'resize' | 'snapshot' | 'restore' | 'delete' | 'adopt' | 'usage'
export interface VolumeCapability { supported: boolean, reason?: string, online?: boolean, minimumBytes?: number, maximumBytes?: number }
export type VolumeCapabilities = Record<VolumeAction, VolumeCapability>

export interface PersistentVolume {
  id: string
  organizationId: string
  projectId: string
  environmentId?: string
  resourceId?: string
  name: string
  provider: string
  providerId?: string
  type: VolumeType
  status: VolumeStatus
  capacityBytes?: number
  usedBytes?: number
  filesystem?: string
  encrypted: boolean
  capabilities: VolumeCapabilities
  desiredState: Record<string, JsonValue>
  observedState: Record<string, JsonValue>
  backupPolicyId?: string
  lastBackupAt?: string
  orphanedAt?: string
  adoptedAt?: string
  version: number
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export interface VolumeAttachment {
  id: string
  volumeId: string
  resourceId: string
  targetPath: string
  readOnly: boolean
  uid?: number
  gid?: number
  mode?: string
  propagation: 'private' | 'rprivate' | 'shared' | 'rshared' | 'slave' | 'rslave'
  driverOptions: Record<string, JsonValue>
  desiredState: 'attached' | 'detached'
  observedState: 'pending' | 'attached' | 'detached' | 'error'
  operationId?: string
  lastError?: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface VolumeSnapshot {
  id: string
  volumeId: string
  recoveryPointId?: string
  providerId?: string
  name: string
  status: 'pending' | 'available' | 'restoring' | 'deleting' | 'deleted' | 'error'
  sizeBytes?: number
  encrypted: boolean
  checksum?: string
  metadata: Record<string, JsonValue>
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export interface VolumeInventoryItem extends PersistentVolume {
  attachments: VolumeAttachment[]
  snapshots: VolumeSnapshot[]
  orphaned: boolean
  usagePercent?: number
  backupState: 'protected' | 'stale' | 'unprotected'
}

export interface VolumeDriverObservation { providerId: string, capacityBytes?: number, usedBytes?: number, filesystem?: string, encrypted?: boolean, attachedResourceIds?: string[], raw?: Record<string, JsonValue> }
export interface VolumeDriver {
  readonly provider: string
  readonly type: VolumeType
  capabilities(volume?: PersistentVolume): VolumeCapabilities
  discover(projectId: string, environmentId?: string): Promise<VolumeDriverObservation[]>
  create(volume: PersistentVolume): Promise<VolumeDriverObservation>
  attach(volume: PersistentVolume, attachment: VolumeAttachment): Promise<void>
  detach(volume: PersistentVolume, attachment: VolumeAttachment, options: { force: boolean }): Promise<void>
  resize(volume: PersistentVolume, capacityBytes: number): Promise<VolumeDriverObservation>
  snapshot(volume: PersistentVolume, snapshot: VolumeSnapshot): Promise<{ providerId?: string, sizeBytes?: number, checksum?: string }>
  restore(volume: PersistentVolume, snapshot: VolumeSnapshot, target: PersistentVolume): Promise<VolumeDriverObservation>
  delete(volume: PersistentVolume): Promise<void>
  usage(volume: PersistentVolume): Promise<{ usedBytes?: number, capacityBytes?: number }>
}
