/**
 * Mock AWS services for unit testing
 * Provides in-memory implementations of AWS services without external dependencies
 */

export interface MockAWSConfig {
  region?: string
  credentials?: {
    accessKeyId: string
    secretAccessKey: string
  }
}

/**
 * Mock CloudFormation service
 */
export class MockCloudFormation {
  private stacks: Map<string, any> = new Map()
  private stackEvents: Map<string, any[]> = new Map()

  async createStack(params: any): Promise<any> {
    const stackId = `arn:aws:cloudformation:${params.region || 'us-east-1'}:123456789012:stack/${params.StackName}/${Date.now()}`

    this.stacks.set(params.StackName, {
      StackId: stackId,
      StackName: params.StackName,
      StackStatus: 'CREATE_IN_PROGRESS',
      CreationTime: new Date().toISOString(),
      TemplateBody: params.TemplateBody,
      Parameters: params.Parameters || [],
    })

    this.addEvent(params.StackName, {
      EventId: Date.now().toString(),
      StackName: params.StackName,
      LogicalResourceId: params.StackName,
      ResourceType: 'AWS::CloudFormation::Stack',
      Timestamp: new Date().toISOString(),
      ResourceStatus: 'CREATE_IN_PROGRESS',
    })

    // Simulate async stack creation
    setTimeout(() => {
      const stack = this.stacks.get(params.StackName)
      if (stack) {
        stack.StackStatus = 'CREATE_COMPLETE'
        this.addEvent(params.StackName, {
          EventId: (Date.now() + 1).toString(),
          StackName: params.StackName,
          LogicalResourceId: params.StackName,
          ResourceType: 'AWS::CloudFormation::Stack',
          Timestamp: new Date().toISOString(),
          ResourceStatus: 'CREATE_COMPLETE',
        })
      }
    }, 100)

    return { StackId: stackId }
  }

  async updateStack(params: any): Promise<any> {
    const stack = this.stacks.get(params.StackName)

    if (!stack) {
      throw new Error(`Stack ${params.StackName} does not exist`)
    }

    stack.StackStatus = 'UPDATE_IN_PROGRESS'
    stack.TemplateBody = params.TemplateBody || stack.TemplateBody

    this.addEvent(params.StackName, {
      EventId: Date.now().toString(),
      StackName: params.StackName,
      LogicalResourceId: params.StackName,
      ResourceType: 'AWS::CloudFormation::Stack',
      Timestamp: new Date().toISOString(),
      ResourceStatus: 'UPDATE_IN_PROGRESS',
    })

    setTimeout(() => {
      stack.StackStatus = 'UPDATE_COMPLETE'
      this.addEvent(params.StackName, {
        EventId: (Date.now() + 1).toString(),
        StackName: params.StackName,
        LogicalResourceId: params.StackName,
        ResourceType: 'AWS::CloudFormation::Stack',
        Timestamp: new Date().toISOString(),
        ResourceStatus: 'UPDATE_COMPLETE',
      })
    }, 100)

    return { StackId: stack.StackId }
  }

  async deleteStack(params: any): Promise<void> {
    const stack = this.stacks.get(params.StackName)

    if (!stack) {
      throw new Error(`Stack ${params.StackName} does not exist`)
    }

    stack.StackStatus = 'DELETE_IN_PROGRESS'

    this.addEvent(params.StackName, {
      EventId: Date.now().toString(),
      StackName: params.StackName,
      LogicalResourceId: params.StackName,
      ResourceType: 'AWS::CloudFormation::Stack',
      Timestamp: new Date().toISOString(),
      ResourceStatus: 'DELETE_IN_PROGRESS',
    })

    setTimeout(() => {
      this.stacks.delete(params.StackName)
      this.addEvent(params.StackName, {
        EventId: (Date.now() + 1).toString(),
        StackName: params.StackName,
        LogicalResourceId: params.StackName,
        ResourceType: 'AWS::CloudFormation::Stack',
        Timestamp: new Date().toISOString(),
        ResourceStatus: 'DELETE_COMPLETE',
      })
    }, 100)
  }

  async describeStacks(params: any): Promise<any> {
    if (params.StackName) {
      const stack = this.stacks.get(params.StackName)

      if (!stack) {
        throw new Error(`Stack ${params.StackName} does not exist`)
      }

      return {
        Stacks: [stack],
      }
    }

    return {
      Stacks: Array.from(this.stacks.values()),
    }
  }

  async describeStackEvents(params: any): Promise<any> {
    const events = this.stackEvents.get(params.StackName) || []

    return {
      StackEvents: events,
    }
  }

  private addEvent(stackName: string, event: any): void {
    if (!this.stackEvents.has(stackName)) {
      this.stackEvents.set(stackName, [])
    }

    this.stackEvents.get(stackName)!.unshift(event)
  }

  /**
   * Reset mock state (useful for testing)
   */
  reset(): void {
    this.stacks.clear()
    this.stackEvents.clear()
  }
}

/**
 * Mock S3 service
 */
export class MockS3 {
  private buckets: Map<string, Map<string, Buffer>> = new Map()

  async createBucket(params: any): Promise<any> {
    this.buckets.set(params.Bucket, new Map())

    return {
      Location: `/${params.Bucket}`,
    }
  }

  async deleteBucket(params: any): Promise<void> {
    this.buckets.delete(params.Bucket)
  }

  async putObject(params: any): Promise<any> {
    let bucket = this.buckets.get(params.Bucket)

    if (!bucket) {
      bucket = new Map()
      this.buckets.set(params.Bucket, bucket)
    }

    bucket.set(params.Key, Buffer.from(params.Body || ''))

    return {
      ETag: `"${Date.now()}"`,
    }
  }

  async getObject(params: any): Promise<any> {
    const bucket = this.buckets.get(params.Bucket)

    if (!bucket) {
      throw new Error(`Bucket ${params.Bucket} does not exist`)
    }

    const data = bucket.get(params.Key)

    if (!data) {
      throw new Error(`Object ${params.Key} does not exist`)
    }

    return {
      Body: data,
      ContentLength: data.length,
    }
  }

  async deleteObject(params: any): Promise<void> {
    const bucket = this.buckets.get(params.Bucket)

    if (bucket) {
      bucket.delete(params.Key)
    }
  }

  async listObjects(params: any): Promise<any> {
    const bucket = this.buckets.get(params.Bucket)

    if (!bucket) {
      throw new Error(`Bucket ${params.Bucket} does not exist`)
    }

    const objects = Array.from(bucket.keys()).map(key => ({
      Key: key,
      Size: bucket.get(key)!.length,
      LastModified: new Date().toISOString(),
    }))

    return {
      Contents: objects,
    }
  }

  /**
   * Reset mock state
   */
  reset(): void {
    this.buckets.clear()
  }
}

/**
 * Mock DynamoDB service
 */
export class MockDynamoDB {
  private tables: Map<string, any> = new Map()
  private data: Map<string, Map<string, any>> = new Map()

  async createTable(params: any): Promise<any> {
    this.tables.set(params.TableName, {
      TableName: params.TableName,
      KeySchema: params.KeySchema,
      AttributeDefinitions: params.AttributeDefinitions,
      TableStatus: 'ACTIVE',
      CreationDateTime: new Date().toISOString(),
    })

    this.data.set(params.TableName, new Map())

    return {
      TableDescription: this.tables.get(params.TableName),
    }
  }

  async deleteTable(params: any): Promise<void> {
    this.tables.delete(params.TableName)
    this.data.delete(params.TableName)
  }

  async putItem(params: any): Promise<void> {
    let tableData = this.data.get(params.TableName)

    if (!tableData) {
      tableData = new Map()
      this.data.set(params.TableName, tableData)
    }

    const key = JSON.stringify(params.Item)
    tableData.set(key, params.Item)
  }

  async getItem(params: any): Promise<any> {
    const tableData = this.data.get(params.TableName)

    if (!tableData) {
      return {}
    }

    const key = JSON.stringify(params.Key)
    const item = tableData.get(key)

    return item ? { Item: item } : {}
  }

  async deleteItem(params: any): Promise<void> {
    const tableData = this.data.get(params.TableName)

    if (tableData) {
      const key = JSON.stringify(params.Key)
      tableData.delete(key)
    }
  }

  async scan(params: any): Promise<any> {
    const tableData = this.data.get(params.TableName)

    if (!tableData) {
      return { Items: [] }
    }

    return {
      Items: Array.from(tableData.values()),
    }
  }

  /**
   * Reset mock state
   */
  reset(): void {
    this.tables.clear()
    this.data.clear()
  }
}

/**
 * Create mock AWS services
 */
export function createMockAWS(config?: MockAWSConfig) {
  return {
    cloudformation: new MockCloudFormation(),
    s3: new MockS3(),
    dynamodb: new MockDynamoDB(),
  }
}
