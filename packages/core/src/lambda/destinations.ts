/**
 * Lambda Destinations
 * Asynchronous invocation destinations for success and failure
 */

export interface LambdaDestination {
  id: string
  functionName: string
  qualifier?: string
  successDestination?: DestinationConfig
  failureDestination?: DestinationConfig
  maxEventAge?: number // seconds
  maxRetries?: number
}

export interface DestinationConfig {
  type: 'sqs' | 'sns' | 'eventbridge' | 'lambda'
  arn: string
}

export interface DestinationRecord {
  id: string
  timestamp: Date
  functionName: string
  requestId: string
  status: 'success' | 'failure'
  destinationType: 'sqs' | 'sns' | 'eventbridge' | 'lambda'
  destinationArn: string
  payload?: any
  error?: string
}

export interface EventBridgeDestination {
  id: string
  functionName: string
  eventBusArn: string
  detailType: string
  source: string
}

/**
 * Lambda destinations manager
 */
export class LambdaDestinationsManager {
  private destinations: Map<string, LambdaDestination> = new Map()
  private records: Map<string, DestinationRecord> = new Map()
  private eventBridgeDestinations: Map<string, EventBridgeDestination> = new Map()
  private destinationCounter = 0
  private recordCounter = 0
  private eventBridgeCounter = 0

  /**
   * Configure destinations
   */
  configureDestinations(destination: Omit<LambdaDestination, 'id'>): LambdaDestination {
    const id = `destination-${Date.now()}-${this.destinationCounter++}`

    const lambdaDestination: LambdaDestination = {
      id,
      ...destination,
    }

    this.destinations.set(id, lambdaDestination)

    return lambdaDestination
  }

  /**
   * Configure SQS destination
   */
  configureSQSDestination(options: {
    functionName: string
    queueArn: string
    onSuccess?: boolean
    onFailure?: boolean
  }): LambdaDestination {
    const destinationConfig: DestinationConfig = {
      type: 'sqs',
      arn: options.queueArn,
    }

    return this.configureDestinations({
      functionName: options.functionName,
      successDestination: options.onSuccess ? destinationConfig : undefined,
      failureDestination: options.onFailure ? destinationConfig : undefined,
      maxEventAge: 21600, // 6 hours
      maxRetries: 2,
    })
  }

  /**
   * Configure SNS destination
   */
  configureSNSDestination(options: {
    functionName: string
    topicArn: string
    onSuccess?: boolean
    onFailure?: boolean
  }): LambdaDestination {
    const destinationConfig: DestinationConfig = {
      type: 'sns',
      arn: options.topicArn,
    }

    return this.configureDestinations({
      functionName: options.functionName,
      successDestination: options.onSuccess ? destinationConfig : undefined,
      failureDestination: options.onFailure ? destinationConfig : undefined,
      maxEventAge: 21600,
      maxRetries: 2,
    })
  }

  /**
   * Configure EventBridge destination
   */
  configureEventBridgeDestination(options: {
    functionName: string
    eventBusArn: string
    onSuccess?: boolean
    onFailure?: boolean
  }): LambdaDestination {
    const destinationConfig: DestinationConfig = {
      type: 'eventbridge',
      arn: options.eventBusArn,
    }

    return this.configureDestinations({
      functionName: options.functionName,
      successDestination: options.onSuccess ? destinationConfig : undefined,
      failureDestination: options.onFailure ? destinationConfig : undefined,
      maxEventAge: 21600,
      maxRetries: 2,
    })
  }

  /**
   * Configure Lambda destination
   */
  configureLambdaDestination(options: {
    functionName: string
    destinationFunctionArn: string
    onSuccess?: boolean
    onFailure?: boolean
  }): LambdaDestination {
    const destinationConfig: DestinationConfig = {
      type: 'lambda',
      arn: options.destinationFunctionArn,
    }

    return this.configureDestinations({
      functionName: options.functionName,
      successDestination: options.onSuccess ? destinationConfig : undefined,
      failureDestination: options.onFailure ? destinationConfig : undefined,
      maxEventAge: 21600,
      maxRetries: 2,
    })
  }

  /**
   * Configure DLQ with SNS destination
   */
  configureDLQWithNotification(options: {
    functionName: string
    dlqArn: string
    notificationTopicArn: string
  }): LambdaDestination {
    return this.configureDestinations({
      functionName: options.functionName,
      failureDestination: {
        type: 'sqs',
        arn: options.dlqArn,
      },
      maxEventAge: 3600, // 1 hour for DLQ
      maxRetries: 0, // No retries, go straight to DLQ
    })
  }

  /**
   * Create EventBridge integration
   */
  createEventBridgeIntegration(options: {
    functionName: string
    eventBusArn: string
    detailType?: string
    source?: string
  }): EventBridgeDestination {
    const id = `eventbridge-${Date.now()}-${this.eventBridgeCounter++}`

    const destination: EventBridgeDestination = {
      id,
      functionName: options.functionName,
      eventBusArn: options.eventBusArn,
      detailType: options.detailType || 'Lambda Function Invocation Result',
      source: options.source || `lambda.${options.functionName}`,
    }

    this.eventBridgeDestinations.set(id, destination)

    return destination
  }

  /**
   * Simulate sending to destination
   */
  sendToDestination(options: {
    functionName: string
    requestId: string
    status: 'success' | 'failure'
    payload?: any
    error?: string
  }): DestinationRecord | null {
    // Find destination config
    const destination = Array.from(this.destinations.values()).find(
      d => d.functionName === options.functionName
    )

    if (!destination) {
      return null
    }

    const destinationConfig =
      options.status === 'success'
        ? destination.successDestination
        : destination.failureDestination

    if (!destinationConfig) {
      return null
    }

    const id = `record-${Date.now()}-${this.recordCounter++}`

    const record: DestinationRecord = {
      id,
      timestamp: new Date(),
      functionName: options.functionName,
      requestId: options.requestId,
      status: options.status,
      destinationType: destinationConfig.type,
      destinationArn: destinationConfig.arn,
      payload: options.payload,
      error: options.error,
    }

    this.records.set(id, record)

    return record
  }

  /**
   * Get destination
   */
  getDestination(id: string): LambdaDestination | undefined {
    return this.destinations.get(id)
  }

  /**
   * List destinations
   */
  listDestinations(functionName?: string): LambdaDestination[] {
    const destinations = Array.from(this.destinations.values())
    return functionName
      ? destinations.filter(d => d.functionName === functionName)
      : destinations
  }

  /**
   * Get destination records
   */
  getDestinationRecords(functionName?: string): DestinationRecord[] {
    const records = Array.from(this.records.values())
    return functionName
      ? records.filter(r => r.functionName === functionName)
      : records
  }

  /**
   * Generate CloudFormation for EventSourceMapping with destination
   */
  generateEventInvokeConfigCF(destination: LambdaDestination): any {
    return {
      Type: 'AWS::Lambda::EventInvokeConfig',
      Properties: {
        FunctionName: destination.functionName,
        Qualifier: destination.qualifier || '$LATEST',
        MaximumEventAgeInSeconds: destination.maxEventAge || 21600,
        MaximumRetryAttempts: destination.maxRetries ?? 2,
        ...(destination.successDestination && {
          DestinationConfig: {
            OnSuccess: {
              Destination: destination.successDestination.arn,
            },
          },
        }),
        ...(destination.failureDestination && {
          DestinationConfig: {
            OnFailure: {
              Destination: destination.failureDestination.arn,
            },
          },
        }),
      },
    }
  }

  /**
   * Generate CloudFormation for EventBridge rule
   */
  generateEventBridgeRuleCF(destination: EventBridgeDestination): any {
    return {
      Type: 'AWS::Events::Rule',
      Properties: {
        EventBusName: destination.eventBusArn.split('/').pop(),
        EventPattern: {
          source: [destination.source],
          'detail-type': [destination.detailType],
        },
        State: 'ENABLED',
        Targets: [
          {
            Arn: `arn:aws:lambda:us-east-1:123456789012:function:${destination.functionName}`,
            Id: destination.id,
          },
        ],
      },
    }
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.destinations.clear()
    this.records.clear()
    this.eventBridgeDestinations.clear()
    this.destinationCounter = 0
    this.recordCounter = 0
    this.eventBridgeCounter = 0
  }
}

/**
 * Global Lambda destinations manager instance
 */
export const lambdaDestinationsManager: LambdaDestinationsManager = new LambdaDestinationsManager()
