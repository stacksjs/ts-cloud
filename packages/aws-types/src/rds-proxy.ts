/**
 * AWS RDS Proxy Types
 * CloudFormation resource types for RDS Proxy (connection pooling)
 */

import type { Tag } from './common'

export interface DBProxy {
  Type: 'AWS::RDS::DBProxy'
  Properties: {
    DBProxyName: string
    EngineFamily: 'MYSQL' | 'POSTGRESQL' | 'SQLSERVER'
    Auth: Array<{
      AuthScheme?: 'SECRETS'
      ClientPasswordAuthType?: 'MYSQL_NATIVE_PASSWORD' | 'POSTGRES_SCRAM_SHA_256' | 'POSTGRES_MD5' | 'SQL_SERVER_AUTHENTICATION'
      Description?: string
      IAMAuth?: 'DISABLED' | 'REQUIRED' | 'ENABLED'
      SecretArn?: string | { Ref: string }
    }>
    RoleArn: string | { Ref: string }
    VpcSubnetIds: Array<string | { Ref: string }>

    // Optional configurations
    VpcSecurityGroupIds?: Array<string | { Ref: string }>
    RequireTLS?: boolean
    IdleClientTimeout?: number // in seconds (default: 1800, max: 28800)
    DebugLogging?: boolean

    Tags?: Tag[]
  }
  DeletionPolicy?: 'Delete' | 'Retain'
  UpdateReplacePolicy?: 'Delete' | 'Retain'
}

export interface DBProxyTargetGroup {
  Type: 'AWS::RDS::DBProxyTargetGroup'
  Properties: {
    DBProxyName: string | { Ref: string }
    TargetGroupName: 'default' // Currently only 'default' is supported
    DBInstanceIdentifiers?: Array<string | { Ref: string }>
    DBClusterIdentifiers?: Array<string | { Ref: string }>

    // Connection pool configuration
    ConnectionPoolConfig?: {
      MaxConnectionsPercent?: number // 1-100 (default: 100)
      MaxIdleConnectionsPercent?: number // 0-MaxConnectionsPercent
      ConnectionBorrowTimeout?: number // in seconds (default: 120)
      SessionPinningFilters?: Array<string> // e.g., ['EXCLUDE_VARIABLE_SETS']
      InitQuery?: string
    }
  }
  DependsOn?: string | string[]
}

export interface DBProxyEndpoint {
  Type: 'AWS::RDS::DBProxyEndpoint'
  Properties: {
    DBProxyName: string | { Ref: string }
    DBProxyEndpointName: string
    VpcSubnetIds: Array<string | { Ref: string }>
    TargetRole?: 'READ_WRITE' | 'READ_ONLY'
    VpcSecurityGroupIds?: Array<string | { Ref: string }>

    Tags?: Tag[]
  }
  DependsOn?: string | string[]
}
