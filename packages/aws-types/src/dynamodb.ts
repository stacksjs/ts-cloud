import type { CloudFormationResource } from './index'

export interface DynamoDBTable extends CloudFormationResource {
  Type: 'AWS::DynamoDB::Table'
  Properties: {
    TableName?: string
    BillingMode?: 'PROVISIONED' | 'PAY_PER_REQUEST'
    AttributeDefinitions: Array<{
      AttributeName: string
      AttributeType: 'S' | 'N' | 'B'
    }>
    KeySchema: Array<{
      AttributeName: string
      KeyType: 'HASH' | 'RANGE'
    }>
    ProvisionedThroughput?: {
      ReadCapacityUnits: number
      WriteCapacityUnits: number
    }
    GlobalSecondaryIndexes?: Array<{
      IndexName: string
      KeySchema: Array<{
        AttributeName: string
        KeyType: 'HASH' | 'RANGE'
      }>
      Projection: {
        ProjectionType: 'ALL' | 'KEYS_ONLY' | 'INCLUDE'
        NonKeyAttributes?: string[]
      }
      ProvisionedThroughput?: {
        ReadCapacityUnits: number
        WriteCapacityUnits: number
      }
    }>
    LocalSecondaryIndexes?: Array<{
      IndexName: string
      KeySchema: Array<{
        AttributeName: string
        KeyType: 'HASH' | 'RANGE'
      }>
      Projection: {
        ProjectionType: 'ALL' | 'KEYS_ONLY' | 'INCLUDE'
        NonKeyAttributes?: string[]
      }
    }>
    StreamSpecification?: {
      StreamViewType: 'NEW_IMAGE' | 'OLD_IMAGE' | 'NEW_AND_OLD_IMAGES' | 'KEYS_ONLY'
    }
    SSESpecification?: {
      SSEEnabled: boolean
      SSEType?: 'AES256' | 'KMS'
      KMSMasterKeyId?: string
    }
    PointInTimeRecoverySpecification?: {
      PointInTimeRecoveryEnabled: boolean
    }
    TimeToLiveSpecification?: {
      AttributeName: string
      Enabled: boolean
    }
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}
