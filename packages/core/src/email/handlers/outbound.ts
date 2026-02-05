/**
 * Outbound Email Lambda Handler
 *
 * Processes outgoing emails:
 * - Accepts JSON email payloads from S3
 * - Generates proper MIME messages
 * - Supports HTML and plain text
 * - Handles attachments (base64 encoded)
 * - Tracks via configuration set
 * - Stores sent emails in S3
*/

export const handler = `
const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');

const s3 = new S3Client({});
const ses = new SESClient({});

exports.handler = async (event) => {
  console.log('Outbound email event:', JSON.stringify(event, null, 2));

  const bucket = process.env.EMAIL_BUCKET;
  const configSet = process.env.CONFIG_SET || 'default';

  for (const record of event.Records) {
    try {
      // Get the email payload from S3
      const s3Event = record.s3 || {};
      const key = decodeURIComponent(s3Event.object?.key?.replace(/\\+/g, ' ') || '');

      if (!key || !key.startsWith('outbox/')) {
        continue;
      }

      const getResult = await s3.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }));

      const emailData = JSON.parse(await getResult.Body.transformToString());

      // Build MIME message
      const boundary = \`----=_Part_\${Date.now()}_\${Math.random().toString(36).substr(2)}\`;
      const mixedBoundary = \`----=_Mixed_\${Date.now()}_\${Math.random().toString(36).substr(2)}\`;

      let rawMessage = '';

      // Headers
      rawMessage += \`From: \${emailData.from}\\r\\n\`;
      rawMessage += \`To: \${Array.isArray(emailData.to) ? emailData.to.join(', ') : emailData.to}\\r\\n\`;

      if (emailData.cc) {
        rawMessage += \`Cc: \${Array.isArray(emailData.cc) ? emailData.cc.join(', ') : emailData.cc}\\r\\n\`;
      }

      if (emailData.replyTo) {
        rawMessage += \`Reply-To: \${emailData.replyTo}\\r\\n\`;
      }

      rawMessage += \`Subject: =?UTF-8?B?\${Buffer.from(emailData.subject || '').toString('base64')}?=\\r\\n\`;
      rawMessage += \`Date: \${new Date().toUTCString()}\\r\\n\`;
      rawMessage += \`Message-ID: <\${Date.now()}.\${Math.random().toString(36)}@\${emailData.from.split('@')[1] || 'local'}>\\r\\n\`;
      rawMessage += 'MIME-Version: 1.0\\r\\n';

      const hasAttachments = emailData.attachments && emailData.attachments.length > 0;

      if (hasAttachments) {
        rawMessage += \`Content-Type: multipart/mixed; boundary="\${mixedBoundary}"\\r\\n\\r\\n\`;
        rawMessage += \`--\${mixedBoundary}\\r\\n\`;
      }

      // Body (multipart alternative for HTML + text)
      if (emailData.html && emailData.text) {
        rawMessage += \`Content-Type: multipart/alternative; boundary="\${boundary}"\\r\\n\\r\\n\`;

        // Plain text part
        rawMessage += \`--\${boundary}\\r\\n\`;
        rawMessage += 'Content-Type: text/plain; charset=UTF-8\\r\\n';
        rawMessage += 'Content-Transfer-Encoding: quoted-printable\\r\\n\\r\\n';
        rawMessage += emailData.text + '\\r\\n\\r\\n';

        // HTML part
        rawMessage += \`--\${boundary}\\r\\n\`;
        rawMessage += 'Content-Type: text/html; charset=UTF-8\\r\\n';
        rawMessage += 'Content-Transfer-Encoding: quoted-printable\\r\\n\\r\\n';
        rawMessage += emailData.html + '\\r\\n\\r\\n';

        rawMessage += \`--\${boundary}--\\r\\n\`;
      } else if (emailData.html) {
        if (!hasAttachments) {
          rawMessage += 'Content-Type: text/html; charset=UTF-8\\r\\n';
          rawMessage += 'Content-Transfer-Encoding: quoted-printable\\r\\n\\r\\n';
        } else {
          rawMessage += 'Content-Type: text/html; charset=UTF-8\\r\\n\\r\\n';
        }
        rawMessage += emailData.html + '\\r\\n';
      } else {
        if (!hasAttachments) {
          rawMessage += 'Content-Type: text/plain; charset=UTF-8\\r\\n';
          rawMessage += 'Content-Transfer-Encoding: quoted-printable\\r\\n\\r\\n';
        } else {
          rawMessage += 'Content-Type: text/plain; charset=UTF-8\\r\\n\\r\\n';
        }
        rawMessage += (emailData.text || emailData.body || '') + '\\r\\n';
      }

      // Attachments
      if (hasAttachments) {
        for (const attachment of emailData.attachments) {
          rawMessage += \`--\${mixedBoundary}\\r\\n\`;
          rawMessage += \`Content-Type: \${attachment.contentType || 'application/octet-stream'}; name="\${attachment.filename}"\\r\\n\`;
          rawMessage += 'Content-Transfer-Encoding: base64\\r\\n';
          rawMessage += \`Content-Disposition: attachment; filename="\${attachment.filename}"\\r\\n\\r\\n\`;
          rawMessage += attachment.content + '\\r\\n';
        }
        rawMessage += \`--\${mixedBoundary}--\\r\\n\`;
      }

      // Send via SES
      const sendResult = await ses.send(new SendRawEmailCommand({
        RawMessage: { Data: Buffer.from(rawMessage) },
        ConfigurationSetName: configSet,
      }));

      console.log(\`Email sent: \${sendResult.MessageId}\`);

      // Store in sent folder
      const timestamp = new Date();
      const year = timestamp.getFullYear();
      const month = String(timestamp.getMonth() + 1).padStart(2, '0');
      const day = String(timestamp.getDate()).padStart(2, '0');

      const fromEmail = emailData.from.match(/<([^>]+)>/) ? emailData.from.match(/<([^>]+)>/)[1] : emailData.from;
      const [localPart, domain] = fromEmail.split('@');

      const sentPath = \`mailboxes/\${domain}/\${localPart}/sent/\${year}/\${month}/\${day}/\${sendResult.MessageId}\`;

      // Save sent email metadata
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: \`\${sentPath}/metadata.json\`,
        Body: JSON.stringify({
          messageId: sendResult.MessageId,
          from: emailData.from,
          to: emailData.to,
          cc: emailData.cc,
          subject: emailData.subject,
          sentAt: timestamp.toISOString(),
          hasAttachments,
        }, null, 2),
        ContentType: 'application/json',
      }));

      // Save raw message
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: \`\${sentPath}/raw.eml\`,
        Body: rawMessage,
        ContentType: 'message/rfc822',
      }));

      // Delete from outbox
      await s3.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      }));

    } catch (error) {
      console.error('Error sending email:', error);
    }
  }

  return { statusCode: 200, body: 'OK' };
};
`

export default handler
