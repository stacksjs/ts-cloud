/**
 * AWS OpenSearch Types
 * CloudFormation resource types for AWS OpenSearch Service
 */

import type { Tag } from './common'

export interface OpenSearchDomain {
  Type: 'AWS::OpenSearchService::Domain'
  Properties: {
    DomainName?: string
    EngineVersion?: string // e.g., 'OpenSearch_2.11', 'Elasticsearch_7.10'

    // Cluster configuration
    ClusterConfig?: {
      InstanceType?: string // e.g., 't3.small.search', 'm6g.large.search'
      InstanceCount?: number
      DedicatedMasterEnabled?: boolean
      DedicatedMasterType?: string
      DedicatedMasterCount?: number
      ZoneAwarenessEnabled?: boolean
      ZoneAwarenessConfig?: {
        AvailabilityZoneCount?: number
      }
      WarmEnabled?: boolean
      WarmType?: string
      WarmCount?: number
      ColdStorageOptions?: {
        Enabled?: boolean
      }
    }

    // Storage
    EBSOptions?: {
      EBSEnabled?: boolean
      VolumeType?: 'gp2' | 'gp3' | 'io1' | 'standard'
      VolumeSize?: number // in GiB
      Iops?: number
      Throughput?: number
    }

    // Access control
    AccessPolicies?: Record<string, any> | string

    // Encryption
    EncryptionAtRestOptions?: {
      Enabled?: boolean
      KmsKeyId?: string | { Ref: string }
    }
    NodeToNodeEncryptionOptions?: {
      Enabled?: boolean
    }
    DomainEndpointOptions?: {
      EnforceHTTPS?: boolean
      TLSSecurityPolicy?: 'Policy-Min-TLS-1-0-2019-07' | 'Policy-Min-TLS-1-2-2019-07'
      CustomEndpointEnabled?: boolean
      CustomEndpoint?: string
      CustomEndpointCertificateArn?: string | { Ref: string }
    }

    // Advanced security
    AdvancedSecurityOptions?: {
      Enabled?: boolean
      InternalUserDatabaseEnabled?: boolean
      MasterUserOptions?: {
        MasterUserARN?: string | { Ref: string }
        MasterUserName?: string
        MasterUserPassword?: string
      }
      SAMLOptions?: {
        Enabled?: boolean
        Idp?: {
          EntityId: string
          MetadataContent: string
        }
        MasterBackendRole?: string
        MasterUserName?: string
        RolesKey?: string
        SessionTimeoutMinutes?: number
        SubjectKey?: string
      }
    }

    // VPC configuration
    VPCOptions?: {
      SubnetIds?: Array<string | { Ref: string }>
      SecurityGroupIds?: Array<string | { Ref: string }>
    }

    // Snapshot configuration
    SnapshotOptions?: {
      AutomatedSnapshotStartHour?: number
    }

    // Advanced options
    AdvancedOptions?: Record<string, string>

    // Logging
    LogPublishingOptions?: {
      [key: string]: {
        CloudWatchLogsLogGroupArn: string | { Ref: string }
        Enabled?: boolean
      }
    }

    // Auto-Tune
    AutoTuneOptions?: {
      DesiredState?: 'ENABLED' | 'DISABLED'
      MaintenanceSchedules?: Array<{
        StartAt?: string
        Duration?: {
          Value?: number
          Unit?: 'HOURS'
        }
        CronExpressionForRecurrence?: string
      }>
    }

    // Software update options
    SoftwareUpdateOptions?: {
      AutoSoftwareUpdateEnabled?: boolean
    }

    // Off-peak window
    OffPeakWindowOptions?: {
      Enabled?: boolean
      OffPeakWindow?: {
        WindowStartTime?: {
          Hours: number
          Minutes: number
        }
      }
    }

    Tags?: Tag[]
  }
  DeletionPolicy?: 'Delete' | 'Retain' | 'Snapshot'
  UpdateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot'
}

export interface OpenSearchDomainPolicy {
  Type: 'AWS::OpenSearchService::DomainPolicy'
  Properties: {
    DomainName: string | { Ref: string }
    AccessPolicies: Record<string, any> | string
  }
}
