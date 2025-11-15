import type { CloudFormationResource } from './index'

export interface RDSDBInstance extends CloudFormationResource {
  Type: 'AWS::RDS::DBInstance'
  Properties: {
    DBInstanceIdentifier?: string
    DBInstanceClass: string
    Engine: 'mysql' | 'postgres' | 'mariadb' | 'oracle-ee' | 'oracle-se2' | 'oracle-se1' | 'oracle-se' | 'sqlserver-ee' | 'sqlserver-se' | 'sqlserver-ex' | 'sqlserver-web'
    EngineVersion?: string
    MasterUsername?: string
    MasterUserPassword?: string
    AllocatedStorage?: number
    StorageType?: 'gp2' | 'gp3' | 'io1' | 'io2' | 'standard'
    StorageEncrypted?: boolean
    KmsKeyId?: string
    DBName?: string
    DBSubnetGroupName?: string | { Ref: string }
    VPCSecurityGroups?: string[]
    PubliclyAccessible?: boolean
    BackupRetentionPeriod?: number
    PreferredBackupWindow?: string
    PreferredMaintenanceWindow?: string
    MultiAZ?: boolean
    AutoMinorVersionUpgrade?: boolean
    DeletionProtection?: boolean
    EnableCloudwatchLogsExports?: string[]
    DBParameterGroupName?: string | { Ref: string }
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface RDSDBSubnetGroup extends CloudFormationResource {
  Type: 'AWS::RDS::DBSubnetGroup'
  Properties: {
    DBSubnetGroupName?: string
    DBSubnetGroupDescription: string
    SubnetIds: string[]
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface RDSDBParameterGroup extends CloudFormationResource {
  Type: 'AWS::RDS::DBParameterGroup'
  Properties: {
    DBParameterGroupName?: string
    Description: string
    Family: string
    Parameters?: Record<string, string>
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}
