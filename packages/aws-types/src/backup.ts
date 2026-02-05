/**
 * AWS Backup Types
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/AWS_Backup.html
*/

import type { Tag } from './common'

/**
 * AWS::Backup::BackupVault
*/
export interface BackupVault {
  Type: 'AWS::Backup::BackupVault'
  Properties: {
    BackupVaultName: string
    BackupVaultTags?: Record<string, string>
    EncryptionKeyArn?: string
    Notifications?: {
      SNSTopicArn: string
      BackupVaultEvents: Array<'BACKUP_JOB_STARTED' | 'BACKUP_JOB_COMPLETED' | 'BACKUP_JOB_SUCCESSFUL' | 'BACKUP_JOB_FAILED' | 'BACKUP_JOB_EXPIRED' | 'RESTORE_JOB_STARTED' | 'RESTORE_JOB_COMPLETED' | 'RESTORE_JOB_SUCCESSFUL' | 'RESTORE_JOB_FAILED' | 'COPY_JOB_STARTED' | 'COPY_JOB_SUCCESSFUL' | 'COPY_JOB_FAILED' | 'RECOVERY_POINT_MODIFIED' | 'BACKUP_PLAN_CREATED' | 'BACKUP_PLAN_MODIFIED' | 'S3_BACKUP_OBJECT_FAILED' | 'S3_RESTORE_OBJECT_FAILED'>
    }
    AccessPolicy?: {
      Version: string
      Statement: Array<{
        Sid?: string
        Effect: 'Allow' | 'Deny'
        Principal: any
        Action: string | string[]
        Resource?: string | string[]
        Condition?: Record<string, any>
      }>
    }
    LockConfiguration?: {
      MinRetentionDays: number
      MaxRetentionDays?: number
      ChangeableForDays?: number
    }
  }
}

/**
 * AWS::Backup::BackupPlan
*/
export interface BackupPlan {
  Type: 'AWS::Backup::BackupPlan'
  Properties: {
    BackupPlan: {
      BackupPlanName: string
      BackupPlanRule: Array<{
        RuleName: string
        TargetBackupVault: string | { Ref: string }
        ScheduleExpression?: string
        ScheduleExpressionTimezone?: string
        StartWindowMinutes?: number
        CompletionWindowMinutes?: number
        Lifecycle?: {
          DeleteAfterDays?: number
          MoveToColdStorageAfterDays?: number
          OptInToArchiveForSupportedResources?: boolean
        }
        RecoveryPointTags?: Record<string, string>
        CopyActions?: Array<{
          DestinationBackupVaultArn: string
          Lifecycle?: {
            DeleteAfterDays?: number
            MoveToColdStorageAfterDays?: number
            OptInToArchiveForSupportedResources?: boolean
          }
        }>
        EnableContinuousBackup?: boolean
      }>
      AdvancedBackupSettings?: Array<{
        BackupOptions: Record<string, string>
        ResourceType: string
      }>
    }
    BackupPlanTags?: Record<string, string>
  }
}

/**
 * AWS::Backup::BackupSelection
*/
export interface BackupSelection {
  Type: 'AWS::Backup::BackupSelection'
  Properties: {
    BackupPlanId: string | { Ref: string }
    BackupSelection: {
      SelectionName: string
      IamRoleArn: string | { 'Fn::GetAtt': [string, string] }
      Resources?: string[]
      ListOfTags?: Array<{
        ConditionType: 'STRINGEQUALS'
        ConditionKey: string
        ConditionValue: string
      }>
      NotResources?: string[]
      Conditions?: {
        StringEquals?: Array<{
          ConditionKey: string
          ConditionValue: string
        }>
        StringNotEquals?: Array<{
          ConditionKey: string
          ConditionValue: string
        }>
        StringLike?: Array<{
          ConditionKey: string
          ConditionValue: string
        }>
        StringNotLike?: Array<{
          ConditionKey: string
          ConditionValue: string
        }>
      }
    }
  }
}

/**
 * AWS::Backup::Framework
*/
export interface BackupFramework {
  Type: 'AWS::Backup::Framework'
  Properties: {
    FrameworkName?: string
    FrameworkDescription?: string
    FrameworkControls: Array<{
      ControlName: string
      ControlInputParameters?: Array<{
        ParameterName: string
        ParameterValue: string
      }>
      ControlScope?: {
        ComplianceResourceIds?: string[]
        ComplianceResourceTypes?: string[]
        Tags?: Array<{
          Key: string
          Value: string
        }>
      }
    }>
    FrameworkTags?: Tag[]
  }
}

/**
 * AWS::Backup::ReportPlan
*/
export interface BackupReportPlan {
  Type: 'AWS::Backup::ReportPlan'
  Properties: {
    ReportPlanName?: string
    ReportPlanDescription?: string
    ReportDeliveryChannel: {
      S3BucketName: string
      S3KeyPrefix?: string
      Formats?: string[]
    }
    ReportSetting: {
      ReportTemplate: string
      FrameworkArns?: string[]
      Accounts?: string[]
      OrganizationUnits?: string[]
      Regions?: string[]
    }
    ReportPlanTags?: Tag[]
  }
}

/**
 * AWS::Backup::BackupVaultNotifications (Legacy)
*/
export interface BackupVaultNotifications {
  Type: 'AWS::Backup::BackupVault'
  Properties: {
    BackupVaultName: string
    SNSTopicArn: string
    BackupVaultEvents: Array<'BACKUP_JOB_STARTED' | 'BACKUP_JOB_COMPLETED' | 'RESTORE_JOB_STARTED' | 'RESTORE_JOB_COMPLETED' | 'COPY_JOB_STARTED' | 'COPY_JOB_SUCCESSFUL' | 'COPY_JOB_FAILED' | 'RECOVERY_POINT_MODIFIED'>
  }
}

export type BackupResource =
  | BackupVault
  | BackupPlan
  | BackupSelection
  | BackupFramework
  | BackupReportPlan
