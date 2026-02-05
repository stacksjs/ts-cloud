/**
 * AWS Athena Types
 * CloudFormation resource types for AWS Athena (log analytics, data querying)
 */

import type { Tag } from './common'

export interface WorkGroup {
  Type: 'AWS::Athena::WorkGroup'
  Properties: {
    Name: string
    Description?: string
    State?: 'ENABLED' | 'DISABLED'

    WorkGroupConfiguration?: {
      // Query result location
      ResultConfiguration?: {
        OutputLocation?: string
        EncryptionConfiguration?: {
          EncryptionOption: 'SSE_S3' | 'SSE_KMS' | 'CSE_KMS'
          KmsKey?: string | { Ref: string }
        }
        ExpectedBucketOwner?: string
        AclConfiguration?: {
          S3AclOption: 'BUCKET_OWNER_FULL_CONTROL'
        }
      }

      // Performance settings
      EnforceWorkGroupConfiguration?: boolean
      PublishCloudWatchMetricsEnabled?: boolean
      BytesScannedCutoffPerQuery?: number
      RequesterPaysEnabled?: boolean

      // Engine version
      EngineVersion?: {
        SelectedEngineVersion?: string
        EffectiveEngineVersion?: string
      }

      // Execution role (for federated queries)
      ExecutionRole?: string | { Ref: string }

      // Additional configurations
      AdditionalConfiguration?: string
      CustomerContentEncryptionConfiguration?: {
        KmsKey: string | { Ref: string }
      }
    }

    Tags?: Tag[]
  }
  DeletionPolicy?: 'Delete' | 'Retain'
  UpdateReplacePolicy?: 'Delete' | 'Retain'
}

export interface DataCatalog {
  Type: 'AWS::Athena::DataCatalog'
  Properties: {
    Name: string
    Type: 'LAMBDA' | 'GLUE' | 'HIVE'
    Description?: string
    Parameters?: Record<string, string>
    Tags?: Tag[]
  }
}

export interface NamedQuery {
  Type: 'AWS::Athena::NamedQuery'
  Properties: {
    Name?: string
    Database: string
    QueryString: string
    Description?: string
    WorkGroup?: string
  }
}

export interface PreparedStatement {
  Type: 'AWS::Athena::PreparedStatement'
  Properties: {
    StatementName: string
    WorkGroup: string
    QueryStatement: string
    Description?: string
  }
  DependsOn?: string | string[]
}

export interface CapacityReservation {
  Type: 'AWS::Athena::CapacityReservation'
  Properties: {
    Name: string
    TargetDpus: number
    CapacityAssignmentConfiguration?: {
      CapacityAssignments?: Array<{
        WorkGroupNames?: string[]
      }>
    }
    Tags?: Tag[]
  }
}
