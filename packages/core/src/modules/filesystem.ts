import type {
  EFSAccessPoint,
  EFSFileSystem,
  EFSMountTarget,
} from '@ts-cloud/aws-types'
import type { EnvironmentType } from '@ts-cloud/types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface FileSystemOptions {
  slug: string
  environment: EnvironmentType
  encrypted?: boolean
  kmsKeyId?: string
  performanceMode?: 'generalPurpose' | 'maxIO'
  throughputMode?: 'bursting' | 'provisioned' | 'elastic'
  provisionedThroughput?: number
  enableBackup?: boolean
}

export interface MountTargetOptions {
  slug: string
  environment: EnvironmentType
  subnetId: string
  securityGroups: string[]
  ipAddress?: string
}

export interface AccessPointOptions {
  slug: string
  environment: EnvironmentType
  path?: string
  uid?: string
  gid?: string
  permissions?: string
}

export interface LifecyclePolicyOptions {
  transitionToIA?: 7 | 14 | 30 | 60 | 90
  transitionToPrimary?: boolean
}

/**
 * FileSystem Module - EFS (Elastic File System)
 * Provides clean API for creating and configuring shared file systems
 */
export class FileSystem {
  /**
   * Create an EFS file system
   */
  static createFileSystem(options: FileSystemOptions): {
    fileSystem: EFSFileSystem
    logicalId: string
  } {
    const {
      slug,
      environment,
      encrypted = true,
      kmsKeyId,
      performanceMode = 'generalPurpose',
      throughputMode = 'bursting',
      provisionedThroughput,
      enableBackup = true,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'efs',
    })

    const logicalId = generateLogicalId(resourceName)

    const fileSystem: EFSFileSystem = {
      Type: 'AWS::EFS::FileSystem',
      Properties: {
        Encrypted: encrypted,
        PerformanceMode: performanceMode,
        ThroughputMode: throughputMode,
        FileSystemTags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    if (kmsKeyId) {
      fileSystem.Properties!.KmsKeyId = kmsKeyId
    }

    if (throughputMode === 'provisioned' && provisionedThroughput) {
      fileSystem.Properties!.ProvisionedThroughputInMibps = provisionedThroughput
    }

    if (enableBackup) {
      fileSystem.Properties!.BackupPolicy = {
        Status: 'ENABLED',
      }
    }

    return { fileSystem, logicalId }
  }

  /**
   * Create a mount target for multi-AZ access
   */
  static createMountTarget(
    fileSystemLogicalId: string,
    options: MountTargetOptions,
  ): {
      mountTarget: EFSMountTarget
      logicalId: string
    } {
    const {
      slug,
      environment,
      subnetId,
      securityGroups,
      ipAddress,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'efs-mt',
    })

    const logicalId = generateLogicalId(`${resourceName}-${subnetId}`)

    const mountTarget: EFSMountTarget = {
      Type: 'AWS::EFS::MountTarget',
      Properties: {
        FileSystemId: Fn.Ref(fileSystemLogicalId),
        SubnetId: subnetId,
        SecurityGroups: securityGroups,
      },
    }

    if (ipAddress) {
      mountTarget.Properties.IpAddress = ipAddress
    }

    return { mountTarget, logicalId }
  }

  /**
   * Create an access point with POSIX permissions
   */
  static createAccessPoint(
    fileSystemLogicalId: string,
    options: AccessPointOptions,
  ): {
      accessPoint: EFSAccessPoint
      logicalId: string
    } {
    const {
      slug,
      environment,
      path = '/',
      uid = '1000',
      gid = '1000',
      permissions = '755',
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'efs-ap',
    })

    const logicalId = generateLogicalId(`${resourceName}-${path.replace(/\//g, '-')}`)

    const accessPoint: EFSAccessPoint = {
      Type: 'AWS::EFS::AccessPoint',
      Properties: {
        FileSystemId: Fn.Ref(fileSystemLogicalId),
        PosixUser: {
          Uid: uid,
          Gid: gid,
        },
        RootDirectory: {
          Path: path,
          CreationInfo: {
            OwnerUid: uid,
            OwnerGid: gid,
            Permissions: permissions,
          },
        },
        AccessPointTags: [
          { Key: 'Name', Value: `${resourceName}-${path}` },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    return { accessPoint, logicalId }
  }

  /**
   * Set lifecycle policy for cost optimization
   */
  static setLifecyclePolicy(
    fileSystem: EFSFileSystem,
    options: LifecyclePolicyOptions,
  ): EFSFileSystem {
    const { transitionToIA, transitionToPrimary = false } = options

    if (!fileSystem.Properties) {
      fileSystem.Properties = {}
    }

    fileSystem.Properties.LifecyclePolicies = []

    if (transitionToIA) {
      const days = `AFTER_${transitionToIA}_DAYS` as const
      fileSystem.Properties.LifecyclePolicies.push({
        TransitionToIA: days,
      })
    }

    if (transitionToPrimary) {
      fileSystem.Properties.LifecyclePolicies.push({
        TransitionToPrimaryStorageClass: 'AFTER_1_ACCESS',
      })
    }

    return fileSystem
  }

  /**
   * Enable automatic backups
   */
  static enableBackup(fileSystem: EFSFileSystem): EFSFileSystem {
    if (!fileSystem.Properties) {
      fileSystem.Properties = {}
    }

    fileSystem.Properties.BackupPolicy = {
      Status: 'ENABLED',
    }

    return fileSystem
  }

  /**
   * Disable automatic backups
   */
  static disableBackup(fileSystem: EFSFileSystem): EFSFileSystem {
    if (!fileSystem.Properties) {
      fileSystem.Properties = {}
    }

    fileSystem.Properties.BackupPolicy = {
      Status: 'DISABLED',
    }

    return fileSystem
  }

  /**
   * Set provisioned throughput mode
   */
  static setProvisionedThroughput(
    fileSystem: EFSFileSystem,
    throughputInMibps: number,
  ): EFSFileSystem {
    if (!fileSystem.Properties) {
      fileSystem.Properties = {}
    }

    fileSystem.Properties.ThroughputMode = 'provisioned'
    fileSystem.Properties.ProvisionedThroughputInMibps = throughputInMibps

    return fileSystem
  }

  /**
   * Set elastic throughput mode (recommended for most workloads)
   */
  static setElasticThroughput(fileSystem: EFSFileSystem): EFSFileSystem {
    if (!fileSystem.Properties) {
      fileSystem.Properties = {}
    }

    fileSystem.Properties.ThroughputMode = 'elastic'

    return fileSystem
  }

  /**
   * Enable max I/O performance mode (for highly parallelized workloads)
   */
  static enableMaxIO(fileSystem: EFSFileSystem): EFSFileSystem {
    if (!fileSystem.Properties) {
      fileSystem.Properties = {}
    }

    fileSystem.Properties.PerformanceMode = 'maxIO'

    return fileSystem
  }
}
