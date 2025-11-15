import type { CloudFormationResource } from './index'

export interface EFSFileSystem extends CloudFormationResource {
  Type: 'AWS::EFS::FileSystem'
  Properties?: {
    Encrypted?: boolean
    KmsKeyId?: string
    LifecyclePolicies?: Array<{
      TransitionToIA?: 'AFTER_7_DAYS' | 'AFTER_14_DAYS' | 'AFTER_30_DAYS' | 'AFTER_60_DAYS' | 'AFTER_90_DAYS'
      TransitionToPrimaryStorageClass?: 'AFTER_1_ACCESS'
    }>
    PerformanceMode?: 'generalPurpose' | 'maxIO'
    ThroughputMode?: 'bursting' | 'provisioned' | 'elastic'
    ProvisionedThroughputInMibps?: number
    BackupPolicy?: {
      Status: 'ENABLED' | 'DISABLED'
    }
    FileSystemTags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface EFSMountTarget extends CloudFormationResource {
  Type: 'AWS::EFS::MountTarget'
  Properties: {
    FileSystemId: string | { Ref: string }
    SubnetId: string
    SecurityGroups: string[]
    IpAddress?: string
  }
}

export interface EFSAccessPoint extends CloudFormationResource {
  Type: 'AWS::EFS::AccessPoint'
  Properties: {
    FileSystemId: string | { Ref: string }
    PosixUser?: {
      Uid: string
      Gid: string
      SecondaryGids?: string[]
    }
    RootDirectory?: {
      Path?: string
      CreationInfo?: {
        OwnerUid: string
        OwnerGid: string
        Permissions: string
      }
    }
    AccessPointTags?: Array<{
      Key: string
      Value: string
    }>
  }
}
