import { describe, expect, test } from 'bun:test'
import { Workflow } from '../src/modules/workflow'
import { TemplateBuilder } from '../src/template-builder'
import type { EnvironmentType } from '@ts-cloud/types'

const slug = 'test-app'
const environment: EnvironmentType = 'development'

describe('workflow Module - State Machine', () => {
  test('should create a standard state machine with auto-generated role', () => {
    const definition = {
      StartAt: 'HelloWorld',
      States: {
        HelloWorld: Workflow.createPassState({ result: 'Hello World', end: true }),
      },
    }

    const { stateMachine, logicalId, role, roleLogicalId } = Workflow.createStateMachine({
      slug,
      environment,
      definition,
    })

    expect(stateMachine.Type).toBe('AWS::StepFunctions::StateMachine')
    expect(stateMachine.Properties?.StateMachineName).toContain('test-app')
    expect(stateMachine.Properties?.StateMachineType).toBe('STANDARD')
    expect(stateMachine.Properties?.DefinitionString).toBe(JSON.stringify(definition))
    expect(logicalId).toBeTruthy()
    expect(role).toBeDefined()
    expect(roleLogicalId).toBeTruthy()
    expect(role?.Type).toBe('AWS::IAM::Role')
  })

  test('should create an express state machine', () => {
    const definition = {
      StartAt: 'HelloWorld',
      States: {
        HelloWorld: Workflow.createPassState({ result: 'Hello World', end: true }),
      },
    }

    const { stateMachine } = Workflow.createStateMachine({
      slug,
      environment,
      type: 'EXPRESS',
      definition,
    })

    expect(stateMachine.Properties?.StateMachineType).toBe('EXPRESS')
  })

  test('should create a state machine with custom role ARN', () => {
    const definition = {
      StartAt: 'HelloWorld',
      States: {
        HelloWorld: Workflow.createPassState({ result: 'Hello World', end: true }),
      },
    }

    const customRoleArn = 'arn:aws:iam::123456789012:role/custom-role'

    const { stateMachine, role } = Workflow.createStateMachine({
      slug,
      environment,
      definition,
      roleArn: customRoleArn,
    })

    expect(stateMachine.Properties?.RoleArn).toBe(customRoleArn)
    expect(role).toBeUndefined()
  })

  test('should create a state machine with logging configuration', () => {
    const definition = {
      StartAt: 'HelloWorld',
      States: {
        HelloWorld: Workflow.createPassState({ result: 'Hello World', end: true }),
      },
    }

    const { stateMachine } = Workflow.createStateMachine({
      slug,
      environment,
      definition,
      loggingConfiguration: {
        level: 'ALL',
        includeExecutionData: true,
        destinations: ['arn:aws:logs:us-east-1:123456789012:log-group:/aws/stepfunctions/test'],
      },
    })

    expect(stateMachine.Properties?.LoggingConfiguration).toBeDefined()
    expect(stateMachine.Properties?.LoggingConfiguration?.Level).toBe('ALL')
    expect(stateMachine.Properties?.LoggingConfiguration?.IncludeExecutionData).toBe(true)
  })

  test('should create a state machine with tracing enabled', () => {
    const definition = {
      StartAt: 'HelloWorld',
      States: {
        HelloWorld: Workflow.createPassState({ result: 'Hello World', end: true }),
      },
    }

    const { stateMachine } = Workflow.createStateMachine({
      slug,
      environment,
      definition,
      tracingConfiguration: {
        enabled: true,
      },
    })

    expect(stateMachine.Properties?.TracingConfiguration).toBeDefined()
    expect(stateMachine.Properties?.TracingConfiguration?.Enabled).toBe(true)
  })
})

describe('workflow Module - Task States', () => {
  test('should create a Lambda task state', () => {
    const functionArn = 'arn:aws:lambda:us-east-1:123456789012:function:my-function'

    const task = Workflow.createLambdaTask(functionArn, {
      parameters: { input: 'test' },
      resultPath: '$.result',
      next: 'NextState',
    })

    expect(task.Type).toBe('Task')
    expect(task.Resource).toBe('arn:aws:states:::lambda:invoke')
    expect(task.Parameters).toBeDefined()
    expect(task.Parameters?.FunctionName).toBe(functionArn)
    expect(task.ResultPath).toBe('$.result')
    expect(task.Next).toBe('NextState')
  })

  test('should create a DynamoDB GetItem task state', () => {
    const task = Workflow.createDynamoDBTask(
      'GetItem',
      'my-table',
      {
        Key: {
          id: { S: 'test-id' },
        },
      },
      {
        resultPath: '$.dbResult',
        end: true,
      },
    )

    expect(task.Type).toBe('Task')
    expect(task.Resource).toBe('arn:aws:states:::dynamodb:getItem')
    expect(task.Parameters?.TableName).toBe('my-table')
    expect(task.Parameters?.Key).toBeDefined()
    expect(task.End).toBe(true)
  })

  test('should create a DynamoDB PutItem task state', () => {
    const task = Workflow.createDynamoDBTask(
      'PutItem',
      'my-table',
      {
        Item: {
          id: { S: 'test-id' },
          name: { S: 'Test' },
        },
      },
    )

    expect(task.Resource).toBe('arn:aws:states:::dynamodb:putItem')
  })

  test('should create an SNS publish task state', () => {
    const topicArn = 'arn:aws:sns:us-east-1:123456789012:my-topic'

    const task = Workflow.createSNSPublishTask(
      topicArn,
      { message: 'Hello SNS' },
      {
        resultPath: null,
        end: true,
      },
    )

    expect(task.Type).toBe('Task')
    expect(task.Resource).toBe('arn:aws:states:::sns:publish')
    expect(task.Parameters?.TopicArn).toBe(topicArn)
    expect(task.Parameters?.Message).toEqual({ message: 'Hello SNS' })
    expect(task.ResultPath).toBeNull()
  })

  test('should create an SQS send message task state', () => {
    const queueUrl = 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue'

    const task = Workflow.createSQSSendMessageTask(
      queueUrl,
      { body: 'Hello SQS' },
      {
        next: 'NextState',
      },
    )

    expect(task.Type).toBe('Task')
    expect(task.Resource).toBe('arn:aws:states:::sqs:sendMessage')
    expect(task.Parameters?.QueueUrl).toBe(queueUrl)
    expect(task.Parameters?.MessageBody).toEqual({ body: 'Hello SQS' })
    expect(task.Next).toBe('NextState')
  })
})

describe('workflow Module - Control States', () => {
  test('should create a Pass state', () => {
    const pass = Workflow.createPassState({
      result: { message: 'Processing' },
      resultPath: '$.status',
      next: 'NextState',
    })

    expect(pass.Type).toBe('Pass')
    expect(pass.Result).toEqual({ message: 'Processing' })
    expect(pass.ResultPath).toBe('$.status')
    expect(pass.Next).toBe('NextState')
  })

  test('should create a Wait state with seconds', () => {
    const wait = Workflow.createWaitState({
      seconds: 60,
      next: 'NextState',
    })

    expect(wait.Type).toBe('Wait')
    expect(wait.Seconds).toBe(60)
    expect(wait.Next).toBe('NextState')
  })

  test('should create a Wait state with timestamp', () => {
    const wait = Workflow.createWaitState({
      timestamp: '2024-01-01T00:00:00Z',
      next: 'NextState',
    })

    expect(wait.Type).toBe('Wait')
    expect(wait.Timestamp).toBe('2024-01-01T00:00:00Z')
  })

  test('should create a Choice state', () => {
    const choice = Workflow.createChoiceState(
      [
        {
          Variable: '$.status',
          StringEquals: 'success',
          Next: 'SuccessState',
        },
        {
          Variable: '$.status',
          StringEquals: 'error',
          Next: 'ErrorState',
        },
      ],
      'DefaultState',
    )

    expect(choice.Type).toBe('Choice')
    expect(choice.Choices).toHaveLength(2)
    expect(choice.Default).toBe('DefaultState')
  })

  test('should create a Parallel state', () => {
    const branch1 = {
      StartAt: 'Branch1Task',
      States: {
        Branch1Task: Workflow.createPassState({ result: 'Branch 1', end: true }),
      },
    }

    const branch2 = {
      StartAt: 'Branch2Task',
      States: {
        Branch2Task: Workflow.createPassState({ result: 'Branch 2', end: true }),
      },
    }

    const parallel = Workflow.createParallelState([branch1, branch2], {
      resultPath: '$.parallelResults',
      next: 'NextState',
    })

    expect(parallel.Type).toBe('Parallel')
    expect(parallel.Branches).toHaveLength(2)
    expect(parallel.ResultPath).toBe('$.parallelResults')
    expect(parallel.Next).toBe('NextState')
  })

  test('should create a Map state', () => {
    const iterator = {
      StartAt: 'ProcessItem',
      States: {
        ProcessItem: Workflow.createPassState({ result: 'Processed', end: true }),
      },
    }

    const map = Workflow.createMapState(iterator, {
      itemsPath: '$.items',
      maxConcurrency: 5,
      resultPath: '$.results',
      end: true,
    })

    expect(map.Type).toBe('Map')
    expect(map.ItemsPath).toBe('$.items')
    expect(map.MaxConcurrency).toBe(5)
    expect(map.Iterator).toEqual(iterator)
    expect(map.End).toBe(true)
  })

  test('should create a Succeed state', () => {
    const succeed = Workflow.createSucceedState()

    expect(succeed.Type).toBe('Succeed')
  })

  test('should create a Fail state', () => {
    const fail = Workflow.createFailState('ErrorCode', 'Error message')

    expect(fail.Type).toBe('Fail')
    expect(fail.Error).toBe('ErrorCode')
    expect(fail.Cause).toBe('Error message')
  })
})

describe('workflow Module - Error Handling', () => {
  test('should create standard retry policy', () => {
    const retry = Workflow.RetryPolicies.standard()

    expect(retry.ErrorEquals).toContain('States.ALL')
    expect(retry.IntervalSeconds).toBe(2)
    expect(retry.MaxAttempts).toBe(3)
    expect(retry.BackoffRate).toBe(2.0)
  })

  test('should create aggressive retry policy', () => {
    const retry = Workflow.RetryPolicies.aggressive()

    expect(retry.ErrorEquals).toContain('States.TaskFailed')
    expect(retry.IntervalSeconds).toBe(1)
    expect(retry.MaxAttempts).toBe(5)
    expect(retry.BackoffRate).toBe(1.5)
  })

  test('should create custom retry policy', () => {
    const retry = Workflow.RetryPolicies.custom(
      ['CustomError'],
      5,
      10,
      1.8,
    )

    expect(retry.ErrorEquals).toEqual(['CustomError'])
    expect(retry.IntervalSeconds).toBe(5)
    expect(retry.MaxAttempts).toBe(10)
    expect(retry.BackoffRate).toBe(1.8)
  })

  test('should create catch all policy', () => {
    const catchPolicy = Workflow.CatchPolicies.all('ErrorHandler')

    expect(catchPolicy.ErrorEquals).toContain('States.ALL')
    expect(catchPolicy.Next).toBe('ErrorHandler')
    expect(catchPolicy.ResultPath).toBe('$.error')
  })

  test('should create specific catch policy', () => {
    const catchPolicy = Workflow.CatchPolicies.specific(
      ['CustomError', 'AnotherError'],
      'SpecificHandler',
      '$.customError',
    )

    expect(catchPolicy.ErrorEquals).toEqual(['CustomError', 'AnotherError'])
    expect(catchPolicy.Next).toBe('SpecificHandler')
    expect(catchPolicy.ResultPath).toBe('$.customError')
  })

  test('should apply retry and catch to task', () => {
    const task = Workflow.createLambdaTask(
      'arn:aws:lambda:us-east-1:123456789012:function:my-function',
      {
        retry: [Workflow.RetryPolicies.standard()],
        catch: [Workflow.CatchPolicies.all('ErrorHandler')],
        end: true,
      },
    )

    expect(task.Retry).toHaveLength(1)
    expect(task.Catch).toHaveLength(1)
    expect(task.Retry?.[0].ErrorEquals).toContain('States.ALL')
    expect(task.Catch?.[0].Next).toBe('ErrorHandler')
  })
})

describe('workflow Module - Common Patterns', () => {
  test('should create sequential workflow pattern', () => {
    const definition = Workflow.Patterns.sequential(slug, environment, [
      { name: 'Step1', state: Workflow.createPassState({ result: 'Step 1' }) },
      { name: 'Step2', state: Workflow.createPassState({ result: 'Step 2' }) },
      { name: 'Step3', state: Workflow.createPassState({ result: 'Step 3' }) },
    ])

    expect(definition.StartAt).toBe('Step1')
    expect(Object.keys(definition.States)).toHaveLength(3)
    expect(definition.States.Step1.Next).toBe('Step2')
    expect(definition.States.Step2.Next).toBe('Step3')
    expect(definition.States.Step3.End).toBe(true)
  })

  test('should create fan-out workflow pattern', () => {
    const branch1 = {
      StartAt: 'Branch1',
      States: {
        Branch1: Workflow.createPassState({ result: 'Branch 1', end: true }),
      },
    }

    const branch2 = {
      StartAt: 'Branch2',
      States: {
        Branch2: Workflow.createPassState({ result: 'Branch 2', end: true }),
      },
    }

    const definition = Workflow.Patterns.fanout(slug, environment, [
      { name: 'Branch1', definition: branch1 },
      { name: 'Branch2', definition: branch2 },
    ])

    expect(definition.StartAt).toBe('Parallel')
    expect(definition.States.Parallel.Type).toBe('Parallel')
    expect(definition.States.Parallel.Branches).toHaveLength(2)
    expect(definition.States.Parallel.End).toBe(true)
  })

  test('should create map workflow pattern', () => {
    const itemProcessor = {
      StartAt: 'ProcessItem',
      States: {
        ProcessItem: Workflow.createPassState({ result: 'Processed', end: true }),
      },
    }

    const definition = Workflow.Patterns.map(slug, environment, itemProcessor, 10)

    expect(definition.StartAt).toBe('Map')
    expect(definition.States.Map.Type).toBe('Map')
    expect(definition.States.Map.Iterator).toEqual(itemProcessor)
    expect(definition.States.Map.MaxConcurrency).toBe(10)
    expect(definition.States.Map.End).toBe(true)
  })

  test('should create error handling workflow pattern', () => {
    const mainTask = Workflow.createLambdaTask(
      'arn:aws:lambda:us-east-1:123456789012:function:my-function',
    )

    const errorHandler = Workflow.createFailState('ProcessingError', 'Failed to process')

    const definition = Workflow.Patterns.withErrorHandling(
      slug,
      environment,
      mainTask,
      errorHandler,
    )

    expect(definition.StartAt).toBe('Main')
    expect(definition.States.Main.Catch).toHaveLength(1)
    expect(definition.States.Main.Catch?.[0].Next).toBe('ErrorHandler')
    expect(definition.States.ErrorHandler).toEqual(errorHandler)
    expect(definition.States.Success.Type).toBe('Succeed')
  })
})

describe('workflow Module - Integration with TemplateBuilder', () => {
  test('should add state machine to template', () => {
    const builder = new TemplateBuilder()

    const definition = {
      StartAt: 'HelloWorld',
      States: {
        HelloWorld: Workflow.createPassState({ result: 'Hello World', end: true }),
      },
    }

    const { stateMachine, logicalId, role, roleLogicalId } = Workflow.createStateMachine({
      slug,
      environment,
      definition,
    })

    if (role && roleLogicalId) {
      builder.addResource(roleLogicalId, role)
    }

    builder.addResource(logicalId, stateMachine)

    const template = builder.build()

    expect(template.Resources[logicalId]).toBeDefined()
    expect(template.Resources[logicalId].Type).toBe('AWS::StepFunctions::StateMachine')

    if (roleLogicalId) {
      expect(template.Resources[roleLogicalId]).toBeDefined()
      expect(template.Resources[roleLogicalId].Type).toBe('AWS::IAM::Role')
    }
  })

  test('should create complex workflow with multiple state types', () => {
    const builder = new TemplateBuilder()

    const definition = {
      StartAt: 'Initialize',
      States: {
        Initialize: Workflow.createPassState({
          result: { status: 'initialized' },
          resultPath: '$.init',
          next: 'Wait',
        }),
        Wait: Workflow.createWaitState({
          seconds: 5,
          next: 'ProcessItems',
        }),
        ProcessItems: Workflow.createMapState(
          {
            StartAt: 'ProcessItem',
            States: {
              ProcessItem: Workflow.createLambdaTask(
                'arn:aws:lambda:us-east-1:123456789012:function:processor',
                { end: true },
              ),
            },
          },
          {
            maxConcurrency: 5,
            next: 'CheckResults',
          },
        ),
        CheckResults: Workflow.createChoiceState(
          [
            {
              Variable: '$.success',
              BooleanEquals: true,
              Next: 'Success',
            },
            {
              Variable: '$.success',
              BooleanEquals: false,
              Next: 'Failed',
            },
          ],
        ),
        Success: Workflow.createSucceedState(),
        Failed: Workflow.createFailState('ProcessingFailed', 'Items failed to process'),
      },
    }

    const { stateMachine, logicalId, role, roleLogicalId } = Workflow.createStateMachine({
      slug,
      environment,
      definition,
    })

    if (role && roleLogicalId) {
      builder.addResource(roleLogicalId, role)
    }

    builder.addResource(logicalId, stateMachine)

    const template = builder.build()
    const parsedDefinition = JSON.parse(
      template.Resources[logicalId].Properties.DefinitionString,
    )

    expect(parsedDefinition.States.Initialize.Type).toBe('Pass')
    expect(parsedDefinition.States.Wait.Type).toBe('Wait')
    expect(parsedDefinition.States.ProcessItems.Type).toBe('Map')
    expect(parsedDefinition.States.CheckResults.Type).toBe('Choice')
    expect(parsedDefinition.States.Success.Type).toBe('Succeed')
    expect(parsedDefinition.States.Failed.Type).toBe('Fail')
  })
})
