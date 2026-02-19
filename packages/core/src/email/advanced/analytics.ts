/**
 * Email Analytics
 *
 * Provides open tracking, click tracking, and email metrics
 */

export interface EmailAnalytics {
  messageId: string
  sent: boolean
  sentAt?: string
  delivered: boolean
  deliveredAt?: string
  opened: boolean
  openedAt?: string
  openCount: number
  clicked: boolean
  clickedAt?: string
  clickCount: number
  clicks: ClickEvent[]
  bounced: boolean
  bouncedAt?: string
  bounceType?: string
  complained: boolean
  complainedAt?: string
  unsubscribed: boolean
  unsubscribedAt?: string
}

export interface ClickEvent {
  url: string
  clickedAt: string
  userAgent?: string
  ipAddress?: string
}

export interface EmailMetrics {
  period: string
  sent: number
  delivered: number
  opened: number
  clicked: number
  bounced: number
  complained: number
  unsubscribed: number
  deliveryRate: number
  openRate: number
  clickRate: number
  bounceRate: number
  complaintRate: number
}

/**
 * Email Analytics Module
 */
export class EmailAnalyticsModule {
  /**
   * Lambda code for tracking pixel (open tracking)
   */
  static TrackingPixelLambdaCode = `
const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

const dynamodb = new DynamoDBClient({});
const ANALYTICS_TABLE = process.env.ANALYTICS_TABLE;

// 1x1 transparent GIF
const TRACKING_PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

exports.handler = async (event) => {
  console.log('Tracking pixel request:', JSON.stringify(event, null, 2));

  try {
    const messageId = event.pathParameters?.messageId || event.queryStringParameters?.mid;

    if (messageId && ANALYTICS_TABLE) {
      const now = new Date().toISOString();

      // Update open tracking
      await dynamodb.send(new UpdateItemCommand({
        TableName: ANALYTICS_TABLE,
        Key: { messageId: { S: messageId } },
        UpdateExpression: 'SET opened = :true, openedAt = if_not_exists(openedAt, :now), openCount = if_not_exists(openCount, :zero) + :one',
        ExpressionAttributeValues: {
          ':true': { BOOL: true },
          ':now': { S: now },
          ':zero': { N: '0' },
          ':one': { N: '1' },
        },
      }));

      console.log(\`Tracked open for: \${messageId}\`);
    }
  } catch (error) {
    console.error('Error tracking open:', error);
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
    body: TRACKING_PIXEL.toString('base64'),
    isBase64Encoded: true,
  };
};
`

  /**
   * Lambda code for click tracking
   */
  static ClickTrackingLambdaCode = `
const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

const dynamodb = new DynamoDBClient({});
const ANALYTICS_TABLE = process.env.ANALYTICS_TABLE;

exports.handler = async (event) => {
  console.log('Click tracking request:', JSON.stringify(event, null, 2));

  try {
    const messageId = event.pathParameters?.messageId || event.queryStringParameters?.mid;
    const url = event.queryStringParameters?.url;

    if (!url) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing URL parameter' }),
      };
    }

    const decodedUrl = decodeURIComponent(url);

    if (messageId && ANALYTICS_TABLE) {
      const now = new Date().toISOString();
      const userAgent = event.headers?.['user-agent'] || '';
      const ipAddress = event.requestContext?.identity?.sourceIp || '';

      // Update click tracking
      await dynamodb.send(new UpdateItemCommand({
        TableName: ANALYTICS_TABLE,
        Key: { messageId: { S: messageId } },
        UpdateExpression: 'SET clicked = :true, clickedAt = if_not_exists(clickedAt, :now), clickCount = if_not_exists(clickCount, :zero) + :one, clicks = list_append(if_not_exists(clicks, :empty), :click)',
        ExpressionAttributeValues: {
          ':true': { BOOL: true },
          ':now': { S: now },
          ':zero': { N: '0' },
          ':one': { N: '1' },
          ':empty': { L: [] },
          ':click': { L: [{ M: {
            url: { S: decodedUrl },
            clickedAt: { S: now },
            userAgent: { S: userAgent },
            ipAddress: { S: ipAddress },
          }}]},
        },
      }));

      console.log(\`Tracked click for: \${messageId} -> \${decodedUrl}\`);
    }

    // Redirect to actual URL
    return {
      statusCode: 302,
      headers: {
        'Location': decodedUrl,
        'Cache-Control': 'no-store',
      },
      body: '',
    };
  } catch (error) {
    console.error('Error tracking click:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
`

  /**
   * Lambda code for processing SES events
   */
  static SesEventProcessorCode = `
const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

const dynamodb = new DynamoDBClient({});
const ANALYTICS_TABLE = process.env.ANALYTICS_TABLE;

exports.handler = async (event) => {
  console.log('SES event:', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.Sns?.Message || record.body || '{}');
      const eventType = message.eventType || message.notificationType;
      const mail = message.mail || {};
      const messageId = mail.messageId;

      if (!messageId || !ANALYTICS_TABLE) continue;

      const now = new Date().toISOString();
      let updateExpression = '';
      const expressionValues = {};

      switch (eventType) {
        case 'Send':
          updateExpression = 'SET sent = :true, sentAt = :now';
          expressionValues[':true'] = { BOOL: true };
          expressionValues[':now'] = { S: now };
          break;

        case 'Delivery':
          updateExpression = 'SET delivered = :true, deliveredAt = :now';
          expressionValues[':true'] = { BOOL: true };
          expressionValues[':now'] = { S: now };
          break;

        case 'Bounce':
          updateExpression = 'SET bounced = :true, bouncedAt = :now, bounceType = :type';
          expressionValues[':true'] = { BOOL: true };
          expressionValues[':now'] = { S: now };
          expressionValues[':type'] = { S: message.bounce?.bounceType || 'Unknown' };
          break;

        case 'Complaint':
          updateExpression = 'SET complained = :true, complainedAt = :now';
          expressionValues[':true'] = { BOOL: true };
          expressionValues[':now'] = { S: now };
          break;

        case 'Open':
          updateExpression = 'SET opened = :true, openedAt = if_not_exists(openedAt, :now), openCount = if_not_exists(openCount, :zero) + :one';
          expressionValues[':true'] = { BOOL: true };
          expressionValues[':now'] = { S: now };
          expressionValues[':zero'] = { N: '0' };
          expressionValues[':one'] = { N: '1' };
          break;

        case 'Click':
          updateExpression = 'SET clicked = :true, clickedAt = if_not_exists(clickedAt, :now), clickCount = if_not_exists(clickCount, :zero) + :one';
          expressionValues[':true'] = { BOOL: true };
          expressionValues[':now'] = { S: now };
          expressionValues[':zero'] = { N: '0' };
          expressionValues[':one'] = { N: '1' };
          break;

        default:
          console.log(\`Unknown event type: \${eventType}\`);
          continue;
      }

      await dynamodb.send(new UpdateItemCommand({
        TableName: ANALYTICS_TABLE,
        Key: { messageId: { S: messageId } },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: expressionValues,
      }));

      console.log(\`Processed \${eventType} for: \${messageId}\`);
    } catch (error) {
      console.error('Error processing SES event:', error);
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
      [`${config.slug}EmailAnalyticsTable`]: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${config.slug}-email-analytics`,
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
   * Create tracking pixel Lambda
   */
  static createTrackingPixelLambda(config: {
    slug: string
    roleArn: string
    analyticsTable: string
  }): Record<string, any> {
    return {
      [`${config.slug}TrackingPixelLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-tracking-pixel`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 10,
          MemorySize: 128,
          Code: {
            ZipFile: EmailAnalyticsModule.TrackingPixelLambdaCode,
          },
          Environment: {
            Variables: {
              ANALYTICS_TABLE: config.analyticsTable,
            },
          },
        },
      },
    }
  }

  /**
   * Create click tracking Lambda
   */
  static createClickTrackingLambda(config: {
    slug: string
    roleArn: string
    analyticsTable: string
  }): Record<string, any> {
    return {
      [`${config.slug}ClickTrackingLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-click-tracking`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 10,
          MemorySize: 128,
          Code: {
            ZipFile: EmailAnalyticsModule.ClickTrackingLambdaCode,
          },
          Environment: {
            Variables: {
              ANALYTICS_TABLE: config.analyticsTable,
            },
          },
        },
      },
    }
  }

  /**
   * Create SES event processor Lambda
   */
  static createSesEventProcessorLambda(config: {
    slug: string
    roleArn: string
    analyticsTable: string
  }): Record<string, any> {
    return {
      [`${config.slug}SesEventProcessorLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-ses-event-processor`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 30,
          MemorySize: 256,
          Code: {
            ZipFile: EmailAnalyticsModule.SesEventProcessorCode,
          },
          Environment: {
            Variables: {
              ANALYTICS_TABLE: config.analyticsTable,
            },
          },
        },
      },
    }
  }

  /**
   * Inject tracking into email HTML
   */
  static injectTracking(params: {
    html: string
    messageId: string
    trackingDomain: string
  }): string {
    const { html, messageId, trackingDomain } = params

    // Inject tracking pixel before </body>
    const trackingPixel = `<img src="https://${trackingDomain}/track/open/${messageId}" width="1" height="1" style="display:none" alt="" />`
    let trackedHtml = html.replace('</body>', `${trackingPixel}</body>`)

    // Replace links with tracking links
    trackedHtml = trackedHtml.replace(
      /href="(https?:\/\/[^"]+)"/g,
      (_match, url) => {
        const encodedUrl = encodeURIComponent(url)
        return `href="https://${trackingDomain}/track/click/${messageId}?url=${encodedUrl}"`
      }
    )

    return trackedHtml
  }

  /**
   * Calculate email metrics for a period
   */
  static calculateMetrics(analytics: EmailAnalytics[]): EmailMetrics {
    const sent = analytics.filter(a => a.sent).length
    const delivered = analytics.filter(a => a.delivered).length
    const opened = analytics.filter(a => a.opened).length
    const clicked = analytics.filter(a => a.clicked).length
    const bounced = analytics.filter(a => a.bounced).length
    const complained = analytics.filter(a => a.complained).length
    const unsubscribed = analytics.filter(a => a.unsubscribed).length

    return {
      period: new Date().toISOString(),
      sent,
      delivered,
      opened,
      clicked,
      bounced,
      complained,
      unsubscribed,
      deliveryRate: sent > 0 ? (delivered / sent) * 100 : 0,
      openRate: delivered > 0 ? (opened / delivered) * 100 : 0,
      clickRate: opened > 0 ? (clicked / opened) * 100 : 0,
      bounceRate: sent > 0 ? (bounced / sent) * 100 : 0,
      complaintRate: delivered > 0 ? (complained / delivered) * 100 : 0,
    }
  }
}

export default EmailAnalyticsModule
