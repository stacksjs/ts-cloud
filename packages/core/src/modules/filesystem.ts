import type {
  EC2SecurityGroup,
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

  /**
   * Create a security group for EFS mount targets
   * Allows NFS traffic (port 2049) from specified sources
   */
  static createEfsSecurityGroup(options: {
    slug: string
    environment: EnvironmentType
    vpcId: string
    sourceSecurityGroupIds?: string[]
    sourceCidrBlocks?: string[]
    description?: string
  }): {
    securityGroup: EC2SecurityGroup
    logicalId: string
  } {
    const {
      slug,
      environment,
      vpcId,
      sourceSecurityGroupIds = [],
      sourceCidrBlocks = [],
      description,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'efs-sg',
    })

    const logicalId = generateLogicalId(resourceName)

    // Build ingress rules
    const ingressRules: any[] = []

    // Add rules for source security groups
    for (const sgId of sourceSecurityGroupIds) {
      ingressRules.push({
        IpProtocol: 'tcp',
        FromPort: 2049,
        ToPort: 2049,
        SourceSecurityGroupId: sgId,
        Description: 'NFS from security group',
      })
    }

    // Add rules for source CIDR blocks
    for (const cidr of sourceCidrBlocks) {
      ingressRules.push({
        IpProtocol: 'tcp',
        FromPort: 2049,
        ToPort: 2049,
        CidrIp: cidr,
        Description: 'NFS from CIDR block',
      })
    }

    const securityGroup: EC2SecurityGroup = {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupName: resourceName,
        GroupDescription: description || `Security group for EFS mount targets - ${slug} ${environment}`,
        VpcId: vpcId,
        SecurityGroupIngress: ingressRules,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    return { securityGroup, logicalId }
  }

  /**
   * Create mount targets across multiple subnets (multi-AZ)
   * Returns all mount targets and their logical IDs
   */
  static createMultiAzMountTargets(
    fileSystemLogicalId: string,
    options: {
      slug: string
      environment: EnvironmentType
      subnetIds: string[]
      securityGroupId: string
    },
  ): {
    mountTargets: EFSMountTarget[]
    logicalIds: string[]
  } {
    const { slug, environment, subnetIds, securityGroupId } = options

    const mountTargets: EFSMountTarget[] = []
    const logicalIds: string[] = []

    for (let i = 0; i < subnetIds.length; i++) {
      const subnetId = subnetIds[i]
      const resourceName = generateResourceName({
        slug,
        environment,
        resourceType: 'efs-mt',
      })

      const logicalId = generateLogicalId(`${resourceName}-az${i + 1}`)

      const mountTarget: EFSMountTarget = {
        Type: 'AWS::EFS::MountTarget',
        Properties: {
          FileSystemId: Fn.Ref(fileSystemLogicalId),
          SubnetId: subnetId,
          SecurityGroups: [securityGroupId],
        },
      }

      mountTargets.push(mountTarget)
      logicalIds.push(logicalId)
    }

    return { mountTargets, logicalIds }
  }

  /**
   * Create a complete EFS setup with security group and mount targets
   */
  static createCompleteFileSystem(options: {
    slug: string
    environment: EnvironmentType
    vpcId: string
    subnetIds: string[]
    sourceSecurityGroupIds?: string[]
    encrypted?: boolean
    performanceMode?: 'generalPurpose' | 'maxIO'
    throughputMode?: 'bursting' | 'provisioned' | 'elastic'
    enableBackup?: boolean
    transitionToIA?: 7 | 14 | 30 | 60 | 90
  }): {
    resources: Record<string, any>
    outputs: {
      fileSystemId: string
      securityGroupId: string
      mountTargetIds: string[]
    }
  } {
    const {
      slug,
      environment,
      vpcId,
      subnetIds,
      sourceSecurityGroupIds = [],
      encrypted = true,
      performanceMode = 'generalPurpose',
      throughputMode = 'elastic',
      enableBackup = true,
      transitionToIA,
    } = options

    const resources: Record<string, any> = {}

    // Create file system
    const { fileSystem, logicalId: fsLogicalId } = FileSystem.createFileSystem({
      slug,
      environment,
      encrypted,
      performanceMode,
      throughputMode,
      enableBackup,
    })

    // Add lifecycle policy if specified
    if (transitionToIA) {
      FileSystem.setLifecyclePolicy(fileSystem, {
        transitionToIA,
        transitionToPrimary: true,
      })
    }

    resources[fsLogicalId] = fileSystem

    // Create security group
    const { securityGroup, logicalId: sgLogicalId } = FileSystem.createEfsSecurityGroup({
      slug,
      environment,
      vpcId,
      sourceSecurityGroupIds,
    })
    resources[sgLogicalId] = securityGroup

    // Create mount targets
    const { mountTargets, logicalIds: mtLogicalIds } = FileSystem.createMultiAzMountTargets(
      fsLogicalId,
      {
        slug,
        environment,
        subnetIds,
        securityGroupId: Fn.Ref(sgLogicalId),
      },
    )

    for (let i = 0; i < mountTargets.length; i++) {
      resources[mtLogicalIds[i]] = mountTargets[i]
    }

    return {
      resources,
      outputs: {
        fileSystemId: fsLogicalId,
        securityGroupId: sgLogicalId,
        mountTargetIds: mtLogicalIds,
      },
    }
  }
}
