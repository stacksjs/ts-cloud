/**
 * Email Conversion Lambda Handler
 *
 * Converts raw MIME emails to readable formats:
 * - Converts raw MIME to HTML/text
 * - Extracts and saves attachments separately
 * - Generates email previews
 * - Creates searchable metadata JSON
*/

export const handler = `
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const s3 = new S3Client({});

exports.handler = async (event) => {
  console.log('Email conversion event:', JSON.stringify(event, null, 2));

  const bucket = process.env.EMAIL_BUCKET;

  for (const record of event.Records) {
    try {
      const s3Event = record.s3 || {};
      const key = decodeURIComponent(s3Event.object?.key?.replace(/\\+/g, ' ') || '');

      // Only process raw.eml files in mailboxes
      if (!key.endsWith('/raw.eml') || !key.startsWith('mailboxes/')) {
        continue;
      }

      const basePath = key.replace('/raw.eml', '');

      // Get raw email
      const getResult = await s3.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }));

      const rawEmail = await getResult.Body.transformToString();

      // Parse email
      const parsed = parseEmail(rawEmail);

      // Save HTML version
      if (parsed.html) {
        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: \`\${basePath}/body.html\`,
          Body: parsed.html,
          ContentType: 'text/html',
        }));
      }

      // Save text version
      if (parsed.text) {
        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: \`\${basePath}/body.txt\`,
          Body: parsed.text,
          ContentType: 'text/plain',
        }));
      }

      // Save attachments
      if (parsed.attachments && parsed.attachments.length > 0) {
        for (let i = 0; i < parsed.attachments.length; i++) {
          const attachment = parsed.attachments[i];
          await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: \`\${basePath}/attachments/\${attachment.filename}\`,
            Body: Buffer.from(attachment.content, 'base64'),
            ContentType: attachment.contentType,
          }));
        }

        // Update metadata with attachment info
        try {
          const metaResult = await s3.send(new GetObjectCommand({
            Bucket: bucket,
            Key: \`\${basePath}/metadata.json\`,
          }));
          const metadata = JSON.parse(await metaResult.Body.transformToString());

          metadata.attachments = parsed.attachments.map(a => ({
            filename: a.filename,
            contentType: a.contentType,
            size: a.size,
          }));
          metadata.converted = true;
          metadata.convertedAt = new Date().toISOString();

          await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: \`\${basePath}/metadata.json\`,
            Body: JSON.stringify(metadata, null, 2),
            ContentType: 'application/json',
          }));
        } catch (err) {
          console.log('Could not update metadata:', err.message);
        }
      }

      // Generate preview (first 200 chars of text)
      const preview = (parsed.text || parsed.html?.replace(/<[^>]+>/g, '') || '')
        .substring(0, 200)
        .replace(/\\s+/g, ' ')
        .trim();

      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: \`\${basePath}/preview.txt\`,
        Body: preview,
        ContentType: 'text/plain',
      }));

      console.log(\`Converted email: \${key}\`);

    } catch (error) {
      console.error('Error converting email:', error);
    }
  }

  return { statusCode: 200, body: 'OK' };
};

// Simple MIME parser
function parseEmail(rawEmail) {
  const result = {
    headers: {},
    text: null,
    html: null,
    attachments: [],
  };

  // Split headers and body
  const parts = rawEmail.split(/\\r?\\n\\r?\\n/);
  const headerSection = parts[0];
  const bodySection = parts.slice(1).join('\\n\\n');

  // Parse headers
  let currentHeader = '';
  for (const line of headerSection.split(/\\r?\\n/)) {
    if (line.match(/^[A-Za-z-]+:/)) {
      const colonIndex = line.indexOf(':');
      currentHeader = line.substring(0, colonIndex).toLowerCase();
      result.headers[currentHeader] = line.substring(colonIndex + 1).trim();
    } else if (currentHeader && (line.startsWith(' ') || line.startsWith('\\t'))) {
      result.headers[currentHeader] += ' ' + line.trim();
    }
  }

  // Check content type
  const contentType = result.headers['content-type'] || 'text/plain';

  if (contentType.includes('multipart/')) {
    // Extract boundary
    const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      const mimeParts = bodySection.split('--' + boundary);

      for (const part of mimeParts) {
        if (part.trim() === '' || part.trim() === '--') continue;

        const partParts = part.split(/\\r?\\n\\r?\\n/);
        const partHeaders = partParts[0];
        const partBody = partParts.slice(1).join('\\n\\n').trim();

        const partContentType = (partHeaders.match(/Content-Type:\\s*([^;\\r\\n]+)/i) || [])[1] || '';
        const partEncoding = (partHeaders.match(/Content-Transfer-Encoding:\\s*([^\\r\\n]+)/i) || [])[1] || '';
        const partDisposition = (partHeaders.match(/Content-Disposition:\\s*([^;\\r\\n]+)/i) || [])[1] || '';

        if (partDisposition.includes('attachment') || partContentType.includes('application/')) {
          // Attachment
          const filenameMatch = partHeaders.match(/filename="?([^"\\r\\n]+)"?/i);
          const filename = filenameMatch ? filenameMatch[1] : \`attachment_\${result.attachments.length + 1}\`;

          let content = partBody;
          if (partEncoding.toLowerCase() === 'base64') {
            content = partBody.replace(/\\s/g, '');
          }

          result.attachments.push({
            filename,
            contentType: partContentType.trim(),
            content,
            size: Buffer.from(content, 'base64').length,
          });
        } else if (partContentType.includes('text/html')) {
          result.html = decodeContent(partBody, partEncoding);
        } else if (partContentType.includes('text/plain')) {
          result.text = decodeContent(partBody, partEncoding);
        } else if (partContentType.includes('multipart/')) {
          // Nested multipart - recursively parse
          const nestedResult = parseEmail(partHeaders + '\\n\\n' + partBody);
          if (nestedResult.html) result.html = nestedResult.html;
          if (nestedResult.text) result.text = nestedResult.text;
          result.attachments.push(...nestedResult.attachments);
        }
      }
    }
  } else if (contentType.includes('text/html')) {
    result.html = bodySection;
  } else {
    result.text = bodySection;
  }

  return result;
}

function decodeContent(content, encoding) {
  if (!encoding) return content;

  encoding = encoding.toLowerCase().trim();

  if (encoding === 'base64') {
    return Buffer.from(content.replace(/\\s/g, ''), 'base64').toString('utf-8');
  } else if (encoding === 'quoted-printable') {
    return content
      .replace(/=\\r?\\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  return content;
}
`

export default handler
