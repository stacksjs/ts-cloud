/**
 * Shared Mailboxes for Teams
 *
 * Provides shared mailbox functionality with team access
*/

export interface SharedMailbox {
  id: string
  address: string
  displayName: string
  description?: string
  members: MailboxMember[]
  settings: MailboxSettings
  createdAt: string
  updatedAt: string
}

export interface MailboxMember {
  userId: string
  email: string
  name?: string
  role: 'owner' | 'admin' | 'member' | 'viewer'
  permissions: MailboxPermissions
  addedAt: string
  addedBy: string
}

export interface MailboxPermissions {
  read: boolean
  send: boolean
  delete: boolean
  manage: boolean
  assignTo: boolean
}

export interface MailboxSettings {
  autoAssign: boolean
  assignmentStrategy: 'round-robin' | 'least-busy' | 'manual'
  notifyOnNew: boolean
  notifyMembers: string[]
  signature?: string
  autoResponder?: {
    enabled: boolean
    subject: string
    body: string
  }
}

export interface MailboxAssignment {
  messageId: string
  assignedTo: string
  assignedBy: string
  assignedAt: string
  status: 'open' | 'in-progress' | 'resolved' | 'closed'
  notes?: string
}

/**
 * Shared Mailboxes Module
*/
export class SharedMailboxes {
  /**
   * Lambda code for shared mailbox management
  */
  static SharedMailboxLambdaCode = `
const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

const s3 = new S3Client({});
const dynamodb = new DynamoDBClient({});
const EMAIL_BUCKET = process.env.EMAIL_BUCKET;
const MAILBOX_TABLE = process.env.MAILBOX_TABLE;

exports.handler = async (event) => {
  console.log('Shared mailbox event:', JSON.stringify(event, null, 2));

  const { httpMethod, path, body, pathParameters } = event;
  const mailboxId = pathParameters?.mailboxId;

  try {
    switch (\`\${httpMethod} \${path.split('/')[1]}\`) {
      case 'GET mailboxes':
        return await listMailboxes();
      case 'GET mailbox':
        return await getMailbox(mailboxId);
      case 'POST mailboxes':
        return await createMailbox(JSON.parse(body));
      case 'PUT mailbox':
        return await updateMailbox(mailboxId, JSON.parse(body));
      case 'DELETE mailbox':
        return await deleteMailbox(mailboxId);
      case 'POST assign':
        return await assignMessage(mailboxId, JSON.parse(body));
      case 'GET messages':
        return await getMailboxMessages(mailboxId, event.queryStringParameters);
      default:
        return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
    }
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

async function listMailboxes() {
  const result = await dynamodb.send(new QueryCommand({
    TableName: MAILBOX_TABLE,
    IndexName: 'type-index',
    KeyConditionExpression: '#type = :type',
    ExpressionAttributeNames: { '#type': 'type' },
    ExpressionAttributeValues: { ':type': { S: 'mailbox' } },
  }));

  const mailboxes = result.Items?.map(item => ({
    id: item.id.S,
    address: item.address.S,
    displayName: item.displayName.S,
    memberCount: item.memberCount?.N || 0,
  })) || [];

  return {
    statusCode: 200,
    body: JSON.stringify(mailboxes),
  };
}

async function getMailbox(mailboxId) {
  const result = await dynamodb.send(new GetItemCommand({
    TableName: MAILBOX_TABLE,
    Key: { id: { S: mailboxId } },
  }));

  if (!result.Item) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Mailbox not found' }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify(unmarshallMailbox(result.Item)),
  };
}

async function createMailbox(data) {
  const id = \`mb-\${Date.now()}-\${Math.random().toString(36).substr(2, 9)}\`;
  const now = new Date().toISOString();

  const mailbox = {
    id: { S: id },
    type: { S: 'mailbox' },
    address: { S: data.address },
    displayName: { S: data.displayName },
    description: { S: data.description || '' },
    members: { S: JSON.stringify(data.members || []) },
    settings: { S: JSON.stringify(data.settings || {}) },
    memberCount: { N: String((data.members || []).length) },
    createdAt: { S: now },
    updatedAt: { S: now },
  };

  await dynamodb.send(new PutItemCommand({
    TableName: MAILBOX_TABLE,
    Item: mailbox,
  }));

  return {
    statusCode: 201,
    body: JSON.stringify({ id, ...data, createdAt: now }),
  };
}

async function updateMailbox(mailboxId, data) {
  const now = new Date().toISOString();

  await dynamodb.send(new UpdateItemCommand({
    TableName: MAILBOX_TABLE,
    Key: { id: { S: mailboxId } },
    UpdateExpression: 'SET displayName = :name, description = :desc, members = :members, settings = :settings, memberCount = :count, updatedAt = :now',
    ExpressionAttributeValues: {
      ':name': { S: data.displayName },
      ':desc': { S: data.description || '' },
      ':members': { S: JSON.stringify(data.members || []) },
      ':settings': { S: JSON.stringify(data.settings || {}) },
      ':count': { N: String((data.members || []).length) },
      ':now': { S: now },
    },
  }));

  return {
    statusCode: 200,
    body: JSON.stringify({ id: mailboxId, ...data, updatedAt: now }),
  };
}

async function deleteMailbox(mailboxId) {
  await dynamodb.send(new DeleteItemCommand({
    TableName: MAILBOX_TABLE,
    Key: { id: { S: mailboxId } },
  }));

  return { statusCode: 204, body: '' };
}

async function assignMessage(mailboxId, data) {
  const { messageId, assignedTo, assignedBy, notes } = data;
  const now = new Date().toISOString();

  await dynamodb.send(new PutItemCommand({
    TableName: MAILBOX_TABLE,
    Item: {
      id: { S: \`assign-\${messageId}\` },
      type: { S: 'assignment' },
      mailboxId: { S: mailboxId },
      messageId: { S: messageId },
      assignedTo: { S: assignedTo },
      assignedBy: { S: assignedBy },
      assignedAt: { S: now },
      status: { S: 'open' },
      notes: { S: notes || '' },
    },
  }));

  return {
    statusCode: 200,
    body: JSON.stringify({ messageId, assignedTo, status: 'open' }),
  };
}

async function getMailboxMessages(mailboxId, queryParams) {
  const mailbox = await getMailbox(mailboxId);
  if (mailbox.statusCode !== 200) return mailbox;

  const mailboxData = JSON.parse(mailbox.body);
  const [localPart, domain] = mailboxData.address.split('@');

  // Get inbox from S3
  const inboxKey = \`mailboxes/\${domain}/\${localPart}/inbox.json\`;
  try {
    const result = await s3.send(new GetObjectCommand({
      Bucket: EMAIL_BUCKET,
      Key: inboxKey,
    }));

    const inbox = JSON.parse(await result.Body.transformToString());

    // Get assignments
    const assignmentResult = await dynamodb.send(new QueryCommand({
      TableName: MAILBOX_TABLE,
      IndexName: 'mailbox-index',
      KeyConditionExpression: 'mailboxId = :mailboxId AND begins_with(id, :prefix)',
      ExpressionAttributeValues: {
        ':mailboxId': { S: mailboxId },
        ':prefix': { S: 'assign-' },
      },
    }));

    const assignments = {};
    for (const item of assignmentResult.Items || []) {
      assignments[item.messageId.S] = {
        assignedTo: item.assignedTo.S,
        status: item.status.S,
      };
    }

    // Merge assignments with inbox
    const messages = inbox.map(msg => ({
      ...msg,
      assignment: assignments[msg.messageId] || null,
    }));

    return {
      statusCode: 200,
      body: JSON.stringify(messages),
    };
  } catch (error) {
    if (error.name === 'NoSuchKey') {
      return { statusCode: 200, body: JSON.stringify([]) };
    }
    throw error;
  }
}

function unmarshallMailbox(item) {
  return {
    id: item.id.S,
    address: item.address.S,
    displayName: item.displayName.S,
    description: item.description?.S,
    members: JSON.parse(item.members?.S || '[]'),
    settings: JSON.parse(item.settings?.S || '{}'),
    createdAt: item.createdAt.S,
    updatedAt: item.updatedAt.S,
  };
}
`

  /**
   * Create shared mailbox DynamoDB table
  */
  static createMailboxTable(config: { slug: string }): Record<string, any> {
    return {
      [`${config.slug}SharedMailboxTable`]: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${config.slug}-shared-mailboxes`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'id', AttributeType: 'S' },
            { AttributeName: 'type', AttributeType: 'S' },
            { AttributeName: 'mailboxId', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'id', KeyType: 'HASH' },
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: 'type-index',
              KeySchema: [
                { AttributeName: 'type', KeyType: 'HASH' },
              ],
              Projection: { ProjectionType: 'ALL' },
            },
            {
              IndexName: 'mailbox-index',
              KeySchema: [
                { AttributeName: 'mailboxId', KeyType: 'HASH' },
                { AttributeName: 'id', KeyType: 'RANGE' },
              ],
              Projection: { ProjectionType: 'ALL' },
            },
          ],
        },
      },
    }
  }

  /**
   * Create shared mailbox Lambda
  */
  static createSharedMailboxLambda(config: {
    slug: string
    roleArn: string
    emailBucket: string
    mailboxTable: string
  }): Record<string, any> {
    return {
      [`${config.slug}SharedMailboxLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-shared-mailbox`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 30,
          MemorySize: 256,
          Code: {
            ZipFile: SharedMailboxes.SharedMailboxLambdaCode,
          },
          Environment: {
            Variables: {
              EMAIL_BUCKET: config.emailBucket,
              MAILBOX_TABLE: config.mailboxTable,
            },
          },
        },
      },
    }
  }

  /**
   * Default permission sets
  */
  static readonly PermissionSets = {
    owner: {
      read: true,
      send: true,
      delete: true,
      manage: true,
      assignTo: true,
    },
    admin: {
      read: true,
      send: true,
      delete: true,
      manage: true,
      assignTo: true,
    },
    member: {
      read: true,
      send: true,
      delete: false,
      manage: false,
      assignTo: true,
    },
    viewer: {
      read: true,
      send: false,
      delete: false,
      manage: false,
      assignTo: false,
    },
  } as const
}

export default SharedMailboxes
