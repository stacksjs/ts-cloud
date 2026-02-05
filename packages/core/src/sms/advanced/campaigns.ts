/**
 * SMS Campaigns and Scheduling
 *
 * Provides campaign management and scheduled SMS sending
 */

export interface SmsCampaign {
  id: string
  name: string
  description?: string
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled'
  message: {
    body: string
    template?: string
    variables?: string[]
  }
  audience: CampaignAudience
  schedule: CampaignSchedule
  settings: CampaignSettings
  stats: CampaignStats
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
}

export interface CampaignAudience {
  type: 'list' | 'segment' | 'all'
  listId?: string
  segmentId?: string
  filters?: AudienceFilter[]
  estimatedSize?: number
}

export interface AudienceFilter {
  field: string
  operator: 'equals' | 'not-equals' | 'contains' | 'greater-than' | 'less-than'
  value: string
}

export interface CampaignSchedule {
  type: 'immediate' | 'scheduled' | 'recurring'
  scheduledFor?: string
  timezone?: string
  recurrence?: {
    frequency: 'daily' | 'weekly' | 'monthly'
    interval: number
    endDate?: string
    maxOccurrences?: number
  }
}

export interface CampaignSettings {
  messageType: 'TRANSACTIONAL' | 'PROMOTIONAL'
  senderId?: string
  originationNumber?: string
  throttleRate?: number // messages per second
  quietHours?: {
    start: string // HH:MM
    end: string
    timezone: string
  }
  optOutHandling: boolean
}

export interface CampaignStats {
  totalRecipients: number
  sent: number
  delivered: number
  failed: number
  optedOut: number
  deliveryRate: number
  cost: number
}

/**
 * SMS Campaigns Module
 */
export class SmsCampaigns {
  /**
   * Lambda code for campaign management
   */
  static CampaignManagerCode = `
const { DynamoDBClient, PutItemCommand, GetItemCommand, UpdateItemCommand, ScanCommand } = require('@aws-sdk/client-dynamodb');

const dynamodb = new DynamoDBClient({});
const CAMPAIGNS_TABLE = process.env.CAMPAIGNS_TABLE;

exports.handler = async (event) => {
  console.log('Campaign manager event:', JSON.stringify(event, null, 2));

  const { httpMethod, body, pathParameters } = event;
  const campaignId = pathParameters?.id;

  try {
    switch (httpMethod) {
      case 'POST':
        return await createCampaign(JSON.parse(body || '{}'));
      case 'GET':
        if (campaignId) {
          return await getCampaign(campaignId);
        }
        return await listCampaigns(event.queryStringParameters);
      case 'PUT':
        return await updateCampaign(campaignId, JSON.parse(body || '{}'));
      case 'DELETE':
        return await cancelCampaign(campaignId);
      default:
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

async function createCampaign(data) {
  const id = \`camp-\${Date.now()}-\${Math.random().toString(36).substr(2, 9)}\`;
  const now = new Date().toISOString();

  const campaign = {
    id: { S: id },
    name: { S: data.name },
    description: { S: data.description || '' },
    status: { S: 'draft' },
    message: { S: JSON.stringify(data.message || {}) },
    audience: { S: JSON.stringify(data.audience || {}) },
    schedule: { S: JSON.stringify(data.schedule || { type: 'immediate' }) },
    settings: { S: JSON.stringify(data.settings || { messageType: 'TRANSACTIONAL', optOutHandling: true }) },
    stats: { S: JSON.stringify({ totalRecipients: 0, sent: 0, delivered: 0, failed: 0, optedOut: 0, deliveryRate: 0, cost: 0 }) },
    createdAt: { S: now },
    updatedAt: { S: now },
  };

  await dynamodb.send(new PutItemCommand({
    TableName: CAMPAIGNS_TABLE,
    Item: campaign,
  }));

  return {
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, status: 'draft', createdAt: now }),
  };
}

async function getCampaign(id) {
  const result = await dynamodb.send(new GetItemCommand({
    TableName: CAMPAIGNS_TABLE,
    Key: { id: { S: id } },
  }));

  if (!result.Item) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Campaign not found' }) };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(unmarshallCampaign(result.Item)),
  };
}

async function listCampaigns(params) {
  const result = await dynamodb.send(new ScanCommand({
    TableName: CAMPAIGNS_TABLE,
  }));

  const campaigns = (result.Items || []).map(unmarshallCampaign);
  campaigns.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(campaigns),
  };
}

async function updateCampaign(id, data) {
  const now = new Date().toISOString();

  const updateExpressions = ['updatedAt = :now'];
  const expressionValues = { ':now': { S: now } };

  if (data.name) {
    updateExpressions.push('name = :name');
    expressionValues[':name'] = { S: data.name };
  }
  if (data.message) {
    updateExpressions.push('message = :message');
    expressionValues[':message'] = { S: JSON.stringify(data.message) };
  }
  if (data.audience) {
    updateExpressions.push('audience = :audience');
    expressionValues[':audience'] = { S: JSON.stringify(data.audience) };
  }
  if (data.schedule) {
    updateExpressions.push('schedule = :schedule');
    expressionValues[':schedule'] = { S: JSON.stringify(data.schedule) };
  }
  if (data.settings) {
    updateExpressions.push('settings = :settings');
    expressionValues[':settings'] = { S: JSON.stringify(data.settings) };
  }
  if (data.status) {
    updateExpressions.push('#status = :status');
    expressionValues[':status'] = { S: data.status };
  }

  await dynamodb.send(new UpdateItemCommand({
    TableName: CAMPAIGNS_TABLE,
    Key: { id: { S: id } },
    UpdateExpression: 'SET ' + updateExpressions.join(', '),
    ExpressionAttributeNames: data.status ? { '#status': 'status' } : undefined,
    ExpressionAttributeValues: expressionValues,
  }));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, updatedAt: now }),
  };
}

async function cancelCampaign(id) {
  await dynamodb.send(new UpdateItemCommand({
    TableName: CAMPAIGNS_TABLE,
    Key: { id: { S: id } },
    UpdateExpression: 'SET #status = :status, updatedAt = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': { S: 'cancelled' },
      ':now': { S: new Date().toISOString() },
    },
  }));

  return { statusCode: 200, body: JSON.stringify({ id, status: 'cancelled' }) };
}

function unmarshallCampaign(item) {
  return {
    id: item.id.S,
    name: item.name.S,
    description: item.description?.S,
    status: item.status.S,
    message: JSON.parse(item.message?.S || '{}'),
    audience: JSON.parse(item.audience?.S || '{}'),
    schedule: JSON.parse(item.schedule?.S || '{}'),
    settings: JSON.parse(item.settings?.S || '{}'),
    stats: JSON.parse(item.stats?.S || '{}'),
    createdAt: item.createdAt.S,
    updatedAt: item.updatedAt.S,
    startedAt: item.startedAt?.S,
    completedAt: item.completedAt?.S,
  };
}
`

  /**
   * Lambda code for campaign execution
   */
  static CampaignExecutorCode = `
const { DynamoDBClient, GetItemCommand, UpdateItemCommand, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { PinpointClient, SendMessagesCommand } = require('@aws-sdk/client-pinpoint');

const dynamodb = new DynamoDBClient({});
const pinpoint = new PinpointClient({});

const CAMPAIGNS_TABLE = process.env.CAMPAIGNS_TABLE;
const CONTACTS_TABLE = process.env.CONTACTS_TABLE;
const OPT_OUT_TABLE = process.env.OPT_OUT_TABLE;
const PINPOINT_APP_ID = process.env.PINPOINT_APP_ID;

exports.handler = async (event) => {
  console.log('Campaign executor event:', JSON.stringify(event, null, 2));

  try {
    // Get scheduled campaigns
    const result = await dynamodb.send(new ScanCommand({
      TableName: CAMPAIGNS_TABLE,
      FilterExpression: '#status = :scheduled',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':scheduled': { S: 'scheduled' },
      },
    }));

    const campaigns = result.Items || [];
    const now = new Date();

    for (const item of campaigns) {
      const campaign = unmarshallCampaign(item);
      const schedule = campaign.schedule;

      // Check if it's time to run
      if (schedule.type === 'scheduled' && schedule.scheduledFor) {
        const scheduledTime = new Date(schedule.scheduledFor);
        if (scheduledTime > now) continue;
      }

      // Check quiet hours
      if (campaign.settings.quietHours) {
        const { start, end, timezone } = campaign.settings.quietHours;
        const localTime = new Date().toLocaleTimeString('en-US', { timeZone: timezone, hour12: false });
        if (localTime >= start && localTime <= end) {
          console.log(\`Campaign \${campaign.id} skipped - quiet hours\`);
          continue;
        }
      }

      // Start campaign
      await executeCampaign(campaign);
    }

    return { statusCode: 200 };
  } catch (error) {
    console.error('Error executing campaigns:', error);
    return { statusCode: 500, error: error.message };
  }
};

async function executeCampaign(campaign) {
  console.log(\`Executing campaign: \${campaign.id}\`);

  // Update status to running
  await dynamodb.send(new UpdateItemCommand({
    TableName: CAMPAIGNS_TABLE,
    Key: { id: { S: campaign.id } },
    UpdateExpression: 'SET #status = :status, startedAt = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': { S: 'running' },
      ':now': { S: new Date().toISOString() },
    },
  }));

  // Get recipients
  const recipients = await getRecipients(campaign.audience);
  const optedOut = await getOptedOutNumbers();

  // Filter out opted-out numbers
  const eligibleRecipients = recipients.filter(r => !optedOut.has(r.phoneNumber));

  let sent = 0;
  let delivered = 0;
  let failed = 0;
  let cost = 0;

  // Send messages in batches
  const batchSize = campaign.settings.throttleRate || 20;

  for (let i = 0; i < eligibleRecipients.length; i += batchSize) {
    const batch = eligibleRecipients.slice(i, i + batchSize);

    for (const recipient of batch) {
      try {
        const messageBody = resolveTemplate(campaign.message.body, recipient);

        const result = await pinpoint.send(new SendMessagesCommand({
          ApplicationId: PINPOINT_APP_ID,
          MessageRequest: {
            Addresses: {
              [recipient.phoneNumber]: {
                ChannelType: 'SMS',
              },
            },
            MessageConfiguration: {
              SMSMessage: {
                Body: messageBody,
                MessageType: campaign.settings.messageType,
                SenderId: campaign.settings.senderId,
                OriginationNumber: campaign.settings.originationNumber,
              },
            },
          },
        }));

        const status = result.MessageResponse?.Result?.[recipient.phoneNumber]?.DeliveryStatus;
        if (status === 'SUCCESSFUL') {
          delivered++;
          cost += 0.00645; // Approximate US SMS cost
        } else {
          failed++;
        }
        sent++;
      } catch (error) {
        console.error(\`Failed to send to \${recipient.phoneNumber}:\`, error);
        failed++;
      }
    }

    // Throttle between batches
    if (i + batchSize < eligibleRecipients.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Update campaign stats
  await dynamodb.send(new UpdateItemCommand({
    TableName: CAMPAIGNS_TABLE,
    Key: { id: { S: campaign.id } },
    UpdateExpression: 'SET #status = :status, stats = :stats, completedAt = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': { S: 'completed' },
      ':stats': { S: JSON.stringify({
        totalRecipients: eligibleRecipients.length,
        sent,
        delivered,
        failed,
        optedOut: recipients.length - eligibleRecipients.length,
        deliveryRate: sent > 0 ? (delivered / sent) * 100 : 0,
        cost: Math.round(cost * 100) / 100,
      })},
      ':now': { S: new Date().toISOString() },
    },
  }));

  console.log(\`Campaign \${campaign.id} completed: \${delivered}/\${sent} delivered\`);
}

async function getRecipients(audience) {
  // Simplified - in production, query from contacts table based on audience type
  if (audience.type === 'list' && audience.listId) {
    const result = await dynamodb.send(new ScanCommand({
      TableName: CONTACTS_TABLE,
      FilterExpression: 'listId = :listId',
      ExpressionAttributeValues: {
        ':listId': { S: audience.listId },
      },
    }));
    return (result.Items || []).map(item => ({
      phoneNumber: item.phoneNumber.S,
      name: item.name?.S,
      ...JSON.parse(item.attributes?.S || '{}'),
    }));
  }
  return [];
}

async function getOptedOutNumbers() {
  const result = await dynamodb.send(new ScanCommand({
    TableName: OPT_OUT_TABLE,
  }));
  return new Set((result.Items || []).map(item => item.phoneNumber.S));
}

function resolveTemplate(template, data) {
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    result = result.replace(new RegExp(\`{{\\\\s*\${key}\\\\s*}}\`, 'g'), String(value));
  }
  return result;
}

function unmarshallCampaign(item) {
  return {
    id: item.id.S,
    name: item.name.S,
    status: item.status.S,
    message: JSON.parse(item.message?.S || '{}'),
    audience: JSON.parse(item.audience?.S || '{}'),
    schedule: JSON.parse(item.schedule?.S || '{}'),
    settings: JSON.parse(item.settings?.S || '{}'),
    stats: JSON.parse(item.stats?.S || '{}'),
  };
}
`

  /**
   * Create campaigns DynamoDB table
   */
  static createCampaignsTable(config: { slug: string }): Record<string, any> {
    return {
      [`${config.slug}SmsCampaignsTable`]: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${config.slug}-sms-campaigns`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'id', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'id', KeyType: 'HASH' },
          ],
        },
      },
    }
  }

  /**
   * Create campaign manager Lambda
   */
  static createCampaignManagerLambda(config: {
    slug: string
    roleArn: string
    campaignsTable: string
  }): Record<string, any> {
    return {
      [`${config.slug}SmsCampaignManagerLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-sms-campaign-manager`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 30,
          MemorySize: 256,
          Code: {
            ZipFile: SmsCampaigns.CampaignManagerCode,
          },
          Environment: {
            Variables: {
              CAMPAIGNS_TABLE: config.campaignsTable,
            },
          },
        },
      },
    }
  }
}

export default SmsCampaigns
