/**
 * Email Feedback Lambda Handler
 *
 * Processes SES bounce and complaint notifications:
 * - Processes SES bounce notifications
 * - Processes complaint notifications
 * - Updates suppression list
 * - Sends admin notifications
 */

export const handler = `
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const s3 = new S3Client({});
const sns = new SNSClient({});

exports.handler = async (event) => {
  console.log('Email feedback event:', JSON.stringify(event, null, 2));

  const bucket = process.env.EMAIL_BUCKET;
  const adminTopicArn = process.env.ADMIN_TOPIC_ARN;

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.Sns?.Message || record.body || '{}');
      const notificationType = message.notificationType || message.eventType;

      if (!notificationType) {
        console.log('Unknown notification type, skipping');
        continue;
      }

      const timestamp = new Date().toISOString();

      if (notificationType === 'Bounce') {
        await handleBounce(message, bucket, adminTopicArn, timestamp);
      } else if (notificationType === 'Complaint') {
        await handleComplaint(message, bucket, adminTopicArn, timestamp);
      } else if (notificationType === 'Delivery') {
        await handleDelivery(message, bucket, timestamp);
      }

    } catch (error) {
      console.error('Error processing feedback:', error);
    }
  }

  return { statusCode: 200, body: 'OK' };
};

async function handleBounce(message, bucket, adminTopicArn, timestamp) {
  const bounce = message.bounce || {};
  const mail = message.mail || {};

  console.log(\`Processing bounce: \${bounce.bounceType} - \${bounce.bounceSubType}\`);

  // Get bounced recipients
  const bouncedRecipients = bounce.bouncedRecipients || [];

  for (const recipient of bouncedRecipients) {
    const email = recipient.emailAddress;

    // Add to suppression list
    await addToSuppressionList(bucket, email, 'bounce', {
      type: bounce.bounceType,
      subType: bounce.bounceSubType,
      diagnosticCode: recipient.diagnosticCode,
      action: recipient.action,
      status: recipient.status,
      timestamp,
      originalMessageId: mail.messageId,
    });

    console.log(\`Added \${email} to suppression list (bounce)\`);
  }

  // Log bounce event
  await logFeedbackEvent(bucket, 'bounces', {
    type: 'bounce',
    bounceType: bounce.bounceType,
    bounceSubType: bounce.bounceSubType,
    recipients: bouncedRecipients.map(r => r.emailAddress),
    messageId: mail.messageId,
    timestamp,
  });

  // Notify admin for hard bounces
  if (bounce.bounceType === 'Permanent' && adminTopicArn) {
    await sns.send(new PublishCommand({
      TopicArn: adminTopicArn,
      Subject: \`Email Bounce Alert: \${bounce.bounceSubType}\`,
      Message: JSON.stringify({
        type: 'bounce',
        bounceType: bounce.bounceType,
        bounceSubType: bounce.bounceSubType,
        recipients: bouncedRecipients.map(r => ({
          email: r.emailAddress,
          diagnosticCode: r.diagnosticCode,
        })),
        originalSubject: mail.commonHeaders?.subject,
        timestamp,
      }, null, 2),
    }));
  }
}

async function handleComplaint(message, bucket, adminTopicArn, timestamp) {
  const complaint = message.complaint || {};
  const mail = message.mail || {};

  console.log(\`Processing complaint: \${complaint.complaintFeedbackType}\`);

  // Get complained recipients
  const complainedRecipients = complaint.complainedRecipients || [];

  for (const recipient of complainedRecipients) {
    const email = recipient.emailAddress;

    // Add to suppression list
    await addToSuppressionList(bucket, email, 'complaint', {
      feedbackType: complaint.complaintFeedbackType,
      userAgent: complaint.userAgent,
      timestamp,
      originalMessageId: mail.messageId,
    });

    console.log(\`Added \${email} to suppression list (complaint)\`);
  }

  // Log complaint event
  await logFeedbackEvent(bucket, 'complaints', {
    type: 'complaint',
    feedbackType: complaint.complaintFeedbackType,
    recipients: complainedRecipients.map(r => r.emailAddress),
    messageId: mail.messageId,
    timestamp,
  });

  // Always notify admin for complaints
  if (adminTopicArn) {
    await sns.send(new PublishCommand({
      TopicArn: adminTopicArn,
      Subject: \`Email Complaint Alert: \${complaint.complaintFeedbackType || 'Unknown'}\`,
      Message: JSON.stringify({
        type: 'complaint',
        feedbackType: complaint.complaintFeedbackType,
        recipients: complainedRecipients.map(r => r.emailAddress),
        originalSubject: mail.commonHeaders?.subject,
        timestamp,
      }, null, 2),
    }));
  }
}

async function handleDelivery(message, bucket, timestamp) {
  const delivery = message.delivery || {};
  const mail = message.mail || {};

  console.log(\`Processing delivery confirmation for \${delivery.recipients?.join(', ')}\`);

  // Log delivery event
  await logFeedbackEvent(bucket, 'deliveries', {
    type: 'delivery',
    recipients: delivery.recipients,
    messageId: mail.messageId,
    processingTimeMillis: delivery.processingTimeMillis,
    smtpResponse: delivery.smtpResponse,
    timestamp,
  });
}

async function addToSuppressionList(bucket, email, reason, details) {
  const key = 'suppression/list.json';
  let list = [];

  try {
    const result = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }));
    list = JSON.parse(await result.Body.transformToString());
  } catch {
    // List doesn't exist yet
  }

  // Check if already in list
  const existing = list.find(item => item.email === email);
  if (existing) {
    existing.lastUpdated = details.timestamp;
    existing.count = (existing.count || 1) + 1;
  } else {
    list.push({
      email,
      reason,
      addedAt: details.timestamp,
      lastUpdated: details.timestamp,
      count: 1,
      details,
    });
  }

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(list, null, 2),
    ContentType: 'application/json',
  }));
}

async function logFeedbackEvent(bucket, type, event) {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  const key = \`feedback/\${type}/\${year}/\${month}/\${day}/\${Date.now()}-\${Math.random().toString(36).substr(2)}.json\`;

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(event, null, 2),
    ContentType: 'application/json',
  }));
}
`

export default handler
