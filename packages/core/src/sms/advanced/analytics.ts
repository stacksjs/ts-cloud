/**
 * SMS Analytics
 *
 * Provides delivery rates, engagement metrics, and reporting
 */

export interface SmsMetrics {
  period: string
  sent: number
  delivered: number
  failed: number
  pending: number
  optedOut: number
  deliveryRate: number
  failureRate: number
  averageDeliveryTime: number
  cost: number
}

export interface SmsEngagement {
  messageId: string
  delivered: boolean
  deliveredAt?: string
  clicked?: boolean
  clickedAt?: string
  replied?: boolean
  repliedAt?: string
  replyContent?: string
  optedOut?: boolean
  optedOutAt?: string
}

export interface DeliveryReport {
  messageId: string
  to: string
  status: 'PENDING' | 'SUCCESSFUL' | 'FAILED' | 'UNKNOWN'
  statusCode?: string
  statusMessage?: string
  carrier?: string
  countryCode?: string
  priceInMillicents?: number
  timestamp: string
}

/**
 * SMS Analytics Module
 */
export class SmsAnalytics {
  /**
   * Lambda code for analytics aggregation
   */
  static AnalyticsAggregatorCode = `
const { DynamoDBClient, ScanCommand, PutItemCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');

const dynamodb = new DynamoDBClient({});
const MESSAGE_LOG_TABLE = process.env.MESSAGE_LOG_TABLE;
const ANALYTICS_TABLE = process.env.ANALYTICS_TABLE;

exports.handler = async (event) => {
  console.log('SMS analytics aggregator event:', JSON.stringify(event, null, 2));

  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  try {
    // Get messages from the last hour
    const hourlyResult = await dynamodb.send(new ScanCommand({
      TableName: MESSAGE_LOG_TABLE,
      FilterExpression: 'sentAt >= :hourAgo',
      ExpressionAttributeValues: {
        ':hourAgo': { S: hourAgo.toISOString() },
      },
    }));

    const hourlyMessages = hourlyResult.Items || [];
    const hourlyMetrics = calculateMetrics(hourlyMessages);

    // Save hourly metrics
    await dynamodb.send(new PutItemCommand({
      TableName: ANALYTICS_TABLE,
      Item: {
        period: { S: \`hourly-\${now.toISOString().slice(0, 13)}\` },
        type: { S: 'hourly' },
        timestamp: { S: now.toISOString() },
        metrics: { S: JSON.stringify(hourlyMetrics) },
        ttl: { N: String(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60) },
      },
    }));

    // Get messages from the last day
    const dailyResult = await dynamodb.send(new ScanCommand({
      TableName: MESSAGE_LOG_TABLE,
      FilterExpression: 'sentAt >= :dayAgo',
      ExpressionAttributeValues: {
        ':dayAgo': { S: dayAgo.toISOString() },
      },
    }));

    const dailyMessages = dailyResult.Items || [];
    const dailyMetrics = calculateMetrics(dailyMessages);

    // Save daily metrics
    await dynamodb.send(new PutItemCommand({
      TableName: ANALYTICS_TABLE,
      Item: {
        period: { S: \`daily-\${now.toISOString().slice(0, 10)}\` },
        type: { S: 'daily' },
        timestamp: { S: now.toISOString() },
        metrics: { S: JSON.stringify(dailyMetrics) },
        ttl: { N: String(Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60) },
      },
    }));

    // Calculate by country
    const byCountry = {};
    for (const msg of dailyMessages) {
      const country = msg.countryCode?.S || 'UNKNOWN';
      if (!byCountry[country]) {
        byCountry[country] = [];
      }
      byCountry[country].push(msg);
    }

    for (const [country, messages] of Object.entries(byCountry)) {
      const countryMetrics = calculateMetrics(messages);
      await dynamodb.send(new PutItemCommand({
        TableName: ANALYTICS_TABLE,
        Item: {
          period: { S: \`country-\${country}-\${now.toISOString().slice(0, 10)}\` },
          type: { S: 'country' },
          country: { S: country },
          timestamp: { S: now.toISOString() },
          metrics: { S: JSON.stringify(countryMetrics) },
          ttl: { N: String(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60) },
        },
      }));
    }

    console.log('SMS analytics aggregated successfully');
    return { statusCode: 200 };
  } catch (error) {
    console.error('Error aggregating SMS analytics:', error);
    return { statusCode: 500, error: error.message };
  }
};

function calculateMetrics(messages) {
  const sent = messages.length;
  const delivered = messages.filter(m => m.deliveryStatus?.S === 'SUCCESSFUL').length;
  const failed = messages.filter(m => ['FAILED', 'PERMANENT_FAILURE'].includes(m.deliveryStatus?.S)).length;
  const pending = messages.filter(m => !m.deliveryStatus?.S || m.deliveryStatus?.S === 'PENDING').length;
  const optedOut = messages.filter(m => m.deliveryStatus?.S === 'OPTED_OUT').length;

  const deliveryTimes = messages
    .filter(m => m.sentAt?.S && m.deliveredAt?.S)
    .map(m => new Date(m.deliveredAt.S) - new Date(m.sentAt.S));

  const averageDeliveryTime = deliveryTimes.length > 0
    ? deliveryTimes.reduce((a, b) => a + b, 0) / deliveryTimes.length / 1000
    : 0;

  const cost = messages
    .filter(m => m.priceMillicents?.N)
    .reduce((sum, m) => sum + parseFloat(m.priceMillicents.N) / 100000, 0);

  return {
    sent,
    delivered,
    failed,
    pending,
    optedOut,
    deliveryRate: sent > 0 ? Math.round((delivered / sent) * 1000) / 10 : 0,
    failureRate: sent > 0 ? Math.round((failed / sent) * 1000) / 10 : 0,
    averageDeliveryTime: Math.round(averageDeliveryTime * 10) / 10,
    cost: Math.round(cost * 100) / 100,
  };
}
`

  /**
   * Lambda code for real-time delivery tracking
   */
  static DeliveryTrackerCode = `
const { DynamoDBClient, UpdateItemCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');

const dynamodb = new DynamoDBClient({});
const MESSAGE_LOG_TABLE = process.env.MESSAGE_LOG_TABLE;
const DELIVERY_REPORTS_TABLE = process.env.DELIVERY_REPORTS_TABLE;

exports.handler = async (event) => {
  console.log('Delivery tracker event:', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.Sns?.Message || record.body || '{}');

      const {
        messageId,
        destinationPhoneNumber,
        messageStatus,
        messageStatusDescription,
        isoCountryCode,
        mcc,
        mnc,
        priceInMillicentsUSD,
      } = message;

      if (!messageId) continue;

      const now = new Date().toISOString();

      // Update message log
      await dynamodb.send(new UpdateItemCommand({
        TableName: MESSAGE_LOG_TABLE,
        Key: { messageId: { S: messageId } },
        UpdateExpression: 'SET deliveryStatus = :status, deliveredAt = :now, countryCode = :country, priceMillicents = :price',
        ExpressionAttributeValues: {
          ':status': { S: messageStatus || 'UNKNOWN' },
          ':now': { S: now },
          ':country': { S: isoCountryCode || '' },
          ':price': { N: String(priceInMillicentsUSD || 0) },
        },
      }));

      // Save delivery report
      await dynamodb.send(new PutItemCommand({
        TableName: DELIVERY_REPORTS_TABLE,
        Item: {
          messageId: { S: messageId },
          to: { S: destinationPhoneNumber || '' },
          status: { S: messageStatus || 'UNKNOWN' },
          statusMessage: { S: messageStatusDescription || '' },
          countryCode: { S: isoCountryCode || '' },
          carrier: { S: \`\${mcc || ''}-\${mnc || ''}\` },
          priceInMillicents: { N: String(priceInMillicentsUSD || 0) },
          timestamp: { S: now },
          ttl: { N: String(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60) },
        },
      }));

      console.log(\`Tracked delivery for \${messageId}: \${messageStatus}\`);
    } catch (error) {
      console.error('Error tracking delivery:', error);
    }
  }

  return { statusCode: 200 };
};
`

  /**
   * Create analytics DynamoDB table
   */
  static createAnalyticsTable(config: { slug: string }): Record<string, any> {
    return {
      [`${config.slug}SmsAnalyticsTable`]: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${config.slug}-sms-analytics`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'period', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'period', KeyType: 'HASH' },
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
   * Create delivery reports table
   */
  static createDeliveryReportsTable(config: { slug: string }): Record<string, any> {
    return {
      [`${config.slug}SmsDeliveryReportsTable`]: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${config.slug}-sms-delivery-reports`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'messageId', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'messageId', KeyType: 'HASH' },
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
   * Create analytics aggregator Lambda
   */
  static createAnalyticsAggregatorLambda(config: {
    slug: string
    roleArn: string
    messageLogTable: string
    analyticsTable: string
  }): Record<string, any> {
    return {
      [`${config.slug}SmsAnalyticsAggregatorLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-sms-analytics-aggregator`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 60,
          MemorySize: 256,
          Code: {
            ZipFile: SmsAnalytics.AnalyticsAggregatorCode,
          },
          Environment: {
            Variables: {
              MESSAGE_LOG_TABLE: config.messageLogTable,
              ANALYTICS_TABLE: config.analyticsTable,
            },
          },
        },
      },
    }
  }
}

export default SmsAnalytics
