import type { CloudFormationResource } from './index'

export interface DynamoDBKeySchemaElement {
  AttributeName: string
  KeyType: 'HASH' | 'RANGE'
}

export interface DynamoDBProjection {
  ProjectionType: 'ALL' | 'KEYS_ONLY' | 'INCLUDE'
  NonKeyAttributes?: string[]
}

export interface DynamoDBProvisionedThroughput {
  ReadCapacityUnits: number
  WriteCapacityUnits: number
}

export interface DynamoDBGlobalSecondaryIndex {
  IndexName: string
  KeySchema: DynamoDBKeySchemaElement[]
  Projection: DynamoDBProjection
  ProvisionedThroughput?: DynamoDBProvisionedThroughput
}

export interface DynamoDBLocalSecondaryIndex {
  IndexName: string
  KeySchema: DynamoDBKeySchemaElement[]
  Projection: DynamoDBProjection
}

export interface DynamoDBTable extends CloudFormationResource {
  Type: 'AWS::DynamoDB::Table'
  Properties: {
    TableName?: string
    BillingMode?: 'PROVISIONED' | 'PAY_PER_REQUEST'
    AttributeDefinitions: Array<{
      AttributeName: string
      AttributeType: 'S' | 'N' | 'B'
    }>
    KeySchema: DynamoDBKeySchemaElement[]
    ProvisionedThroughput?: DynamoDBProvisionedThroughput
    GlobalSecondaryIndexes?: DynamoDBGlobalSecondaryIndex[]
    LocalSecondaryIndexes?: DynamoDBLocalSecondaryIndex[]
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
