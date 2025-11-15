import type {
  StepFunctionsStateMachine,
  IAMRole,
} from '@ts-cloud/aws-types'
import type { EnvironmentType } from '@ts-cloud/types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface StateMachineOptions {
  slug: string
  environment: EnvironmentType
  stateMachineName?: string
  type?: 'STANDARD' | 'EXPRESS'
  definition: StateMachineDefinition
  roleArn?: string
  loggingConfiguration?: {
    level: 'ALL' | 'ERROR' | 'FATAL' | 'OFF'
    includeExecutionData?: boolean
    destinations?: string[]
  }
  tracingConfiguration?: {
    enabled: boolean
  }
}

export interface StateMachineDefinition {
  Comment?: string
  StartAt: string
  States: Record<string, State>
  TimeoutSeconds?: number
  Version?: string
}

export type State =
  | TaskState
  | PassState
  | WaitState
  | ChoiceState
  | ParallelState
  | MapState
  | SucceedState
  | FailState

export interface BaseState {
  Type: 'Task' | 'Pass' | 'Wait' | 'Choice' | 'Parallel' | 'Map' | 'Succeed' | 'Fail'
  Comment?: string
  End?: boolean
  Next?: string
}

export interface TaskState extends BaseState {
  Type: 'Task'
  Resource: string
  Parameters?: Record<string, unknown>
  ResultPath?: string | null
  OutputPath?: string
  InputPath?: string
  TimeoutSeconds?: number
  HeartbeatSeconds?: number
  Retry?: RetryConfig[]
  Catch?: CatchConfig[]
}

export interface PassState extends BaseState {
  Type: 'Pass'
  Result?: unknown
  ResultPath?: string | null
  Parameters?: Record<string, unknown>
}

export interface WaitState extends BaseState {
  Type: 'Wait'
  Seconds?: number
  Timestamp?: string
  SecondsPath?: string
  TimestampPath?: string
}

export interface ChoiceState extends BaseState {
  Type: 'Choice'
  Choices: ChoiceRule[]
  Default?: string
}

export interface ChoiceRule {
  Variable: string
  StringEquals?: string
  StringLessThan?: string
  StringGreaterThan?: string
  NumericEquals?: number
  NumericLessThan?: number
  NumericGreaterThan?: number
  BooleanEquals?: boolean
  TimestampEquals?: string
  TimestampLessThan?: string
  TimestampGreaterThan?: string
  IsPresent?: boolean
  IsNull?: boolean
  IsNumeric?: boolean
  IsString?: boolean
  IsBoolean?: boolean
  IsTimestamp?: boolean
  Next: string
  And?: ChoiceRule[]
  Or?: ChoiceRule[]
  Not?: ChoiceRule
}

export interface ParallelState extends BaseState {
  Type: 'Parallel'
  Branches: StateMachineDefinition[]
  ResultPath?: string | null
  Retry?: RetryConfig[]
  Catch?: CatchConfig[]
}

export interface MapState extends BaseState {
  Type: 'Map'
  ItemsPath?: string
  Iterator: StateMachineDefinition
  MaxConcurrency?: number
  ResultPath?: string | null
  Retry?: RetryConfig[]
  Catch?: CatchConfig[]
}

export interface SucceedState extends BaseState {
  Type: 'Succeed'
}

export interface FailState extends BaseState {
  Type: 'Fail'
  Error?: string
  Cause?: string
}

export interface RetryConfig {
  ErrorEquals: string[]
  IntervalSeconds?: number
  MaxAttempts?: number
  BackoffRate?: number
}

export interface CatchConfig {
  ErrorEquals: string[]
  Next: string
  ResultPath?: string
}

/**
 * Workflow Module - Step Functions
 * Provides clean API for orchestrating distributed applications and microservices
 */
export class Workflow {
  /**
   * Create a Step Functions state machine
   */
  static createStateMachine(options: StateMachineOptions): {
    stateMachine: StepFunctionsStateMachine
    logicalId: string
    role?: IAMRole
    roleLogicalId?: string
  } {
    const {
      slug,
      environment,
      stateMachineName,
      type = 'STANDARD',
      definition,
      roleArn,
      loggingConfiguration,
      tracingConfiguration,
    } = options

    const resourceName = stateMachineName || generateResourceName({
      slug,
      environment,
      resourceType: 'state-machine',
    })

    const logicalId = generateLogicalId(resourceName)

    // Create role if not provided
    let role: IAMRole | undefined
    let roleLogicalId: string | undefined
    let finalRoleArn: string

    if (roleArn) {
      finalRoleArn = roleArn
    }
    else {
      const roleResourceName = generateResourceName({
        slug,
        environment,
        resourceType: 'state-machine-role',
      })
      roleLogicalId = generateLogicalId(roleResourceName)

      role = {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: roleResourceName,
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: {
                  Service: 'states.amazonaws.com',
                },
                Action: 'sts:AssumeRole',
              },
            ],
          },
          ManagedPolicyArns: [
            'arn:aws:iam::aws:policy/CloudWatchLogsFullAccess',
          ],
          Tags: [
            { Key: 'Name', Value: roleResourceName },
            { Key: 'Environment', Value: environment },
          ],
        },
      }

      finalRoleArn = Fn.GetAtt(roleLogicalId, 'Arn') as unknown as string
    }

    const stateMachine: StepFunctionsStateMachine = {
      Type: 'AWS::StepFunctions::StateMachine',
      Properties: {
        StateMachineName: resourceName,
        StateMachineType: type,
        DefinitionString: JSON.stringify(definition),
        RoleArn: finalRoleArn,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    if (loggingConfiguration) {
      stateMachine.Properties!.LoggingConfiguration = {
        Level: loggingConfiguration.level,
        IncludeExecutionData: loggingConfiguration.includeExecutionData,
        Destinations: loggingConfiguration.destinations?.map(arn => ({ CloudWatchLogsLogGroup: { LogGroupArn: arn } })),
      }
    }

    if (tracingConfiguration) {
      stateMachine.Properties!.TracingConfiguration = {
        Enabled: tracingConfiguration.enabled,
      }
    }

    return { stateMachine, logicalId, role, roleLogicalId }
  }

  /**
   * Create a Lambda task state
   */
  static createLambdaTask(
    functionArn: string,
    options?: {
      parameters?: Record<string, unknown>
      resultPath?: string | null
      retry?: RetryConfig[]
      catch?: CatchConfig[]
      next?: string
      end?: boolean
    },
  ): TaskState {
    return {
      Type: 'Task',
      Resource: 'arn:aws:states:::lambda:invoke',
      Parameters: {
        FunctionName: functionArn,
        Payload: options?.parameters || { 'Input.$': '$' },
      },
      ResultPath: options?.resultPath,
      Retry: options?.retry,
      Catch: options?.catch,
      Next: options?.next,
      End: options?.end,
    }
  }

  /**
   * Create a DynamoDB task state
   */
  static createDynamoDBTask(
    action: 'GetItem' | 'PutItem' | 'UpdateItem' | 'DeleteItem',
    tableName: string,
    parameters: Record<string, unknown>,
    options?: {
      resultPath?: string | null
      retry?: RetryConfig[]
      catch?: CatchConfig[]
      next?: string
      end?: boolean
    },
  ): TaskState {
    const resourceMap = {
      GetItem: 'arn:aws:states:::dynamodb:getItem',
      PutItem: 'arn:aws:states:::dynamodb:putItem',
      UpdateItem: 'arn:aws:states:::dynamodb:updateItem',
      DeleteItem: 'arn:aws:states:::dynamodb:deleteItem',
    }

    return {
      Type: 'Task',
      Resource: resourceMap[action],
      Parameters: {
        TableName: tableName,
        ...parameters,
      },
      ResultPath: options?.resultPath,
      Retry: options?.retry,
      Catch: options?.catch,
      Next: options?.next,
      End: options?.end,
    }
  }

  /**
   * Create an SNS publish task state
   */
  static createSNSPublishTask(
    topicArn: string,
    message: Record<string, unknown>,
    options?: {
      resultPath?: string | null
      retry?: RetryConfig[]
      catch?: CatchConfig[]
      next?: string
      end?: boolean
    },
  ): TaskState {
    return {
      Type: 'Task',
      Resource: 'arn:aws:states:::sns:publish',
      Parameters: {
        TopicArn: topicArn,
        Message: message,
      },
      ResultPath: options?.resultPath,
      Retry: options?.retry,
      Catch: options?.catch,
      Next: options?.next,
      End: options?.end,
    }
  }

  /**
   * Create an SQS send message task state
   */
  static createSQSSendMessageTask(
    queueUrl: string,
    messageBody: Record<string, unknown>,
    options?: {
      resultPath?: string | null
      retry?: RetryConfig[]
      catch?: CatchConfig[]
      next?: string
      end?: boolean
    },
  ): TaskState {
    return {
      Type: 'Task',
      Resource: 'arn:aws:states:::sqs:sendMessage',
      Parameters: {
        QueueUrl: queueUrl,
        MessageBody: messageBody,
      },
      ResultPath: options?.resultPath,
      Retry: options?.retry,
      Catch: options?.catch,
      Next: options?.next,
      End: options?.end,
    }
  }

  /**
   * Create a Pass state
   */
  static createPassState(options?: {
    result?: unknown
    resultPath?: string | null
    parameters?: Record<string, unknown>
    next?: string
    end?: boolean
  }): PassState {
    return {
      Type: 'Pass',
      Result: options?.result,
      ResultPath: options?.resultPath,
      Parameters: options?.parameters,
      Next: options?.next,
      End: options?.end,
    }
  }

  /**
   * Create a Wait state
   */
  static createWaitState(options: {
    seconds?: number
    timestamp?: string
    secondsPath?: string
    timestampPath?: string
    next?: string
    end?: boolean
  }): WaitState {
    return {
      Type: 'Wait',
      Seconds: options.seconds,
      Timestamp: options.timestamp,
      SecondsPath: options.secondsPath,
      TimestampPath: options.timestampPath,
      Next: options.next,
      End: options.end,
    }
  }

  /**
   * Create a Choice state
   */
  static createChoiceState(
    choices: ChoiceRule[],
    defaultState?: string,
  ): ChoiceState {
    return {
      Type: 'Choice',
      Choices: choices,
      Default: defaultState,
    }
  }

  /**
   * Create a Parallel state
   */
  static createParallelState(
    branches: StateMachineDefinition[],
    options?: {
      resultPath?: string | null
      retry?: RetryConfig[]
      catch?: CatchConfig[]
      next?: string
      end?: boolean
    },
  ): ParallelState {
    return {
      Type: 'Parallel',
      Branches: branches,
      ResultPath: options?.resultPath,
      Retry: options?.retry,
      Catch: options?.catch,
      Next: options?.next,
      End: options?.end,
    }
  }

  /**
   * Create a Map state
   */
  static createMapState(
    iterator: StateMachineDefinition,
    options?: {
      itemsPath?: string
      maxConcurrency?: number
      resultPath?: string | null
      retry?: RetryConfig[]
      catch?: CatchConfig[]
      next?: string
      end?: boolean
    },
  ): MapState {
    return {
      Type: 'Map',
      ItemsPath: options?.itemsPath || '$.items',
      Iterator: iterator,
      MaxConcurrency: options?.maxConcurrency,
      ResultPath: options?.resultPath,
      Retry: options?.retry,
      Catch: options?.catch,
      Next: options?.next,
      End: options?.end,
    }
  }

  /**
   * Create a Succeed state
   */
  static createSucceedState(): SucceedState {
    return {
      Type: 'Succeed',
    }
  }

  /**
   * Create a Fail state
   */
  static createFailState(error?: string, cause?: string): FailState {
    return {
      Type: 'Fail',
      Error: error,
      Cause: cause,
    }
  }

  /**
   * Common retry configurations
   */
  static readonly RetryPolicies = {
    /**
     * Standard retry with exponential backoff
     */
    standard: (): RetryConfig => ({
      ErrorEquals: ['States.ALL'],
      IntervalSeconds: 2,
      MaxAttempts: 3,
      BackoffRate: 2.0,
    }),

    /**
     * Aggressive retry for transient errors
     */
    aggressive: (): RetryConfig => ({
      ErrorEquals: ['States.TaskFailed', 'States.Timeout'],
      IntervalSeconds: 1,
      MaxAttempts: 5,
      BackoffRate: 1.5,
    }),

    /**
     * Custom retry configuration
     */
    custom: (
      errorEquals: string[],
      intervalSeconds: number,
      maxAttempts: number,
      backoffRate: number,
    ): RetryConfig => ({
      ErrorEquals: errorEquals,
      IntervalSeconds: intervalSeconds,
      MaxAttempts: maxAttempts,
      BackoffRate: backoffRate,
    }),
  } as const

  /**
   * Common catch configurations
   */
  static readonly CatchPolicies = {
    /**
     * Catch all errors
     */
    all: (nextState: string, resultPath?: string): CatchConfig => ({
      ErrorEquals: ['States.ALL'],
      Next: nextState,
      ResultPath: resultPath || '$.error',
    }),

    /**
     * Catch specific errors
     */
    specific: (errors: string[], nextState: string, resultPath?: string): CatchConfig => ({
      ErrorEquals: errors,
      Next: nextState,
      ResultPath: resultPath || '$.error',
    }),
  } as const

  /**
   * Common workflow patterns
   */
  static readonly Patterns = {
    /**
     * Simple sequential workflow
     */
    sequential: (
      slug: string,
      environment: EnvironmentType,
      tasks: { name: string, state: State }[],
    ): StateMachineDefinition => {
      const states: Record<string, State> = {}

      tasks.forEach((task, index) => {
        const isLast = index === tasks.length - 1
        states[task.name] = {
          ...task.state,
          Next: isLast ? undefined : tasks[index + 1].name,
          End: isLast,
        }
      })

      return {
        Comment: 'Sequential workflow',
        StartAt: tasks[0].name,
        States: states,
      }
    },

    /**
     * Fan-out workflow (parallel execution)
     */
    fanout: (
      slug: string,
      environment: EnvironmentType,
      branches: { name: string, definition: StateMachineDefinition }[],
    ): StateMachineDefinition => {
      return {
        Comment: 'Fan-out workflow',
        StartAt: 'Parallel',
        States: {
          Parallel: {
            Type: 'Parallel',
            Branches: branches.map(b => b.definition),
            End: true,
          },
        },
      }
    },

    /**
     * Map workflow (process array of items)
     */
    map: (
      slug: string,
      environment: EnvironmentType,
      itemProcessor: StateMachineDefinition,
      maxConcurrency?: number,
    ): StateMachineDefinition => {
      return {
        Comment: 'Map workflow',
        StartAt: 'Map',
        States: {
          Map: {
            Type: 'Map',
            ItemsPath: '$.items',
            Iterator: itemProcessor,
            MaxConcurrency: maxConcurrency,
            End: true,
          },
        },
      }
    },

    /**
     * Error handling workflow
     */
    withErrorHandling: (
      slug: string,
      environment: EnvironmentType,
      mainTask: TaskState,
      errorHandler: State,
    ): StateMachineDefinition => {
      return {
        Comment: 'Workflow with error handling',
        StartAt: 'Main',
        States: {
          Main: {
            ...mainTask,
            Catch: [
              {
                ErrorEquals: ['States.ALL'],
                Next: 'ErrorHandler',
              },
            ],
            Next: 'Success',
          },
          ErrorHandler: errorHandler,
          Success: {
            Type: 'Succeed',
          },
        },
      }
    },
  } as const
}
