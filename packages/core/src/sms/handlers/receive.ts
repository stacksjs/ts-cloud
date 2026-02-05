/**
 * SMS Receive Lambda Handler
 *
 * Processes inbound SMS messages:
 * - Process inbound SMS (two-way)
 * - Handle opt-out keywords
 * - Forward to webhook
*/

export const handler = `
const { DynamoDBClient, PutItemCommand, GetItemCommand, DeleteItemCommand } = require('@aws-sdk/client-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const dynamodb = new DynamoDBClient({});
const sns = new SNSClient({});

const OPT_OUT_KEYWORDS = ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'OPT OUT'];
const OPT_IN_KEYWORDS = ['START', 'SUBSCRIBE', 'OPTIN', 'OPT IN', 'YES'];

exports.handler = async (event) => {
  console.log('SMS receive event:', JSON.stringify(event, null, 2));

  const optOutTable = process.env.OPT_OUT_TABLE;
  const messageLogTable = process.env.MESSAGE_LOG_TABLE;
  const notificationTopicArn = process.env.NOTIFICATION_TOPIC_ARN;
  const webhookUrl = process.env.WEBHOOK_URL;

  for (const record of event.Records) {
    try {
      // Parse SNS message from Pinpoint
      const message = JSON.parse(record.Sns?.Message || record.body || '{}');

      const {
        originationNumber,
        destinationNumber,
        messageBody,
        messageKeyword,
        inboundMessageId,
      } = message;

      if (!originationNumber || !messageBody) {
        console.log('Missing required fields');
        continue;
      }

      const timestamp = new Date().toISOString();
      const normalizedBody = messageBody.trim().toUpperCase();

      // Check for opt-out keywords
      if (OPT_OUT_KEYWORDS.some(kw => normalizedBody === kw || normalizedBody.startsWith(kw + ' '))) {
        console.log(\`Opt-out request from \${originationNumber}\`);

        if (optOutTable) {
          await dynamodb.send(new PutItemCommand({
            TableName: optOutTable,
            Item: {
              phoneNumber: { S: originationNumber },
              optedOutAt: { S: timestamp },
              keyword: { S: normalizedBody.split(' ')[0] },
              originalMessage: { S: messageBody },
            },
          }));
        }

        // Send confirmation (optional - check carrier requirements)
        // await sendOptOutConfirmation(originationNumber, destinationNumber);

        continue;
      }

      // Check for opt-in keywords
      if (OPT_IN_KEYWORDS.some(kw => normalizedBody === kw || normalizedBody.startsWith(kw + ' '))) {
        console.log(\`Opt-in request from \${originationNumber}\`);

        if (optOutTable) {
          await dynamodb.send(new DeleteItemCommand({
            TableName: optOutTable,
            Key: {
              phoneNumber: { S: originationNumber },
            },
          }));
        }

        continue;
      }

      // Log inbound message
      if (messageLogTable) {
        await dynamodb.send(new PutItemCommand({
          TableName: messageLogTable,
          Item: {
            messageId: { S: inboundMessageId || \`inbound-\${Date.now()}\` },
            direction: { S: 'inbound' },
            from: { S: originationNumber },
            to: { S: destinationNumber },
            body: { S: messageBody },
            keyword: { S: messageKeyword || '' },
            receivedAt: { S: timestamp },
            ttl: { N: String(Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60) },
          },
        }));
      }

      // Send SNS notification
      if (notificationTopicArn) {
        await sns.send(new PublishCommand({
          TopicArn: notificationTopicArn,
          Subject: 'Inbound SMS',
          Message: JSON.stringify({
            type: 'inbound_sms',
            from: originationNumber,
            to: destinationNumber,
            body: messageBody,
            keyword: messageKeyword,
            timestamp,
          }, null, 2),
          MessageAttributes: {
            eventType: {
              DataType: 'String',
              StringValue: 'inbound_sms',
            },
          },
        }));
      }

      // Forward to webhook
      if (webhookUrl) {
        try {
          const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'inbound_sms',
              data: {
                from: originationNumber,
                to: destinationNumber,
                body: messageBody,
                keyword: messageKeyword,
                messageId: inboundMessageId,
                timestamp,
              },
            }),
          });

          console.log(\`Webhook response: \${response.status}\`);
        } catch (err) {
          console.error('Webhook failed:', err.message);
        }
      }

      console.log(\`Processed inbound SMS from \${originationNumber}\`);

    } catch (error) {
      console.error('Error processing inbound SMS:', error);
    }
  }

  return { statusCode: 200, body: 'OK' };
};
`

export default handler
