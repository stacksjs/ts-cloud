/**
 * Link Shortening and Tracking
 *
 * Provides URL shortening and click tracking for SMS
 */

export interface ShortenedLink {
  id: string
  originalUrl: string
  shortUrl: string
  campaignId?: string
  messageId?: string
  clicks: number
  uniqueClicks: number
  createdAt: string
  expiresAt?: string
}

export interface LinkClick {
  linkId: string
  clickedAt: string
  userAgent?: string
  ipAddress?: string
  country?: string
  device?: string
}

/**
 * Link Tracking Module
 */
export class LinkTracking {
  /**
   * Lambda code for link shortening
   */
  static LinkShortenerCode = `
const { DynamoDBClient, PutItemCommand, GetItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const crypto = require('crypto');

const dynamodb = new DynamoDBClient({});
const LINKS_TABLE = process.env.LINKS_TABLE;
const SHORT_DOMAIN = process.env.SHORT_DOMAIN;

exports.handler = async (event) => {
  console.log('Link shortener event:', JSON.stringify(event, null, 2));

  const { httpMethod, body, pathParameters } = event;

  try {
    if (httpMethod === 'POST') {
      // Create short link
      const data = JSON.parse(body || '{}');
      return await createShortLink(data);
    } else if (httpMethod === 'GET' && pathParameters?.id) {
      // Redirect to original URL
      return await handleRedirect(pathParameters.id, event);
    }

    return { statusCode: 405, body: 'Method not allowed' };
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

async function createShortLink(data) {
  const { url, campaignId, messageId, expiresIn } = data;

  if (!url) {
    return { statusCode: 400, body: JSON.stringify({ error: 'URL is required' }) };
  }

  // Generate short ID
  const id = generateShortId();
  const now = new Date().toISOString();
  const expiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;

  await dynamodb.send(new PutItemCommand({
    TableName: LINKS_TABLE,
    Item: {
      id: { S: id },
      originalUrl: { S: url },
      campaignId: { S: campaignId || '' },
      messageId: { S: messageId || '' },
      clicks: { N: '0' },
      uniqueClicks: { N: '0' },
      visitors: { SS: ['_placeholder'] }, // DynamoDB requires non-empty set
      createdAt: { S: now },
      ...(expiresAt && { expiresAt: { S: expiresAt } }),
      ttl: { N: String(Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60) },
    },
  }));

  const shortUrl = SHORT_DOMAIN ? 'https://' + SHORT_DOMAIN + '/l/' + id : '/l/' + id;

  return {
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      shortUrl,
      originalUrl: url,
      createdAt: now,
    }),
  };
}

async function handleRedirect(id, event) {
  const result = await dynamodb.send(new GetItemCommand({
    TableName: LINKS_TABLE,
    Key: { id: { S: id } },
  }));

  if (!result.Item) {
    return { statusCode: 404, body: 'Link not found' };
  }

  const link = result.Item;

  // Check expiration
  if (link.expiresAt?.S && new Date(link.expiresAt.S) < new Date()) {
    return { statusCode: 410, body: 'Link has expired' };
  }

  const originalUrl = link.originalUrl.S;

  // Track click
  const ipAddress = event.requestContext?.identity?.sourceIp || 'unknown';
  const userAgent = event.headers?.['user-agent'] || '';
  const visitorId = crypto.createHash('md5').update(ipAddress + userAgent).digest('hex').substring(0, 8);

  try {
    await dynamodb.send(new UpdateItemCommand({
      TableName: LINKS_TABLE,
      Key: { id: { S: id } },
      UpdateExpression: 'SET clicks = clicks + :one, visitors = list_append(if_not_exists(visitors, :empty), :visitor)',
      ExpressionAttributeValues: {
        ':one': { N: '1' },
        ':empty': { L: [] },
        ':visitor': { L: [{ S: visitorId }] },
      },
    }));
  } catch (e) {
    console.error('Error tracking click:', e);
  }

  return {
    statusCode: 302,
    headers: {
      'Location': originalUrl,
      'Cache-Control': 'no-store',
    },
    body: '',
  };
}

function generateShortId() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}
`

  /**
   * Create links DynamoDB table
   */
  static createLinksTable(config: { slug: string }): Record<string, any> {
    return {
      [`${config.slug}ShortLinksTable`]: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${config.slug}-short-links`,
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
   * Create link shortener Lambda
   */
  static createLinkShortenerLambda(config: {
    slug: string
    roleArn: string
    linksTable: string
    shortDomain?: string
  }): Record<string, any> {
    return {
      [`${config.slug}LinkShortenerLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-link-shortener`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 10,
          MemorySize: 128,
          Code: {
            ZipFile: LinkTracking.LinkShortenerCode,
          },
          Environment: {
            Variables: {
              LINKS_TABLE: config.linksTable,
              SHORT_DOMAIN: config.shortDomain || '',
            },
          },
        },
      },
    }
  }

  /**
   * Shorten URLs in message text
   */
  static shortenUrlsInMessage(message: string, shortDomain: string, linkIdPrefix: string): {
    message: string
    links: Array<{ original: string; short: string; id: string }>
  } {
    const urlRegex = /(https?:\/\/[^\s]+)/g
    const links: Array<{ original: string; short: string; id: string }> = []
    let index = 0

    const shortenedMessage = message.replace(urlRegex, (url) => {
      const id = `${linkIdPrefix}-${index++}`
      const shortUrl = `https://${shortDomain}/l/${id}`
      links.push({ original: url, short: shortUrl, id })
      return shortUrl
    })

    return { message: shortenedMessage, links }
  }
}

export default LinkTracking
