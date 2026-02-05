/**
 * SMS Send Lambda Handler
 *
 * Sends SMS messages:
 * - Send SMS via Pinpoint/SNS
 * - Handle templated messages
 * - Track delivery status
*/

export const handler = `
const { PinpointClient, SendMessagesCommand } = require('@aws-sdk/client-pinpoint');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');

const pinpoint = new PinpointClient({});
const sns = new SNSClient({});
const dynamodb = new DynamoDBClient({});

exports.handler = async (event) => {
  console.log('SMS send event:', JSON.stringify(event, null, 2));

  const applicationId = process.env.PINPOINT_APP_ID;
  const messageLogTable = process.env.MESSAGE_LOG_TABLE;
  const senderId = process.env.SMS_SENDER_ID;
  const originationNumber = process.env.SMS_ORIGINATION_NUMBER;

  // Handle both direct invocation and SQS/SNS events
  const messages = event.Records
    ? event.Records.map(r => JSON.parse(r.body || r.Sns?.Message || '{}'))
    : [event];

  const results = [];

  for (const message of messages) {
    try {
      const {
        to,
        body,
        template,
        templateData,
        messageType = 'TRANSACTIONAL',
      } = message;

      if (!to || (!body && !template)) {
        console.log('Missing required fields (to, body/template)');
        continue;
      }

      // Resolve template if provided
      let messageBody = body;
      if (template && templateData) {
        messageBody = resolveTemplate(template, templateData);
      }

      const messageId = \`sms-\${Date.now()}-\${Math.random().toString(36).substr(2)}\`;

      // Send via Pinpoint if app ID is configured
      if (applicationId) {
        const sendResult = await pinpoint.send(new SendMessagesCommand({
          ApplicationId: applicationId,
          MessageRequest: {
            Addresses: {
              [to]: {
                ChannelType: 'SMS',
              },
            },
            MessageConfiguration: {
              SMSMessage: {
                Body: messageBody,
                MessageType: messageType,
                SenderId: senderId,
                OriginationNumber: originationNumber,
              },
            },
          },
        }));

        const result = sendResult.MessageResponse?.Result?.[to] || {};

        // Log message
        if (messageLogTable) {
          await dynamodb.send(new PutItemCommand({
            TableName: messageLogTable,
            Item: {
              messageId: { S: result.MessageId || messageId },
              to: { S: to },
              body: { S: messageBody },
              messageType: { S: messageType },
              deliveryStatus: { S: result.DeliveryStatus || 'UNKNOWN' },
              statusCode: { N: String(result.StatusCode || 0) },
              statusMessage: { S: result.StatusMessage || '' },
              sentAt: { S: new Date().toISOString() },
              ttl: { N: String(Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60) },
            },
          }));
        }

        results.push({
          to,
          messageId: result.MessageId || messageId,
          status: result.DeliveryStatus,
          statusCode: result.StatusCode,
        });

      } else {
        // Fallback to SNS
        const snsResult = await sns.send(new PublishCommand({
          PhoneNumber: to,
          Message: messageBody,
          MessageAttributes: {
            'AWS.SNS.SMS.SMSType': {
              DataType: 'String',
              StringValue: messageType === 'PROMOTIONAL' ? 'Promotional' : 'Transactional',
            },
            ...(senderId && {
              'AWS.SNS.SMS.SenderID': {
                DataType: 'String',
                StringValue: senderId,
              },
            }),
          },
        }));

        // Log message
        if (messageLogTable) {
          await dynamodb.send(new PutItemCommand({
            TableName: messageLogTable,
            Item: {
              messageId: { S: snsResult.MessageId || messageId },
              to: { S: to },
              body: { S: messageBody },
              messageType: { S: messageType },
              deliveryStatus: { S: 'SENT' },
              sentAt: { S: new Date().toISOString() },
              ttl: { N: String(Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60) },
            },
          }));
        }

        results.push({
          to,
          messageId: snsResult.MessageId || messageId,
          status: 'SENT',
        });
      }

      console.log(\`SMS sent to \${to}: \${results[results.length - 1].status}\`);

    } catch (error) {
      console.error('Error sending SMS:', error);
      results.push({
        to: message.to,
        error: error.message,
        status: 'FAILED',
      });
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ results }),
  };
};

function resolveTemplate(template, data) {
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    result = result.replace(new RegExp(\`{{\\\\s*\${key}\\\\s*}}\`, 'g'), value);
  }
  return result;
}
`

export default handler
