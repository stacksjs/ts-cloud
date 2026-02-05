/**
 * AWS DynamoDB Client
 * Direct API calls for DynamoDB operations
 */

import { AWSClient } from './client'

export interface AttributeValue {
  S?: string
  N?: string
  B?: string
  SS?: string[]
  NS?: string[]
  BS?: string[]
  M?: Record<string, AttributeValue>
  L?: AttributeValue[]
  NULL?: boolean
  BOOL?: boolean
}

export interface KeySchemaElement {
  AttributeName: string
  KeyType: 'HASH' | 'RANGE'
}

export interface AttributeDefinition {
  AttributeName: string
  AttributeType: 'S' | 'N' | 'B'
}

export interface GlobalSecondaryIndex {
  IndexName: string
  KeySchema: KeySchemaElement[]
  Projection: {
    ProjectionType: 'ALL' | 'KEYS_ONLY' | 'INCLUDE'
    NonKeyAttributes?: string[]
  }
  ProvisionedThroughput?: {
    ReadCapacityUnits: number
    WriteCapacityUnits: number
  }
}

export interface TableDescription {
  TableName: string
  TableStatus: 'CREATING' | 'UPDATING' | 'DELETING' | 'ACTIVE' | 'INACCESSIBLE_ENCRYPTION_CREDENTIALS' | 'ARCHIVING' | 'ARCHIVED'
  TableArn: string
  ItemCount: number
  TableSizeBytes: number
  CreationDateTime: string
  KeySchema: KeySchemaElement[]
  AttributeDefinitions: AttributeDefinition[]
  GlobalSecondaryIndexes?: GlobalSecondaryIndex[]
}

/**
 * DynamoDB client for direct API calls
 */
export class DynamoDBClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  private async request<T>(action: string, params: Record<string, any>): Promise<T> {
    return this.client.request({
      service: 'dynamodb',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.0',
        'X-Amz-Target': `DynamoDB_20120810.${action}`,
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * Create a new DynamoDB table
   */
  async createTable(params: {
    TableName: string
    KeySchema: KeySchemaElement[]
    AttributeDefinitions: AttributeDefinition[]
    BillingMode?: 'PROVISIONED' | 'PAY_PER_REQUEST'
    ProvisionedThroughput?: {
      ReadCapacityUnits: number
      WriteCapacityUnits: number
    }
    GlobalSecondaryIndexes?: GlobalSecondaryIndex[]
    Tags?: Array<{ Key: string; Value: string }>
    TimeToLiveSpecification?: {
      AttributeName: string
      Enabled: boolean
    }
  }): Promise<{ TableDescription: TableDescription }> {
    return this.request('CreateTable', params)
  }

  /**
   * Delete a DynamoDB table
   */
  async deleteTable(params: { TableName: string }): Promise<{ TableDescription: TableDescription }> {
    return this.request('DeleteTable', params)
  }

  /**
   * Describe a DynamoDB table
   */
  async describeTable(params: { TableName: string }): Promise<{ Table: TableDescription }> {
    return this.request('DescribeTable', params)
  }

  /**
   * List all DynamoDB tables
   */
  async listTables(params?: {
    ExclusiveStartTableName?: string
    Limit?: number
  }): Promise<{ TableNames: string[]; LastEvaluatedTableName?: string }> {
    return this.request('ListTables', params || {})
  }

  /**
   * Put an item into a table
   */
  async putItem(params: {
    TableName: string
    Item: Record<string, AttributeValue>
    ConditionExpression?: string
    ExpressionAttributeNames?: Record<string, string>
    ExpressionAttributeValues?: Record<string, AttributeValue>
    ReturnValues?: 'NONE' | 'ALL_OLD'
  }): Promise<{ Attributes?: Record<string, AttributeValue> }> {
    return this.request('PutItem', params)
  }

  /**
   * Get an item from a table
   */
  async getItem(params: {
    TableName: string
    Key: Record<string, AttributeValue>
    ProjectionExpression?: string
    ExpressionAttributeNames?: Record<string, string>
    ConsistentRead?: boolean
  }): Promise<{ Item?: Record<string, AttributeValue> }> {
    return this.request('GetItem', params)
  }

  /**
   * Update an item in a table
   */
  async updateItem(params: {
    TableName: string
    Key: Record<string, AttributeValue>
    UpdateExpression: string
    ConditionExpression?: string
    ExpressionAttributeNames?: Record<string, string>
    ExpressionAttributeValues?: Record<string, AttributeValue>
    ReturnValues?: 'NONE' | 'ALL_OLD' | 'UPDATED_OLD' | 'ALL_NEW' | 'UPDATED_NEW'
  }): Promise<{ Attributes?: Record<string, AttributeValue> }> {
    return this.request('UpdateItem', params)
  }

  /**
   * Delete an item from a table
   */
  async deleteItem(params: {
    TableName: string
    Key: Record<string, AttributeValue>
    ConditionExpression?: string
    ExpressionAttributeNames?: Record<string, string>
    ExpressionAttributeValues?: Record<string, AttributeValue>
    ReturnValues?: 'NONE' | 'ALL_OLD'
  }): Promise<{ Attributes?: Record<string, AttributeValue> }> {
    return this.request('DeleteItem', params)
  }

  /**
   * Query items from a table
   */
  async query(params: {
    TableName: string
    IndexName?: string
    KeyConditionExpression: string
    FilterExpression?: string
    ProjectionExpression?: string
    ExpressionAttributeNames?: Record<string, string>
    ExpressionAttributeValues?: Record<string, AttributeValue>
    Limit?: number
    ExclusiveStartKey?: Record<string, AttributeValue>
    ScanIndexForward?: boolean
    ConsistentRead?: boolean
  }): Promise<{
    Items: Array<Record<string, AttributeValue>>
    Count: number
    ScannedCount: number
    LastEvaluatedKey?: Record<string, AttributeValue>
  }> {
    return this.request('Query', params)
  }

  /**
   * Scan items from a table
   */
  async scan(params: {
    TableName: string
    IndexName?: string
    FilterExpression?: string
    ProjectionExpression?: string
    ExpressionAttributeNames?: Record<string, string>
    ExpressionAttributeValues?: Record<string, AttributeValue>
    Limit?: number
    ExclusiveStartKey?: Record<string, AttributeValue>
    ConsistentRead?: boolean
  }): Promise<{
    Items: Array<Record<string, AttributeValue>>
    Count: number
    ScannedCount: number
    LastEvaluatedKey?: Record<string, AttributeValue>
  }> {
    return this.request('Scan', params)
  }

  /**
   * Batch write items
   */
  async batchWriteItem(params: {
    RequestItems: Record<string, Array<{
      PutRequest?: { Item: Record<string, AttributeValue> }
      DeleteRequest?: { Key: Record<string, AttributeValue> }
    }>>
  }): Promise<{
    UnprocessedItems: Record<string, Array<{
      PutRequest?: { Item: Record<string, AttributeValue> }
      DeleteRequest?: { Key: Record<string, AttributeValue> }
    }>>
  }> {
    return this.request('BatchWriteItem', params)
  }

  /**
   * Batch get items
   */
  async batchGetItem(params: {
    RequestItems: Record<string, {
      Keys: Array<Record<string, AttributeValue>>
      ProjectionExpression?: string
      ExpressionAttributeNames?: Record<string, string>
      ConsistentRead?: boolean
    }>
  }): Promise<{
    Responses: Record<string, Array<Record<string, AttributeValue>>>
    UnprocessedKeys: Record<string, {
      Keys: Array<Record<string, AttributeValue>>
    }>
  }> {
    return this.request('BatchGetItem', params)
  }

  /**
   * Update time to live settings
   */
  async updateTimeToLive(params: {
    TableName: string
    TimeToLiveSpecification: {
      AttributeName: string
      Enabled: boolean
    }
  }): Promise<{ TimeToLiveSpecification: { AttributeName: string; Enabled: boolean } }> {
    return this.request('UpdateTimeToLive', params)
  }

  /**
   * Helper: Marshal a JavaScript object to DynamoDB format
   */
  static marshal(obj: Record<string, any>): Record<string, AttributeValue> {
    const result: Record<string, AttributeValue> = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = DynamoDBClient.marshalValue(value)
    }
    return result
  }

  /**
   * Helper: Marshal a single value to DynamoDB format
   */
  static marshalValue(value: any): AttributeValue {
    if (value === null || value === undefined) {
      return { NULL: true }
    }
    if (typeof value === 'string') {
      return { S: value }
    }
    if (typeof value === 'number') {
      return { N: String(value) }
    }
    if (typeof value === 'boolean') {
      return { BOOL: value }
    }
    if (Array.isArray(value)) {
      return { L: value.map(v => DynamoDBClient.marshalValue(v)) }
    }
    if (typeof value === 'object') {
      return { M: DynamoDBClient.marshal(value) }
    }
    return { S: String(value) }
  }

  /**
   * Helper: Unmarshal DynamoDB format to JavaScript object
   */
  static unmarshal(item: Record<string, AttributeValue>): Record<string, any> {
    const result: Record<string, any> = {}
    for (const [key, value] of Object.entries(item)) {
      result[key] = DynamoDBClient.unmarshalValue(value)
    }
    return result
  }

  /**
   * Helper: Unmarshal a single DynamoDB value
   */
  static unmarshalValue(value: AttributeValue): any {
    if (value.S !== undefined) return value.S
    if (value.N !== undefined) return Number(value.N)
    if (value.BOOL !== undefined) return value.BOOL
    if (value.NULL !== undefined) return null
    if (value.L !== undefined) return value.L.map(v => DynamoDBClient.unmarshalValue(v))
    if (value.M !== undefined) return DynamoDBClient.unmarshal(value.M)
    if (value.SS !== undefined) return value.SS
    if (value.NS !== undefined) return value.NS.map(Number)
    return null
  }
}
