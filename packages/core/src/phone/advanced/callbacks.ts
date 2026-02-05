/**
 * Callback Requests and Queue Management
 *
 * Provides callback scheduling and queue management
*/

export interface CallbackRequest {
  id: string
  phoneNumber: string
  customerName?: string
  reason?: string
  preferredTime?: string
  queueId?: string
  priority: number
  status: 'pending' | 'scheduled' | 'in-progress' | 'completed' | 'failed' | 'cancelled'
  attempts: number
  maxAttempts: number
  createdAt: string
  scheduledFor?: string
  completedAt?: string
  notes?: string
}

export interface QueuePosition {
  position: number
  estimatedWaitTime: number
  callersAhead: number
}

/**
 * Callback Module
*/
export class Callbacks {
  /**
   * Lambda code for callback request handling
  */
  static CallbackRequestCode = `
const { DynamoDBClient, PutItemCommand, QueryCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { ConnectClient, StartOutboundVoiceContactCommand } = require('@aws-sdk/client-connect');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const dynamodb = new DynamoDBClient({});
const connect = new ConnectClient({});
const sns = new SNSClient({});

const CALLBACKS_TABLE = process.env.CALLBACKS_TABLE;
const CONNECT_INSTANCE_ID = process.env.CONNECT_INSTANCE_ID;
const CONTACT_FLOW_ID = process.env.CONTACT_FLOW_ID;
const SOURCE_PHONE_NUMBER = process.env.SOURCE_PHONE_NUMBER;
const NOTIFICATION_TOPIC_ARN = process.env.NOTIFICATION_TOPIC_ARN;

exports.handler = async (event) => {
  console.log('Callback request event:', JSON.stringify(event, null, 2));

  const { httpMethod, body, pathParameters } = event;

  try {
    switch (httpMethod) {
      case 'POST':
        return await createCallbackRequest(JSON.parse(body || '{}'));
      case 'GET':
        if (pathParameters?.id) {
          return await getCallbackRequest(pathParameters.id);
        }
        return await listCallbackRequests(event.queryStringParameters);
      case 'DELETE':
        return await cancelCallbackRequest(pathParameters?.id);
      default:
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

async function createCallbackRequest(data) {
  const id = \`cb-\${Date.now()}-\${Math.random().toString(36).substr(2, 9)}\`;
  const now = new Date().toISOString();

  const callback = {
    id: { S: id },
    phoneNumber: { S: data.phoneNumber },
    customerName: { S: data.customerName || '' },
    reason: { S: data.reason || '' },
    preferredTime: { S: data.preferredTime || '' },
    queueId: { S: data.queueId || '' },
    priority: { N: String(data.priority || 5) },
    status: { S: 'pending' },
    attempts: { N: '0' },
    maxAttempts: { N: String(data.maxAttempts || 3) },
    createdAt: { S: now },
    ttl: { N: String(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60) },
  };

  await dynamodb.send(new PutItemCommand({
    TableName: CALLBACKS_TABLE,
    Item: callback,
  }));

  // Send notification
  if (NOTIFICATION_TOPIC_ARN) {
    await sns.send(new PublishCommand({
      TopicArn: NOTIFICATION_TOPIC_ARN,
      Subject: 'New Callback Request',
      Message: JSON.stringify({
        type: 'callback_request',
        id,
        phoneNumber: data.phoneNumber,
        customerName: data.customerName,
        reason: data.reason,
        timestamp: now,
      }, null, 2),
    }));
  }

  return {
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, status: 'pending', createdAt: now }),
  };
}

async function getCallbackRequest(id) {
  const result = await dynamodb.send(new GetItemCommand({
    TableName: CALLBACKS_TABLE,
    Key: { id: { S: id } },
  }));

  if (!result.Item) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(unmarshallCallback(result.Item)),
  };
}

async function listCallbackRequests(params) {
  const result = await dynamodb.send(new ScanCommand({
    TableName: CALLBACKS_TABLE,
    FilterExpression: '#status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': { S: params?.status || 'pending' },
    },
  }));

  const callbacks = (result.Items || []).map(unmarshallCallback);
  callbacks.sort((a, b) => a.priority - b.priority);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(callbacks),
  };
}

async function cancelCallbackRequest(id) {
  await dynamodb.send(new UpdateItemCommand({
    TableName: CALLBACKS_TABLE,
    Key: { id: { S: id } },
    UpdateExpression: 'SET #status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': { S: 'cancelled' },
    },
  }));

  return { statusCode: 200, body: JSON.stringify({ id, status: 'cancelled' }) };
}

function unmarshallCallback(item) {
  return {
    id: item.id.S,
    phoneNumber: item.phoneNumber.S,
    customerName: item.customerName?.S,
    reason: item.reason?.S,
    preferredTime: item.preferredTime?.S,
    queueId: item.queueId?.S,
    priority: parseInt(item.priority?.N || '5'),
    status: item.status.S,
    attempts: parseInt(item.attempts?.N || '0'),
    maxAttempts: parseInt(item.maxAttempts?.N || '3'),
    createdAt: item.createdAt.S,
    scheduledFor: item.scheduledFor?.S,
    completedAt: item.completedAt?.S,
  };
}
`

  /**
   * Lambda code for processing callbacks
  */
  static CallbackProcessorCode = `
const { DynamoDBClient, ScanCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { ConnectClient, StartOutboundVoiceContactCommand } = require('@aws-sdk/client-connect');

const dynamodb = new DynamoDBClient({});
const connect = new ConnectClient({});

const CALLBACKS_TABLE = process.env.CALLBACKS_TABLE;
const CONNECT_INSTANCE_ID = process.env.CONNECT_INSTANCE_ID;
const CONTACT_FLOW_ID = process.env.CONTACT_FLOW_ID;
const SOURCE_PHONE_NUMBER = process.env.SOURCE_PHONE_NUMBER;
const QUEUE_ID = process.env.QUEUE_ID;

exports.handler = async (event) => {
  console.log('Callback processor event:', JSON.stringify(event, null, 2));

  try {
    // Get pending callbacks
    const result = await dynamodb.send(new ScanCommand({
      TableName: CALLBACKS_TABLE,
      FilterExpression: '#status = :pending',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':pending': { S: 'pending' },
      },
    }));

    const callbacks = result.Items || [];

    // Sort by priority and creation time
    callbacks.sort((a, b) => {
      const priorityDiff = parseInt(a.priority?.N || '5') - parseInt(b.priority?.N || '5');
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(a.createdAt.S) - new Date(b.createdAt.S);
    });

    // Process up to 5 callbacks at a time
    const toProcess = callbacks.slice(0, 5);

    for (const callback of toProcess) {
      const id = callback.id.S;
      const phoneNumber = callback.phoneNumber.S;
      const attempts = parseInt(callback.attempts?.N || '0');
      const maxAttempts = parseInt(callback.maxAttempts?.N || '3');

      // Check if preferred time has passed
      if (callback.preferredTime?.S) {
        const preferredTime = new Date(callback.preferredTime.S);
        if (preferredTime > new Date()) {
          console.log(\`Skipping callback \${id} - preferred time not reached\`);
          continue;
        }
      }

      try {
        // Update status to in-progress
        await dynamodb.send(new UpdateItemCommand({
          TableName: CALLBACKS_TABLE,
          Key: { id: { S: id } },
          UpdateExpression: 'SET #status = :status, attempts = :attempts',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': { S: 'in-progress' },
            ':attempts': { N: String(attempts + 1) },
          },
        }));

        // Initiate outbound call
        await connect.send(new StartOutboundVoiceContactCommand({
          InstanceId: CONNECT_INSTANCE_ID,
          ContactFlowId: CONTACT_FLOW_ID,
          DestinationPhoneNumber: phoneNumber,
          SourcePhoneNumber: SOURCE_PHONE_NUMBER,
          QueueId: QUEUE_ID,
          Attributes: {
            callbackId: id,
            customerName: callback.customerName?.S || '',
            reason: callback.reason?.S || '',
          },
        }));

        console.log(\`Initiated callback to \${phoneNumber}\`);

        // Mark as completed (will be updated by call result handler)
        await dynamodb.send(new UpdateItemCommand({
          TableName: CALLBACKS_TABLE,
          Key: { id: { S: id } },
          UpdateExpression: 'SET #status = :status, completedAt = :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': { S: 'completed' },
            ':now': { S: new Date().toISOString() },
          },
        }));

      } catch (callError) {
        console.error(\`Failed to call \${phoneNumber}:\`, callError);

        // Check if max attempts reached
        if (attempts + 1 >= maxAttempts) {
          await dynamodb.send(new UpdateItemCommand({
            TableName: CALLBACKS_TABLE,
            Key: { id: { S: id } },
            UpdateExpression: 'SET #status = :status, error = :error',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':status': { S: 'failed' },
              ':error': { S: callError.message },
            },
          }));
        } else {
          // Reset to pending for retry
          await dynamodb.send(new UpdateItemCommand({
            TableName: CALLBACKS_TABLE,
            Key: { id: { S: id } },
            UpdateExpression: 'SET #status = :status',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':status': { S: 'pending' },
            },
          }));
        }
      }
    }

    return { statusCode: 200, processed: toProcess.length };
  } catch (error) {
    console.error('Error processing callbacks:', error);
    return { statusCode: 500, error: error.message };
  }
};
`

  /**
   * Create callbacks DynamoDB table
  */
  static createCallbacksTable(config: { slug: string }): Record<string, any> {
    return {
      [`${config.slug}CallbacksTable`]: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${config.slug}-callbacks`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'id', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'id', KeyType: 'HASH' },
          ],
          TimeToLiveSpecification: {
            AttributeName: 'ttl',
            Enabled: true,
          },
        },
      },
    }
  }

  /**
   * Create callback request Lambda
  */
  static createCallbackRequestLambda(config: {
    slug: string
    roleArn: string
    callbacksTable: string
    notificationTopicArn?: string
  }): Record<string, any> {
    return {
      [`${config.slug}CallbackRequestLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-callback-request`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 30,
          MemorySize: 256,
          Code: {
            ZipFile: Callbacks.CallbackRequestCode,
          },
          Environment: {
            Variables: {
              CALLBACKS_TABLE: config.callbacksTable,
              NOTIFICATION_TOPIC_ARN: config.notificationTopicArn || '',
            },
          },
        },
      },
    }
  }

  /**
   * Create callback processor Lambda
  */
  static createCallbackProcessorLambda(config: {
    slug: string
    roleArn: string
    callbacksTable: string
    connectInstanceId: string
    contactFlowId: string
    sourcePhoneNumber: string
    queueId?: string
  }): Record<string, any> {
    return {
      [`${config.slug}CallbackProcessorLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-callback-processor`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 300,
          MemorySize: 256,
          Code: {
            ZipFile: Callbacks.CallbackProcessorCode,
          },
          Environment: {
            Variables: {
              CALLBACKS_TABLE: config.callbacksTable,
              CONNECT_INSTANCE_ID: config.connectInstanceId,
              CONTACT_FLOW_ID: config.contactFlowId,
              SOURCE_PHONE_NUMBER: config.sourcePhoneNumber,
              QUEUE_ID: config.queueId || '',
            },
          },
        },
      },
    }
  }
}

export default Callbacks
