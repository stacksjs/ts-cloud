/**
 * MMS Support (Images, Media)
 *
 * Provides multimedia messaging capabilities
 */

export interface MmsMessage {
  to: string
  body?: string
  mediaUrls: string[]
  mediaType?: 'image' | 'video' | 'audio' | 'document'
  fallbackSms?: string
}

export interface MmsMedia {
  url: string
  contentType: string
  size: number
  filename?: string
}

/**
 * MMS Module
 */
export class MmsSupport {
  /**
   * Lambda code for MMS sending
   */
  static MmsSenderCode = `
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');

const s3 = new S3Client({});
const sns = new SNSClient({});
const dynamodb = new DynamoDBClient({});

const MEDIA_BUCKET = process.env.MEDIA_BUCKET;
const MESSAGE_LOG_TABLE = process.env.MESSAGE_LOG_TABLE;
const ORIGINATION_NUMBER = process.env.ORIGINATION_NUMBER;

// Supported media types
const SUPPORTED_TYPES = {
  'image/jpeg': { maxSize: 1024 * 1024, extension: 'jpg' },
  'image/png': { maxSize: 1024 * 1024, extension: 'png' },
  'image/gif': { maxSize: 1024 * 1024, extension: 'gif' },
  'video/mp4': { maxSize: 5 * 1024 * 1024, extension: 'mp4' },
  'video/3gpp': { maxSize: 5 * 1024 * 1024, extension: '3gp' },
  'audio/mpeg': { maxSize: 1024 * 1024, extension: 'mp3' },
  'audio/wav': { maxSize: 1024 * 1024, extension: 'wav' },
};

exports.handler = async (event) => {
  console.log('MMS sender event:', JSON.stringify(event, null, 2));

  try {
    const body = JSON.parse(event.body || '{}');
    const { to, text, mediaUrls, fallbackSms } = body;

    if (!to) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing recipient phone number' }),
      };
    }

    if (!mediaUrls || mediaUrls.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'At least one media URL is required' }),
      };
    }

    const messageId = \`mms-\${Date.now()}-\${Math.random().toString(36).substr(2, 9)}\`;
    const now = new Date().toISOString();

    // Validate and process media
    const processedMedia = [];
    for (const url of mediaUrls) {
      try {
        const media = await processMedia(url, messageId);
        processedMedia.push(media);
      } catch (error) {
        console.error(\`Failed to process media \${url}:\`, error);
      }
    }

    if (processedMedia.length === 0) {
      // Fall back to SMS if no media could be processed
      if (fallbackSms) {
        const smsResult = await sendFallbackSms(to, fallbackSms);
        return {
          statusCode: 200,
          body: JSON.stringify({
            messageId,
            type: 'sms_fallback',
            ...smsResult,
          }),
        };
      }
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No valid media could be processed' }),
      };
    }

    // Send MMS via SNS (carrier-dependent)
    // Note: True MMS requires carrier integration or third-party service
    // This implementation uses SNS with media URLs as a simplified approach
    const message = {
      to,
      text: text || '',
      mediaUrls: processedMedia.map(m => m.publicUrl),
      messageId,
      timestamp: now,
    };

    const snsResult = await sns.send(new PublishCommand({
      PhoneNumber: to,
      Message: text || 'You have received a multimedia message. View it here: ' + processedMedia[0].publicUrl,
      MessageAttributes: {
        'AWS.SNS.SMS.SMSType': {
          DataType: 'String',
          StringValue: 'Transactional',
        },
      },
    }));

    // Log message
    await dynamodb.send(new PutItemCommand({
      TableName: MESSAGE_LOG_TABLE,
      Item: {
        messageId: { S: messageId },
        type: { S: 'mms' },
        to: { S: to },
        text: { S: text || '' },
        mediaUrls: { SS: processedMedia.map(m => m.publicUrl) },
        snsMessageId: { S: snsResult.MessageId || '' },
        sentAt: { S: now },
        ttl: { N: String(Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60) },
      },
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageId,
        type: 'mms',
        mediaCount: processedMedia.length,
        snsMessageId: snsResult.MessageId,
      }),
    };
  } catch (error) {
    console.error('Error sending MMS:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

async function processMedia(url, messageId) {
  // Fetch media
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(\`Failed to fetch media: \${response.status}\`);
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const typeConfig = SUPPORTED_TYPES[contentType];

  if (!typeConfig) {
    throw new Error(\`Unsupported media type: \${contentType}\`);
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > typeConfig.maxSize) {
    throw new Error(\`Media too large: \${buffer.byteLength} bytes (max: \${typeConfig.maxSize})\`);
  }

  // Upload to S3
  const key = \`mms/\${messageId}/media.\${typeConfig.extension}\`;
  await s3.send(new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: key,
    Body: Buffer.from(buffer),
    ContentType: contentType,
  }));

  // Generate public URL (requires bucket to be configured for public access or use presigned URL)
  const publicUrl = \`https://\${MEDIA_BUCKET}.s3.amazonaws.com/\${key}\`;

  return {
    originalUrl: url,
    publicUrl,
    contentType,
    size: buffer.byteLength,
  };
}

async function sendFallbackSms(to, message) {
  const result = await sns.send(new PublishCommand({
    PhoneNumber: to,
    Message: message,
    MessageAttributes: {
      'AWS.SNS.SMS.SMSType': {
        DataType: 'String',
        StringValue: 'Transactional',
      },
    },
  }));

  return {
    snsMessageId: result.MessageId,
    fallback: true,
  };
}
`

  /**
   * Create media storage bucket
   */
  static createMediaBucket(config: { slug: string }): Record<string, any> {
    return {
      [`${config.slug}MmsMediaBucket`]: {
        Type: 'AWS::S3::Bucket',
        Properties: {
          BucketName: `${config.slug}-mms-media`,
          LifecycleConfiguration: {
            Rules: [
              {
                Id: 'DeleteOldMedia',
                Status: 'Enabled',
                ExpirationInDays: 30,
              },
            ],
          },
          CorsConfiguration: {
            CorsRules: [
              {
                AllowedOrigins: ['*'],
                AllowedMethods: ['GET'],
                AllowedHeaders: ['*'],
                MaxAge: 3600,
              },
            ],
          },
        },
      },
    }
  }

  /**
   * Create MMS sender Lambda
   */
  static createMmsSenderLambda(config: {
    slug: string
    roleArn: string
    mediaBucket: string
    messageLogTable: string
    originationNumber?: string
  }): Record<string, any> {
    return {
      [`${config.slug}MmsSenderLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-mms-sender`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 60,
          MemorySize: 512,
          Code: {
            ZipFile: MmsSupport.MmsSenderCode,
          },
          Environment: {
            Variables: {
              MEDIA_BUCKET: config.mediaBucket,
              MESSAGE_LOG_TABLE: config.messageLogTable,
              ORIGINATION_NUMBER: config.originationNumber || '',
            },
          },
        },
      },
    }
  }

  /**
   * Supported media types
   */
  static readonly SupportedMediaTypes = {
    image: ['image/jpeg', 'image/png', 'image/gif'],
    video: ['video/mp4', 'video/3gpp'],
    audio: ['audio/mpeg', 'audio/wav'],
  } as const

  /**
   * Media size limits (in bytes)
   */
  static readonly MediaSizeLimits: { image: number, video: number, audio: number } = {
    image: 1024 * 1024, // 1MB
    video: 5 * 1024 * 1024, // 5MB
    audio: 1024 * 1024, // 1MB
  }
}

export default MmsSupport
