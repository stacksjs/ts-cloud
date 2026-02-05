/**
 * Inbound Email Lambda Handler
 *
 * Processes incoming emails from SES:
 * - Parses raw MIME emails
 * - Extracts metadata (from, to, subject, date, attachments)
 * - Organizes by domain/account/sender structure
 * - Supports + addressing (user+tag@domain.com)
 * - Stores in S3 with proper structure
 * - Triggers SNS notifications
*/

export const handler = `
const { S3Client, GetObjectCommand, PutObjectCommand, CopyObjectCommand } = require('@aws-sdk/client-s3');
const s3 = new S3Client({});

exports.handler = async (event) => {
  console.log('Inbound email event:', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      // Handle SES notification via SNS
      const sesNotification = JSON.parse(record.Sns?.Message || record.body || '{}');
      const mail = sesNotification.mail || {};
      const receipt = sesNotification.receipt || {};

      const bucket = process.env.EMAIL_BUCKET;
      const messageId = mail.messageId;

      if (!messageId) {
        console.log('No messageId found, skipping');
        continue;
      }

      // Get the raw email from S3
      const sourceKey = \`incoming/\${messageId}\`;
      let rawEmail;

      try {
        const getResult = await s3.send(new GetObjectCommand({
          Bucket: bucket,
          Key: sourceKey,
        }));
        rawEmail = await getResult.Body.transformToString();
      } catch (err) {
        console.log('Could not retrieve raw email:', err.message);
        continue;
      }

      // Parse email headers
      const headers = {};
      const headerSection = rawEmail.split('\\n\\n')[0];
      let currentHeader = '';

      for (const line of headerSection.split('\\n')) {
        if (line.match(/^[A-Za-z-]+:/)) {
          const colonIndex = line.indexOf(':');
          currentHeader = line.substring(0, colonIndex).toLowerCase();
          headers[currentHeader] = line.substring(colonIndex + 1).trim();
        } else if (currentHeader && (line.startsWith(' ') || line.startsWith('\\t'))) {
          headers[currentHeader] += ' ' + line.trim();
        }
      }

      // Extract key metadata
      const from = headers['from'] || '';
      const to = headers['to'] || '';
      const subject = headers['subject'] || '(no subject)';
      const date = headers['date'] || new Date().toISOString();

      // Parse sender email
      const fromMatch = from.match(/<([^>]+)>/) || [null, from];
      const fromEmail = fromMatch[1] || from;
      const fromDomain = fromEmail.split('@')[1] || 'unknown';

      // Parse recipient email (handle + addressing)
      const toMatch = to.match(/<([^>]+)>/) || [null, to];
      const toEmail = toMatch[1] || to;
      const [localPart, toDomain] = toEmail.split('@');
      const baseLocalPart = localPart.split('+')[0]; // Handle user+tag@domain.com
      const tag = localPart.includes('+') ? localPart.split('+')[1] : null;

      // Create timestamp-based path
      const timestamp = new Date(date);
      const year = timestamp.getFullYear();
      const month = String(timestamp.getMonth() + 1).padStart(2, '0');
      const day = String(timestamp.getDate()).padStart(2, '0');

      // Organize by: domain/mailbox/year/month/day/sender/messageId
      const destPath = \`mailboxes/\${toDomain}/\${baseLocalPart}/\${year}/\${month}/\${day}/\${fromDomain}/\${messageId}\`;

      // Copy raw email to organized location
      await s3.send(CopyObjectCommand({
        Bucket: bucket,
        CopySource: \`\${bucket}/\${sourceKey}\`,
        Key: \`\${destPath}/raw.eml\`,
      }));

      // Create metadata JSON
      const metadata = {
        messageId,
        from: fromEmail,
        fromName: from.replace(/<[^>]+>/, '').trim(),
        to: toEmail,
        toName: to.replace(/<[^>]+>/, '').trim(),
        subject,
        date: timestamp.toISOString(),
        receivedAt: new Date().toISOString(),
        tag,
        spamVerdict: receipt.spamVerdict?.status || 'UNKNOWN',
        virusVerdict: receipt.virusVerdict?.status || 'UNKNOWN',
        spfVerdict: receipt.spfVerdict?.status || 'UNKNOWN',
        dkimVerdict: receipt.dkimVerdict?.status || 'UNKNOWN',
        dmarcVerdict: receipt.dmarcVerdict?.status || 'UNKNOWN',
        hasAttachments: rawEmail.includes('Content-Disposition: attachment'),
      };

      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: \`\${destPath}/metadata.json\`,
        Body: JSON.stringify(metadata, null, 2),
        ContentType: 'application/json',
      }));

      // Update inbox index
      const indexKey = \`mailboxes/\${toDomain}/\${baseLocalPart}/inbox.json\`;
      let inbox = [];

      try {
        const indexResult = await s3.send(new GetObjectCommand({
          Bucket: bucket,
          Key: indexKey,
        }));
        inbox = JSON.parse(await indexResult.Body.transformToString());
      } catch {
        // Index doesn't exist yet
      }

      inbox.unshift({
        messageId,
        from: fromEmail,
        subject,
        date: timestamp.toISOString(),
        read: false,
        path: destPath,
      });

      // Keep only last 1000 emails in index
      inbox = inbox.slice(0, 1000);

      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: indexKey,
        Body: JSON.stringify(inbox, null, 2),
        ContentType: 'application/json',
      }));

      console.log(\`Processed email: \${messageId} from \${fromEmail} to \${toEmail}\`);

    } catch (error) {
      console.error('Error processing email:', error);
    }
  }

  return { statusCode: 200, body: 'OK' };
};
`

export default handler
