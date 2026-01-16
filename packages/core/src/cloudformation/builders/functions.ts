import type { CloudFormationBuilder } from '../builder'
import { Arn, Fn } from '../types'

export interface FunctionEvent {
  type: 'http' | 's3' | 'sqs' | 'sns' | 'kinesis' | 'dynamodb-stream' | 'schedule'
  path?: string
  method?: string
  bucket?: string
  filterPrefix?: string
  filterSuffix?: string
  queueName?: string
  streamName?: string
  tableName?: string
  batchSize?: number
  startingPosition?: 'LATEST' | 'TRIM_HORIZON'
  parallelizationFactor?: number
  expression?: string // cron or rate expression
}

export interface FunctionItem {
  name: string
  runtime: string
  handler: string
  memory: number
  timeout: number
  events?: FunctionEvent[]
  environment?: Record<string, string>
}

export interface FunctionsConfig {
  [category: string]: FunctionItem[]
}

/**
 * Add Lambda function resources to CloudFormation template
 */
export function addFunctionResources(
  builder: CloudFormationBuilder,
  config: FunctionsConfig,
): void {
  for (const [category, functions] of Object.entries(config)) {
    functions.forEach(func => {
      addLambdaFunction(builder, func, category)
    })
  }
}

/**
 * Add a single Lambda function
 */
function addLambdaFunction(
  builder: CloudFormationBuilder,
  config: FunctionItem,
  category: string,
): void {
  const logicalId = builder.toLogicalId(`${category}-${config.name}-function`)

  // Lambda Execution Role
  const roleName = `${logicalId}Role`
  builder.addResource(roleName, 'AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: { Service: 'lambda.amazonaws.com' },
        Action: 'sts:AssumeRole',
      }],
    },
    ManagedPolicyArns: [
      'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
    ],
    Policies: [{
      PolicyName: 'LambdaExecutionPolicy',
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          // Add specific permissions based on events
          ...generateEventPermissions(config.events || []),
        ],
      },
    }],
    Tags: [
      { Key: 'Name', Value: Fn.sub(`\${AWS::StackName}-${config.name}-role`) },
    ],
  })

  // Lambda Function
  const functionProperties: Record<string, any> = {
    FunctionName: Fn.sub(`\${AWS::StackName}-${config.name}`),
    Runtime: config.runtime,
    Handler: config.handler,
    Role: Fn.getAtt(roleName, 'Arn'),
    MemorySize: config.memory,
    Timeout: config.timeout,
    Code: {
      // In production, this would point to S3 or use inline code
      ZipFile: `exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  return { statusCode: 200, body: 'Function not yet implemented' };
};`,
    },
    Environment: config.environment ? {
      Variables: config.environment,
    } : undefined,
    Tags: [
      { Key: 'Name', Value: Fn.sub(`\${AWS::StackName}-${config.name}`) },
    ],
  }

  // VPC configuration if needed
  if (category !== 'edge') { // Edge functions can't be in VPC
    functionProperties.VpcConfig = {
      SubnetIds: [
        Fn.ref('PrivateSubnet1'),
        Fn.ref('PrivateSubnet2'),
      ],
      SecurityGroupIds: [Fn.ref('AppSecurityGroup')],
    }
  }

  builder.addResource(logicalId, 'AWS::Lambda::Function', functionProperties, {
    dependsOn: roleName,
  })

  // Log Group
  builder.addResource(`${logicalId}LogGroup`, 'AWS::Logs::LogGroup', {
    LogGroupName: Fn.sub(`/aws/lambda/\${AWS::StackName}-${config.name}`),
    RetentionInDays: 14,
  })

  // Event source mappings
  if (config.events) {
    config.events.forEach((event, index) => {
      addEventSource(builder, logicalId, event, index)
    })
  }

  // Output
  builder.addOutputs({
    [`${logicalId}Arn`]: {
      Description: `${config.name} function ARN`,
      Value: Fn.getAtt(logicalId, 'Arn'),
      Export: {
        Name: Fn.sub(`\${AWS::StackName}-${config.name}-function-arn`),
      },
    },
  })
}

/**
 * Add event source mapping for Lambda function
 */
function addEventSource(
  builder: CloudFormationBuilder,
  functionLogicalId: string,
  event: FunctionEvent,
  index: number,
): void {
  const eventSourceId = `${functionLogicalId}EventSource${index}`

  switch (event.type) {
    case 'http':
      // HTTP events are handled by API Gateway (not created here)
      break

    case 's3':
      if (event.bucket) {
        const bucketLogicalId = builder.toLogicalId(`${event.bucket}-bucket`)

        // Lambda permission for S3
        builder.addResource(`${eventSourceId}Permission`, 'AWS::Lambda::Permission', {
          FunctionName: Fn.ref(functionLogicalId),
          Action: 'lambda:InvokeFunction',
          Principal: 's3.amazonaws.com',
          SourceArn: Arn.s3Bucket(Fn.ref(bucketLogicalId) as any),
        }, {
          dependsOn: [functionLogicalId, bucketLogicalId],
        })

        // Note: S3 bucket notification configuration should be added to the bucket itself
      }
      break

    case 'sqs':
      if (event.queueName) {
        const queueLogicalId = builder.toLogicalId(`${event.queueName}-queue`)

        builder.addResource(eventSourceId, 'AWS::Lambda::EventSourceMapping', {
          EventSourceArn: Fn.getAtt(queueLogicalId, 'Arn'),
          FunctionName: Fn.ref(functionLogicalId),
          BatchSize: event.batchSize || 10,
        }, {
          dependsOn: [functionLogicalId, queueLogicalId],
        })
      }
      break

    case 'kinesis':
      if (event.streamName) {
        const streamLogicalId = builder.toLogicalId(`${event.streamName}-stream`)

        builder.addResource(eventSourceId, 'AWS::Lambda::EventSourceMapping', {
          EventSourceArn: Fn.getAtt(streamLogicalId, 'Arn'),
          FunctionName: Fn.ref(functionLogicalId),
          BatchSize: event.batchSize || 100,
          StartingPosition: event.startingPosition || 'LATEST',
          ParallelizationFactor: event.parallelizationFactor || 1,
        }, {
          dependsOn: [functionLogicalId, streamLogicalId],
        })
      }
      break

    case 'dynamodb-stream':
      if (event.tableName) {
        const tableLogicalId = builder.toLogicalId(`${event.tableName}-table`)

        builder.addResource(eventSourceId, 'AWS::Lambda::EventSourceMapping', {
          EventSourceArn: Fn.getAtt(tableLogicalId, 'StreamArn'),
          FunctionName: Fn.ref(functionLogicalId),
          BatchSize: event.batchSize || 100,
          StartingPosition: event.startingPosition || 'LATEST',
        }, {
          dependsOn: [functionLogicalId, tableLogicalId],
        })
      }
      break

    case 'schedule':
      if (event.expression) {
        // EventBridge Rule
        builder.addResource(`${eventSourceId}Rule`, 'AWS::Events::Rule', {
          ScheduleExpression: event.expression,
          State: 'ENABLED',
          Targets: [{
            Arn: Fn.getAtt(functionLogicalId, 'Arn'),
            Id: `${functionLogicalId}Target`,
          }],
        }, {
          dependsOn: functionLogicalId,
        })

        // Lambda permission for EventBridge
        builder.addResource(`${eventSourceId}Permission`, 'AWS::Lambda::Permission', {
          FunctionName: Fn.ref(functionLogicalId),
          Action: 'lambda:InvokeFunction',
          Principal: 'events.amazonaws.com',
          SourceArn: Fn.getAtt(`${eventSourceId}Rule`, 'Arn'),
        }, {
          dependsOn: [functionLogicalId, `${eventSourceId}Rule`],
        })
      }
      break
  }
}

/**
 * Generate IAM policy statements based on function events
 */
function generateEventPermissions(
  events: FunctionEvent[] | undefined,
): any[] {
  const statements: any[] = []

  if (!events) {
    return statements
  }

  events.forEach(event => {
    switch (event.type) {
      case 's3':
        statements.push({
          Effect: 'Allow',
          Action: [
            's3:GetObject',
            's3:GetObjectVersion',
          ],
          Resource: event.bucket ? `arn:aws:s3:::${event.bucket}/*` : 'arn:aws:s3:::*/*',
        })
        break

      case 'sqs':
        statements.push({
          Effect: 'Allow',
          Action: [
            'sqs:ReceiveMessage',
            'sqs:DeleteMessage',
            'sqs:GetQueueAttributes',
          ],
          Resource: event.queueName
            ? Arn.sqs(event.queueName)
            : 'arn:aws:sqs:*:*:*',
        })
        break

      case 'kinesis':
        statements.push({
          Effect: 'Allow',
          Action: [
            'kinesis:GetRecords',
            'kinesis:GetShardIterator',
            'kinesis:DescribeStream',
            'kinesis:ListStreams',
          ],
          Resource: event.streamName
            ? Arn.kinesis(event.streamName)
            : 'arn:aws:kinesis:*:*:stream/*',
        })
        break

      case 'dynamodb-stream':
        statements.push({
          Effect: 'Allow',
          Action: [
            'dynamodb:GetRecords',
            'dynamodb:GetShardIterator',
            'dynamodb:DescribeStream',
            'dynamodb:ListStreams',
          ],
          Resource: event.tableName
            ? Fn.sub(`arn:aws:dynamodb:\${AWS::Region}:\${AWS::AccountId}:table/${event.tableName}/stream/*`)
            : 'arn:aws:dynamodb:*:*:table/*/stream/*',
        })
        break
    }
  })

  // Default permissions
  if (statements.length === 0) {
    statements.push({
      Effect: 'Allow',
      Action: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      Resource: 'arn:aws:logs:*:*:*',
    })
  }

  return statements
}
