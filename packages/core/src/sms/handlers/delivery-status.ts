/**
 * SMS Delivery Status Lambda Handler
 *
 * Processes delivery status updates:
 * - Process delivery receipts
 * - Update message status
 * - Handle failures
*/

export const handler = `
const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const dynamodb = new DynamoDBClient({});
const sns = new SNSClient({});

exports.handler = async (event) => {
  console.log('SMS delivery status event:', JSON.stringify(event, null, 2));

  const messageLogTable = process.env.MESSAGE_LOG_TABLE;
  const notificationTopicArn = process.env.NOTIFICATION_TOPIC_ARN;
  const webhookUrl = process.env.WEBHOOK_URL;

  for (const record of event.Records) {
    try {
      // Parse delivery status from SNS/Pinpoint
      const message = JSON.parse(record.Sns?.Message || record.body || '{}');

      const {
        eventType,
        messageId,
        destinationPhoneNumber,
        messageStatus,
        messageStatusDescription,
        isoCountryCode,
        mcc,
        mnc,
        priceInMillicentsUSD,
      } = message;

      if (!messageId) {
        console.log('No messageId in delivery status');
        continue;
      }

      const timestamp = new Date().toISOString();
      const status = messageStatus || eventType || 'UNKNOWN';

      console.log(\`Delivery status for \${messageId}: \${status}\`);

      // Update message log
      if (messageLogTable) {
        await dynamodb.send(new UpdateItemCommand({
          TableName: messageLogTable,
          Key: {
            messageId: { S: messageId },
          },
          UpdateExpression: 'SET deliveryStatus = :status, statusDescription = :desc, deliveredAt = :at, priceMillicents = :price, countryCode = :country',
          ExpressionAttributeValues: {
            ':status': { S: status },
            ':desc': { S: messageStatusDescription || '' },
            ':at': { S: timestamp },
            ':price': { N: String(priceInMillicentsUSD || 0) },
            ':country': { S: isoCountryCode || '' },
          },
        }));
      }

      // Handle failures - notify admin
      const isFailure = ['FAILED', 'UNREACHABLE', 'UNKNOWN', 'CARRIER_UNREACHABLE', 'BLOCKED', 'CARRIER_BLOCKED', 'INVALID', 'INVALID_MESSAGE', 'OPTED_OUT'].includes(status);

      if (isFailure) {
        console.log(\`SMS delivery failed: \${status} - \${messageStatusDescription}\`);

        // Send failure notification
        if (notificationTopicArn) {
          await sns.send(new PublishCommand({
            TopicArn: notificationTopicArn,
            Subject: \`SMS Delivery Failed: \${status}\`,
            Message: JSON.stringify({
              type: 'sms_delivery_failed',
              messageId,
              to: destinationPhoneNumber,
              status,
              description: messageStatusDescription,
              countryCode: isoCountryCode,
              timestamp,
            }, null, 2),
            MessageAttributes: {
              eventType: {
                DataType: 'String',
                StringValue: 'sms_delivery_failed',
              },
            },
          }));
        }
      }

      // Forward to webhook for all status updates
      if (webhookUrl) {
        try {
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'sms_delivery_status',
              data: {
                messageId,
                to: destinationPhoneNumber,
                status,
                description: messageStatusDescription,
                countryCode: isoCountryCode,
                carrier: { mcc, mnc },
                priceMillicents: priceInMillicentsUSD,
                timestamp,
              },
            }),
          });
        } catch (err) {
          console.error('Webhook failed:', err.message);
        }
      }

    } catch (error) {
      console.error('Error processing delivery status:', error);
    }
  }

  return { statusCode: 200, body: 'OK' };
};
`

export default handler
