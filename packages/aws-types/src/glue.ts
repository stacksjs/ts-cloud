/**
 * AWS Glue Types
 * CloudFormation resource types for AWS Glue (ETL jobs, data catalog)
 */

import type { Tag } from './common'

export interface Database {
  Type: 'AWS::Glue::Database'
  Properties: {
    CatalogId: string
    DatabaseInput: {
      Name: string
      Description?: string
      LocationUri?: string
      Parameters?: Record<string, string>
    }
  }
}

export interface Table {
  Type: 'AWS::Glue::Table'
  Properties: {
    CatalogId: string
    DatabaseName: string | { Ref: string }
    TableInput: {
      Name: string
      Description?: string
      Owner?: string
      Retention?: number
      StorageDescriptor?: {
        Columns?: Array<{
          Name: string
          Type?: string
          Comment?: string
        }>
        Location?: string
        InputFormat?: string
        OutputFormat?: string
        Compressed?: boolean
        NumberOfBuckets?: number
        SerdeInfo?: {
          Name?: string
          SerializationLibrary?: string
          Parameters?: Record<string, string>
        }
        BucketColumns?: string[]
        SortColumns?: Array<{
          Column: string
          SortOrder: number
        }>
        Parameters?: Record<string, string>
        SkewedInfo?: {
          SkewedColumnNames?: string[]
          SkewedColumnValues?: string[]
          SkewedColumnValueLocationMaps?: Record<string, string>
        }
        StoredAsSubDirectories?: boolean
      }
      PartitionKeys?: Array<{
        Name: string
        Type?: string
        Comment?: string
      }>
      TableType?: string
      Parameters?: Record<string, string>
    }
  }
  DependsOn?: string | string[]
}

export interface Crawler {
  Type: 'AWS::Glue::Crawler'
  Properties: {
    Name?: string
    Role: string | { Ref: string }
    DatabaseName: string | { Ref: string }
    Targets: {
      S3Targets?: Array<{
        Path: string
        Exclusions?: string[]
        ConnectionName?: string
      }>
      JdbcTargets?: Array<{
        ConnectionName: string
        Path: string
        Exclusions?: string[]
      }>
      DynamoDBTargets?: Array<{
        Path: string
      }>
      CatalogTargets?: Array<{
        DatabaseName: string
        Tables: string[]
      }>
    }
    Description?: string
    Schedule?: {
      ScheduleExpression: string
    }
    Classifiers?: string[]
    TablePrefix?: string
    SchemaChangePolicy?: {
      UpdateBehavior?: 'LOG' | 'UPDATE_IN_DATABASE'
      DeleteBehavior?: 'LOG' | 'DELETE_FROM_DATABASE' | 'DEPRECATE_IN_DATABASE'
    }
    Configuration?: string
    CrawlerSecurityConfiguration?: string
    Tags?: Record<string, string>
  }
}

export interface Job {
  Type: 'AWS::Glue::Job'
  Properties: {
    Name?: string
    Role: string | { Ref: string }
    Command: {
      Name: 'glueetl' | 'gluestreaming' | 'pythonshell'
      ScriptLocation: string
      PythonVersion?: '2' | '3'
    }
    AllocatedCapacity?: number
    MaxCapacity?: number
    ExecutionProperty?: {
      MaxConcurrentRuns?: number
    }
    MaxRetries?: number
    Timeout?: number
    GlueVersion?: string
    NumberOfWorkers?: number
    WorkerType?: 'Standard' | 'G.1X' | 'G.2X' | 'G.025X'
    DefaultArguments?: Record<string, string>
    Connections?: {
      Connections?: string[]
    }
    Description?: string
    SecurityConfiguration?: string
    Tags?: Record<string, string>
  }
}

export interface Trigger {
  Type: 'AWS::Glue::Trigger'
  Properties: {
    Name?: string
    Type: 'SCHEDULED' | 'CONDITIONAL' | 'ON_DEMAND'
    Actions: Array<{
      JobName?: string | { Ref: string }
      Arguments?: Record<string, string>
      Timeout?: number
      SecurityConfiguration?: string
      NotificationProperty?: {
        NotifyDelayAfter?: number
      }
      CrawlerName?: string
    }>
    Description?: string
    Schedule?: string // Cron expression
    Predicate?: {
      Logical?: 'AND' | 'ANY'
      Conditions?: Array<{
        LogicalOperator?: 'EQUALS'
        JobName?: string | { Ref: string }
        State?: 'SUCCEEDED' | 'STOPPED' | 'FAILED' | 'TIMEOUT'
        CrawlerName?: string
        CrawlState?: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
      }>
    }
    StartOnCreation?: boolean
    WorkflowName?: string
    Tags?: Record<string, string>
  }
}

export interface Partition {
  Type: 'AWS::Glue::Partition'
  Properties: {
    CatalogId: string
    DatabaseName: string | { Ref: string }
    TableName: string | { Ref: string }
    PartitionInput: {
      Values: string[]
      StorageDescriptor?: {
        Columns?: Array<{
          Name: string
          Type?: string
          Comment?: string
        }>
        Location?: string
        InputFormat?: string
        OutputFormat?: string
        SerdeInfo?: {
          SerializationLibrary?: string
          Parameters?: Record<string, string>
        }
      }
      Parameters?: Record<string, string>
    }
  }
  DependsOn?: string | string[]
}

export interface Connection {
  Type: 'AWS::Glue::Connection'
  Properties: {
    CatalogId: string
    ConnectionInput: {
      Name: string
      Description?: string
      ConnectionType: 'JDBC' | 'SFTP' | 'MONGODB' | 'KAFKA' | 'NETWORK'
      ConnectionProperties: Record<string, string>
      PhysicalConnectionRequirements?: {
        AvailabilityZone?: string
        SecurityGroupIdList?: Array<string | { Ref: string }>
        SubnetId?: string | { Ref: string }
      }
    }
  }
}

export interface SecurityConfiguration {
  Type: 'AWS::Glue::SecurityConfiguration'
  Properties: {
    Name: string
    EncryptionConfiguration: {
      S3Encryptions?: Array<{
        S3EncryptionMode?: 'DISABLED' | 'SSE-KMS' | 'SSE-S3'
        KmsKeyArn?: string | { Ref: string }
      }>
      CloudWatchEncryption?: {
        CloudWatchEncryptionMode?: 'DISABLED' | 'SSE-KMS'
        KmsKeyArn?: string | { Ref: string }
      }
      JobBookmarksEncryption?: {
        JobBookmarksEncryptionMode?: 'DISABLED' | 'CSE-KMS'
        KmsKeyArn?: string | { Ref: string }
      }
    }
  }
}
