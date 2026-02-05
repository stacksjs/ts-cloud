/**
 * AWS Kinesis Types
 * CloudFormation resource types for AWS Kinesis (data streaming)
 */

import type { Tag } from './common'

export interface Stream {
  Type: 'AWS::Kinesis::Stream'
  Properties: {
    Name?: string
    ShardCount?: number
    RetentionPeriodHours?: number // 24-8760 (1-365 days)

    // Stream mode
    StreamModeDetails?: {
      StreamMode: 'PROVISIONED' | 'ON_DEMAND'
    }

    // Encryption
    StreamEncryption?: {
      EncryptionType: 'KMS'
      KeyId: string | { Ref: string }
    }

    Tags?: Tag[]
  }
  DeletionPolicy?: 'Delete' | 'Retain'
  UpdateReplacePolicy?: 'Delete' | 'Retain'
}

export interface StreamConsumer {
  Type: 'AWS::Kinesis::StreamConsumer'
  Properties: {
    StreamARN: string | { 'Fn::GetAtt': [string, string] }
    ConsumerName: string
  }
  DependsOn?: string | string[]
}

// Kinesis Data Firehose
export interface DeliveryStream {
  Type: 'AWS::KinesisFirehose::DeliveryStream'
  Properties: {
    DeliveryStreamName?: string
    DeliveryStreamType?: 'DirectPut' | 'KinesisStreamAsSource'

    // Source configuration (if Type = KinesisStreamAsSource)
    KinesisStreamSourceConfiguration?: {
      KinesisStreamARN: string | { 'Fn::GetAtt': [string, string] }
      RoleARN: string | { Ref: string }
    }

    // S3 destination
    S3DestinationConfiguration?: {
      BucketARN: string | { 'Fn::GetAtt': [string, string] }
      RoleARN: string | { Ref: string }
      Prefix?: string
      ErrorOutputPrefix?: string
      BufferingHints?: {
        IntervalInSeconds?: number
        SizeInMBs?: number
      }
      CompressionFormat?: 'UNCOMPRESSED' | 'GZIP' | 'ZIP' | 'Snappy' | 'HADOOP_SNAPPY'
      EncryptionConfiguration?: {
        NoEncryptionConfig?: 'NoEncryption'
        KMSEncryptionConfig?: {
          AWSKMSKeyARN: string | { Ref: string }
        }
      }
      CloudWatchLoggingOptions?: {
        Enabled?: boolean
        LogGroupName?: string
        LogStreamName?: string
      }
    }

    // Extended S3 destination
    ExtendedS3DestinationConfiguration?: {
      BucketARN: string | { 'Fn::GetAtt': [string, string] }
      RoleARN: string | { Ref: string }
      Prefix?: string
      ErrorOutputPrefix?: string
      BufferingHints?: {
        IntervalInSeconds?: number
        SizeInMBs?: number
      }
      CompressionFormat?: 'UNCOMPRESSED' | 'GZIP' | 'ZIP' | 'Snappy' | 'HADOOP_SNAPPY'
      EncryptionConfiguration?: {
        NoEncryptionConfig?: 'NoEncryption'
        KMSEncryptionConfig?: {
          AWSKMSKeyARN: string | { Ref: string }
        }
      }
      CloudWatchLoggingOptions?: {
        Enabled?: boolean
        LogGroupName?: string
        LogStreamName?: string
      }
      DataFormatConversionConfiguration?: {
        Enabled?: boolean
        SchemaConfiguration?: {
          DatabaseName?: string
          TableName?: string
          Region?: string
          RoleARN?: string | { Ref: string }
        }
        InputFormatConfiguration?: {
          Deserializer?: {
            OpenXJsonSerDe?: Record<string, any>
            HiveJsonSerDe?: Record<string, any>
          }
        }
        OutputFormatConfiguration?: {
          Serializer?: {
            ParquetSerDe?: Record<string, any>
            OrcSerDe?: Record<string, any>
          }
        }
      }
      DynamicPartitioningConfiguration?: {
        Enabled?: boolean
        RetryOptions?: {
          DurationInSeconds?: number
        }
      }
      ProcessingConfiguration?: {
        Enabled?: boolean
        Processors?: Array<{
          Type: 'Lambda'
          Parameters?: Array<{
            ParameterName: string
            ParameterValue: string
          }>
        }>
      }
    }

    // Elasticsearch destination
    ElasticsearchDestinationConfiguration?: {
      DomainARN: string | { 'Fn::GetAtt': [string, string] }
      IndexName: string
      RoleARN: string | { Ref: string }
      TypeName?: string
      IndexRotationPeriod?: 'NoRotation' | 'OneHour' | 'OneDay' | 'OneWeek' | 'OneMonth'
      BufferingHints?: {
        IntervalInSeconds?: number
        SizeInMBs?: number
      }
      RetryOptions?: {
        DurationInSeconds?: number
      }
      S3BackupMode?: 'FailedDocumentsOnly' | 'AllDocuments'
      S3Configuration: {
        BucketARN: string | { 'Fn::GetAtt': [string, string] }
        RoleARN: string | { Ref: string }
        Prefix?: string
      }
      CloudWatchLoggingOptions?: {
        Enabled?: boolean
        LogGroupName?: string
        LogStreamName?: string
      }
    }

    // OpenSearch destination
    AmazonopensearchserviceDestinationConfiguration?: {
      DomainARN: string | { 'Fn::GetAtt': [string, string] }
      IndexName: string
      RoleARN: string | { Ref: string }
      TypeName?: string
      IndexRotationPeriod?: 'NoRotation' | 'OneHour' | 'OneDay' | 'OneWeek' | 'OneMonth'
      BufferingHints?: {
        IntervalInSeconds?: number
        SizeInMBs?: number
      }
      RetryOptions?: {
        DurationInSeconds?: number
      }
      S3BackupMode?: 'FailedDocumentsOnly' | 'AllDocuments'
      S3Configuration: {
        BucketARN: string | { 'Fn::GetAtt': [string, string] }
        RoleARN: string | { Ref: string }
        Prefix?: string
      }
      CloudWatchLoggingOptions?: {
        Enabled?: boolean
        LogGroupName?: string
        LogStreamName?: string
      }
    }

    // Redshift destination
    RedshiftDestinationConfiguration?: {
      ClusterJDBCURL: string
      CopyCommand: {
        DataTableName: string
        CopyOptions?: string
        DataTableColumns?: string
      }
      Username: string
      Password: string
      RoleARN: string | { Ref: string }
      S3Configuration: {
        BucketARN: string | { 'Fn::GetAtt': [string, string] }
        RoleARN: string | { Ref: string }
        Prefix?: string
      }
      CloudWatchLoggingOptions?: {
        Enabled?: boolean
        LogGroupName?: string
        LogStreamName?: string
      }
    }

    Tags?: Tag[]
  }
  DeletionPolicy?: 'Delete' | 'Retain'
  UpdateReplacePolicy?: 'Delete' | 'Retain'
}

// Kinesis Data Analytics
export interface Application {
  Type: 'AWS::KinesisAnalytics::Application'
  Properties: {
    ApplicationName?: string
    ApplicationDescription?: string
    ApplicationCode?: string
    Inputs: Array<{
      NamePrefix: string
      InputSchema: {
        RecordColumns: Array<{
          Name: string
          SqlType: string
          Mapping?: string
        }>
        RecordFormat: {
          RecordFormatType: 'CSV' | 'JSON'
          MappingParameters?: {
            CSVMappingParameters?: {
              RecordRowDelimiter: string
              RecordColumnDelimiter: string
            }
            JSONMappingParameters?: {
              RecordRowPath: string
            }
          }
        }
        RecordEncoding?: string
      }
      KinesisStreamsInput?: {
        ResourceARN: string | { 'Fn::GetAtt': [string, string] }
        RoleARN: string | { Ref: string }
      }
      KinesisFirehoseInput?: {
        ResourceARN: string | { 'Fn::GetAtt': [string, string] }
        RoleARN: string | { Ref: string }
      }
    }>
  }
}
