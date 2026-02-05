/**
 * Missed Call Lambda Handler
 *
 * Processes missed call events:
 * - Logs missed call
 * - Sends notification
*/

export const handler = `
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

const sns = new SNSClient({});
const dynamodb = new DynamoDBClient({});

exports.handler = async (event) => {
  console.log('Missed call event:', JSON.stringify(event, null, 2));

  const notificationTopicArn = process.env.NOTIFICATION_TOPIC_ARN;
  const callLogTable = process.env.CALL_LOG_TABLE;
  const webhookUrl = process.env.WEBHOOK_URL;

  try {
    // Extract call details from Connect event
    const contactData = event.Details?.ContactData || {};

    const callDetails = {
      contactId: contactData.ContactId,
      customerEndpoint: contactData.CustomerEndpoint?.Address,
      systemEndpoint: contactData.SystemEndpoint?.Address,
      queue: contactData.Queue?.Name,
      waitTime: contactData.Queue?.EnqueueTimestamp
        ? Math.floor((Date.now() - new Date(contactData.Queue.EnqueueTimestamp).getTime()) / 1000)
        : 0,
      disconnectReason: event.Details?.Parameters?.disconnectReason || 'customer_abandoned',
      timestamp: new Date().toISOString(),
    };

    console.log('Missed call details:', callDetails);

    // Update call log
    if (callLogTable && callDetails.contactId) {
      await dynamodb.send(new UpdateItemCommand({
        TableName: callLogTable,
        Key: {
          contactId: { S: callDetails.contactId },
        },
        UpdateExpression: 'SET #status = :status, disconnectReason = :reason, waitTime = :wait, missedAt = :at',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': { S: 'missed' },
          ':reason': { S: callDetails.disconnectReason },
          ':wait': { N: String(callDetails.waitTime) },
          ':at': { S: callDetails.timestamp },
        },
      }));
    }

    // Send SNS notification
    if (notificationTopicArn) {
      await sns.send(new PublishCommand({
        TopicArn: notificationTopicArn,
        Subject: 'Missed Call Alert',
        Message: JSON.stringify({
          type: 'missed_call',
          from: callDetails.customerEndpoint,
          to: callDetails.systemEndpoint,
          queue: callDetails.queue,
          waitTime: callDetails.waitTime,
          reason: callDetails.disconnectReason,
          contactId: callDetails.contactId,
          timestamp: callDetails.timestamp,
        }, null, 2),
        MessageAttributes: {
          eventType: {
            DataType: 'String',
            StringValue: 'missed_call',
          },
        },
      }));
    }

    // Send webhook notification
    if (webhookUrl) {
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'missed_call',
            data: callDetails,
          }),
        });
      } catch (err) {
        console.error('Webhook notification failed:', err.message);
      }
    }

    return {
      statusCode: 200,
      message: 'Missed call logged',
    };

  } catch (error) {
    console.error('Error processing missed call:', error);
    return {
      statusCode: 500,
      error: error.message,
    };
  }
};
`

export default handler
