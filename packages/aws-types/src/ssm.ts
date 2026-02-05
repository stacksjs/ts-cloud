/**
 * AWS Systems Manager (SSM) Types
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/AWS_SSM.html
*/

import type { Tag } from './common'

/**
 * AWS::SSM::Parameter
*/
export interface SSMParameter {
  Type: 'AWS::SSM::Parameter'
  Properties: {
    Name?: string
    Type: 'String' | 'StringList' | 'SecureString'
    Value: string
    Description?: string
    AllowedPattern?: string
    DataType?: 'text' | 'aws:ec2:image'
    Tier?: 'Standard' | 'Advanced' | 'Intelligent-Tiering'
    Policies?: string
    Tags?: Record<string, string>
  }
}

/**
 * AWS::SSM::Association
*/
export interface SSMAssociation {
  Type: 'AWS::SSM::Association'
  Properties: {
    Name: string
    AssociationName?: string
    DocumentVersion?: string
    InstanceId?: string
    Parameters?: Record<string, string[]>
    ScheduleExpression?: string
    Targets?: Array<{
      Key: string
      Values: string[]
    }>
    OutputLocation?: {
      S3Location?: {
        OutputS3BucketName?: string
        OutputS3KeyPrefix?: string
        OutputS3Region?: string
      }
    }
    AutomationTargetParameterName?: string
    MaxErrors?: string
    MaxConcurrency?: string
    ComplianceSeverity?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNSPECIFIED'
    SyncCompliance?: 'AUTO' | 'MANUAL'
    WaitForSuccessTimeoutSeconds?: number
    ApplyOnlyAtCronInterval?: boolean
    CalendarNames?: string[]
    ScheduleOffset?: number
  }
}

/**
 * AWS::SSM::Document
*/
export interface SSMDocument {
  Type: 'AWS::SSM::Document'
  Properties: {
    Name?: string
    Content: any
    DocumentType?: 'Command' | 'Policy' | 'Automation' | 'Session' | 'Package' | 'ApplicationConfiguration' | 'ApplicationConfigurationSchema' | 'DeploymentStrategy' | 'ChangeCalendar' | 'Automation.ChangeTemplate' | 'ProblemAnalysis' | 'ProblemAnalysisTemplate' | 'CloudFormation' | 'ConformancePackTemplate' | 'QuickSetup'
    DocumentFormat?: 'YAML' | 'JSON' | 'TEXT'
    TargetType?: string
    VersionName?: string
    Requires?: Array<{
      Name: string
      Version?: string
    }>
    Attachments?: Array<{
      Key?: 'SourceUrl' | 'S3FileUrl' | 'AttachmentReference'
      Name?: string
      Values?: string[]
    }>
    Tags?: Tag[]
    UpdateMethod?: 'Replace' | 'NewVersion'
  }
}

/**
 * AWS::SSM::MaintenanceWindow
*/
export interface SSMMaintenanceWindow {
  Type: 'AWS::SSM::MaintenanceWindow'
  Properties: {
    Name: string
    Description?: string
    AllowUnassociatedTargets: boolean
    Cutoff: number
    Duration: number
    Schedule: string
    ScheduleTimezone?: string
    ScheduleOffset?: number
    StartDate?: string
    EndDate?: string
    Tags?: Tag[]
  }
}

/**
 * AWS::SSM::MaintenanceWindowTarget
*/
export interface SSMMaintenanceWindowTarget {
  Type: 'AWS::SSM::MaintenanceWindowTarget'
  Properties: {
    WindowId: string | { Ref: string }
    ResourceType: 'INSTANCE' | 'RESOURCE_GROUP'
    Targets: Array<{
      Key: string
      Values: string[]
    }>
    OwnerInformation?: string
    Name?: string
    Description?: string
  }
}

/**
 * AWS::SSM::MaintenanceWindowTask
*/
export interface SSMMaintenanceWindowTask {
  Type: 'AWS::SSM::MaintenanceWindowTask'
  Properties: {
    WindowId: string | { Ref: string }
    TaskType: 'RUN_COMMAND' | 'AUTOMATION' | 'LAMBDA' | 'STEP_FUNCTIONS'
    TaskArn: string
    ServiceRoleArn?: string
    Targets?: Array<{
      Key: string
      Values: string[]
    }>
    MaxConcurrency?: string
    MaxErrors?: string
    Priority?: number
    LoggingInfo?: {
      S3Bucket: string
      S3Prefix?: string
      S3Region: string
    }
    Name?: string
    Description?: string
    TaskInvocationParameters?: {
      RunCommand?: {
        Comment?: string
        DocumentHash?: string
        DocumentHashType?: 'Sha256' | 'Sha1'
        NotificationConfig?: {
          NotificationArn?: string
          NotificationEvents?: string[]
          NotificationType?: 'Command' | 'Invocation'
        }
        OutputS3BucketName?: string
        OutputS3KeyPrefix?: string
        Parameters?: Record<string, string[]>
        ServiceRoleArn?: string
        TimeoutSeconds?: number
      }
      Automation?: {
        DocumentVersion?: string
        Parameters?: Record<string, string[]>
      }
      Lambda?: {
        ClientContext?: string
        Payload?: string
        Qualifier?: string
      }
      StepFunctions?: {
        Input?: string
        Name?: string
      }
    }
  }
}

/**
 * AWS::SSM::PatchBaseline
*/
export interface SSMPatchBaseline {
  Type: 'AWS::SSM::PatchBaseline'
  Properties: {
    Name: string
    Description?: string
    OperatingSystem?: 'WINDOWS' | 'AMAZON_LINUX' | 'AMAZON_LINUX_2' | 'UBUNTU' | 'REDHAT_ENTERPRISE_LINUX' | 'SUSE' | 'CENTOS' | 'ORACLE_LINUX' | 'DEBIAN' | 'MACOS'
    ApprovedPatches?: string[]
    ApprovedPatchesComplianceLevel?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL' | 'UNSPECIFIED'
    ApprovedPatchesEnableNonSecurity?: boolean
    RejectedPatches?: string[]
    RejectedPatchesAction?: 'ALLOW_AS_DEPENDENCY' | 'BLOCK'
    ApprovalRules?: {
      PatchRules: Array<{
        PatchFilterGroup: {
          PatchFilters: Array<{
            Key: string
            Values: string[]
          }>
        }
        ComplianceLevel?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL' | 'UNSPECIFIED'
        ApproveAfterDays?: number
        ApproveUntilDate?: string
        EnableNonSecurity?: boolean
      }>
    }
    GlobalFilters?: {
      PatchFilters: Array<{
        Key: string
        Values: string[]
      }>
    }
    Sources?: Array<{
      Name: string
      Products: string[]
      Configuration: string
    }>
    Tags?: Tag[]
  }
}

/**
 * AWS::SSM::ResourceDataSync
*/
export interface SSMResourceDataSync {
  Type: 'AWS::SSM::ResourceDataSync'
  Properties: {
    SyncName: string
    SyncType?: string
    BucketName?: string
    BucketPrefix?: string
    BucketRegion?: string
    KMSKeyArn?: string
    SyncFormat?: string
    S3Destination?: {
      BucketName: string
      BucketPrefix?: string
      BucketRegion: string
      KMSKeyArn?: string
      SyncFormat: string
      DestinationDataSharing?: {
        DestinationDataSharingType: string
      }
    }
    SyncSource?: {
      SourceType: string
      SourceRegions: string[]
      IncludeFutureRegions?: boolean
      AwsOrganizationsSource?: {
        OrganizationSourceType: string
        OrganizationalUnits?: string[]
      }
    }
  }
}

export type SSMResource =
  | SSMParameter
  | SSMAssociation
  | SSMDocument
  | SSMMaintenanceWindow
  | SSMMaintenanceWindowTarget
  | SSMMaintenanceWindowTask
  | SSMPatchBaseline
  | SSMResourceDataSync
