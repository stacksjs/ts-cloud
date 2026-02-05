/**
 * Incoming Call Lambda Handler
 *
 * Processes incoming calls from Amazon Connect:
 * - Logs call details
 * - Sends notifications (SNS, webhook)
 * - Routes based on caller ID
*/

export const handler = `
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');

const sns = new SNSClient({});
const dynamodb = new DynamoDBClient({});

exports.handler = async (event) => {
  console.log('Incoming call event:', JSON.stringify(event, null, 2));

  const notificationTopicArn = process.env.NOTIFICATION_TOPIC_ARN;
  const callLogTable = process.env.CALL_LOG_TABLE;
  const webhookUrl = process.env.WEBHOOK_URL;

  try {
    // Extract call details from Connect event
    const contactData = event.Details?.ContactData || {};
    const parameters = event.Details?.Parameters || {};

    const callDetails = {
      contactId: contactData.ContactId,
      channel: contactData.Channel || 'VOICE',
      initiationMethod: contactData.InitiationMethod,
      customerEndpoint: contactData.CustomerEndpoint?.Address,
      systemEndpoint: contactData.SystemEndpoint?.Address,
      queue: contactData.Queue?.Name,
      attributes: contactData.Attributes || {},
      timestamp: new Date().toISOString(),
    };

    console.log('Call details:', callDetails);

    // Log call to DynamoDB
    if (callLogTable) {
      await dynamodb.send(new PutItemCommand({
        TableName: callLogTable,
        Item: {
          contactId: { S: callDetails.contactId },
          timestamp: { S: callDetails.timestamp },
          callerNumber: { S: callDetails.customerEndpoint || 'unknown' },
          calledNumber: { S: callDetails.systemEndpoint || 'unknown' },
          channel: { S: callDetails.channel },
          initiationMethod: { S: callDetails.initiationMethod || 'unknown' },
          status: { S: 'incoming' },
          ttl: { N: String(Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60) }, // 90 days
        },
      }));
    }

    // Send SNS notification
    if (notificationTopicArn) {
      await sns.send(new PublishCommand({
        TopicArn: notificationTopicArn,
        Subject: 'Incoming Call',
        Message: JSON.stringify({
          type: 'incoming_call',
          from: callDetails.customerEndpoint,
          to: callDetails.systemEndpoint,
          contactId: callDetails.contactId,
          timestamp: callDetails.timestamp,
        }, null, 2),
        MessageAttributes: {
          eventType: {
            DataType: 'String',
            StringValue: 'incoming_call',
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
            event: 'incoming_call',
            data: callDetails,
          }),
        });
      } catch (err) {
        console.error('Webhook notification failed:', err.message);
      }
    }

    // Return routing decision
    // Can be customized based on caller ID, time of day, etc.
    return {
      statusCode: 200,
      route: parameters.defaultRoute || 'main_queue',
      callerInfo: {
        number: callDetails.customerEndpoint,
        isKnown: false, // Could lookup in CRM
      },
    };

  } catch (error) {
    console.error('Error processing incoming call:', error);
    return {
      statusCode: 500,
      error: error.message,
    };
  }
};
`

export default handler
