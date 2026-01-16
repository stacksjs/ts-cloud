/**
 * AWS Secrets Manager Types
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/AWS_SecretsManager.html
 */

import type { Tag } from './common'

/**
 * AWS::SecretsManager::Secret
 */
export interface SecretsManagerSecret {
  Type: 'AWS::SecretsManager::Secret'
  Properties: {
    Name?: string
    Description?: string
    SecretString?: string
    GenerateSecretString?: {
      ExcludeCharacters?: string
      ExcludeLowercase?: boolean
      ExcludeNumbers?: boolean
      ExcludePunctuation?: boolean
      ExcludeUppercase?: boolean
      GenerateStringKey?: string
      IncludeSpace?: boolean
      PasswordLength?: number
      RequireEachIncludedType?: boolean
      SecretStringTemplate?: string
    }
    KmsKeyId?: string | { Ref: string } | { 'Fn::GetAtt': [string, string] }
    ReplicaRegions?: Array<{
      Region: string
      KmsKeyId?: string
    }>
    Tags?: Tag[]
  }
  DeletionPolicy?: 'Delete' | 'Retain' | 'Snapshot'
  UpdateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot'
}

/**
 * AWS::SecretsManager::SecretTargetAttachment
 */
export interface SecretsManagerSecretTargetAttachment {
  Type: 'AWS::SecretsManager::SecretTargetAttachment'
  Properties: {
    SecretId: string | { Ref: string }
    TargetId: string | { Ref: string }
    TargetType: 'AWS::RDS::DBInstance' | 'AWS::RDS::DBCluster' | 'AWS::Redshift::Cluster' | 'AWS::DocDB::DBInstance' | 'AWS::DocDB::DBCluster'
  }
}

/**
 * AWS::SecretsManager::RotationSchedule
 */
export interface SecretsManagerRotationSchedule {
  Type: 'AWS::SecretsManager::RotationSchedule'
  Properties: {
    SecretId: string | { Ref: string }
    RotationLambdaARN?: string | { 'Fn::GetAtt': [string, string] }
    RotationRules?: {
      AutomaticallyAfterDays?: number
      Duration?: string
      ScheduleExpression?: string
    }
    HostedRotationLambda?: {
      RotationType: string
      RotationLambdaName?: string
      KmsKeyArn?: string
      MasterSecretArn?: string
      MasterSecretKmsKeyArn?: string
      VpcSecurityGroupIds?: string
      VpcSubnetIds?: string
      ExcludeCharacters?: string
      SuperuserSecretArn?: string
      SuperuserSecretKmsKeyArn?: string
    }
  }
}

/**
 * AWS::SecretsManager::ResourcePolicy
 */
export interface SecretsManagerResourcePolicy {
  Type: 'AWS::SecretsManager::ResourcePolicy'
  Properties: {
    SecretId: string | { Ref: string }
    ResourcePolicy: {
      Version: string
      Statement: Array<{
        Sid?: string
        Effect: 'Allow' | 'Deny'
        Principal: {
          AWS?: string | string[]
          Service?: string | string[]
          Federated?: string
        }
        Action: string | string[]
        Resource?: string | string[]
        Condition?: Record<string, any>
      }>
    }
    BlockPublicPolicy?: boolean
  }
}

export type SecretsManagerResource =
  | SecretsManagerSecret
  | SecretsManagerSecretTargetAttachment
  | SecretsManagerRotationSchedule
  | SecretsManagerResourcePolicy
